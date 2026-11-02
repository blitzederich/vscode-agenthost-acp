/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import type { ChildProcessWithoutNullStreams } from 'child_process';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../log/common/log.js';
import type { IProductService } from '../../../../product/common/productService.js';
import { AgentSession, fixedChatOwnerRef, GROK_BUILD_AGENT_PROVIDER_ID, type AgentSignal, type IAgentChatContext, type IAgentDiscoveredChat } from '../../../common/agent.js';
import { ActionType } from '../../../common/state/sessionActions.js';
import { CustomizationType, ResponsePartKind, TurnState, type Turn } from '../../../common/state/sessionState.js';
import {
	AcpClient,
	type IAcpTransport,
} from '../../../node/grokBuild/acpClient.js';
import { decodeGrokBuildChat, encodeGrokBuildChat } from '../../../node/grokBuild/grokBuildChatBacking.js';
import { GrokBuildAgent, mergeRestoredTurns } from '../../../node/grokBuild/grokBuildAgent.js';
import { GROK_PERMISSION_PRESET_ALLOW_EDITS, GROK_PERMISSION_PRESET_ASK, GROK_PERMISSION_PRESET_KEY, GROK_THINKING_LEVEL_KEY, grokPathPrefixRejectedError, grokPlanModeFailedError, grokSlashCommandRejectedError, grokSlashCommandsUnavailableError } from '../../../node/grokBuild/grokBuildUx.js';
import { IAgentConfigurationService, type IAgentChatConfigurationChangeEvent } from '../../../node/agentConfigurationService.js';
import { SessionConfigKey } from '../../../common/sessionConfigKeys.js';
import { GROK_BUILD_ACP_ARGV, grokCannotRestoreSessionError, grokCliMissingError, grokCliNotExecutableError, grokHandshakeTimeoutError, grokNotLoggedInError, grokSessionMissingError, grokUnreadableVersionWarning, grokVersionTooOldError, grokWorkingDirectoryRejectedError } from '../../../node/grokBuild/grokBuildLaunchConfig.js';
import type { AcpAgentCapabilities } from '../../../node/grokBuild/protocol/acpTypes.js';

class TestProductService {
	readonly _serviceBrand: undefined;
	readonly version = '1.145.0';
	readonly nameShort = 'Code - OSS';
	readonly nameLong = 'Code - OSS';
	readonly applicationName = 'code-oss';
	readonly dataFolderName = '.vscode-oss';
	readonly urlProtocol = 'code-oss';
	readonly quality = 'stable';
	readonly commit = 'test';
	readonly date = undefined;
	readonly vscodeVersion = '1.145.0';
}

interface IFakeChild {
	stderr: PassThrough;
	stdin: PassThrough;
	stdout: PassThrough;
	exitCode: number | null;
	signalCode: NodeJS.Signals | null;
	kill(signal?: NodeJS.Signals): boolean;
}

interface IFakePeer {
	readonly transport: IAcpTransport;
	readonly outbound: PassThrough;
	readonly child: EventEmitter & IFakeChild;
	push(message: object): void;
	pushRaw(text: string): void;
	writeStderr(text: string): void;
	exit(code: number | null, signal: NodeJS.Signals | null): void;
	dispose(): void;
}

const LIVE_CAPABILITIES: AcpAgentCapabilities = {
	loadSession: true,
	sessionCapabilities: { list: {}, resume: {}, close: {} },
};

function makeFakePeer(): IFakePeer {
	const clientStdin = new PassThrough();
	const clientStdout = new PassThrough();
	const exitEmitter = new Emitter<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }>();
	const onceExitListeners: ((e: { readonly code: number | null; readonly signal: NodeJS.Signals | null }) => void)[] = [];
	const stderr = new PassThrough();
	const childStdin = new PassThrough();
	const childStdout = new PassThrough();
	const child = new EventEmitter() as EventEmitter & IFakeChild;
	child.stderr = stderr;
	child.stdin = childStdin;
	child.stdout = childStdout;
	child.exitCode = null;
	child.signalCode = null;

	let disposed = false;
	let exited = false;
	const fireExit = (code: number | null, signal: NodeJS.Signals | null) => {
		if (disposed || exited) {
			return;
		}
		exited = true;
		child.exitCode = code;
		child.signalCode = signal;
		const event = { code, signal };
		exitEmitter.fire(event);
		for (const listener of onceExitListeners.splice(0)) {
			listener(event);
		}
	};
	child.kill = (signal?: NodeJS.Signals) => {
		fireExit(null, signal ?? 'SIGTERM');
		return true;
	};

	const transport: IAcpTransport = {
		stdin: clientStdin,
		stdout: clientStdout,
		kill(signal?: NodeJS.Signals) {
			fireExit(null, signal ?? 'SIGTERM');
			return true;
		},
		onExit: exitEmitter.event,
		onExitOnce(listener) {
			if (exited) {
				listener({ code: child.exitCode, signal: child.signalCode });
				return;
			}
			onceExitListeners.push(listener);
		},
	};

	return {
		transport,
		outbound: clientStdin,
		child,
		push(message: object) {
			clientStdout.write(JSON.stringify(message) + '\n');
		},
		pushRaw(text: string) {
			clientStdout.write(text);
		},
		writeStderr(text: string) {
			stderr.write(text);
		},
		exit(code, signal) {
			fireExit(code, signal);
		},
		dispose() {
			disposed = true;
			onceExitListeners.length = 0;
			exitEmitter.dispose();
			clientStdin.destroy();
			clientStdout.destroy();
			stderr.destroy();
			childStdin.destroy();
			childStdout.destroy();
		},
	};
}

class CapturingLogService extends NullLogService {
	readonly infos: string[] = [];
	readonly warnings: string[] = [];
	readonly errors: string[] = [];
	readonly traces: string[] = [];
	override info(message: string): void {
		this.infos.push(message);
	}
	override warn(message: string): void {
		this.warnings.push(message);
	}
	override error(message: string | Error): void {
		this.errors.push(message instanceof Error ? message.message : message);
	}
	override trace(message: string): void {
		this.traces.push(message);
	}

	/** Info and above. That is the default log level (`LogLevel.Info`). */
	defaultLevelText(): string {
		return [...this.infos, ...this.warnings, ...this.errors].join('\n');
	}
}

function readNextMessage(stream: PassThrough, timeoutMs = 2_000): Promise<any> {
	return new Promise((resolve, reject) => {
		let buf = '';
		const onData = (chunk: Buffer | string) => {
			buf += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
			const nl = buf.indexOf('\n');
			if (nl < 0) {
				return;
			}
			const line = buf.slice(0, nl).trim();
			cleanup();
			try {
				resolve(JSON.parse(line));
			} catch (err) {
				reject(err);
			}
		};
		const onEnd = () => {
			cleanup();
			reject(new Error('stream ended'));
		};
		const timer = setTimeout(() => {
			cleanup();
			reject(new Error('timeout waiting for ACP message'));
		}, timeoutMs);
		const cleanup = () => {
			clearTimeout(timer);
			stream.off('data', onData);
			stream.off('end', onEnd);
		};
		stream.on('data', onData);
		stream.on('end', onEnd);
	});
}

function readIfAny(stream: PassThrough, timeoutMs = 150): Promise<any | undefined> {
	return new Promise(resolve => {
		let buf = '';
		const onData = (chunk: Buffer | string) => {
			buf += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
			const nl = buf.indexOf('\n');
			if (nl < 0) {
				return;
			}
			const line = buf.slice(0, nl).trim();
			cleanup();
			resolve(JSON.parse(line));
		};
		const timer = setTimeout(() => {
			cleanup();
			resolve(undefined);
		}, timeoutMs);
		const cleanup = () => {
			clearTimeout(timer);
			stream.off('data', onData);
		};
		stream.on('data', onData);
	});
}

async function completeHandshake(peer: IFakePeer, capabilities: AcpAgentCapabilities = LIVE_CAPABILITIES): Promise<void> {
	const init = await readNextMessage(peer.outbound);
	assert.strictEqual(init.method, 'initialize');
	peer.push({
		jsonrpc: '2.0',
		id: init.id,
		result: { protocolVersion: 1, agentCapabilities: capabilities },
	});
	const auth = await readNextMessage(peer.outbound);
	assert.strictEqual(auth.method, 'authenticate');
	assert.strictEqual(auth.params.methodId, 'grok.com');
	peer.push({ jsonrpc: '2.0', id: auth.id, result: {} });
}

function pushUpdate(peer: IFakePeer, sessionId: string, update: object): void {
	peer.push({
		jsonrpc: '2.0',
		method: 'session/update',
		params: { sessionId, update },
	});
}

function markdownOf(turn: Turn): string {
	return turn.responseParts
		.filter(part => part.kind === ResponsePartKind.Markdown)
		.map(part => part.kind === ResponsePartKind.Markdown ? part.content : '')
		.join('');
}

function chatContext(chat: URI): IAgentChatContext {
	const owner = URI.from({ scheme: GROK_BUILD_AGENT_PROVIDER_ID, path: '/session' });
	return {
		resource: chat,
		owner: fixedChatOwnerRef(owner),
		sessionSettings: undefined,
		launchWorkingDirectories: undefined,
		workspaceless: false,
	};
}

function chatContextForSession(chat: URI, sessionId: string): IAgentChatContext {
	return {
		resource: chat,
		owner: fixedChatOwnerRef(AgentSession.uri(GROK_BUILD_AGENT_PROVIDER_ID, sessionId)),
		sessionSettings: undefined,
		launchWorkingDirectories: undefined,
		workspaceless: false,
	};
}

const LIVE_PERMISSION_OPTIONS = [
	{ optionId: 'allow-edits-session', name: 'Yes, allow all edits during this session', kind: 'allow_always' },
	{ optionId: 'allow-once', name: 'Yes', kind: 'allow_once' },
	{ optionId: 'reject-once', name: 'No, and tell Grok what to do differently', kind: 'reject_once' },
] as const;

