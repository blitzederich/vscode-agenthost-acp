/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import { Emitter } from '../../../../../base/common/event.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../log/common/log.js';
import { fixedChatOwnerRef, GROK_BUILD_AGENT_PROVIDER_ID, type AgentSignal, type IAgentChatContext, type IAgentDiscoveredChat } from '../../../common/agent.js';
import { ActionType } from '../../../common/state/sessionActions.js';
import { ResponsePartKind, TurnState, type Turn } from '../../../common/state/sessionState.js';
import {
	AcpClient,
	type IAcpTransport,
} from '../../../node/grokBuild/acpClient.js';
import { encodeGrokBuildChat } from '../../../node/grokBuild/grokBuildChatBacking.js';
import { GrokBuildAgent } from '../../../node/grokBuild/grokBuildAgent.js';
import { GROK_BUILD_ACP_ARGV, grokCannotRestoreSessionError, grokNotLoggedInError, grokUnreadableVersionWarning, grokWorkingDirectoryBusyError, grokWorkingDirectoryRejectedError } from '../../../node/grokBuild/grokBuildLaunchConfig.js';
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
	readonly child: IFakeChild;
	push(message: object): void;
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
	readonly warnings: string[] = [];
	readonly errors: string[] = [];
	override warn(message: string): void {
		this.warnings.push(message);
	}
	override error(message: string | Error): void {
		this.errors.push(message instanceof Error ? message.message : message);
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

const LIVE_PERMISSION_OPTIONS = [
	{ optionId: 'allow-edits-session', name: 'Yes, allow all edits during this session', kind: 'allow_always' },
	{ optionId: 'allow-once', name: 'Yes', kind: 'allow_once' },
	{ optionId: 'reject-once', name: 'No, and tell Grok what to do differently', kind: 'reject_once' },
] as const;

suite('GrokBuildAgent', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function createAgent(log: NullLogService = new NullLogService()): GrokBuildAgent {
		return store.add(new GrokBuildAgent(log, new TestProductService() as any));
	}

	test('descriptor uses Grok Build label and provider id', () => {
		const agent = createAgent();
		assert.strictEqual(agent.id, GROK_BUILD_AGENT_PROVIDER_ID);
		const descriptor = agent.getDescriptor();
		assert.strictEqual(descriptor.provider, GROK_BUILD_AGENT_PROVIDER_ID);
		assert.strictEqual(descriptor.displayName, 'Grok Build');
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
		assert.ok(created && 'providerData' in created && created.providerData);
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
		process.env.ELECTRON_RUN_AS_NODE = '1';
		process.env.VSCODE_FOO = 'secret';
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
			assert.ok(!('ELECTRON_RUN_AS_NODE' in launchEnv));
			assert.ok(!('VSCODE_FOO' in launchEnv));
		} finally {
				restoreEnv('ELECTRON_RUN_AS_NODE', previousElectron);
				restoreEnv('VSCODE_FOO', previousVscode);
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

	test('session/list paginates by cwd and discovery skips in-process sessions', async () => {
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
		assert.deepStrictEqual(page1.params, { cwd: '/tmp/proj' });
		peer.push({
			jsonrpc: '2.0',
			id: page1.id,
			result: {
				sessions: [{ sessionId: 'sess-a', cwd: '/tmp/proj', title: 'Alpha', updatedAt: '2026-01-01T00:00:00.000Z' }],
				nextCursor: 'c1',
			},
		});
		const page2 = await readNextMessage(peer.outbound);
		assert.deepStrictEqual(page2.params, { cwd: '/tmp/proj', cursor: 'c1' });
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
		peer.push({ jsonrpc: '2.0', id: again1.id, result: { sessions: [{ sessionId: 'sess-a', cwd: '/tmp/proj', title: 'Alpha' }, { sessionId: 'sess-live', cwd: '/tmp/proj', title: 'Live' }], nextCursor: null } });
		await discovery;
		assert.deepStrictEqual(discovered.map(entry => entry.summary), ['Alpha']);
		assert.strictEqual(discovered[0].external, true);
	});

	test('session/list stops on a repeated cursor and lists without a cwd filter when no chat is loaded', async () => {
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
		const peers: IFakePeer[] = [];
		let spawnCount = 0;
		const agent = createAgent();
		agent.bindTestSpawn(launch => {
			spawnCount++;
			assert.deepStrictEqual([...launch.args], [...GROK_BUILD_ACP_ARGV]);
			assert.ok(!Object.keys(launch.env).some(key => key === 'ELECTRON_RUN_AS_NODE' || key.startsWith('VSCODE_')));
			const peer = store.add(makeFakePeer());
			peers.push(peer);
			return { transport: peer.transport, child: peer.child as any, onDispose: () => { /* peer owned by the suite */ } };
		});

		const chat = URI.from({ scheme: GROK_BUILD_AGENT_PROVIDER_ID, path: '/chat/crash' });
		const context = chatContext(chat);
		const create = agent.chats.createChat(chat, context, { workingDirectories: [URI.file('/tmp/proj')] });
		const crashed = await nextPeer(peers, 0);
		await completeHandshake(crashed);
		const sessionNew = await readNextMessage(crashed.outbound);
		assert.strictEqual(sessionNew.method, 'session/new');
		assert.strictEqual(sessionNew.params.cwd, '/tmp/proj');
		peerPushSession(crashed, sessionNew.id, 'sess-crash');
		await create;

		const send = agent.chats.sendMessage(chat, 'in flight', [URI.file('/tmp/proj')], undefined, 'turn-crash', undefined, context);
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
		assert.strictEqual(messages.length, 1);
		assert.strictEqual(messages[0].state, TurnState.Error);
		assert.strictEqual(messages[0].message.text, 'in flight');
		const errorPart = messages[0].responseParts.find(part => part.kind === ResponsePartKind.Error);
		assert.ok(errorPart && errorPart.kind === ResponsePartKind.Error);
		assert.strictEqual(errorPart.error.errorType, 'GrokProcessExited');
		assert.match(errorPart.error.message, /TAILMARK/);

		const sendAgain = agent.chats.sendMessage(chat, 'after crash', [URI.file('/tmp/proj')], undefined, 'turn-after', undefined, context);
		const respawned = await nextPeer(peers, 1);
		await completeHandshake(respawned);
		const load = await readNextMessage(respawned.outbound);
		assert.strictEqual(load.method, 'session/load');
		assert.deepStrictEqual(load.params, { sessionId: 'sess-crash', cwd: '/tmp/proj', mcpServers: [] });
		pushUpdate(respawned, 'sess-crash', { sessionUpdate: 'user_message_chunk', messageId: 'u1', content: { type: 'text', text: 'in flight' } });
		pushUpdate(respawned, 'sess-crash', { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'partial' } });
		respawned.push({ jsonrpc: '2.0', id: load.id, result: {} });
		const promptAgain = await readNextMessage(respawned.outbound);
		assert.strictEqual(promptAgain.method, 'session/prompt');
		assert.strictEqual(promptAgain.params.prompt[0].text, 'after crash');
		respawned.push({ jsonrpc: '2.0', id: promptAgain.id, result: { stopReason: 'end_turn' } });
		await sendAgain;

		const restored = await agent.chats.getMessages(chat, context);
		assert.strictEqual(restored.length, 2);
		assert.strictEqual(restored[0].message.text, 'in flight');
		assert.strictEqual(markdownOf(restored[0]), 'partial');
		assert.strictEqual(restored[0].state, TurnState.Complete);
		assert.strictEqual(restored[1].message.text, 'after crash');
		assert.strictEqual(spawnCount, 2);
	});

	test('handshake failure includes the stderr tail and tears down once', async () => {
		const peer = store.add(makeFakePeer());
		let spawnCount = 0;
		let disposeCount = 0;
		const agent = createAgent();
		agent.bindTestSpawn(() => {
			spawnCount++;
			return { transport: peer.transport, child: peer.child as any, onDispose: () => { disposeCount++; } };
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
			return { transport: peer2.transport, child: peer2.child as any, onDispose: () => { disposeCount++; } };
		});
		const chat2 = URI.from({ scheme: GROK_BUILD_AGENT_PROVIDER_ID, path: '/chat/handshake-2' });
		const create2 = agent.chats.createChat(chat2, chatContext(chat2), { workingDirectories: [URI.file('/tmp')] });
		await completeHandshake(peer2, { loadSession: false });
		const sessionNew = await readNextMessage(peer2.outbound);
		peerPushSession(peer2, sessionNew.id, 'sess-after-handshake');
		await create2;
		assert.strictEqual(spawnCount, 2);
	});

	test('session/close is sent on dispose and release when advertised, including unknown-session success', async () => {
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
		peer.push({ jsonrpc: '2.0', id: close.id, error: { code: -32002, message: 'unknown session' } });
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
		peer.push({ jsonrpc: '2.0', id: close2.id, result: {} });
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

	test('setWorkingDirectory reloads the session at the new cwd', async () => {
		const peer = store.add(makeFakePeer());
		const client = store.add(new AcpClient(peer.transport));
		const agent = createAgent();
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

		const sameDirectory = agent.setWorkingDirectory(chat, context, URI.file('/tmp/a'));
		assert.strictEqual(await readIfAny(peer.outbound), undefined);
		await sameDirectory;

		const moved = agent.setWorkingDirectory(chat, context, URI.file('/tmp/b'));
		const load = await readNextMessage(peer.outbound);
		assert.strictEqual(load.method, 'session/load');
		assert.deepStrictEqual(load.params, { sessionId: 'sess-cwd', cwd: '/tmp/b', mcpServers: [] });
		peer.push({ jsonrpc: '2.0', id: load.id, result: {} });
		await moved;
		const metadata = await agent.getChatMetadata(chat, context);
		assert.strictEqual(metadata?.workingDirectories?.[0].fsPath, '/tmp/b');
		assert.ok(changes.some(data => data.includes('/tmp/b')));

		await assert.rejects(
			agent.setWorkingDirectory(chat, context, URI.from({ scheme: 'vscode-remote', path: '/tmp/c' })),
			(err: unknown) => err instanceof Error && err.message === grokWorkingDirectoryRejectedError().message,
		);
		await assert.rejects(
			agent.setWorkingDirectory(chat, context, URI.file('/tmp/b').with({ query: 'x' })),
			(err: unknown) => err instanceof Error && err.message === grokWorkingDirectoryRejectedError().message,
		);
		await assert.rejects(
			agent.setWorkingDirectory(chat, context, URI.file('/tmp/b').with({ fragment: 'x' })),
			(err: unknown) => err instanceof Error && err.message === grokWorkingDirectoryRejectedError().message,
		);

		const send = agent.chats.sendMessage(chat, 'busy', [URI.file('/tmp/b')], undefined, 'turn-busy', undefined, context);
		const prompt = await readNextMessage(peer.outbound);
		await assert.rejects(
			agent.setWorkingDirectory(chat, context, URI.file('/tmp/c')),
			(err: unknown) => err instanceof Error && err.message === grokWorkingDirectoryBusyError().message,
		);
		peer.push({ jsonrpc: '2.0', id: prompt.id, result: { stopReason: 'end_turn' } });
		await send;
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
});

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

async function nextPeer(peers: readonly IFakePeer[], index: number): Promise<IFakePeer> {
	const start = Date.now();
	while (peers.length <= index) {
		if (Date.now() - start > 2_000) {
			throw new Error(`timed out waiting for grok spawn ${index}`);
		}
		await new Promise(resolve => setTimeout(resolve, 5));
	}
	return peers[index];
}