suite('GrokBuildAgent', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function createAgent(log: NullLogService = new NullLogService(), configuration?: {
		readonly onDidChatConfigChange?: Event<IAgentChatConfigurationChangeEvent>;
		readonly getChatConfigValues?: () => Record<string, unknown> | undefined;
	}): GrokBuildAgent {
		const configurationService = {
			onDidChatConfigChange: configuration?.onDidChatConfigChange ?? Event.None,
			getChatConfigValues: configuration?.getChatConfigValues ?? (() => undefined),
		} as unknown as IAgentConfigurationService;
		return store.add(new GrokBuildAgent(log, new TestProductService() as unknown as IProductService, configurationService));
	}

	test('descriptor uses Grok Build label and provider id', () => {
		const agent = createAgent();
		assert.strictEqual(agent.id, GROK_BUILD_AGENT_PROVIDER_ID);
		const descriptor = agent.getDescriptor();
		assert.strictEqual(descriptor.provider, GROK_BUILD_AGENT_PROVIDER_ID);
		assert.strictEqual(descriptor.displayName, 'Grok Build');
		assert.strictEqual(agent.agentHostCapabilities.workspaceConversion, false);
		assert.deepStrictEqual(agent.getProtectedResources(), []);
	});

	test('createChat + sendMessage maps updates; unknown notifications ignored', async () => {
		const peer = store.add(makeFakePeer());
		const client = store.add(new AcpClient(peer.transport));
		const agent = createAgent();
		agent.bindTestClient(client);

		const signals: AgentSignal[] = [];
		store.add(agent.onDidChatProgress(s => signals.push(s)));

		const chat = URI.from({ scheme: GROK_BUILD_AGENT_PROVIDER_ID, path: '/chat/1' });
		const context = chatContext(chat);

		const createPromise = agent.chats.createChat(chat, context, {
			workingDirectories: [URI.file('/tmp/grok-acp-probe')],
		});
		const sessionNew = await readNextMessage(peer.outbound);
		assert.strictEqual(sessionNew.method, 'session/new');
		assert.strictEqual(sessionNew.params.cwd, '/tmp/grok-acp-probe');
		assert.deepStrictEqual(sessionNew.params.mcpServers, []);
		peer.push({
			jsonrpc: '2.0',
			id: sessionNew.id,
			result: {
				sessionId: '01a199cf-f5b0-7ea0-9492-44c99e9e2603',
				models: {
					currentModelId: 'grok-4.7',
					availableModels: [
						{ modelId: 'grok-4.7', name: 'Grok 4.7' },
						{ modelId: 'grok-4.7-build-fast', name: 'Grok 4.7 Fast' },
					],
				},
			},
		});
		const created = await createPromise;
		assert.ok(created?.providerData);
		assert.ok(agent.models.get().some(m => m.id === 'grok-4.7'));

		peer.push({ jsonrpc: '2.0', method: '_x.ai/queue/changed', params: { sessionId: '01a199cf-f5b0-7ea0-9492-44c99e9e2603' } });
		peer.push({ jsonrpc: '2.0', method: '_x.ai/session/prompt_complete', params: {} });
		peer.push({ jsonrpc: '2.0', method: '_x.ai/mcp_initialized', params: {} });

		const sendPromise = agent.chats.sendMessage(chat, 'hi', [URI.file('/tmp/grok-acp-probe')], undefined, 'turn-1', undefined, context);
		const prompt = await readNextMessage(peer.outbound);
		assert.strictEqual(prompt.method, 'session/prompt');

		peer.push({
			jsonrpc: '2.0',
			method: 'session/update',
			params: {
				sessionId: '01a199cf-f5b0-7ea0-9492-44c99e9e2603',
				update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hello' } },
			},
		});
		peer.push({
			jsonrpc: '2.0',
			method: 'session/update',
			params: {
				sessionId: '01a199cf-f5b0-7ea0-9492-44c99e9e2603',
				update: { sessionUpdate: 'available_commands_update', availableCommands: [] },
			},
		});
		peer.push({
			jsonrpc: '2.0',
			id: prompt.id,
			result: { stopReason: 'end_turn', _meta: { usage: { inputTokens: 3, outputTokens: 1, cachedReadTokens: 2 } } },
		});
		await sendPromise;

		assert.ok(signals.some(s => s.kind === 'action' && s.action.type === ActionType.ChatTurnStarted));
		assert.ok(signals.some(s => s.kind === 'action' && s.action.type === ActionType.ChatResponsePart));
		assert.ok(signals.some(s => s.kind === 'action' && s.action.type === ActionType.ChatTurnComplete));

		const messages = await agent.chats.getMessages(chat, context);
		assert.strictEqual(messages.length, 1);
		assert.strictEqual(messages[0].message.text, 'hi');
	});

	test('createChat with options.model calls session/set_model; changeModel updates backing', async () => {
		const peer = store.add(makeFakePeer());
		const client = store.add(new AcpClient(peer.transport));
		const agent = createAgent();
		agent.bindTestClient(client);

		const chat = URI.from({ scheme: GROK_BUILD_AGENT_PROVIDER_ID, path: '/chat/model' });
		const context = chatContext(chat);

		const createPromise = agent.chats.createChat(chat, context, {
			workingDirectories: [URI.file('/tmp')],
			model: { id: 'grok-4.7-build-fast' },
		});
		const sessionNew = await readNextMessage(peer.outbound);
		assert.strictEqual(sessionNew.method, 'session/new');
		peer.push({
			jsonrpc: '2.0',
			id: sessionNew.id,
			result: {
				sessionId: 'sess-model',
				models: { currentModelId: 'grok-4.7', availableModels: [{ modelId: 'grok-4.7', name: 'Grok 4.7' }, { modelId: 'grok-4.7-build-fast', name: 'Fast' }] },
			},
		});
		const setModel = await readNextMessage(peer.outbound);
		assert.strictEqual(setModel.method, 'session/set_model');
		assert.deepStrictEqual(setModel.params, { sessionId: 'sess-model', modelId: 'grok-4.7-build-fast' });
		peer.push({ jsonrpc: '2.0', id: setModel.id, result: { _meta: { model: { Ok: 'grok-4.7-build-fast' } } } });
		await createPromise;
		assert.strictEqual(agent.chats.getModel!(chat, context)?.id, 'grok-4.7-build-fast');

		const changePromise = agent.chats.changeModel!(chat, { id: 'grok-4.7' }, context);
		const changeReq = await readNextMessage(peer.outbound);
		assert.strictEqual(changeReq.method, 'session/set_model');
		assert.deepStrictEqual(changeReq.params, { sessionId: 'sess-model', modelId: 'grok-4.7' });
		peer.push({ jsonrpc: '2.0', id: changeReq.id, result: { _meta: { model: { Ok: 'grok-4.7' } } } });
		await changePromise;
		assert.strictEqual(agent.chats.getModel!(chat, context)?.id, 'grok-4.7');

		const badPromise = agent.chats.changeModel!(chat, { id: 'no-such-model' }, context);
		const badReq = await readNextMessage(peer.outbound);
		peer.push({ jsonrpc: '2.0', id: badReq.id, error: { code: -32602, message: 'Invalid params', data: 'unknown model id' } });
		await assert.rejects(badPromise, (err: unknown) => {
			assert.ok(err instanceof Error);
			assert.match(err.message, /unknown model id/);
			return true;
		});
		assert.strictEqual(agent.chats.getModel!(chat, context)?.id, 'grok-4.7');
	});

	test('live permission reject round trip ends prompt as cancelled', async () => {
		const peer = store.add(makeFakePeer());
		const client = store.add(new AcpClient(peer.transport));
		const agent = createAgent();
		agent.bindTestClient(client);

		const chat = URI.from({ scheme: GROK_BUILD_AGENT_PROVIDER_ID, path: '/chat/perm' });
		const context = chatContext(chat);

		const createPromise = agent.chats.createChat(chat, context, { workingDirectories: [URI.file('/tmp')] });
		const sessionNew = await readNextMessage(peer.outbound);
		peer.push({
			jsonrpc: '2.0',
			id: sessionNew.id,
			result: { sessionId: 'sess-perm', models: { currentModelId: 'grok-4.7', availableModels: [{ modelId: 'grok-4.7', name: 'Grok 4.7' }] } },
		});
		await createPromise;

		const pendingSignals: AgentSignal[] = [];
		store.add(agent.onDidChatProgress(s => pendingSignals.push(s)));

		const sendPromise = agent.chats.sendMessage(chat, 'edit', [URI.file('/tmp')], undefined, 'turn-perm', undefined, context);
		const prompt = await readNextMessage(peer.outbound);
		assert.strictEqual(prompt.method, 'session/prompt');

		peer.push({
			jsonrpc: '2.0',
			method: 'session/update',
			params: {
				sessionId: 'sess-perm',
				update: {
					sessionUpdate: 'tool_call',
					toolCallId: 'call-5e5bb6f0-dd44-448a-b257-ea1fe5e8013a-1',
					kind: 'edit',
					title: 'Edit `/tmp/grok-acp-probe/target.txt`',
					rawInput: {
						variant: 'SearchReplace',
						file_path: '/tmp/grok-acp-probe/target.txt',
						old_string: 'original',
						new_string: 'changed',
						replace_all: false,
					},
					_meta: { 'x.ai/tool': { name: 'search_replace', kind: 'edit', label: 'Edit' } },
				},
			},
		});

		peer.push({
			jsonrpc: '2.0',
			id: 42,
			method: 'session/request_permission',
			params: {
				sessionId: 'sess-perm',
				toolCall: {
					toolCallId: 'call-5e5bb6f0-dd44-448a-b257-ea1fe5e8013a-1',
					kind: 'edit',
					title: 'Edit `/tmp/grok-acp-probe/target.txt`',
					rawInput: {
						variant: 'SearchReplace',
						file_path: '/tmp/grok-acp-probe/target.txt',
						old_string: 'original',
						new_string: 'changed',
						replace_all: false,
					},
				},
				options: LIVE_PERMISSION_OPTIONS,
			},
		});

		await new Promise(r => setTimeout(r, 30));
		assert.ok(pendingSignals.some(s => s.kind === 'pending_confirmation'));
		agent.respondToPermissionRequest('call-5e5bb6f0-dd44-448a-b257-ea1fe5e8013a-1', false);

		const reply = await readNextMessage(peer.outbound);
		assert.strictEqual(reply.id, 42);
		assert.strictEqual(reply.result.outcome.outcome, 'selected');
		assert.strictEqual(reply.result.outcome.optionId, 'reject-once');

		peer.push({ jsonrpc: '2.0', id: prompt.id, result: { stopReason: 'cancelled' } });
		await sendPromise;

		assert.ok(pendingSignals.some(s => s.kind === 'action' && s.action.type === ActionType.ChatTurnCancelled));
	});

	test('abort sends session/cancel without spawning when already connected', async () => {
		const peer = store.add(makeFakePeer());
		const client = store.add(new AcpClient(peer.transport));
		const agent = createAgent();
		agent.bindTestClient(client);

		const chat = URI.from({ scheme: GROK_BUILD_AGENT_PROVIDER_ID, path: '/chat/cancel' });
		const context = chatContext(chat);
		const createPromise = agent.chats.createChat(chat, context, { workingDirectories: [URI.file('/tmp')] });
		const sessionNew = await readNextMessage(peer.outbound);
		peer.push({ jsonrpc: '2.0', id: sessionNew.id, result: { sessionId: 'sess-cancel', models: { currentModelId: 'm', availableModels: [{ modelId: 'm', name: 'm' }] } } });
		await createPromise;

		await agent.chats.abort(chat, context);
		const cancel = await readNextMessage(peer.outbound);
		assert.strictEqual(cancel.method, 'session/cancel');
		assert.strictEqual(cancel.params.sessionId, 'sess-cancel');
	});

	test('session/new authentication-required surfaces localized not-logged-in error', async () => {
		const peer = store.add(makeFakePeer());
		const client = store.add(new AcpClient(peer.transport));
		const agent = createAgent();
		agent.bindTestClient(client);

		const chat = URI.from({ scheme: GROK_BUILD_AGENT_PROVIDER_ID, path: '/chat/auth' });
		const context = chatContext(chat);
		const createPromise = agent.chats.createChat(chat, context, { workingDirectories: [URI.file('/tmp')] });
		const sessionNew = await readNextMessage(peer.outbound);
		peer.push({
			jsonrpc: '2.0',
			id: sessionNew.id,
			error: { code: -32000, message: 'Authentication required' },
		});
		await assert.rejects(createPromise, (err: unknown) => {
			assert.ok(err instanceof Error);
			assert.strictEqual(err.message, grokNotLoggedInError().message);
			return true;
		});
	});

	test('spawn seam: initialize then authenticate then session/new; concurrent createChat shares handshake', async () => {
		const previousElectron = process.env.ELECTRON_RUN_AS_NODE;
		const previousVscode = process.env.VSCODE_FOO;
		const previousSsh = process.env.SSH_AUTH_SOCK;
		const previousNodeOptions = process.env.NODE_OPTIONS;
		process.env.ELECTRON_RUN_AS_NODE = '1';
		process.env.VSCODE_FOO = 'secret';
		process.env.SSH_AUTH_SOCK = '/tmp/ssh-agent.sock';
		process.env.NODE_OPTIONS = '--inspect';
		try {
			const peer = store.add(makeFakePeer());
			const agent = createAgent();
			let spawnCount = 0;
			let launchEnv: NodeJS.ProcessEnv | undefined;
			agent.bindTestSpawn(launch => {
				spawnCount++;
				launchEnv = launch.env;
				assert.deepStrictEqual([...launch.args], [...GROK_BUILD_ACP_ARGV]);
				assert.ok(!Object.keys(launch.env).some(key => key === 'ELECTRON_RUN_AS_NODE' || key.startsWith('VSCODE_')));
				return { transport: peer.transport, onDispose: () => { /* peer owned by suite store */ } };
			});

			const chatA = URI.from({ scheme: GROK_BUILD_AGENT_PROVIDER_ID, path: '/chat/a' });
			const chatB = URI.from({ scheme: GROK_BUILD_AGENT_PROVIDER_ID, path: '/chat/b' });
			const contextA = chatContext(chatA);
			const contextB = chatContext(chatB);

			const createA = agent.chats.createChat(chatA, contextA, { workingDirectories: [URI.file('/tmp')] });
			const createB = agent.chats.createChat(chatB, contextB, { workingDirectories: [URI.file('/tmp')] });

			const init = await readNextMessage(peer.outbound);
			assert.strictEqual(init.method, 'initialize');
			peer.push({
				jsonrpc: '2.0',
				id: init.id,
				result: { protocolVersion: 1, authMethods: [{ id: 'grok.com', name: 'Grok' }], _meta: { agentVersion: '1.0.70' } },
			});

			const auth = await readNextMessage(peer.outbound);
			assert.strictEqual(auth.method, 'authenticate');
			assert.strictEqual(auth.params.methodId, 'grok.com');
			// Intentionally do not assert/log authenticate result shape (contains PII in _meta).
			peer.push({ jsonrpc: '2.0', id: auth.id, result: { _meta: { email: 'redacted@example.com' } } });

			const sessionNew1 = await readNextMessage(peer.outbound);
			const sessionNew2 = await readNextMessage(peer.outbound);
			assert.strictEqual(sessionNew1.method, 'session/new');
			assert.strictEqual(sessionNew2.method, 'session/new');
			peer.push({
				jsonrpc: '2.0',
				id: sessionNew1.id,
				result: { sessionId: 'sess-a', models: { currentModelId: 'grok-4.7', availableModels: [{ modelId: 'grok-4.7', name: 'Grok 4.7' }] } },
			});
			peer.push({
				jsonrpc: '2.0',
				id: sessionNew2.id,
				result: { sessionId: 'sess-b', models: { currentModelId: 'grok-4.7', availableModels: [{ modelId: 'grok-4.7', name: 'Grok 4.7' }] } },
			});

			await Promise.all([createA, createB]);
			assert.strictEqual(spawnCount, 1);
			assert.ok(launchEnv);
			assert.strictEqual(launchEnv.GROK_CLIENT_NAME, 'Code - OSS');
			assert.strictEqual(launchEnv.GROK_CLIENT_VERSION, '1.145.0');
			assert.strictEqual(launchEnv.SSH_AUTH_SOCK, '/tmp/ssh-agent.sock');
			assert.strictEqual(Object.hasOwn(launchEnv, 'ELECTRON_RUN_AS_NODE'), false);
			assert.strictEqual(Object.hasOwn(launchEnv, 'VSCODE_FOO'), false);
			assert.strictEqual(Object.hasOwn(launchEnv, 'NODE_OPTIONS'), false);
		} finally {
			restoreEnv('ELECTRON_RUN_AS_NODE', previousElectron);
			restoreEnv('VSCODE_FOO', previousVscode);
			restoreEnv('SSH_AUTH_SOCK', previousSsh);
			restoreEnv('NODE_OPTIONS', previousNodeOptions);
		}
	});

	test('session/load replays history into Turn[] and the next send does not load again', async () => {
		const peer = store.add(makeFakePeer());
		const client = store.add(new AcpClient(peer.transport));
		const agent = createAgent();
		agent.bindTestClient(client, LIVE_CAPABILITIES);

		const chat = URI.from({ scheme: GROK_BUILD_AGENT_PROVIDER_ID, path: '/chat/load' });
		const context = chatContext(chat);
		const providerData = encodeGrokBuildChat({ sessionId: 'sess-old', cwd: '/tmp/proj', model: { id: 'grok-4.7' } });
		const materialized = agent.materializeChat(chat, context, providerData);
		const load = await readNextMessage(peer.outbound);
		assert.strictEqual(load.method, 'session/load');
		assert.deepStrictEqual(load.params, { sessionId: 'sess-old', cwd: '/tmp/proj', mcpServers: [] });

		pushUpdate(peer, 'sess-old', { sessionUpdate: 'user_message_chunk', messageId: 'u1', content: { type: 'text', text: 'first ' } });
		pushUpdate(peer, 'sess-old', { sessionUpdate: 'user_message_chunk', messageId: 'u1', content: { type: 'text', text: 'question' } });
		pushUpdate(peer, 'sess-old', { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'hidden thought' } });
		pushUpdate(peer, 'sess-old', { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'first answer' } });
		pushUpdate(peer, 'sess-old', { sessionUpdate: 'user_message_chunk', messageId: 'u2', content: { type: 'text', text: 'second question' } });
		pushUpdate(peer, 'sess-old', { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'second answer' } });
		pushUpdate(peer, 'sess-old', { sessionUpdate: 'session_info_update', title: 'Probe title' });
		peer.push({ jsonrpc: '2.0', id: load.id, result: {} });
		await answerSessionList(peer);
		await materialized;

		const messages = await agent.chats.getMessages(chat, context);
		assert.strictEqual(messages.length, 2);
		assert.strictEqual(messages[0].message.text, 'first question');
		assert.strictEqual(markdownOf(messages[0]), 'first answer');
		assert.strictEqual(messages[0].state, TurnState.Complete);
		assert.strictEqual(messages[1].message.text, 'second question');
		assert.strictEqual(markdownOf(messages[1]), 'second answer');
		assert.ok(!markdownOf(messages[0]).includes('hidden thought'));

		const metadata = await agent.getChatMetadata(chat, context);
		assert.strictEqual(metadata?.summary, 'Probe title');
		assert.strictEqual(metadata?.model?.id, 'grok-4.7');
		assert.strictEqual(metadata?.workingDirectories?.[0].fsPath, '/tmp/proj');

		const send = agent.chats.sendMessage(chat, 'third', [URI.file('/tmp/proj')], undefined, 'turn-3', undefined, context);
		const prompt = await readNextMessage(peer.outbound);
		assert.strictEqual(prompt.method, 'session/prompt');
		peer.push({ jsonrpc: '2.0', id: prompt.id, result: { stopReason: 'end_turn' } });
		await send;
	});

	test('getChatMetadata activation restore loads; a passive read does not connect', async () => {
		const peer = store.add(makeFakePeer());
		const client = store.add(new AcpClient(peer.transport));
		const agent = createAgent();
		agent.bindTestClient(client, LIVE_CAPABILITIES);
		const chat = URI.from({ scheme: GROK_BUILD_AGENT_PROVIDER_ID, path: '/chat/meta' });
		const context = chatContext(chat);
		const providerData = encodeGrokBuildChat({ sessionId: 'sess-meta', cwd: '/tmp/proj', model: { id: 'grok-4.7' } });

		const passive = await agent.getChatMetadata(chat, context, providerData);
		assert.strictEqual(passive?.model?.id, 'grok-4.7');
		assert.strictEqual(passive?.workingDirectories?.[0].fsPath, '/tmp/proj');
		assert.strictEqual(await readIfAny(peer.outbound), undefined);

		const restoring = agent.getChatMetadata(chat, context, providerData, { activation: 'restore' });
		const load = await readNextMessage(peer.outbound);
		assert.strictEqual(load.method, 'session/load');
		assert.strictEqual(load.params.sessionId, 'sess-meta');
		pushUpdate(peer, 'sess-meta', { sessionUpdate: 'session_info_update', title: 'Restored' });
		peer.push({ jsonrpc: '2.0', id: load.id, result: {} });
		await answerSessionList(peer);
		const metadata = await restoring;
		assert.strictEqual(metadata?.summary, 'Restored');
	});

	test('session/resume is used only when loadSession is absent and does not replay history', async () => {
		const peer = store.add(makeFakePeer());
		const client = store.add(new AcpClient(peer.transport));
		const agent = createAgent();
		agent.bindTestClient(client, { loadSession: false, sessionCapabilities: { resume: {}, close: {} } });

		const chat = URI.from({ scheme: GROK_BUILD_AGENT_PROVIDER_ID, path: '/chat/resume' });
		const context = chatContext(chat);
		const providerData = encodeGrokBuildChat({ sessionId: 'sess-resume', cwd: '/tmp/proj' });
		const materialized = agent.materializeChat(chat, context, providerData);
		const resume = await readNextMessage(peer.outbound);
		assert.strictEqual(resume.method, 'session/resume');
		assert.deepStrictEqual(resume.params, { sessionId: 'sess-resume', cwd: '/tmp/proj', mcpServers: [] });
		pushUpdate(peer, 'sess-resume', { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'should not replay' } });
		peer.push({ jsonrpc: '2.0', id: resume.id, result: {} });
		await materialized;
		assert.strictEqual((await agent.chats.getMessages(chat, context)).length, 0);

		const send = agent.chats.sendMessage(chat, 'hi', [URI.file('/tmp/proj')], undefined, 'turn-r', undefined, context);
		const prompt = await readNextMessage(peer.outbound);
		assert.strictEqual(prompt.method, 'session/prompt');
		peer.push({ jsonrpc: '2.0', id: prompt.id, result: { stopReason: 'end_turn' } });
		await send;
	});

	test('restore fails closed when neither session/load nor session/resume is advertised', async () => {
		const peer = store.add(makeFakePeer());
		const client = store.add(new AcpClient(peer.transport));
		const agent = createAgent();
		agent.bindTestClient(client, { loadSession: false, sessionCapabilities: {} });
		const chat = URI.from({ scheme: GROK_BUILD_AGENT_PROVIDER_ID, path: '/chat/norestore' });
		const context = chatContext(chat);
		const materialized = agent.materializeChat(chat, context, encodeGrokBuildChat({ sessionId: 'sess-x', cwd: '/tmp' }));
		await assert.rejects(materialized, (err: unknown) => {
			assert.ok(err instanceof Error);
			assert.strictEqual(err.message, grokCannotRestoreSessionError().message);
			return true;
		});
		assert.strictEqual(await readIfAny(peer.outbound), undefined);
	});

	test('session/list is one unfiltered page walk and discovery skips in-process sessions', async () => {
		const peer = store.add(makeFakePeer());
		const client = store.add(new AcpClient(peer.transport));
		const agent = createAgent();
		agent.bindTestClient(client, LIVE_CAPABILITIES);
		const chat = URI.from({ scheme: GROK_BUILD_AGENT_PROVIDER_ID, path: '/chat/list' });
		const context = chatContext(chat);
		const create = agent.chats.createChat(chat, context, { workingDirectories: [URI.file('/tmp/proj')] });
		const sessionNew = await readNextMessage(peer.outbound);
		peer.push({ jsonrpc: '2.0', id: sessionNew.id, result: { sessionId: 'sess-live', models: { currentModelId: 'grok-4.7', availableModels: [{ modelId: 'grok-4.7', name: 'Grok 4.7' }] } } });
		await create;

		const listed = agent.listChatsToMigrate();
		const page1 = await readNextMessage(peer.outbound);
		assert.strictEqual(page1.method, 'session/list');
		assert.deepStrictEqual(page1.params, {});
		peer.push({
			jsonrpc: '2.0',
			id: page1.id,
			result: {
				sessions: [{ sessionId: 'sess-a', cwd: '/tmp/proj', title: 'Alpha', updatedAt: '2026-01-01T00:00:00.000Z' }],
				nextCursor: 'c1',
			},
		});
		const page2 = await readNextMessage(peer.outbound);
		assert.deepStrictEqual(page2.params, { cursor: 'c1' });
		peer.push({
			jsonrpc: '2.0',
			id: page2.id,
			result: {
				sessions: [
					{ sessionId: 'sess-live', cwd: '/tmp/proj', title: 'Live' },
					{ sessionId: 'sess-b', cwd: '/tmp/proj', title: 'Beta' },
				],
				nextCursor: null,
			},
		});
		const chats = await listed;
		assert.ok(Array.isArray(chats));
		assert.deepStrictEqual(chats.map(entry => entry.summary), ['Alpha', 'Live', 'Beta']);
		assert.strictEqual(await readIfAny(peer.outbound), undefined);

		const discovered: IAgentDiscoveredChat[] = [];
		store.add(agent.onDidDiscoverChats(entries => discovered.push(...entries)));
		const discovery = agent.startChatDiscovery();
		const again1 = await readNextMessage(peer.outbound);
		assert.deepStrictEqual(again1.params, {});
		peer.push({ jsonrpc: '2.0', id: again1.id, result: { sessions: [{ sessionId: 'sess-a', cwd: '/tmp/proj', title: 'Alpha' }, { sessionId: 'sess-live', cwd: '/tmp/proj', title: 'Live' }], nextCursor: null } });
		await discovery;
		assert.deepStrictEqual(discovered.map(entry => entry.summary), ['Alpha']);
		assert.strictEqual(discovered[0].external, true);
	});

	test('session/list stops on a repeated cursor', async () => {
		const log = new CapturingLogService();
		const peer = store.add(makeFakePeer());
		const client = store.add(new AcpClient(peer.transport));
		const agent = createAgent(log);
		agent.bindTestClient(client, { loadSession: false, sessionCapabilities: { list: {} } });

		const unfiltered = agent.listChatsToMigrate();
		const first = await readNextMessage(peer.outbound);
		assert.strictEqual(first.method, 'session/list');
		assert.strictEqual(first.params.cwd, undefined);
		assert.strictEqual(first.params.cursor, undefined);
		peer.push({ jsonrpc: '2.0', id: first.id, result: { sessions: [{ sessionId: 'sess-1', cwd: '/tmp/other', title: 'One' }], nextCursor: 'c1' } });
		const second = await readNextMessage(peer.outbound);
		assert.strictEqual(second.params.cursor, 'c1');
		peer.push({ jsonrpc: '2.0', id: second.id, result: { sessions: [{ sessionId: 'sess-2', cwd: '/tmp/other', title: 'Two' }], nextCursor: 'c1' } });
		const chats = await unfiltered;
		assert.ok(Array.isArray(chats));
		assert.strictEqual(chats.length, 2);
		assert.strictEqual(await readIfAny(peer.outbound), undefined);
		assert.ok(log.warnings.some(message => /repeated cursor/.test(message)));
	});

	test('session/list is skipped when not advertised', async () => {
		const peer = store.add(makeFakePeer());
		const client = store.add(new AcpClient(peer.transport));
		const agent = createAgent();
		agent.bindTestClient(client, { loadSession: true, sessionCapabilities: {} });
		const chat = URI.from({ scheme: GROK_BUILD_AGENT_PROVIDER_ID, path: '/chat/nolist' });
		const context = chatContext(chat);
		const create = agent.chats.createChat(chat, context, { workingDirectories: [URI.file('/tmp')] });
		const sessionNew = await readNextMessage(peer.outbound);
		peer.push({ jsonrpc: '2.0', id: sessionNew.id, result: { sessionId: 'sess-nolist' } });
		await create;
		assert.deepStrictEqual(await agent.listChatsToMigrate(), []);
		assert.strictEqual(await readIfAny(peer.outbound), undefined);
	});

	test('session/list failure returns an unavailable catalog', async () => {
		const log = new CapturingLogService();
		const peer = store.add(makeFakePeer());
		const client = store.add(new AcpClient(peer.transport));
		const agent = createAgent(log);
		agent.bindTestClient(client, { loadSession: false, sessionCapabilities: { list: {} } });
		const failed = agent.listChatsToMigrate();
		const list = await readNextMessage(peer.outbound);
		peer.push({ jsonrpc: '2.0', id: list.id, error: { code: -32603, message: 'list failed' } });
		assert.strictEqual(await failed, undefined);
		assert.ok(log.warnings.some(message => /session\/list failed/.test(message)));
	});

	test('grok exit mid-turn records the failure with stderr and the next send reloads', async () => {
		const spawnedPeers = createPeerQueue();
		let spawnCount = 0;
		const agent = createAgent();
		agent.bindTestSpawn(launch => {
			spawnCount++;
			assert.deepStrictEqual([...launch.args], [...GROK_BUILD_ACP_ARGV]);
			assert.ok(!Object.keys(launch.env).some(key => key === 'ELECTRON_RUN_AS_NODE' || key.startsWith('VSCODE_')));
			const peer = store.add(makeFakePeer());
			spawnedPeers.push(peer);
			return { transport: peer.transport, child: peer.child as unknown as ChildProcessWithoutNullStreams, onDispose: () => { /* peer owned by the suite */ } };
		});

		const chat = URI.from({ scheme: GROK_BUILD_AGENT_PROVIDER_ID, path: '/chat/crash' });
		const context = chatContext(chat);
		const create = agent.chats.createChat(chat, context, { workingDirectories: [URI.file('/tmp/proj')] });
		const crashed = await spawnedPeers.next();
		await completeHandshake(crashed);
		const sessionNew = await readNextMessage(crashed.outbound);
		assert.strictEqual(sessionNew.method, 'session/new');
		assert.strictEqual(sessionNew.params.cwd, '/tmp/proj');
		peerPushSession(crashed, sessionNew.id, 'sess-crash');
		await create;

		const completePrompt = async (text: string, turnId: string) => {
			const sent = agent.chats.sendMessage(chat, text, [URI.file('/tmp/proj')], undefined, turnId, undefined, context);
			const prompt = await readNextMessage(crashed.outbound);
			assert.strictEqual(prompt.method, 'session/prompt');
			crashed.push({ jsonrpc: '2.0', id: prompt.id, result: { stopReason: 'end_turn' } });
			await sent;
		};
		await completePrompt('Reply with exactly: PONG-1', 'turn-0');
		await completePrompt('Show the environment', 'turn-1');

		const killed = 'Write the numbers from 1 to 300';
		const send = agent.chats.sendMessage(chat, killed, [URI.file('/tmp/proj')], undefined, 'turn-crash', undefined, context);
		const prompt = await readNextMessage(crashed.outbound);
		assert.strictEqual(prompt.method, 'session/prompt');
		crashed.push({
			jsonrpc: '2.0',
			id: 7,
			method: 'session/request_permission',
			params: {
				sessionId: 'sess-crash',
				toolCall: { toolCallId: 'call-crash' },
				options: LIVE_PERMISSION_OPTIONS,
			},
		});
		await new Promise(resolve => setTimeout(resolve, 20));
		crashed.writeStderr(`${'N'.repeat(5000)}TAILMARK`);
		crashed.exit(1, null);

		await assert.rejects(send, (err: unknown) => {
			assert.ok(err instanceof Error);
			assert.match(err.message, /The Grok CLI exited unexpectedly/);
			assert.match(err.message, /TAILMARK/);
			assert.ok(!/N{3000}/.test(err.message));
			return true;
		});
		assert.strictEqual(await readIfAny(crashed.outbound), undefined);

		const messages = await agent.chats.getMessages(chat, context);
		assert.strictEqual(messages.length, 3);
		assert.strictEqual(messages[2].state, TurnState.Error);
		assert.strictEqual(messages[2].message.text, killed);
		const errorPart = messages[2].responseParts.find(part => part.kind === ResponsePartKind.Error);
		assert.ok(errorPart && errorPart.kind === ResponsePartKind.Error);
		assert.strictEqual(errorPart.error.errorType, 'GrokProcessExited');
		assert.match(errorPart.error.message, /TAILMARK/);

		const sendAgain = agent.chats.sendMessage(chat, 'after crash', [URI.file('/tmp/other')], undefined, 'turn-after', undefined, context);
		const respawned = await spawnedPeers.next();
		await completeHandshake(respawned);
		const load = await readNextMessage(respawned.outbound);
		assert.strictEqual(load.method, 'session/load');
		assert.deepStrictEqual(load.params, { sessionId: 'sess-crash', cwd: '/tmp/proj', mcpServers: [] });
		pushLiveHistory(respawned, 'sess-crash', killed);
		respawned.push({ jsonrpc: '2.0', id: load.id, result: { models: { currentModelId: 'grok-4.7', availableModels: [{ modelId: 'grok-4.7', name: 'Grok 4.7' }] }, configOptions: [] } });
		await answerSessionList(respawned);
		const promptAgain = await readNextMessage(respawned.outbound);
		assert.strictEqual(promptAgain.method, 'session/prompt');
		assert.strictEqual(promptAgain.params.prompt[0].text, 'after crash');
		respawned.push({ jsonrpc: '2.0', id: promptAgain.id, result: { stopReason: 'end_turn' } });
		await sendAgain;

		const restored = await agent.chats.getMessages(chat, context);
		assert.strictEqual(restored.length, 4);
		assert.strictEqual(restored[0].message.text, 'Reply with exactly: PONG-1');
		assert.strictEqual(markdownOf(restored[0]), 'PONG-1');
		assert.strictEqual(restored[0].state, TurnState.Complete);
		assert.strictEqual(restored[1].message.text, 'Show the environment');
		assert.strictEqual(markdownOf(restored[1]), 'I\'ll run that command and show the raw output.\n\nANDROID_HOME=/opt/android');
		assert.strictEqual(restored[1].state, TurnState.Complete);
		assert.strictEqual(restored[2].message.text, killed);
		assert.strictEqual(restored[2].state, TurnState.Error);
		assert.notStrictEqual(restored[2].state, TurnState.Complete);
		assert.strictEqual(markdownOf(restored[2]), '');
		const restoredError = restored[2].responseParts.find(part => part.kind === ResponsePartKind.Error);
		assert.ok(restoredError && restoredError.kind === ResponsePartKind.Error);
		assert.match(restoredError.error.message, /TAILMARK/);
		assert.strictEqual(restored[3].message.text, 'after crash');
		assert.strictEqual(restored[3].state, TurnState.Complete);
		const metadata = await agent.getChatMetadata(chat, context);
		assert.strictEqual(metadata?.workingDirectories?.[0].fsPath, '/tmp/proj');
		assert.strictEqual(spawnCount, 2);
	});

	test('handshake failure includes the stderr tail and tears down once', async () => {
		const peer = store.add(makeFakePeer());
		let spawnCount = 0;
		let disposeCount = 0;
		const agent = createAgent();
		agent.bindTestSpawn(() => {
			spawnCount++;
			return { transport: peer.transport, child: peer.child as unknown as ChildProcessWithoutNullStreams, onDispose: () => { disposeCount++; } };
		});
		const chat = URI.from({ scheme: GROK_BUILD_AGENT_PROVIDER_ID, path: '/chat/handshake' });
		const context = chatContext(chat);
		const create = agent.chats.createChat(chat, context, { workingDirectories: [URI.file('/tmp')] });
		const init = await readNextMessage(peer.outbound);
		peer.writeStderr('handshake-boom');
		peer.push({ jsonrpc: '2.0', id: init.id, error: { code: -32603, message: 'handshake failed' } });
		await assert.rejects(create, (err: unknown) => {
			assert.ok(err instanceof Error);
			assert.match(err.message, /handshake failed/);
			assert.match(err.message, /handshake-boom/);
			return true;
		});
		assert.strictEqual(disposeCount, 1);

		const peer2 = store.add(makeFakePeer());
		agent.bindTestSpawn(() => {
			spawnCount++;
			return { transport: peer2.transport, child: peer2.child as unknown as ChildProcessWithoutNullStreams, onDispose: () => { disposeCount++; } };
		});
		const chat2 = URI.from({ scheme: GROK_BUILD_AGENT_PROVIDER_ID, path: '/chat/handshake-2' });
		const create2 = agent.chats.createChat(chat2, chatContext(chat2), { workingDirectories: [URI.file('/tmp')] });
		await completeHandshake(peer2, { loadSession: false });
		const sessionNew = await readNextMessage(peer2.outbound);
		peerPushSession(peer2, sessionNew.id, 'sess-after-handshake');
		await create2;
		assert.strictEqual(spawnCount, 2);
	});

	test('a missing or old grok binary fails before spawn with a localized message', async () => {
		const missing = createAgent();
		let missingSpawns = 0;
		missing.bindTestBinaryResolver(async () => {
			throw grokCliMissingError();
		});
		missing.bindTestSpawn(() => {
			missingSpawns++;
			throw new Error('spawned');
		});
		const chat = URI.from({ scheme: GROK_BUILD_AGENT_PROVIDER_ID, path: '/chat/missing-bin' });
		await assert.rejects(
			missing.chats.createChat(chat, chatContext(chat), { workingDirectories: [URI.file('/tmp')] }),
			(err: unknown) => {
				assert.ok(err instanceof Error);
				assert.strictEqual(err.message, grokCliMissingError().message);
				return true;
			},
		);
		assert.strictEqual(missingSpawns, 0);

		const old = createAgent();
		let oldSpawns = 0;
		old.bindTestBinaryResolver(async () => {
			throw grokVersionTooOldError('1.0.69');
		});
		old.bindTestSpawn(() => {
			oldSpawns++;
			throw new Error('spawned');
		});
		const chatOld = URI.from({ scheme: GROK_BUILD_AGENT_PROVIDER_ID, path: '/chat/old-bin' });
		await assert.rejects(
			old.chats.createChat(chatOld, chatContext(chatOld), { workingDirectories: [URI.file('/tmp')] }),
			(err: unknown) => {
				assert.ok(err instanceof Error);
				assert.strictEqual(err.message, grokVersionTooOldError('1.0.69').message);
				return true;
			},
		);
		assert.strictEqual(oldSpawns, 0);
	});

	test('spawn ENOENT and EACCES use localized messages and exit 127 does too', async () => {
		const enoent = store.add(makeFakePeer());
		const agent = createAgent();
		agent.bindTestSpawn(() => ({ transport: enoent.transport, child: enoent.child as unknown as ChildProcessWithoutNullStreams }));
		const chat = URI.from({ scheme: GROK_BUILD_AGENT_PROVIDER_ID, path: '/chat/enoent' });
		const create = agent.chats.createChat(chat, chatContext(chat), { workingDirectories: [URI.file('/tmp')] });
		await readNextMessage(enoent.outbound);
		const missing = Object.assign(new Error('spawn grok ENOENT'), { code: 'ENOENT' });
		enoent.child.emit('error', missing);
		await assert.rejects(create, (err: unknown) => {
			assert.ok(err instanceof Error);
			assert.strictEqual(err.message, grokCliMissingError().message);
			return true;
		});

		const eacces = store.add(makeFakePeer());
		const agentAccess = createAgent();
		agentAccess.bindTestSpawn(() => ({ transport: eacces.transport, child: eacces.child as unknown as ChildProcessWithoutNullStreams }));
		const createAccess = agentAccess.chats.createChat(
			URI.from({ scheme: GROK_BUILD_AGENT_PROVIDER_ID, path: '/chat/eacces' }),
			chatContext(URI.from({ scheme: GROK_BUILD_AGENT_PROVIDER_ID, path: '/chat/eacces' })),
			{ workingDirectories: [URI.file('/tmp')] },
		);
		await readNextMessage(eacces.outbound);
		eacces.child.stdin.emit('error', Object.assign(new Error('EACCES'), { code: 'EACCES' }));
		await assert.rejects(createAccess, (err: unknown) => {
			assert.ok(err instanceof Error);
			assert.strictEqual(err.message, grokCliNotExecutableError().message);
			return true;
		});

		const exited = store.add(makeFakePeer());
		const agentExit = createAgent();
		agentExit.bindTestSpawn(() => ({ transport: exited.transport, child: exited.child as unknown as ChildProcessWithoutNullStreams }));
		const createExit = agentExit.chats.createChat(
			URI.from({ scheme: GROK_BUILD_AGENT_PROVIDER_ID, path: '/chat/exit127' }),
			chatContext(URI.from({ scheme: GROK_BUILD_AGENT_PROVIDER_ID, path: '/chat/exit127' })),
			{ workingDirectories: [URI.file('/tmp')] },
		);
		await readNextMessage(exited.outbound);
		exited.exit(127, null);
		await assert.rejects(createExit, (err: unknown) => {
			assert.ok(err instanceof Error);
			assert.ok(err.message.startsWith(grokCliMissingError().message));
			return true;
		});
	});

	test('initialize timeout is localized and does not reject the abandoned request later', async () => {
		const peer = store.add(makeFakePeer());
		const agent = createAgent();
		agent.bindTestHandshakeTimeout(30);
		agent.bindTestSpawn(() => ({ transport: peer.transport, child: peer.child as unknown as ChildProcessWithoutNullStreams }));
		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown) => unhandled.push(reason);
		process.on('unhandledRejection', onUnhandled);
		try {
			const chat = URI.from({ scheme: GROK_BUILD_AGENT_PROVIDER_ID, path: '/chat/timeout' });
			await assert.rejects(
				agent.chats.createChat(chat, chatContext(chat), { workingDirectories: [URI.file('/tmp')] }),
				(err: unknown) => {
					assert.ok(err instanceof Error);
					assert.strictEqual(err.message, grokHandshakeTimeoutError('initialize').message);
					return true;
				},
			);
			await new Promise(resolve => setTimeout(resolve, 40));
			assert.deepStrictEqual(unhandled, []);
		} finally {
			process.off('unhandledRejection', onUnhandled);
		}
	});

	test('stderr and ACP payloads do not log authenticate results, skill names, or MCP names', async () => {
		const log = new CapturingLogService();
		const peer = store.add(makeFakePeer());
		const agent = createAgent(log);
		agent.bindTestSpawn(() => ({ transport: peer.transport, child: peer.child as unknown as ChildProcessWithoutNullStreams }));
		const chat = URI.from({ scheme: GROK_BUILD_AGENT_PROVIDER_ID, path: '/chat/redact' });
		const context = chatContext(chat);
		const create = agent.chats.createChat(chat, context, { workingDirectories: [URI.file('/tmp')] });
		const init = await readNextMessage(peer.outbound);
		peer.push({ jsonrpc: '2.0', id: init.id, result: { protocolVersion: 1, agentCapabilities: LIVE_CAPABILITIES } });
		const auth = await readNextMessage(peer.outbound);
		assert.strictEqual(auth.method, 'authenticate');
		peer.push({
			jsonrpc: '2.0',
			id: auth.id,
			result: { _meta: { email: 'ada@example.com', team: 'xai-team', tier: 'super' } },
		});
		const sessionNew = await readNextMessage(peer.outbound);
		peerPushSession(peer, sessionNew.id, 'sess-redact');
		await create;

		peer.pushRaw('not-json {"email":"ada@example.com","team":"xai-team","tier":"super"}\n');
		const updated = Event.toPromise(agent.onDidCustomizationsChange!);
		pushUpdate(peer, 'sess-redact', {
			sessionUpdate: 'available_commands_update',
			availableCommands: [{ name: 'secret-skill-name', description: 'hidden skill', input: null }],
		});
		await updated;
		peer.push({
			jsonrpc: '2.0',
			method: '_x.ai/mcp/server',
			params: { name: 'secret-mcp-server', serverName: 'secret-mcp-server' },
		});
		peer.writeStderr('auth {"email":"ada@example.com","team":"xai-team","tier":"super"} skill=secret-skill-name mcp=secret-mcp-server\n');
		await new Promise(resolve => setTimeout(resolve, 20));

		const secret = /ada@example\.com|xai-team|secret-skill-name|secret-mcp-server/;
		assert.ok(!secret.test(log.defaultLevelText()), log.defaultLevelText());
		assert.ok(!/ada@example\.com|xai-team|"tier"/.test(log.traces.join('\n')), log.traces.join('\n'));
		assert.ok(log.errors.some(message => message.includes('parse error on ACP line')));
		assert.ok(log.traces.some(message => message.includes('secret-skill-name') || message.includes('[GrokBuild stderr]')));

		const send = agent.chats.sendMessage(chat, 'hi', [URI.file('/tmp')], undefined, 'turn-redact', undefined, context);
		const prompt = await readNextMessage(peer.outbound);
		assert.strictEqual(prompt.method, 'session/prompt');
		peer.exit(1, null);
		await assert.rejects(send, (err: unknown) => {
			assert.ok(err instanceof Error);
			assert.ok(!/ada@example\.com|xai-team/.test(err.message));
			assert.match(err.message, /secret-skill-name/);
			return true;
		});
		assert.ok(!secret.test(log.defaultLevelText()), log.defaultLevelText());
		assert.ok(!/ada@example\.com/.test([...log.infos, ...log.warnings, ...log.errors, ...log.traces].join('\n')));
	});

	test('session/close is sent on dispose and release when advertised', async () => {
		const peer = store.add(makeFakePeer());
		const client = store.add(new AcpClient(peer.transport));
		const agent = createAgent();
		agent.bindTestClient(client, LIVE_CAPABILITIES);
		const chat = URI.from({ scheme: GROK_BUILD_AGENT_PROVIDER_ID, path: '/chat/close' });
		const context = chatContext(chat);
		const create = agent.chats.createChat(chat, context, { workingDirectories: [URI.file('/tmp')] });
		const sessionNew = await readNextMessage(peer.outbound);
		peerPushSession(peer, sessionNew.id, 'sess-close');
		await create;

		const disposed = agent.chats.disposeChat(chat, context);
		const close = await readNextMessage(peer.outbound);
		assert.strictEqual(close.method, 'session/close');
		assert.deepStrictEqual(close.params, { sessionId: 'sess-close' });
		peer.push({ jsonrpc: '2.0', id: close.id, result: { _meta: { 'x.ai/closeOutcome': 'notResident' } } });
		await disposed;

		const chat2 = URI.from({ scheme: GROK_BUILD_AGENT_PROVIDER_ID, path: '/chat/release' });
		const context2 = chatContext(chat2);
		const create2 = agent.chats.createChat(chat2, context2, { workingDirectories: [URI.file('/tmp')] });
		const sessionNew2 = await readNextMessage(peer.outbound);
		peerPushSession(peer, sessionNew2.id, 'sess-release');
		await create2;
		const released = agent.chats.releaseChat!(chat2, context2);
		const close2 = await readNextMessage(peer.outbound);
		assert.strictEqual(close2.method, 'session/close');
		assert.strictEqual(close2.params.sessionId, 'sess-release');
		peer.push({ jsonrpc: '2.0', id: close2.id, result: { _meta: { 'x.ai/closeOutcome': 'closed' } } });
		await released;
	});

	test('session/close is not sent when the capability is absent', async () => {
		const peer = store.add(makeFakePeer());
		const client = store.add(new AcpClient(peer.transport));
		const agent = createAgent();
		agent.bindTestClient(client);
		const chat = URI.from({ scheme: GROK_BUILD_AGENT_PROVIDER_ID, path: '/chat/noclose' });
		const context = chatContext(chat);
		const create = agent.chats.createChat(chat, context, { workingDirectories: [URI.file('/tmp')] });
		const sessionNew = await readNextMessage(peer.outbound);
		peerPushSession(peer, sessionNew.id, 'sess-noclose');
		await create;
		await agent.chats.disposeChat(chat, context);
		assert.strictEqual(await readIfAny(peer.outbound), undefined);
	});

	test('setWorkingDirectory rejects and sendMessage keeps the session cwd', async () => {
		const log = new CapturingLogService();
		const peer = store.add(makeFakePeer());
		const client = store.add(new AcpClient(peer.transport));
		const agent = createAgent(log);
		agent.bindTestClient(client, LIVE_CAPABILITIES);
		const chat = URI.from({ scheme: GROK_BUILD_AGENT_PROVIDER_ID, path: '/chat/cwd' });
		const context = chatContext(chat);
		const changes: string[] = [];
		store.add(agent.onDidChangeChatData(change => {
			if (change.providerData) {
				changes.push(change.providerData);
			}
		}));
		const create = agent.chats.createChat(chat, context, { workingDirectories: [URI.file('/tmp/a')] });
		const sessionNew = await readNextMessage(peer.outbound);
		assert.strictEqual(sessionNew.params.cwd, '/tmp/a');
		peerPushSession(peer, sessionNew.id, 'sess-cwd');
		await create;
		const persisted = changes.slice();

		await assert.rejects(
			agent.setWorkingDirectory(chat, context, URI.file('/tmp/b')),
			(err: unknown) => err instanceof Error && err.message === grokWorkingDirectoryRejectedError().message,
		);
		assert.strictEqual(await readIfAny(peer.outbound), undefined);
		assert.deepStrictEqual(changes, persisted);
		const metadata = await agent.getChatMetadata(chat, context);
		assert.strictEqual(metadata?.workingDirectories?.[0].fsPath, '/tmp/a');

		const send = agent.chats.sendMessage(chat, 'stay', [URI.file('/tmp/b')], undefined, 'turn-stay', undefined, context);
		const prompt = await readNextMessage(peer.outbound);
		assert.strictEqual(prompt.method, 'session/prompt');
		assert.strictEqual(prompt.params.sessionId, 'sess-cwd');
		peer.push({ jsonrpc: '2.0', id: prompt.id, result: { stopReason: 'end_turn' } });
		await send;
		assert.deepStrictEqual(changes, persisted);
		assert.ok(log.traces.some(message => /ignoring working directory/.test(message) && message.includes('/tmp/b') && message.includes('/tmp/a')));
		const after = await agent.getChatMetadata(chat, context);
		assert.strictEqual(after?.workingDirectories?.[0].fsPath, '/tmp/a');
		assert.strictEqual(await readIfAny(peer.outbound), undefined);
	});

	test('session/load replay uses live whole-message chunks and does not complete a user-only turn', async () => {
		const peer = store.add(makeFakePeer());
		const client = store.add(new AcpClient(peer.transport));
		const agent = createAgent();
		agent.bindTestClient(client, LIVE_CAPABILITIES);
		const chat = URI.from({ scheme: GROK_BUILD_AGENT_PROVIDER_ID, path: '/chat/replay' });
		const context = chatContext(chat);
		const trailing = 'Write the numbers from 1 to 300';
		const materialized = agent.materializeChat(chat, context, encodeGrokBuildChat({ sessionId: 'sess-replay', cwd: '/tmp/proj' }));
		const load = await readNextMessage(peer.outbound);
		assert.strictEqual(load.method, 'session/load');
		pushLiveHistory(peer, 'sess-replay', trailing);
		peer.push({ jsonrpc: '2.0', id: load.id, result: {} });
		await answerSessionList(peer);
		await materialized;

		const messages = await agent.chats.getMessages(chat, context);
		assert.strictEqual(messages.length, 3);
		assert.strictEqual(messages[0].state, TurnState.Complete);
		assert.strictEqual(markdownOf(messages[0]), 'PONG-1');
		assert.strictEqual(messages[1].state, TurnState.Complete);
		assert.strictEqual(markdownOf(messages[1]), 'I\'ll run that command and show the raw output.\n\nANDROID_HOME=/opt/android');
		assert.strictEqual(messages[2].message.text, trailing);
		assert.strictEqual(messages[2].state, TurnState.Cancelled);
		assert.strictEqual(markdownOf(messages[2]), '');
	});

	test('recoverLegacyChat on a fresh agent lists then loads', async () => {
		const peer = store.add(makeFakePeer());
		const agent = createAgent();
		agent.bindTestSpawn(() => ({ transport: peer.transport, onDispose: () => { /* peer owned by the suite */ } }));
		const sessionId = 'sess-fresh';
		const chat = URI.from({ scheme: GROK_BUILD_AGENT_PROVIDER_ID, path: '/chat/fresh-recover' });
		const context = chatContextForSession(chat, sessionId);
		const recovered = agent.recoverLegacyChat(chat, context);
		await completeHandshake(peer);
		const list = await readNextMessage(peer.outbound);
		assert.strictEqual(list.method, 'session/list');
		assert.deepStrictEqual(list.params, {});
		peer.push({
			jsonrpc: '2.0',
			id: list.id,
			result: { sessions: [{ sessionId, cwd: '/tmp/proj', title: 'Fresh title', updatedAt: '2026-01-02T00:00:00.000Z' }] },
		});
		const load = await readNextMessage(peer.outbound);
		assert.strictEqual(load.method, 'session/load');
		assert.deepStrictEqual(load.params, { sessionId, cwd: '/tmp/proj', mcpServers: [] });
		peer.push({
			jsonrpc: '2.0',
			id: load.id,
			result: { models: { currentModelId: 'grok-4.7', availableModels: [{ modelId: 'grok-4.7', name: 'Grok 4.7' }] }, configOptions: [] },
		});
		const result = await recovered;
		const decoded = decodeGrokBuildChat(result.providerData);
		assert.strictEqual(decoded?.sessionId, sessionId);
		assert.strictEqual(decoded?.cwd, '/tmp/proj');
		assert.strictEqual(decoded?.model?.id, 'grok-4.7');
		const metadata = await agent.getChatMetadata(chat, context);
		assert.strictEqual(metadata?.summary, 'Fresh title');
		assert.strictEqual(metadata?.model?.id, 'grok-4.7');
		assert.strictEqual(await readIfAny(peer.outbound), undefined);
	});

	test('session/load looks up a title when discovery has not run', async () => {
		const peer = store.add(makeFakePeer());
		const client = store.add(new AcpClient(peer.transport));
		const agent = createAgent();
		agent.bindTestClient(client, LIVE_CAPABILITIES);
		const chat = URI.from({ scheme: GROK_BUILD_AGENT_PROVIDER_ID, path: '/chat/list-title' });
		const context = chatContext(chat);
		const materialized = agent.materializeChat(chat, context, encodeGrokBuildChat({ sessionId: 'sess-title', cwd: '/tmp/proj' }));
		const load = await readNextMessage(peer.outbound);
		assert.strictEqual(load.method, 'session/load');
		assert.deepStrictEqual(load.params, { sessionId: 'sess-title', cwd: '/tmp/proj', mcpServers: [] });
		peer.push({
			jsonrpc: '2.0',
			id: load.id,
			result: { models: { currentModelId: 'grok-4.7', availableModels: [{ modelId: 'grok-4.7', name: 'Grok 4.7' }] } },
		});
		const list = await readNextMessage(peer.outbound);
		assert.strictEqual(list.method, 'session/list');
		assert.deepStrictEqual(list.params, {});
		peer.push({
			jsonrpc: '2.0',
			id: list.id,
			result: { sessions: [{ sessionId: 'sess-title', cwd: '/tmp/proj', title: 'From the catalog' }] },
		});
		const result = await materialized;
		assert.ok(result);
		const decoded = decodeGrokBuildChat(result.providerData);
		assert.strictEqual(decoded?.model?.id, 'grok-4.7');
		assert.strictEqual(decoded?.cwd, '/tmp/proj');
		const metadata = await agent.getChatMetadata(chat, context);
		assert.strictEqual(metadata?.summary, 'From the catalog');
		assert.strictEqual(metadata?.model?.id, 'grok-4.7');
	});

	test('recoverLegacyChat and materializeChat(undefined) load the listed cwd and title', async () => {
		const peer = store.add(makeFakePeer());
		const client = store.add(new AcpClient(peer.transport));
		const agent = createAgent();
		agent.bindTestClient(client, LIVE_CAPABILITIES);
		const sessionId = 'sess-discovered';
		const chat = URI.from({ scheme: GROK_BUILD_AGENT_PROVIDER_ID, path: '/chat/discovered' });
		const context = chatContextForSession(chat, sessionId);
		const changes: string[] = [];
		store.add(agent.onDidChangeChatData(change => {
			if (change.providerData) {
				changes.push(change.providerData);
			}
		}));

		const recovered = agent.recoverLegacyChat(chat, context);
		const list = await readNextMessage(peer.outbound);
		assert.strictEqual(list.method, 'session/list');
		assert.deepStrictEqual(list.params, {});
		peer.push({
			jsonrpc: '2.0',
			id: list.id,
			result: {
				sessions: [{ sessionId, cwd: '/tmp/proj', title: 'Exact PONG-1 Reply Request', updatedAt: '2026-01-01T00:00:00.000Z' }],
			},
		});
		const load = await readNextMessage(peer.outbound);
		assert.strictEqual(load.method, 'session/load');
		assert.deepStrictEqual(load.params, { sessionId, cwd: '/tmp/proj', mcpServers: [] });
		peer.push({ jsonrpc: '2.0', id: load.id, result: { models: { currentModelId: 'grok-4.7', availableModels: [{ modelId: 'grok-4.7', name: 'Grok 4.7' }] }, configOptions: [] } });
		const result = await recovered;
		const decoded = decodeGrokBuildChat(result.providerData);
		assert.strictEqual(decoded?.sessionId, sessionId);
		assert.strictEqual(decoded?.cwd, '/tmp/proj');
		const metadata = await agent.getChatMetadata(chat, context);
		assert.strictEqual(metadata?.summary, 'Exact PONG-1 Reply Request');
		assert.deepStrictEqual(changes, []);

		const session2 = 'sess-discovered-2';
		const chat2 = URI.from({ scheme: GROK_BUILD_AGENT_PROVIDER_ID, path: '/chat/discovered-2' });
		const context2 = chatContextForSession(chat2, session2);
		const materialized = agent.materializeChat(chat2, context2, undefined);
		const list2 = await readNextMessage(peer.outbound);
		assert.strictEqual(list2.method, 'session/list');
		assert.deepStrictEqual(list2.params, {});
		peer.push({
			jsonrpc: '2.0',
			id: list2.id,
			result: { sessions: [{ sessionId: session2, cwd: '/tmp/other', title: 'Second title' }] },
		});
		const load2 = await readNextMessage(peer.outbound);
		assert.deepStrictEqual(load2.params, { sessionId: session2, cwd: '/tmp/other', mcpServers: [] });
		peer.push({ jsonrpc: '2.0', id: load2.id, result: {} });
		const result2 = await materialized;
		assert.ok(result2);
		const decoded2 = decodeGrokBuildChat(result2.providerData);
		assert.strictEqual(decoded2?.sessionId, session2);
		assert.strictEqual(decoded2?.cwd, '/tmp/other');
		const metadata2 = await agent.getChatMetadata(chat2, context2);
		assert.strictEqual(metadata2?.summary, 'Second title');
		assert.deepStrictEqual(changes, []);
	});

	test('session/load FS_NOT_FOUND reports that the session is gone and persists nothing', async () => {
		const peer = store.add(makeFakePeer());
		const client = store.add(new AcpClient(peer.transport));
		const agent = createAgent();
		agent.bindTestClient(client, LIVE_CAPABILITIES);
		const chat = URI.from({ scheme: GROK_BUILD_AGENT_PROVIDER_ID, path: '/chat/missing' });
		const context = chatContext(chat);
		const changes: string[] = [];
		store.add(agent.onDidChangeChatData(change => {
			if (change.providerData) {
				changes.push(change.providerData);
			}
		}));
		const materialized = agent.materializeChat(chat, context, encodeGrokBuildChat({ sessionId: '00000000-0000-0000-0000-000000000000', cwd: '/tmp/proj' }));
		const load = await readNextMessage(peer.outbound);
		assert.strictEqual(load.method, 'session/load');
		assert.deepStrictEqual(load.params, { sessionId: '00000000-0000-0000-0000-000000000000', cwd: '/tmp/proj', mcpServers: [] });
		peer.push({
			jsonrpc: '2.0',
			id: load.id,
			error: { code: -32603, message: 'Path not found.', data: { detail: 'No such file or directory (os error 2)', code: 'FS_NOT_FOUND' } },
		});
		await assert.rejects(materialized, (err: unknown) => {
			assert.ok(err instanceof Error);
			assert.strictEqual(err.message, grokSessionMissingError().message);
			return true;
		});
		assert.deepStrictEqual(changes, []);
		assert.strictEqual(await agent.getChatMetadata(chat, context), undefined);
		assert.strictEqual(await readIfAny(peer.outbound), undefined);
	});

	test('session/set_model failure on create keeps the CLI default model', async () => {
		const log = new CapturingLogService();
		const peer = store.add(makeFakePeer());
		const client = store.add(new AcpClient(peer.transport));
		const agent = createAgent(log);
		agent.bindTestClient(client);
		const chat = URI.from({ scheme: GROK_BUILD_AGENT_PROVIDER_ID, path: '/chat/model-fallback' });
		const context = chatContext(chat);
		const create = agent.chats.createChat(chat, context, {
			workingDirectories: [URI.file('/tmp')],
			model: { id: 'no-such-model' },
		});
		const sessionNew = await readNextMessage(peer.outbound);
		peer.push({
			jsonrpc: '2.0',
			id: sessionNew.id,
			result: { sessionId: 'sess-fallback', models: { currentModelId: 'grok-4.7', availableModels: [{ modelId: 'grok-4.7', name: 'Grok 4.7' }] } },
		});
		const setModel = await readNextMessage(peer.outbound);
		assert.strictEqual(setModel.method, 'session/set_model');
		peer.push({ jsonrpc: '2.0', id: setModel.id, error: { code: -32602, message: 'Invalid params', data: 'unknown model id' } });
		await create;
		assert.strictEqual(agent.chats.getModel!(chat, context)?.id, 'grok-4.7');
		assert.ok(log.warnings.some(message => /session\/set_model failed/.test(message) && /unknown model id/.test(message)));
	});

	test('an unreadable grok version warns and the CLI is still started', async () => {
		const log = new CapturingLogService();
		const peer = store.add(makeFakePeer());
		const agent = createAgent(log);
		agent.bindTestSpawn(() => ({ transport: peer.transport, onDispose: () => { /* peer owned by the suite */ } }));
		agent.bindTestBinaryResolver(async () => ({ path: 'grok', versionUnreadable: true, versionOutput: 'garbage' }));
		const chat = URI.from({ scheme: GROK_BUILD_AGENT_PROVIDER_ID, path: '/chat/version' });
		const context = chatContext(chat);
		const create = agent.chats.createChat(chat, context, { workingDirectories: [URI.file('/tmp')] });
		await completeHandshake(peer, { loadSession: false });
		const sessionNew = await readNextMessage(peer.outbound);
		peerPushSession(peer, sessionNew.id, 'sess-version');
		await create;
		assert.ok(log.warnings.some(message => message === grokUnreadableVersionWarning('garbage')));
	});

	test('mergeRestoredTurns keeps a promptIndex match only when the user text matches', () => {
		const merged = mergeRestoredTurns(
			[{ id: 'bad', userText: 'fail this', assistantMarkdown: '', state: TurnState.Error, errorMessage: 'prompt failed', promptIndex: 0 }],
			[
				{ id: 'r0', userText: 'other turn', assistantMarkdown: 'ok', promptIndex: 0 },
				{ id: 'r1', userText: 'fail this', assistantMarkdown: '', promptIndex: 3 },
			],
		);
		assert.deepStrictEqual({
			first: { text: merged[0].userText, state: merged[0].state, promptIndex: merged[0].promptIndex },
			second: { text: merged[1].userText, state: merged[1].state, promptIndex: merged[1].promptIndex, error: merged[1].errorMessage },
		}, {
			first: { text: 'other turn', state: TurnState.Complete, promptIndex: 0 },
			second: { text: 'fail this', state: TurnState.Error, promptIndex: 3, error: 'prompt failed' },
		});
	});

	test('session/prompt error while grok is alive records no promptIndex and the next load adopts grok index', async () => {
		const peer = store.add(makeFakePeer());
		const client = store.add(new AcpClient(peer.transport));
		const agent = createAgent();
		agent.bindTestClient(client, LIVE_CAPABILITIES);
		const chat = URI.from({ scheme: GROK_BUILD_AGENT_PROVIDER_ID, path: '/chat/prompt-error' });
		const context = chatContext(chat);
		const create = agent.chats.createChat(chat, context, { workingDirectories: [URI.file('/tmp/proj')] });
		const sessionNew = await readNextMessage(peer.outbound);
		peer.push({ jsonrpc: '2.0', id: sessionNew.id, result: { sessionId: 'sess-prompt-error' } });
		await create;

		const send = agent.chats.sendMessage(chat, 'fail this', [URI.file('/tmp/proj')], undefined, 'turn-fail', undefined, context);
		const prompt = await readNextMessage(peer.outbound);
		assert.strictEqual(prompt.method, 'session/prompt');
		peer.push({ jsonrpc: '2.0', id: prompt.id, error: { code: -32603, message: 'prompt failed' } });
		await assert.rejects(send, /prompt failed/);
		const failed = await agent.chats.getMessages(chat, context);
		assert.strictEqual(failed.length, 1);
		assert.strictEqual(failed[0].state, TurnState.Error);
		assert.strictEqual(failed[0].message.text, 'fail this');

		const peer2 = store.add(makeFakePeer());
		const client2 = store.add(new AcpClient(peer2.transport));
		agent.bindTestClient(client2, LIVE_CAPABILITIES);
		const restoring = agent.getChatMetadata(chat, context, undefined, { activation: 'restore' });
		const load = await readNextMessage(peer2.outbound);
		assert.strictEqual(load.method, 'session/load');
		pushUpdate(peer2, 'sess-prompt-error', { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'other turn' }, _meta: { promptIndex: 0 } });
		pushUpdate(peer2, 'sess-prompt-error', { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ok' }, _meta: { promptIndex: 0 } });
		pushUpdate(peer2, 'sess-prompt-error', { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'fail this' }, _meta: { promptIndex: 3 } });
		peer2.push({ jsonrpc: '2.0', id: load.id, result: { configOptions: [] } });
		await answerSessionList(peer2);
		await restoring;
		const restored = await agent.chats.getMessages(chat, context);
		assert.deepStrictEqual(restored.map(turn => ({ text: turn.message.text, state: turn.state })), [
			{ text: 'other turn', state: TurnState.Complete },
			{ text: 'fail this', state: TurnState.Error },
		]);
	});

	test('reasoning effort is a model parameter applied with session/set_config_option and reapplied after load', async () => {
		const peer = store.add(makeFakePeer());
		const client = store.add(new AcpClient(peer.transport));
		const agent = createAgent();
		const blobs: string[] = [];
		store.add(agent.onDidChangeChatData(event => {
			if (event.providerData) {
				blobs.push(event.providerData);
			}
		}));
		agent.bindTestClient(client, LIVE_CAPABILITIES);
		const chat = URI.from({ scheme: GROK_BUILD_AGENT_PROVIDER_ID, path: '/chat/effort' });
		const context = chatContext(chat);
		const configOptions = [{
			id: 'reasoning_effort',
			name: 'Reasoning Effort',
			category: 'thought_level',
			type: 'select',
			currentValue: 'high',
			options: [
				{ value: 'xhigh', name: 'Extra High' },
				{ value: 'high', name: 'High' },
				{ value: 'medium', name: 'Medium' },
				{ value: 'low', name: 'Low' },
			],
		}];
		const create = agent.chats.createChat(chat, context, { workingDirectories: [URI.file('/tmp/proj')] });
		const sessionNew = await readNextMessage(peer.outbound);
		peer.push({
			jsonrpc: '2.0',
			id: sessionNew.id,
			result: {
				sessionId: 'sess-effort',
				models: { currentModelId: 'grok-4.7', availableModels: [{ modelId: 'grok-4.7', name: 'Grok 4.7' }] },
				configOptions,
			},
		});
		await create;
		const schema = agent.models.get()[0]?.configSchema?.properties[GROK_THINKING_LEVEL_KEY];
		assert.deepStrictEqual(schema?.enum, ['xhigh', 'high', 'medium', 'low']);
		assert.strictEqual(schema?.default, 'high');

		const change = agent.chats.changeModel!(chat, { id: 'grok-4.7', config: { [GROK_THINKING_LEVEL_KEY]: 'low' } }, context);
		const setModel = await readNextMessage(peer.outbound);
		assert.strictEqual(setModel.method, 'session/set_model');
		peer.push({ jsonrpc: '2.0', id: setModel.id, result: {} });
		const setConfig = await readNextMessage(peer.outbound);
		assert.deepStrictEqual(setConfig.params, { sessionId: 'sess-effort', configId: 'reasoning_effort', value: 'low' });
		peer.push({ jsonrpc: '2.0', id: setConfig.id, result: {} });
		await change;
		const persisted = decodeGrokBuildChat(blobs.at(-1));
		assert.strictEqual(persisted?.reasoningEffort, 'low');
		assert.strictEqual(persisted?.model?.config?.[GROK_THINKING_LEVEL_KEY], 'low');

		const peer2 = store.add(makeFakePeer());
		const client2 = store.add(new AcpClient(peer2.transport));
		agent.bindTestClient(client2, LIVE_CAPABILITIES);
		const restoring = agent.getChatMetadata(chat, context, undefined, { activation: 'restore' });
		const load = await readNextMessage(peer2.outbound);
		assert.strictEqual(load.method, 'session/load');
		peer2.push({
			jsonrpc: '2.0',
			id: load.id,
			result: { configOptions: [{ ...configOptions[0], currentValue: 'high' }] },
		});
		await answerSessionList(peer2);
		const reapply = await readNextMessage(peer2.outbound);
		assert.deepStrictEqual(reapply.params, { sessionId: 'sess-effort', configId: 'reasoning_effort', value: 'low' });
		peer2.push({ jsonrpc: '2.0', id: reapply.id, result: {} });
		await restoring;

		const peer3 = store.add(makeFakePeer());
		const client3 = store.add(new AcpClient(peer3.transport));
		agent.bindTestClient(client3, LIVE_CAPABILITIES);
		const restoringMatch = agent.getChatMetadata(chat, context, undefined, { activation: 'restore' });
		const loadMatch = await readNextMessage(peer3.outbound);
		peer3.push({
			jsonrpc: '2.0',
			id: loadMatch.id,
			result: { configOptions: [{ ...configOptions[0], currentValue: 'low' }] },
		});
		await answerSessionList(peer3);
		assert.strictEqual(await readIfAny(peer3.outbound), undefined);
		await restoringMatch;
	});

	test('available commands become slash skills and the selected command is prompt text', async () => {
		const peer = store.add(makeFakePeer());
		const client = store.add(new AcpClient(peer.transport));
		const agent = createAgent();
		agent.bindTestClient(client);
		const chat = URI.from({ scheme: GROK_BUILD_AGENT_PROVIDER_ID, path: '/chat/commands' });
		const context = chatContext(chat);
		const create = agent.chats.createChat(chat, context, { workingDirectories: [URI.file('/tmp')] });
		const sessionNew = await readNextMessage(peer.outbound);
		peer.push({ jsonrpc: '2.0', id: sessionNew.id, result: { sessionId: 'sess-commands' } });
		await create;

		const rejectSlash = async (text: string, name: string) => {
			await assert.rejects(
				agent.chats.sendMessage(chat, text, [URI.file('/tmp')], undefined, 'turn-blocked', undefined, context),
				(err: unknown) => {
					assert.ok(err instanceof Error);
					assert.strictEqual(err.message, grokSlashCommandRejectedError(name).message);
					return true;
				},
			);
			assert.strictEqual(await readIfAny(peer.outbound), undefined);
		};
		await assert.rejects(
			agent.chats.sendMessage(chat, '/compact', [URI.file('/tmp')], undefined, 'turn-blocked', undefined, context),
			(err: unknown) => {
				assert.ok(err instanceof Error);
				assert.strictEqual(err.message, grokSlashCommandsUnavailableError().message);
				return true;
			},
		);
		assert.strictEqual(await readIfAny(peer.outbound), undefined);
		await assert.rejects(
			agent.chats.sendMessage(chat, '/Users/x/a.ts explain', [URI.file('/tmp')], undefined, 'turn-path', undefined, context),
			(err: unknown) => {
				assert.ok(err instanceof Error);
				assert.strictEqual(err.message, grokPathPrefixRejectedError().message);
				return true;
			},
		);
		assert.strictEqual(await readIfAny(peer.outbound), undefined);

		const denied = ['always-approve', 'yolo', 'auto', 'plugins', 'plugin', 'reload-plugins', 'feedback', 'statusline', 'hooks-trust', 'hooks-add', 'settings', 'YOLO'];
		const updated = Event.toPromise(agent.onDidCustomizationsChange!);
		pushUpdate(peer, 'sess-commands', {
			sessionUpdate: 'available_commands_update',
			availableCommands: [
				{ name: 'compact', description: 'Compact the conversation', input: { hint: 'instructions' } },
				{ name: 'review', description: 'Review the change', input: null },
				{ name: 'bundled:imagine', description: 'Imagine', input: null },
				{ name: 'yolo:on', description: 'must stay hidden', input: null },
				...denied.map(name => ({ name, description: name, input: null })),
			],
		});
		await updated;
		const customizations = await agent.getChatCustomizations(chat, context, []);
		const directory = customizations.find(entry => entry.type === 'directory');
		assert.ok(directory && directory.type === 'directory');
		assert.deepStrictEqual(directory.children?.map(child => ({ name: child.name, description: child.type === CustomizationType.Skill ? child.description : undefined })), [
			{ name: 'compact', description: 'Compact the conversation (instructions)' },
			{ name: 'review', description: 'Review the change' },
			{ name: 'bundled:imagine', description: 'Imagine' },
		]);

		await rejectSlash('/yolo', 'yolo');
		await rejectSlash('/YOLO', 'YOLO');
		await rejectSlash('  /yolo', 'yolo');
		await rejectSlash('/yolo:on', 'yolo');
		await rejectSlash('/always-approve on', 'always-approve');
		await rejectSlash('/always-approve:on', 'always-approve');
		await rejectSlash('/plugins trust', 'plugins');
		await rejectSlash('/auto', 'auto');
		await rejectSlash('/foo', 'foo');
		await assert.rejects(
			agent.chats.sendMessage(chat, '/Users/x/a.ts explain', [URI.file('/tmp')], undefined, 'turn-path-2', undefined, context),
			(err: unknown) => {
				assert.ok(err instanceof Error);
				assert.strictEqual(err.message, grokPathPrefixRejectedError().message);
				return true;
			},
		);
		assert.strictEqual(await readIfAny(peer.outbound), undefined);

		pushUpdate(peer, 'sess-commands', {
			sessionUpdate: 'available_commands_update',
			availableCommands: '<redacted 63 commands>',
		});
		await new Promise(resolve => setTimeout(resolve, 20));
		const afterRedaction = await agent.getChatCustomizations(chat, context, []);
		assert.strictEqual(afterRedaction.find(entry => entry.type === 'directory')?.type, 'directory');

		for (const text of ['/compact now', '/bundled:imagine', '/Bundled:Imagine draw', 'note\n/always-approve', 'hello']) {
			const send = agent.chats.sendMessage(chat, text, [URI.file('/tmp')], undefined, 'turn-cmd', undefined, context);
			const prompt = await readNextMessage(peer.outbound);
			assert.strictEqual(prompt.method, 'session/prompt');
			assert.strictEqual(prompt.params.prompt[0].text, text);
			peer.push({ jsonrpc: '2.0', id: prompt.id, result: { stopReason: 'end_turn' } });
			await send;
		}
	});

	test('ACP plan updates become todo tool calls and plan mode uses session/set_mode', async () => {
		const configEmitter = store.add(new Emitter<IAgentChatConfigurationChangeEvent>());
		const peer = store.add(makeFakePeer());
		const client = store.add(new AcpClient(peer.transport));
		const agent = createAgent(new NullLogService(), { onDidChatConfigChange: configEmitter.event });
		agent.bindTestClient(client);
		const chat = URI.from({ scheme: GROK_BUILD_AGENT_PROVIDER_ID, path: '/chat/plan' });
		const context = chatContext(chat);
		const signals: AgentSignal[] = [];
		store.add(agent.onDidChatProgress(signal => signals.push(signal)));
		const create = agent.chats.createChat(chat, context, { workingDirectories: [URI.file('/tmp')] });
		const sessionNew = await readNextMessage(peer.outbound);
		peer.push({ jsonrpc: '2.0', id: sessionNew.id, result: { sessionId: 'sess-plan' } });
		await create;

		const send = agent.chats.sendMessage(chat, 'plan this', [URI.file('/tmp')], undefined, 'turn-plan', undefined, context);
		const prompt = await readNextMessage(peer.outbound);
		pushUpdate(peer, 'sess-plan', {
			sessionUpdate: 'plan',
			entries: [
				{ content: 'Write tests', priority: 'high', status: 'in_progress' },
				{ content: 'Ship it', priority: 'low', status: 'pending' },
			],
		});
		peer.push({ jsonrpc: '2.0', id: prompt.id, result: { stopReason: 'end_turn' } });
		await send;
		const start = signals.find(signal => signal.kind === 'action' && signal.action.type === ActionType.ChatToolCallStart && signal.action.toolName === 'manage_todo_list');
		if (!(start && start.kind === 'action' && start.action.type === ActionType.ChatToolCallStart)) {
			assert.fail('missing todo tool call');
		}
		const startAction = start.action;
		const ready = signals.find(signal => signal.kind === 'action' && signal.action.type === ActionType.ChatToolCallReady && signal.action.toolCallId === startAction.toolCallId);
		if (!(ready && ready.kind === 'action' && ready.action.type === ActionType.ChatToolCallReady)) {
			assert.fail('missing todo tool input');
		}
		assert.deepStrictEqual(JSON.parse(String(ready.action.toolInput)), {
			todoList: [
				{ id: '1', title: 'Write tests', status: 'in-progress' },
				{ id: '2', title: 'Ship it', status: 'not-started' },
			],
		});

		const owner = context.owner.get().toString();
		configEmitter.fire({ session: owner, chat: chat.toString(), config: { [SessionConfigKey.Mode]: 'plan' }, origin: undefined });
		const setMode = await readNextMessage(peer.outbound);
		assert.deepStrictEqual({ method: setMode.method, params: setMode.params }, {
			method: 'session/set_mode',
			params: { sessionId: 'sess-plan', modeId: 'plan' },
		});
		peer.push({ jsonrpc: '2.0', id: setMode.id, result: {} });
		configEmitter.fire({ session: owner, chat: chat.toString(), config: { [SessionConfigKey.Mode]: 'interactive' }, origin: undefined });
		const leave = await readNextMessage(peer.outbound);
		assert.deepStrictEqual(leave.params, { sessionId: 'sess-plan', modeId: 'default' });
		peer.push({ jsonrpc: '2.0', id: leave.id, result: {} });
	});

	test('plan mode is sent again after grok restarts, before the prompt', async () => {
		const peer = store.add(makeFakePeer());
		const client = store.add(new AcpClient(peer.transport));
		const agent = createAgent(new NullLogService(), {
			getChatConfigValues: () => ({ [SessionConfigKey.Mode]: 'plan' }),
		});
		agent.bindTestClient(client);
		const chat = URI.from({ scheme: GROK_BUILD_AGENT_PROVIDER_ID, path: '/chat/plan-restart' });
		const context = chatContext(chat);
		const create = agent.chats.createChat(chat, context, {
			workingDirectories: [URI.file('/tmp')],
			config: { [SessionConfigKey.Mode]: 'plan' },
		});
		const sessionNew = await readNextMessage(peer.outbound);
		peer.push({ jsonrpc: '2.0', id: sessionNew.id, result: { sessionId: 'sess-plan-restart' } });
		const setMode = await readNextMessage(peer.outbound);
		assert.deepStrictEqual(setMode.params, { sessionId: 'sess-plan-restart', modeId: 'plan' });
		peer.push({ jsonrpc: '2.0', id: setMode.id, result: {} });
		await create;

		const peer2 = store.add(makeFakePeer());
		const client2 = store.add(new AcpClient(peer2.transport));
		agent.bindTestClient(client2, LIVE_CAPABILITIES);
		const send = agent.chats.sendMessage(chat, 'continue', [URI.file('/tmp')], undefined, 'turn-plan-restart', undefined, context);
		const load = await readNextMessage(peer2.outbound);
		assert.strictEqual(load.method, 'session/load');
		peer2.push({ jsonrpc: '2.0', id: load.id, result: {} });
		await answerSessionList(peer2);
		const setModeAgain = await readNextMessage(peer2.outbound);
		assert.deepStrictEqual(setModeAgain.params, { sessionId: 'sess-plan-restart', modeId: 'plan' });
		peer2.push({ jsonrpc: '2.0', id: setModeAgain.id, result: {} });
		const prompt = await readNextMessage(peer2.outbound);
		assert.strictEqual(prompt.method, 'session/prompt');
		peer2.push({ jsonrpc: '2.0', id: prompt.id, result: { stopReason: 'end_turn' } });
		await send;
	});

	test('a failed plan mode switch after reload fails the prompt', async () => {
		const peer = store.add(makeFakePeer());
		const client = store.add(new AcpClient(peer.transport));
		const agent = createAgent(new NullLogService(), {
			getChatConfigValues: () => ({ [SessionConfigKey.Mode]: 'plan' }),
		});
		agent.bindTestClient(client);
		const chat = URI.from({ scheme: GROK_BUILD_AGENT_PROVIDER_ID, path: '/chat/plan-fail' });
		const context = chatContext(chat);
		const create = agent.chats.createChat(chat, context, {
			workingDirectories: [URI.file('/tmp')],
			config: { [SessionConfigKey.Mode]: 'plan' },
		});
		const sessionNew = await readNextMessage(peer.outbound);
		peer.push({ jsonrpc: '2.0', id: sessionNew.id, result: { sessionId: 'sess-plan-fail' } });
		const setMode = await readNextMessage(peer.outbound);
		peer.push({ jsonrpc: '2.0', id: setMode.id, result: {} });
		await create;

		const peer2 = store.add(makeFakePeer());
		const client2 = store.add(new AcpClient(peer2.transport));
		agent.bindTestClient(client2, LIVE_CAPABILITIES);
		const send = agent.chats.sendMessage(chat, 'continue', [URI.file('/tmp')], undefined, 'turn-plan-fail', undefined, context);
		const load = await readNextMessage(peer2.outbound);
		assert.strictEqual(load.method, 'session/load');
		peer2.push({ jsonrpc: '2.0', id: load.id, result: {} });
		await answerSessionList(peer2);
		const setModeAgain = await readNextMessage(peer2.outbound);
		assert.strictEqual(setModeAgain.method, 'session/set_mode');
		peer2.push({ jsonrpc: '2.0', id: setModeAgain.id, error: { code: -32603, message: 'mode rejected' } });
		await assert.rejects(send, (err: unknown) => {
			assert.ok(err instanceof Error);
			assert.strictEqual(err.message, grokPlanModeFailedError().message);
			return true;
		});
		assert.strictEqual(await readIfAny(peer2.outbound), undefined);
	});

	test('subagent tool kinds render as task calls and shell does not', async () => {
		const peer = store.add(makeFakePeer());
		const client = store.add(new AcpClient(peer.transport));
		const agent = createAgent();
		agent.bindTestClient(client);
		const chat = URI.from({ scheme: GROK_BUILD_AGENT_PROVIDER_ID, path: '/chat/sub' });
		const context = chatContext(chat);
		const signals: AgentSignal[] = [];
		store.add(agent.onDidChatProgress(signal => signals.push(signal)));
		const create = agent.chats.createChat(chat, context, { workingDirectories: [URI.file('/tmp')] });
		const sessionNew = await readNextMessage(peer.outbound);
		peer.push({ jsonrpc: '2.0', id: sessionNew.id, result: { sessionId: 'sess-sub' } });
		await create;
		const send = agent.chats.sendMessage(chat, 'delegate', [URI.file('/tmp')], undefined, 'turn-sub', undefined, context);
		const prompt = await readNextMessage(peer.outbound);
		pushUpdate(peer, 'sess-sub', {
			sessionUpdate: 'tool_call',
			toolCallId: 'sub-1',
			status: 'completed',
			title: 'Research',
			rawInput: { prompt: 'look around' },
			_meta: { 'x.ai/tool': { name: 'spawn_subagent', kind: 'subagent', label: 'Research' } },
		});
		pushUpdate(peer, 'sess-sub', {
			sessionUpdate: 'tool_call',
			toolCallId: 'shell-1',
			status: 'completed',
			title: 'Run',
			kind: 'execute',
			_meta: { 'x.ai/tool': { name: 'bash', kind: 'execute', label: 'Run' } },
		});
		peer.push({ jsonrpc: '2.0', method: '_x.ai/hook', params: { hookEventName: 'subagent_stop' } });
		peer.push({ jsonrpc: '2.0', id: prompt.id, result: { stopReason: 'end_turn' } });
		await send;
		const starts = signals.filter(signal => signal.kind === 'action' && signal.action.type === ActionType.ChatToolCallStart);
		assert.deepStrictEqual(starts.map(signal => {
			const action = signal.kind === 'action' && signal.action.type === ActionType.ChatToolCallStart ? signal.action : undefined;
			return { toolName: action?.toolName, toolKind: action?._meta?.toolKind };
		}), [
			{ toolName: 'task', toolKind: 'subagent' },
			{ toolName: 'shell', toolKind: undefined },
		]);
	});

	test('the default permission preset never auto-answers and allow-edits selects allow-once', async () => {
		const peer = store.add(makeFakePeer());
		const client = store.add(new AcpClient(peer.transport));
		const agent = createAgent();
		agent.bindTestClient(client);
		const chat = URI.from({ scheme: GROK_BUILD_AGENT_PROVIDER_ID, path: '/chat/preset-ask' });
		const context = chatContext(chat);
		const create = agent.chats.createChat(chat, context, { workingDirectories: [URI.file('/tmp')] });
		const sessionNew = await readNextMessage(peer.outbound);
		peer.push({ jsonrpc: '2.0', id: sessionNew.id, result: { sessionId: 'sess-ask' } });
		await create;
		const send = agent.chats.sendMessage(chat, 'edit', [URI.file('/tmp')], undefined, 'turn-ask', undefined, context);
		const prompt = await readNextMessage(peer.outbound);
		peer.push({
			jsonrpc: '2.0',
			id: 7,
			method: 'session/request_permission',
			params: {
				sessionId: 'sess-ask',
				toolCall: { toolCallId: 'edit-1', kind: 'edit', _meta: { 'x.ai/tool': { name: 'search_replace', kind: 'edit' } } },
				options: LIVE_PERMISSION_OPTIONS,
			},
		});
		assert.strictEqual(await readIfAny(peer.outbound), undefined);
		agent.respondToPermissionRequest('edit-1', true);
		const decision = await readNextMessage(peer.outbound);
		assert.deepStrictEqual(decision.result, { outcome: { outcome: 'selected', optionId: 'allow-once' } });
		peer.push({ jsonrpc: '2.0', id: prompt.id, result: { stopReason: 'end_turn' } });
		await send;

		const allowPeer = store.add(makeFakePeer());
		const allowClient = store.add(new AcpClient(allowPeer.transport));
		let preset: Record<string, unknown> = { [GROK_PERMISSION_PRESET_KEY]: GROK_PERMISSION_PRESET_ALLOW_EDITS };
		const allowAgent = createAgent(new NullLogService(), {
			getChatConfigValues: () => preset,
		});
		allowAgent.bindTestClient(allowClient);
		const allowChat = URI.from({ scheme: GROK_BUILD_AGENT_PROVIDER_ID, path: '/chat/preset-edits' });
		const allowContext = chatContext(allowChat);
		const allowCreate = allowAgent.chats.createChat(allowChat, allowContext, { workingDirectories: [URI.file('/tmp')] });
		const allowNew = await readNextMessage(allowPeer.outbound);
		allowPeer.push({ jsonrpc: '2.0', id: allowNew.id, result: { sessionId: 'sess-edits' } });
		await allowCreate;
		const allowSend = allowAgent.chats.sendMessage(allowChat, 'edit', [URI.file('/tmp')], undefined, 'turn-edits', undefined, allowContext);
		const allowPrompt = await readNextMessage(allowPeer.outbound);
		allowPeer.push({
			jsonrpc: '2.0',
			id: 8,
			method: 'session/request_permission',
			params: {
				sessionId: 'sess-edits',
				toolCall: { toolCallId: 'edit-2', kind: 'edit', _meta: { 'x.ai/tool': { name: 'search_replace', kind: 'edit' } } },
				options: LIVE_PERMISSION_OPTIONS,
			},
		});
		const auto = await readNextMessage(allowPeer.outbound);
		assert.deepStrictEqual(auto.result, { outcome: { outcome: 'selected', optionId: 'allow-once' } });
		allowPeer.push({
			jsonrpc: '2.0',
			id: 10,
			method: 'session/request_permission',
			params: {
				sessionId: 'sess-edits',
				toolCall: { toolCallId: 'edit-no-once', kind: 'edit', _meta: { 'x.ai/tool': { name: 'search_replace', kind: 'edit' } } },
				options: [LIVE_PERMISSION_OPTIONS[0], LIVE_PERMISSION_OPTIONS[2]],
			},
		});
		assert.strictEqual(await readIfAny(allowPeer.outbound), undefined);
		allowAgent.respondToPermissionRequest('edit-no-once', false);
		const missingOnce = await readNextMessage(allowPeer.outbound);
		assert.deepStrictEqual(missingOnce.result, { outcome: { outcome: 'selected', optionId: 'reject-once' } });
		allowPeer.push({
			jsonrpc: '2.0',
			id: 9,
			method: 'session/request_permission',
			params: {
				sessionId: 'sess-edits',
				toolCall: { toolCallId: 'shell-2', kind: 'execute', _meta: { 'x.ai/tool': { name: 'bash', kind: 'execute' } } },
				options: [
					{ optionId: 'always-allow', name: 'Always allow', kind: 'allow_always' },
					{ optionId: 'allow-once', name: 'Yes', kind: 'allow_once' },
					{ optionId: 'reject-once', name: 'No', kind: 'reject_once' },
				],
			},
		});
		assert.strictEqual(await readIfAny(allowPeer.outbound), undefined);
		allowAgent.respondToPermissionRequest('shell-2', false);
		const shellDecision = await readNextMessage(allowPeer.outbound);
		assert.deepStrictEqual(shellDecision.result, { outcome: { outcome: 'selected', optionId: 'reject-once' } });
		preset = { [GROK_PERMISSION_PRESET_KEY]: GROK_PERMISSION_PRESET_ASK };
		allowPeer.push({
			jsonrpc: '2.0',
			id: 11,
			method: 'session/request_permission',
			params: {
				sessionId: 'sess-edits',
				toolCall: { toolCallId: 'edit-3', kind: 'edit', _meta: { 'x.ai/tool': { name: 'search_replace', kind: 'edit' } } },
				options: LIVE_PERMISSION_OPTIONS,
			},
		});
		assert.strictEqual(await readIfAny(allowPeer.outbound), undefined);
		allowAgent.respondToPermissionRequest('edit-3', true);
		const asked = await readNextMessage(allowPeer.outbound);
		assert.deepStrictEqual(asked.result, { outcome: { outcome: 'selected', optionId: 'allow-once' } });
		allowPeer.push({ jsonrpc: '2.0', id: allowPrompt.id, result: { stopReason: 'end_turn' } });
		await allowSend;
	});
});

async function answerSessionList(peer: IFakePeer, sessions: readonly object[] = []): Promise<void> {
	const list = await readNextMessage(peer.outbound);
	assert.strictEqual(list.method, 'session/list');
	peer.push({ jsonrpc: '2.0', id: list.id, result: { sessions } });
}

function pushLiveHistory(peer: IFakePeer, sessionId: string, trailingUser: string): void {
	const user = (promptIndex: number, text: string) => pushUpdate(peer, sessionId, {
		sessionUpdate: 'user_message_chunk',
		content: { type: 'text', text },
		_meta: { modelId: 'grok-4.7', promptIndex },
	});
	const agentText = (promptIndex: number, text: string) => pushUpdate(peer, sessionId, {
		sessionUpdate: 'agent_message_chunk',
		content: { type: 'text', text },
		_meta: { modelId: 'grok-4.7', promptIndex },
	});
	user(0, 'Reply with exactly: PONG-1');
	agentText(0, 'PONG-1');
	user(1, 'Show the environment');
	agentText(1, 'I\'ll run that command and show the raw output.');
	pushUpdate(peer, sessionId, {
		sessionUpdate: 'tool_call',
		toolCallId: 'call-1',
		title: 'run_terminal_command',
		kind: 'execute',
		status: 'completed',
		rawInput: { command: 'env' },
		rawOutput: 'ANDROID_HOME=/opt/android',
		_meta: { 'x.ai/tool': { name: 'run_terminal_command', kind: 'execute', label: 'Run Command' } },
	});
	agentText(1, 'ANDROID_HOME=/opt/android');
	user(2, trailingUser);
}

function peerPushSession(peer: IFakePeer, id: number, sessionId: string): void {
	peer.push({
		jsonrpc: '2.0',
		id,
		result: { sessionId, models: { currentModelId: 'grok-4.7', availableModels: [{ modelId: 'grok-4.7', name: 'Grok 4.7' }] } },
	});
}

function restoreEnv(key: string, value: string | undefined): void {
	if (value === undefined) {
		delete process.env[key];
	} else {
		process.env[key] = value;
	}
}

function createPeerQueue(): { push(peer: IFakePeer): void; next(): Promise<IFakePeer> } {
	const queued: IFakePeer[] = [];
	const waiters: DeferredPromise<IFakePeer>[] = [];
	return {
		push(peer) {
			const waiter = waiters.shift();
			if (waiter) {
				waiter.complete(peer);
			} else {
				queued.push(peer);
			}
		},
		next() {
			const peer = queued.shift();
			if (peer) {
				return Promise.resolve(peer);
			}
			const waiter = new DeferredPromise<IFakePeer>();
			waiters.push(waiter);
			return waiter.p;
		},
	};
}
