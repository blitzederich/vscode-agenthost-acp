/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import type { ChildProcessWithoutNullStreams } from 'child_process';
import { EventEmitter } from 'events';
import * as http from 'http';
import { PassThrough } from 'stream';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../log/common/log.js';
import type { IProductService } from '../../../../product/common/productService.js';
import { AgentSession, fixedChatOwnerRef, GROK_BUILD_AGENT_PROVIDER_ID, type AgentSignal, type IAgentChatContext, type IAgentDiscoveredChat } from '../../../common/agent.js';
import type { ChatInputRequestWithPlanReview } from '../../../common/agentHostPlanReview.js';
import { ChatInputRequestPurpose, readChatInputRequestPurpose } from '../../../common/meta/agentChatInputRequestMeta.js';
import { readUsageInfoMeta } from '../../../common/meta/agentUsageMeta.js';
import { chatReducer } from '../../../common/state/protocol/reducers.js';
import { ActionType, type ChatAction } from '../../../common/state/sessionActions.js';
import { ChatInputAnswerState, ChatInputAnswerValueKind, ChatInputQuestionKind, ChatInputResponseKind, ChatOriginKind, CustomizationType, MessageKind, ResponsePartKind, SessionStatus, ToolCallContributorKind, ToolCallStatus, ToolResultContentType, TurnState, type ChatInputAnswer, type ChatInputRequest, type ChatState, type ToolCallState, type Turn } from '../../../common/state/sessionState.js';
import {
	AcpClient,
	type IAcpTransport,
} from '../../../node/grokBuild/acpClient.js';
import { decodeGrokBuildChat, encodeGrokBuildChat } from '../../../node/grokBuild/grokBuildChatBacking.js';
import { GrokBuildAgent, mergeRestoredTurns } from '../../../node/grokBuild/grokBuildAgent.js';
import { ContextSizeConfigKey } from '../../../common/agentModelConfiguration.js';
import { GROK_COPILOT_USAGE_INFO_KEY } from '../../../node/grokBuild/grokBuildMapSessionUpdates.js';
import { GROK_PERMISSION_PRESET_ALLOW_EDITS, GROK_PERMISSION_PRESET_ASK, GROK_PERMISSION_PRESET_KEY, GROK_THINKING_LEVEL_KEY, grokPathPrefixRejectedError, grokPlanModeFailedError, grokSlashCommandRejectedError, grokSlashCommandsUnavailableError } from '../../../node/grokBuild/grokBuildUx.js';
import { IAgentConfigurationService, type IAgentChatConfigurationChangeEvent, type IAgentChatConfigurationTarget } from '../../../node/agentConfigurationService.js';
import type { AgentHostStateManager } from '../../../node/agentHostStateManager.js';
import { SessionConfigKey } from '../../../common/sessionConfigKeys.js';
import { GROK_BUILD_ACP_ARGV, grokCannotRestoreSessionError, grokCliMissingError, grokCliNotExecutableError, grokHandshakeTimeoutError, grokNotLoggedInError, grokSessionMissingError, grokUnreadableVersionWarning, grokVersionTooOldError, grokWorkingDirectoryRejectedError } from '../../../node/grokBuild/grokBuildLaunchConfig.js';
import { GROK_CLIENT_MCP_SERVER_NAME } from '../../../node/grokBuild/grokBuildClientToolMcpServer.js';
import type { AcpAgentCapabilities } from '../../../node/grokBuild/protocol/acpTypes.js';
import { AHP_SESSION_NOT_FOUND, ProtocolError } from '../../../common/state/sessionProtocol.js';
import { AgentHostGrokBuildClientToolsMcpEnabledConfigKey } from '../../../common/agentHostSchema.js';

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

	function assertClientToolsMcpServer(mcpServers: unknown): asserts mcpServers is Array<{
		type: string;
		name: string;
		url: string;
		headers: Array<{ name: string; value: string }>;
	}> {
		assert.ok(Array.isArray(mcpServers), 'mcpServers should be an array');
		assert.strictEqual(mcpServers.length, 1);
		const server = mcpServers[0] as {
			type: string;
			name: string;
			url: string;
			headers: Array<{ name: string; value: string }>;
		};
		assert.strictEqual(server.type, 'http');
		assert.strictEqual(server.name, GROK_CLIENT_MCP_SERVER_NAME);
		assert.ok(typeof server.url === 'string' && /^http:\/\/127\.0\.0\.1:\d+\/mcp$/.test(server.url), `unexpected mcp url: ${server.url}`);
		assert.ok(Array.isArray(server.headers) && server.headers.length === 1);
		assert.strictEqual(server.headers[0]!.name, 'Authorization');
		assert.ok(/^Bearer [0-9a-f]+$/i.test(server.headers[0]!.value));
	}

	function createAgent(log: NullLogService = new NullLogService(), configuration?: {
		readonly onDidChatConfigChange?: Event<IAgentChatConfigurationChangeEvent>;
		readonly getChatConfigValues?: () => Record<string, unknown> | undefined;
		readonly getRootValue?: (schema: unknown, key: string) => unknown;
		readonly updateChatConfig?: (target: IAgentChatConfigurationTarget, patch: Record<string, unknown>) => void;
		readonly configPatches?: Array<{ target: IAgentChatConfigurationTarget; patch: Record<string, unknown> }>;
		readonly sessionMeta?: Record<string, unknown>;
		readonly getSessionMeta?: () => Record<string, unknown> | undefined;
		readonly onGetSessionState?: (key: unknown) => void;
		/** When false, client-tools MCP is disabled (mcpServers stay empty). Default true. */
		readonly clientToolsMcpEnabled?: boolean;
	}): GrokBuildAgent {
		const configurationService = {
			onDidChatConfigChange: configuration?.onDidChatConfigChange ?? Event.None,
			getChatConfigValues: configuration?.getChatConfigValues ?? (() => undefined),
			getRootValue: configuration?.getRootValue ?? ((_schema: unknown, key: string) => {
				if (key === AgentHostGrokBuildClientToolsMcpEnabledConfigKey) {
					return configuration?.clientToolsMcpEnabled !== false;
				}
				return undefined;
			}),
			updateChatConfig: configuration?.updateChatConfig ?? ((target, patch) => {
				configuration?.configPatches?.push({ target, patch });
			}),
		} as unknown as IAgentConfigurationService;
		const stateManager = {
			getSessionState: (key: unknown) => {
				configuration?.onGetSessionState?.(key);
				const meta = configuration?.getSessionMeta?.() ?? configuration?.sessionMeta;
				return meta !== undefined ? { _meta: meta } : undefined;
			},
		} as unknown as AgentHostStateManager;
		return store.add(new GrokBuildAgent(log, new TestProductService() as unknown as IProductService, configurationService, stateManager));
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
		assertClientToolsMcpServer(sessionNew.params.mcpServers);
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

	test('models expose maxContextWindow from totalContextTokens / contextWindow', async () => {
		const peer = store.add(makeFakePeer());
		const client = store.add(new AcpClient(peer.transport));
		const agent = createAgent();
		agent.bindTestClient(client);

		const chat = URI.from({ scheme: GROK_BUILD_AGENT_PROVIDER_ID, path: '/chat/ctx-window' });
		const context = chatContext(chat);
		const createPromise = agent.chats.createChat(chat, context, { workingDirectories: [URI.file('/tmp')] });
		const sessionNew = await readNextMessage(peer.outbound);
		peer.push({
			jsonrpc: '2.0',
			id: sessionNew.id,
			result: {
				sessionId: 'sess-ctx-window',
				models: {
					currentModelId: 'grok-4.7',
					availableModels: [
						{ modelId: 'grok-4.7', name: 'Grok 4.7', _meta: { totalContextTokens: 256000, contextWindows: [256000, 500000] } },
						{ modelId: 'grok-4.7-500k', name: 'Grok 500k', _meta: { totalContextTokens: 256000, contextWindow: 500000 } },
						{ modelId: 'grok-single', name: 'Single', _meta: { totalContextTokens: 256000, contextWindows: [256000] } },
					],
				},
			},
		});
		await createPromise;
		const models = agent.models.get();
		assert.strictEqual(models.find(m => m.id === 'grok-4.7')?.maxContextWindow, 256000);
		// Session `_meta.contextWindow` must not raise the published model default.
		assert.strictEqual(models.find(m => m.id === 'grok-4.7-500k')?.maxContextWindow, 256000);
		assert.deepStrictEqual(models.find(m => m.id === 'grok-4.7')?.configSchema?.properties?.[ContextSizeConfigKey]?.enum, [256000, 500000]);
		assert.strictEqual(models.find(m => m.id === 'grok-4.7-500k')?.configSchema?.properties?.[ContextSizeConfigKey], undefined);
		assert.strictEqual(models.find(m => m.id === 'grok-single')?.configSchema?.properties?.[ContextSizeConfigKey], undefined);
	});

	test('contextSize selection sends set_model _meta.contextWindow and updates tokenLimit', async () => {
		const peer = store.add(makeFakePeer());
		const client = store.add(new AcpClient(peer.transport));
		const agent = createAgent(new NullLogService(), { sessionMeta: {} });
		agent.bindTestClient(client);
		const signals: AgentSignal[] = [];
		store.add(agent.onDidChatProgress(s => signals.push(s)));

		const chat = URI.from({ scheme: GROK_BUILD_AGENT_PROVIDER_ID, path: '/chat/ctx-size' });
		const context = chatContext(chat);
		const createPromise = agent.chats.createChat(chat, context, { workingDirectories: [URI.file('/tmp')] });
		const sessionNew = await readNextMessage(peer.outbound);
		peer.push({
			jsonrpc: '2.0',
			id: sessionNew.id,
			result: {
				sessionId: 'sess-ctx-size',
				models: {
					currentModelId: 'grok-4.7',
					availableModels: [
						{ modelId: 'grok-4.7', name: 'Grok 4.7', _meta: { totalContextTokens: 256000, contextWindows: [256000, 500000] } },
					],
				},
			},
		});
		await createPromise;
		assert.deepStrictEqual(agent.models.get()[0]?.configSchema?.properties?.[ContextSizeConfigKey]?.enum, [256000, 500000]);
		assert.strictEqual(agent.models.get()[0]?.maxContextWindow, 256000);

		const select500k = agent.chats.changeModel!(chat, {
			id: 'grok-4.7',
			config: { [ContextSizeConfigKey]: 500000 },
		}, context);
		const set500k = await readNextMessage(peer.outbound);
		assert.strictEqual(set500k.method, 'session/set_model');
		assert.deepStrictEqual(set500k.params, {
			sessionId: 'sess-ctx-size',
			modelId: 'grok-4.7',
			_meta: { contextWindow: 500000 },
		});
		peer.push({ jsonrpc: '2.0', id: set500k.id, result: {} });
		await select500k;
		// Shared model list stays at the published default; per-chat override narrows tokenLimit.
		assert.strictEqual(agent.models.get()[0]?.maxContextWindow, 256000);
		assert.strictEqual(agent.chats.getModel!(chat, context)?.config?.[ContextSizeConfigKey], 500000);

		const sendPromise = agent.chats.sendMessage(chat, 'hi', [URI.file('/tmp')], undefined, 'turn-ctx-size', undefined, context);
		const prompt = await readNextMessage(peer.outbound);
		assert.strictEqual(prompt.method, 'session/prompt');
		peer.push({
			jsonrpc: '2.0',
			method: 'session/update',
			params: {
				sessionId: 'sess-ctx-size',
				update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ok' }, _meta: { totalTokens: 12000 } },
			},
		});
		peer.push({
			jsonrpc: '2.0',
			id: prompt.id,
			result: { stopReason: 'end_turn', _meta: { totalTokens: 12000 } },
		});
		await sendPromise;
		const usageMeta = signals.filter(s => s.kind === 'action' && s.action.type === ActionType.SessionMetaChanged).at(-1);
		assert.ok(usageMeta && usageMeta.kind === 'action' && usageMeta.action.type === ActionType.SessionMetaChanged);
		assert.deepStrictEqual(usageMeta.action._meta?.['copilot.usageInfo'], {
			currentTokens: 12000,
			tokenLimit: 500000,
			messagesLength: 1,
		});

		// 500k → 256k must send _meta.contextWindow 256000 (omit = Preserve stays on 500k).
		const select256k = agent.chats.changeModel!(chat, {
			id: 'grok-4.7',
			config: { [ContextSizeConfigKey]: 256000 },
		}, context);
		const set256k = await readNextMessage(peer.outbound);
		assert.strictEqual(set256k.method, 'session/set_model');
		assert.deepStrictEqual(set256k.params, {
			sessionId: 'sess-ctx-size',
			modelId: 'grok-4.7',
			_meta: { contextWindow: 256000 },
		});
		peer.push({ jsonrpc: '2.0', id: set256k.id, result: {} });
		await select256k;
		assert.strictEqual(agent.chats.getModel!(chat, context)?.config?.[ContextSizeConfigKey], 256000);
		assert.strictEqual(agent.models.get()[0]?.maxContextWindow, 256000);

		const unsupported = agent.chats.changeModel!(chat, {
			id: 'grok-4.7',
			config: { [ContextSizeConfigKey]: 999999 },
		}, context);
		const setUnsupported = await readNextMessage(peer.outbound);
		assert.strictEqual(setUnsupported.method, 'session/set_model');
		// Unsupported size is ignored: keep the current offered window in _meta.
		assert.deepStrictEqual(setUnsupported.params, {
			sessionId: 'sess-ctx-size',
			modelId: 'grok-4.7',
			_meta: { contextWindow: 256000 },
		});
		peer.push({ jsonrpc: '2.0', id: setUnsupported.id, result: {} });
		await unsupported;
		assert.strictEqual(agent.models.get()[0]?.maxContextWindow, 256000);
	});

	test('two chats keep independent context-window tokenLimits', async () => {
		const peer = store.add(makeFakePeer());
		const client = store.add(new AcpClient(peer.transport));
		const agent = createAgent(new NullLogService(), { sessionMeta: {} });
		agent.bindTestClient(client);

		const multiWindowModels = {
			currentModelId: 'grok-4.7',
			availableModels: [
				{ modelId: 'grok-4.7', name: 'Grok 4.7', _meta: { totalContextTokens: 256000, contextWindows: [256000, 500000] } },
			],
		};

		const chatA = URI.from({ scheme: GROK_BUILD_AGENT_PROVIDER_ID, path: '/chat/ctx-a' });
		const contextA = chatContext(chatA);
		const createA = agent.chats.createChat(chatA, contextA, { workingDirectories: [URI.file('/tmp/a')] });
		const newA = await readNextMessage(peer.outbound);
		peer.push({ jsonrpc: '2.0', id: newA.id, result: { sessionId: 'sess-ctx-a', models: multiWindowModels } });
		await createA;

		const chatB = URI.from({ scheme: GROK_BUILD_AGENT_PROVIDER_ID, path: '/chat/ctx-b' });
		const contextB = chatContext(chatB);
		const createB = agent.chats.createChat(chatB, contextB, { workingDirectories: [URI.file('/tmp/b')] });
		const newB = await readNextMessage(peer.outbound);
		peer.push({ jsonrpc: '2.0', id: newB.id, result: { sessionId: 'sess-ctx-b', models: multiWindowModels } });
		await createB;

		const selectA = agent.chats.changeModel!(chatA, {
			id: 'grok-4.7',
			config: { [ContextSizeConfigKey]: 500000 },
		}, contextA);
		const setA = await readNextMessage(peer.outbound);
		assert.deepStrictEqual(setA.params?._meta, { contextWindow: 500000 });
		peer.push({ jsonrpc: '2.0', id: setA.id, result: {} });
		await selectA;

		const selectB = agent.chats.changeModel!(chatB, {
			id: 'grok-4.7',
			config: { [ContextSizeConfigKey]: 256000 },
		}, contextB);
		const setB = await readNextMessage(peer.outbound);
		assert.deepStrictEqual(setB.params?._meta, { contextWindow: 256000 });
		peer.push({ jsonrpc: '2.0', id: setB.id, result: {} });
		await selectB;

		assert.strictEqual(agent.models.get()[0]?.maxContextWindow, 256000);
		assert.strictEqual(agent.chats.getModel!(chatA, contextA)?.config?.[ContextSizeConfigKey], 500000);
		assert.strictEqual(agent.chats.getModel!(chatB, contextB)?.config?.[ContextSizeConfigKey], 256000);

		const sendA = agent.chats.sendMessage(chatA, 'a', [URI.file('/tmp/a')], undefined, 'turn-a', undefined, contextA);
		const promptA = await readNextMessage(peer.outbound);
		assert.strictEqual(promptA.method, 'session/prompt');
		peer.push({
			jsonrpc: '2.0',
			method: 'session/update',
			params: {
				sessionId: 'sess-ctx-a',
				update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'a' }, _meta: { totalTokens: 100 } },
			},
		});
		peer.push({ jsonrpc: '2.0', id: promptA.id, result: { stopReason: 'end_turn', _meta: { totalTokens: 100 } } });
		await sendA;

		const sendB = agent.chats.sendMessage(chatB, 'b', [URI.file('/tmp/b')], undefined, 'turn-b', undefined, contextB);
		const promptB = await readNextMessage(peer.outbound);
		assert.strictEqual(promptB.method, 'session/prompt');
		peer.push({
			jsonrpc: '2.0',
			method: 'session/update',
			params: {
				sessionId: 'sess-ctx-b',
				update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'b' }, _meta: { totalTokens: 200 } },
			},
		});
		peer.push({ jsonrpc: '2.0', id: promptB.id, result: { stopReason: 'end_turn', _meta: { totalTokens: 200 } } });
		await sendB;

		const usageA = (await agent.getChatMetadata(chatA, contextA))?._meta?.[GROK_COPILOT_USAGE_INFO_KEY] as { tokenLimit?: number } | undefined;
		const usageB = (await agent.getChatMetadata(chatB, contextB))?._meta?.[GROK_COPILOT_USAGE_INFO_KEY] as { tokenLimit?: number } | undefined;
		assert.strictEqual(usageA?.tokenLimit, 500000);
		assert.strictEqual(usageB?.tokenLimit, 256000);
	});

	test('session/load current-model contextWindow + replay model_changed restore contextSize', async () => {
		const peer = store.add(makeFakePeer());
		const client = store.add(new AcpClient(peer.transport));
		const agent = createAgent();
		agent.bindTestClient(client, LIVE_CAPABILITIES);

		const chat = URI.from({ scheme: GROK_BUILD_AGENT_PROVIDER_ID, path: '/chat/ctx-load' });
		const context = chatContext(chat);
		const providerData = encodeGrokBuildChat({ sessionId: 'sess-ctx-load', cwd: '/tmp/proj' });
		const restoring = agent.getChatMetadata(chat, context, providerData, { activation: 'restore' });
		const load = await readNextMessage(peer.outbound);
		assert.strictEqual(load.method, 'session/load');
		// Live grok: model_changed arrives while history is replaying, before the load result.
		peer.push({
			jsonrpc: '2.0',
			method: '_x.ai/session_notification',
			params: {
				sessionId: 'sess-ctx-load',
				update: { sessionUpdate: 'model_changed', model_id: 'grok-4.7', context_window_selection: 500000 },
			},
		});
		peer.push({
			jsonrpc: '2.0',
			id: load.id,
			result: {
				models: {
					currentModelId: 'grok-4.7',
					availableModels: [
						{
							modelId: 'grok-4.7',
							name: 'Grok 4.7',
							_meta: { totalContextTokens: 256000, contextWindows: [256000, 500000], contextWindow: 500000 },
						},
					],
				},
				configOptions: [],
				// Live result _meta has no contextWindow (sessionId, x.ai/sessionConfig, …).
				_meta: { sessionId: 'sess-ctx-load', codebaseIndexed: true },
			},
		});
		await answerSessionList(peer);
		const metadata = await restoring;
		assert.strictEqual(metadata?.model?.config?.[ContextSizeConfigKey], 500000);
		assert.strictEqual(agent.chats.getModel?.(chat, context)?.config?.[ContextSizeConfigKey], 500000);
		assert.strictEqual((metadata?._meta?.[GROK_COPILOT_USAGE_INFO_KEY] as { tokenLimit?: number } | undefined)?.tokenLimit, undefined);
		assert.strictEqual(agent.models.get()[0]?.maxContextWindow, 256000);

		// Reasoning-only change must still send the restored 500k window.
		const change = agent.chats.changeModel!(chat, {
			id: 'grok-4.7',
			config: { [GROK_THINKING_LEVEL_KEY]: 'low' },
		}, context);
		const setModel = await readNextMessage(peer.outbound);
		assert.strictEqual(setModel.method, 'session/set_model');
		assert.deepStrictEqual(setModel.params?._meta, { contextWindow: 500000 });
		peer.push({ jsonrpc: '2.0', id: setModel.id, result: {} });
		const setConfig = await readNextMessage(peer.outbound);
		assert.strictEqual(setConfig.method, 'session/set_config_option');
		assert.deepStrictEqual(setConfig.params, { sessionId: 'sess-ctx-load', configId: 'reasoning_effort', value: 'low' });
		peer.push({ jsonrpc: '2.0', id: setConfig.id, result: {} });
		await change;
		assert.strictEqual(agent.chats.getModel?.(chat, context)?.config?.[ContextSizeConfigKey], 500000);
		assert.strictEqual(agent.models.get()[0]?.maxContextWindow, 256000);
	});

	test('loading a 500k chat leaves another chat at tokenLimit 256000', async () => {
		const peer = store.add(makeFakePeer());
		const client = store.add(new AcpClient(peer.transport));
		const agent = createAgent(new NullLogService(), { sessionMeta: {} });
		agent.bindTestClient(client, LIVE_CAPABILITIES);
		const signals: AgentSignal[] = [];
		store.add(agent.onDidChatProgress(s => signals.push(s)));

		const multiModel = {
			currentModelId: 'grok-4.7',
			availableModels: [
				{ modelId: 'grok-4.7', name: 'Grok 4.7', _meta: { totalContextTokens: 256000, contextWindows: [256000, 500000] } },
			],
		};

		const chatA = URI.from({ scheme: GROK_BUILD_AGENT_PROVIDER_ID, path: '/chat/ctx-iso-a' });
		const contextA = chatContext(chatA);
		const createA = agent.chats.createChat(chatA, contextA, { workingDirectories: [URI.file('/tmp/a')] });
		const sessionNewA = await readNextMessage(peer.outbound);
		peer.push({
			jsonrpc: '2.0',
			id: sessionNewA.id,
			result: { sessionId: 'sess-ctx-iso-a', models: multiModel },
		});
		await createA;
		assert.strictEqual(agent.models.get()[0]?.maxContextWindow, 256000);

		const sendA = agent.chats.sendMessage(chatA, 'a', [URI.file('/tmp/a')], undefined, 'turn-iso-a', undefined, contextA);
		const promptA = await readNextMessage(peer.outbound);
		assert.strictEqual(promptA.method, 'session/prompt');
		peer.push({
			jsonrpc: '2.0',
			method: 'session/update',
			params: {
				sessionId: 'sess-ctx-iso-a',
				update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'a' }, _meta: { totalTokens: 100 } },
			},
		});
		peer.push({ jsonrpc: '2.0', id: promptA.id, result: { stopReason: 'end_turn', _meta: { totalTokens: 100 } } });
		await sendA;
		const usageABefore = (await agent.getChatMetadata(chatA, contextA))?._meta?.[GROK_COPILOT_USAGE_INFO_KEY] as { tokenLimit?: number } | undefined;
		assert.strictEqual(usageABefore?.tokenLimit, 256000);

		const chatB = URI.from({ scheme: GROK_BUILD_AGENT_PROVIDER_ID, path: '/chat/ctx-iso-b' });
		const contextB = chatContext(chatB);
		const restoringB = agent.getChatMetadata(chatB, contextB, encodeGrokBuildChat({ sessionId: 'sess-ctx-iso-b', cwd: '/tmp/b' }), { activation: 'restore' });
		const loadB = await readNextMessage(peer.outbound);
		assert.strictEqual(loadB.method, 'session/load');
		peer.push({
			jsonrpc: '2.0',
			method: '_x.ai/session_notification',
			params: {
				sessionId: 'sess-ctx-iso-b',
				update: { sessionUpdate: 'model_changed', model_id: 'grok-4.7', context_window_selection: 500000 },
			},
		});
		peer.push({
			jsonrpc: '2.0',
			id: loadB.id,
			result: {
				models: {
					currentModelId: 'grok-4.7',
					availableModels: [
						{
							modelId: 'grok-4.7',
							name: 'Grok 4.7',
							_meta: { totalContextTokens: 256000, contextWindows: [256000, 500000], contextWindow: 500000 },
						},
					],
				},
				configOptions: [],
				_meta: { sessionId: 'sess-ctx-iso-b' },
			},
		});
		await answerSessionList(peer);
		const metadataB = await restoringB;
		assert.strictEqual(metadataB?.model?.config?.[ContextSizeConfigKey], 500000);
		assert.strictEqual(agent.models.get()[0]?.maxContextWindow, 256000);

		const usageAAfter = (await agent.getChatMetadata(chatA, contextA))?._meta?.[GROK_COPILOT_USAGE_INFO_KEY] as { tokenLimit?: number } | undefined;
		assert.strictEqual(usageAAfter?.tokenLimit, 256000);
		assert.strictEqual(agent.chats.getModel?.(chatA, contextA)?.config?.[ContextSizeConfigKey], undefined);
	});

	test('totalTokens and compaction publish merged copilot.usageInfo; 0 ignored', async () => {
		const peer = store.add(makeFakePeer());
		const client = store.add(new AcpClient(peer.transport));
		const getSessionStateKeys: unknown[] = [];
		const agent = createAgent(new NullLogService(), {
			sessionMeta: { keep: 'yes', 'agentHost.external': true },
			onGetSessionState: key => getSessionStateKeys.push(key),
		});
		agent.bindTestClient(client);
		const signals: AgentSignal[] = [];
		store.add(agent.onDidChatProgress(s => signals.push(s)));

		const chat = URI.from({ scheme: GROK_BUILD_AGENT_PROVIDER_ID, path: '/chat/ctx-usage' });
		const context = chatContext(chat);
		const createPromise = agent.chats.createChat(chat, context, { workingDirectories: [URI.file('/tmp')] });
		const sessionNew = await readNextMessage(peer.outbound);
		peer.push({
			jsonrpc: '2.0',
			id: sessionNew.id,
			result: {
				sessionId: 'sess-ctx-usage',
				models: {
					currentModelId: 'grok-4.7',
					availableModels: [{ modelId: 'grok-4.7', name: 'Grok 4.7', _meta: { totalContextTokens: 256000 } }],
				},
			},
		});
		await createPromise;

		const sendPromise = agent.chats.sendMessage(chat, 'hi', [URI.file('/tmp')], undefined, 'turn-ctx', undefined, context);
		const prompt = await readNextMessage(peer.outbound);
		assert.strictEqual(prompt.method, 'session/prompt');

		peer.push({
			jsonrpc: '2.0',
			method: 'session/update',
			params: {
				sessionId: 'sess-ctx-usage',
				update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ok' }, _meta: { totalTokens: 20926 } },
			},
		});
		peer.push({
			jsonrpc: '2.0',
			method: 'session/update',
			params: {
				sessionId: 'sess-ctx-usage',
				update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '!' }, _meta: { totalTokens: 0 } },
			},
		});
		peer.push({
			jsonrpc: '2.0',
			method: '_x.ai/session_notification',
			params: {
				sessionId: 'sess-ctx-usage',
				update: { sessionUpdate: 'auto_compact_completed', tokens_after: 14345 },
			},
		});
		peer.push({
			jsonrpc: '2.0',
			id: prompt.id,
			result: {
				stopReason: 'end_turn',
				_meta: {
					inputTokens: 31897,
					outputTokens: 50,
					cachedReadTokens: 29056,
					totalTokens: 14345,
					usage: { inputTokens: 131894, outputTokens: 331, cachedReadTokens: 100000 },
				},
			},
		});
		await sendPromise;

		const usageActions = signals.filter(s => s.kind === 'action' && s.action.type === ActionType.ChatUsage);
		assert.ok(usageActions.length >= 1);
		const lastUsage = usageActions.at(-1);
		assert.ok(lastUsage && lastUsage.kind === 'action' && lastUsage.action.type === ActionType.ChatUsage);
		assert.strictEqual(lastUsage.action.usage.inputTokens, 31897);
		assert.strictEqual(readUsageInfoMeta(lastUsage.action.usage).turnTokenTotals?.[0]?.inputTokens, 131894);

		assert.ok(getSessionStateKeys.length >= 1);
		for (const key of getSessionStateKeys) {
			assert.strictEqual(typeof key, 'string');
			assert.strictEqual(key, context.owner.get().toString());
		}

		const metaActions = signals.filter(s => s.kind === 'action' && s.action.type === ActionType.SessionMetaChanged);
		assert.ok(metaActions.length >= 1);
		const lastMeta = metaActions.at(-1);
		assert.ok(lastMeta && lastMeta.kind === 'action' && lastMeta.action.type === ActionType.SessionMetaChanged);
		assert.strictEqual(lastMeta.action._meta?.keep, 'yes');
		assert.strictEqual(lastMeta.action._meta?.['agentHost.external'], true);
		assert.deepStrictEqual(lastMeta.action._meta?.['copilot.usageInfo'], {
			currentTokens: 14345,
			tokenLimit: 256000,
			messagesLength: 1,
		});
	});

	test('restore without session state returns usage in metadata._meta; prefers turn_completed over chunk totalTokens', async () => {
		const peer = store.add(makeFakePeer());
		const client = store.add(new AcpClient(peer.transport));
		// Host session state does not exist yet during getChatMetadata(restore).
		const agent = createAgent();
		agent.bindTestClient(client, LIVE_CAPABILITIES);
		const signals: AgentSignal[] = [];
		store.add(agent.onDidChatProgress(s => signals.push(s)));

		const sessionId = 'sess-cli-restore-usage';
		const chat = URI.from({ scheme: GROK_BUILD_AGENT_PROVIDER_ID, path: `/chat/${sessionId}` });
		const context = chatContextForSession(chat, sessionId);
		const restoring = agent.getChatMetadata(chat, context, undefined, { activation: 'restore' });
		const list = await readNextMessage(peer.outbound);
		assert.strictEqual(list.method, 'session/list');
		peer.push({
			jsonrpc: '2.0',
			id: list.id,
			result: {
				sessions: [{ sessionId, cwd: '/tmp/cli', title: 'CLI', updatedAt: '2026-03-01T00:00:00.000Z' }],
			},
		});
		const load = await readNextMessage(peer.outbound);
		assert.strictEqual(load.method, 'session/load');

		pushUpdate(peer, sessionId, {
			sessionUpdate: 'user_message_chunk',
			content: { type: 'text', text: 'hi' },
			_meta: { promptIndex: 0 },
		});
		pushUpdate(peer, sessionId, {
			sessionUpdate: 'agent_message_chunk',
			content: { type: 'text', text: 'yo' },
			_meta: { promptIndex: 0, totalTokens: 1935 },
		});
		peer.push({
			jsonrpc: '2.0',
			method: '_x.ai/session/update',
			params: {
				sessionId,
				update: {
					sessionUpdate: 'turn_completed',
					usage: { inputTokens: 20598, outputTokens: 32, modelCalls: 1 },
				},
			},
		});
		peer.push({
			jsonrpc: '2.0',
			id: load.id,
			result: {
				models: {
					currentModelId: 'grok-4.7',
					availableModels: [{ modelId: 'grok-4.7', name: 'Grok 4.7', _meta: { totalContextTokens: 256000 } }],
				},
				configOptions: [],
			},
		});
		const metadata = await restoring;

		assert.strictEqual(
			signals.some(s => s.kind === 'action' && s.action.type === ActionType.SessionMetaChanged),
			false,
			'SessionMetaChanged must not fire before the host creates session state',
		);
		assert.deepStrictEqual(metadata?._meta?.[GROK_COPILOT_USAGE_INFO_KEY], {
			currentTokens: 20630,
			tokenLimit: 256000,
			messagesLength: 1,
		});
		assert.strictEqual((await agent.chats.getMessages(chat, context)).at(-1)?.message.model?.id, 'grok-4.7');
	});

	test('after restore, live totalTokens publishes once session state exists (dedupe not stuck)', async () => {
		const peer = store.add(makeFakePeer());
		const client = store.add(new AcpClient(peer.transport));
		const sessionMetaHolder: { meta: Record<string, unknown> | undefined } = { meta: undefined };
		const agent = createAgent(new NullLogService(), {
			getSessionMeta: () => sessionMetaHolder.meta,
		});
		agent.bindTestClient(client, LIVE_CAPABILITIES);
		const signals: AgentSignal[] = [];
		store.add(agent.onDidChatProgress(s => signals.push(s)));

		const chat = URI.from({ scheme: GROK_BUILD_AGENT_PROVIDER_ID, path: '/chat/restore-then-live' });
		const context = chatContext(chat);
		const providerData = encodeGrokBuildChat({ sessionId: 'sess-restore-live', cwd: '/tmp/proj' });
		const restoring = agent.getChatMetadata(chat, context, providerData, { activation: 'restore' });
		const load = await readNextMessage(peer.outbound);
		pushUpdate(peer, 'sess-restore-live', {
			sessionUpdate: 'user_message_chunk',
			content: { type: 'text', text: 'a' },
			_meta: { promptIndex: 0 },
		});
		pushUpdate(peer, 'sess-restore-live', {
			sessionUpdate: 'agent_message_chunk',
			content: { type: 'text', text: 'b' },
			_meta: { promptIndex: 0, totalTokens: 1935 },
		});
		peer.push({
			jsonrpc: '2.0',
			method: '_x.ai/session/update',
			params: {
				sessionId: 'sess-restore-live',
				update: {
					sessionUpdate: 'turn_completed',
					usage: { inputTokens: 20598, outputTokens: 32, modelCalls: 1 },
				},
			},
		});
		peer.push({
			jsonrpc: '2.0',
			id: load.id,
			result: {
				models: {
					currentModelId: 'grok-4.7',
					availableModels: [{ modelId: 'grok-4.7', name: 'Grok 4.7', _meta: { totalContextTokens: 256000 } }],
				},
				configOptions: [],
			},
		});
		await answerSessionList(peer);
		const metadata = await restoring;
		assert.deepStrictEqual(metadata?._meta?.[GROK_COPILOT_USAGE_INFO_KEY], {
			currentTokens: 20630,
			tokenLimit: 256000,
			messagesLength: 1,
		});
		assert.strictEqual(signals.filter(s => s.kind === 'action' && s.action.type === ActionType.SessionMetaChanged).length, 0);

		// Host creates the session and applies metadata._meta.
		sessionMetaHolder.meta = { ...(metadata?._meta ?? {}) };
		const published = Event.toPromise(Event.filter(agent.onDidChatProgress, s =>
			s.kind === 'action' && s.action.type === ActionType.SessionMetaChanged));
		pushUpdate(peer, 'sess-restore-live', {
			sessionUpdate: 'agent_message_chunk',
			content: { type: 'text', text: '!' },
			_meta: { totalTokens: 21000 },
		});
		await published;
		const liveMeta = signals.filter(s => s.kind === 'action' && s.action.type === ActionType.SessionMetaChanged).at(-1);
		assert.ok(liveMeta && liveMeta.kind === 'action' && liveMeta.action.type === ActionType.SessionMetaChanged);
		assert.deepStrictEqual(liveMeta.action._meta?.[GROK_COPILOT_USAGE_INFO_KEY], {
			currentTokens: 21000,
			tokenLimit: 256000,
			messagesLength: 1,
		});
	});

	test('restore with contextTokens and empty replay seeds metadata usage from providerData', async () => {
		const peer = store.add(makeFakePeer());
		const client = store.add(new AcpClient(peer.transport));
		const agent = createAgent();
		agent.bindTestClient(client, LIVE_CAPABILITIES);

		const chat = URI.from({ scheme: GROK_BUILD_AGENT_PROVIDER_ID, path: '/chat/seed-context' });
		const context = chatContext(chat);
		const providerData = encodeGrokBuildChat({ sessionId: 'sess-seed', cwd: '/tmp/proj', contextTokens: 21866 });
		const restoring = agent.getChatMetadata(chat, context, providerData, { activation: 'restore' });
		const load = await readNextMessage(peer.outbound);
		peer.push({
			jsonrpc: '2.0',
			id: load.id,
			result: {
				models: {
					currentModelId: 'grok-4.7',
					availableModels: [{ modelId: 'grok-4.7', name: 'Grok 4.7', _meta: { totalContextTokens: 256000 } }],
				},
				configOptions: [],
			},
		});
		await answerSessionList(peer);
		const metadata = await restoring;
		assert.deepStrictEqual(metadata?._meta?.[GROK_COPILOT_USAGE_INFO_KEY], {
			currentTokens: 21866,
			tokenLimit: 256000,
			messagesLength: 0,
		});
	});

	test('replay turn_completed with modelCalls > 1 does not override chunk totalTokens', async () => {
		const peer = store.add(makeFakePeer());
		const client = store.add(new AcpClient(peer.transport));
		const agent = createAgent();
		agent.bindTestClient(client, LIVE_CAPABILITIES);

		const chat = URI.from({ scheme: GROK_BUILD_AGENT_PROVIDER_ID, path: '/chat/multi-call' });
		const context = chatContext(chat);
		const providerData = encodeGrokBuildChat({ sessionId: 'sess-multi', cwd: '/tmp/proj' });
		const restoring = agent.getChatMetadata(chat, context, providerData, { activation: 'restore' });
		const load = await readNextMessage(peer.outbound);
		pushUpdate(peer, 'sess-multi', {
			sessionUpdate: 'user_message_chunk',
			content: { type: 'text', text: 'hi' },
			_meta: { promptIndex: 0 },
		});
		pushUpdate(peer, 'sess-multi', {
			sessionUpdate: 'agent_message_chunk',
			content: { type: 'text', text: 'yo' },
			_meta: { promptIndex: 0, totalTokens: 14581 },
		});
		peer.push({
			jsonrpc: '2.0',
			method: '_x.ai/session/update',
			params: {
				sessionId: 'sess-multi',
				update: {
					sessionUpdate: 'turn_completed',
					usage: { inputTokens: 131894, outputTokens: 331, modelCalls: 5 },
				},
			},
		});
		peer.push({
			jsonrpc: '2.0',
			id: load.id,
			result: {
				models: {
					currentModelId: 'grok-4.7',
					availableModels: [{ modelId: 'grok-4.7', name: 'Grok 4.7', _meta: { totalContextTokens: 256000 } }],
				},
				configOptions: [],
			},
		});
		await answerSessionList(peer);
		const metadata = await restoring;
		assert.deepStrictEqual(metadata?._meta?.[GROK_COPILOT_USAGE_INFO_KEY], {
			currentTokens: 14581,
			tokenLimit: 256000,
			messagesLength: 1,
		});
	});

	test('session/load restore sets message.model from currentModelId without session state', async () => {
		const peer = store.add(makeFakePeer());
		const client = store.add(new AcpClient(peer.transport));
		const agent = createAgent();
		agent.bindTestClient(client, LIVE_CAPABILITIES);
		const signals: AgentSignal[] = [];
		store.add(agent.onDidChatProgress(s => signals.push(s)));

		const chat = URI.from({ scheme: GROK_BUILD_AGENT_PROVIDER_ID, path: '/chat/restore-usage' });
		const context = chatContext(chat);
		// No pinned model in providerData — CLI currentModelId must populate turn message.model.
		const providerData = encodeGrokBuildChat({ sessionId: 'sess-restore-usage', cwd: '/tmp/proj', contextTokens: 9000 });
		const restoring = agent.getChatMetadata(chat, context, providerData, { activation: 'restore' });
		const load = await readNextMessage(peer.outbound);
		assert.strictEqual(load.method, 'session/load');

		pushUpdate(peer, 'sess-restore-usage', {
			sessionUpdate: 'user_message_chunk',
			content: { type: 'text', text: 'earlier' },
			_meta: { promptIndex: 0 },
		});
		pushUpdate(peer, 'sess-restore-usage', {
			sessionUpdate: 'agent_message_chunk',
			content: { type: 'text', text: 'reply' },
			_meta: { promptIndex: 0, totalTokens: 14581 },
		});
		peer.push({
			jsonrpc: '2.0',
			id: load.id,
			result: {
				models: {
					currentModelId: 'grok-4.7',
					availableModels: [{ modelId: 'grok-4.7', name: 'Grok 4.7', _meta: { totalContextTokens: 256000 } }],
				},
				configOptions: [],
			},
		});
		await answerSessionList(peer);
		const metadata = await restoring;

		assert.strictEqual(
			signals.some(s => s.kind === 'action' && s.action.type === ActionType.SessionMetaChanged),
			false,
		);
		assert.deepStrictEqual(metadata?._meta?.[GROK_COPILOT_USAGE_INFO_KEY], {
			currentTokens: 14581,
			tokenLimit: 256000,
			messagesLength: 1,
		});

		const messages = await agent.chats.getMessages(chat, context);
		assert.strictEqual(decodeGrokBuildChat(providerData)?.model, undefined);
		assert.strictEqual(messages.at(-1)?.message.model?.id, 'grok-4.7');
		assert.strictEqual(metadata?.model?.id, 'grok-4.7');
		assert.strictEqual(agent.chats.getModel?.(chat, context)?.id, 'grok-4.7');
	});

	test('explicit backing.model wins over session/load currentModelId for turn message.model', async () => {
		const peer = store.add(makeFakePeer());
		const client = store.add(new AcpClient(peer.transport));
		const agent = createAgent();
		agent.bindTestClient(client, LIVE_CAPABILITIES);

		const chat = URI.from({ scheme: GROK_BUILD_AGENT_PROVIDER_ID, path: '/chat/pinned-model' });
		const context = chatContext(chat);
		const providerData = encodeGrokBuildChat({ sessionId: 'sess-pinned', cwd: '/tmp/proj', model: { id: 'pinned-grok' } });
		const restoring = agent.getChatMetadata(chat, context, providerData, { activation: 'restore' });
		const load = await readNextMessage(peer.outbound);
		assert.strictEqual(load.method, 'session/load');
		pushUpdate(peer, 'sess-pinned', {
			sessionUpdate: 'user_message_chunk',
			content: { type: 'text', text: 'hi' },
			_meta: { promptIndex: 0 },
		});
		pushUpdate(peer, 'sess-pinned', {
			sessionUpdate: 'agent_message_chunk',
			content: { type: 'text', text: 'yo' },
			_meta: { promptIndex: 0, totalTokens: 100 },
		});
		peer.push({
			jsonrpc: '2.0',
			id: load.id,
			result: {
				models: {
					currentModelId: 'grok-4.7',
					availableModels: [
						{ modelId: 'grok-4.7', name: 'Grok 4.7', _meta: { totalContextTokens: 256000 } },
						{ modelId: 'pinned-grok', name: 'Pinned', _meta: { totalContextTokens: 256000 } },
					],
				},
				configOptions: [],
			},
		});
		await answerSessionList(peer);
		await restoring;

		const messages = await agent.chats.getMessages(chat, context);
		assert.strictEqual(messages.at(-1)?.message.model?.id, 'pinned-grok');
		assert.strictEqual(agent.chats.getModel?.(chat, context)?.id, 'pinned-grok');
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
		assert.strictEqual(load.params.sessionId, 'sess-old');
		assert.strictEqual(load.params.cwd, '/tmp/proj');
		assertClientToolsMcpServer(load.params.mcpServers);

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
		assert.strictEqual(passive?.startTime, 0);
		assert.strictEqual(passive?.modifiedTime, 0);
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

	test('restore/load without a turn keeps pre-load modifiedTime; list clamps grok load bump', async () => {
		const peer = store.add(makeFakePeer());
		const client = store.add(new AcpClient(peer.transport));
		const agent = createAgent();
		agent.bindTestClient(client, LIVE_CAPABILITIES);

		const sessionId = 'sess-mtime-load';
		const preLoadIso = '2026-01-15T12:00:00.000Z';
		const preLoadMs = Date.parse(preLoadIso);
		const postLoadIso = '2026-11-04T18:00:00.000Z';
		const before = Date.now();

		// Seed the list cache with the authentic pre-load updatedAt.
		const seedList = agent.listChatsToMigrate();
		const seedReq = await readNextMessage(peer.outbound);
		assert.strictEqual(seedReq.method, 'session/list');
		peer.push({
			jsonrpc: '2.0',
			id: seedReq.id,
			result: { sessions: [{ sessionId, cwd: '/tmp/proj', title: 'Old', updatedAt: preLoadIso }] },
		});
		await seedList;

		const chat = URI.from({ scheme: GROK_BUILD_AGENT_PROVIDER_ID, path: '/chat/mtime-load' });
		const context = chatContext(chat);
		const restoring = agent.getChatMetadata(chat, context, encodeGrokBuildChat({ sessionId, cwd: '/tmp/proj' }), { activation: 'restore' });
		const load = await readNextMessage(peer.outbound);
		assert.strictEqual(load.method, 'session/load');
		pushUpdate(peer, sessionId, { sessionUpdate: 'session_info_update', title: 'Replay title' });
		peer.push({ jsonrpc: '2.0', id: load.id, result: {} });
		const metadata = await restoring;
		assert.strictEqual(metadata?.modifiedTime, preLoadMs);
		assert.ok((metadata?.modifiedTime ?? 0) < before, 'restore must not stamp Date.now()');
		// Listed title wins over a replayed session_info_update title.
		assert.strictEqual(metadata?.summary, 'Old');

		// Grok's post-load list returns a bumped updatedAt; listing must keep the pre-load time.
		const listed = agent.listChatsToMigrate();
		const listReq = await readNextMessage(peer.outbound);
		assert.strictEqual(listReq.method, 'session/list');
		peer.push({
			jsonrpc: '2.0',
			id: listReq.id,
			result: { sessions: [{ sessionId, cwd: '/tmp/proj', title: 'Old', updatedAt: postLoadIso }] },
		});
		const chats = await listed;
		assert.ok(Array.isArray(chats));
		const row = chats.find(entry => entry.summary === 'Old');
		assert.ok(row);
		assert.strictEqual(row.modifiedTime, preLoadMs);
		assert.strictEqual(row.startTime, preLoadMs);
	});

	test('completed turn bumps modifiedTime and clears the pre-load list override', async () => {
		const peer = store.add(makeFakePeer());
		const client = store.add(new AcpClient(peer.transport));
		const agent = createAgent();
		agent.bindTestClient(client, LIVE_CAPABILITIES);

		const sessionId = 'sess-mtime-turn';
		const preLoadIso = '2026-02-01T00:00:00.000Z';
		const preLoadMs = Date.parse(preLoadIso);
		const postLoadIso = '2026-11-04T20:00:00.000Z';

		const seedList = agent.listChatsToMigrate();
		const seedReq = await readNextMessage(peer.outbound);
		peer.push({
			jsonrpc: '2.0',
			id: seedReq.id,
			result: { sessions: [{ sessionId, cwd: '/tmp/proj', title: 'Turn chat', updatedAt: preLoadIso }] },
		});
		await seedList;

		const chat = URI.from({ scheme: GROK_BUILD_AGENT_PROVIDER_ID, path: '/chat/mtime-turn' });
		const context = chatContext(chat);
		const restoring = agent.getChatMetadata(chat, context, encodeGrokBuildChat({ sessionId, cwd: '/tmp/proj' }), { activation: 'restore' });
		const load = await readNextMessage(peer.outbound);
		peer.push({ jsonrpc: '2.0', id: load.id, result: {} });
		await restoring;

		const beforeSend = Date.now();
		const send = agent.chats.sendMessage(chat, 'hi', [URI.file('/tmp/proj')], undefined, 'turn-mtime', undefined, context);
		const prompt = await readNextMessage(peer.outbound);
		assert.strictEqual(prompt.method, 'session/prompt');
		peer.push({ jsonrpc: '2.0', id: prompt.id, result: { stopReason: 'end_turn' } });
		await send;
		const after = await agent.getChatMetadata(chat, context);
		assert.ok((after?.modifiedTime ?? 0) >= beforeSend);
		assert.notStrictEqual(after?.modifiedTime, preLoadMs);

		const listed = agent.listChatsToMigrate();
		const listReq = await readNextMessage(peer.outbound);
		peer.push({
			jsonrpc: '2.0',
			id: listReq.id,
			result: { sessions: [{ sessionId, cwd: '/tmp/proj', title: 'Turn chat', updatedAt: postLoadIso }] },
		});
		const chats = await listed;
		assert.ok(Array.isArray(chats));
		const row = chats.find(entry => entry.summary === 'Turn chat');
		assert.ok(row);
		// Override cleared: listing follows grok's updatedAt again.
		assert.strictEqual(row.modifiedTime, Date.parse(postLoadIso));
	});

	test('reconnect load after list refresh keeps original pre-load modifiedTime until a turn', async () => {
		const peer = store.add(makeFakePeer());
		const client = store.add(new AcpClient(peer.transport));
		const agent = createAgent();
		agent.bindTestClient(client, LIVE_CAPABILITIES);

		const sessionId = 'sess-mtime-reconnect';
		const preLoadIso = '2026-01-10T08:00:00.000Z';
		const preLoadMs = Date.parse(preLoadIso);
		const postLoadIso = '2026-11-04T19:30:00.000Z';
		const postReconnectIso = '2026-11-04T19:45:00.000Z';

		const seedList = agent.listChatsToMigrate();
		const seedReq = await readNextMessage(peer.outbound);
		peer.push({
			jsonrpc: '2.0',
			id: seedReq.id,
			result: { sessions: [{ sessionId, cwd: '/tmp/proj', title: 'Reconnect', updatedAt: preLoadIso }] },
		});
		await seedList;

		const chat = URI.from({ scheme: GROK_BUILD_AGENT_PROVIDER_ID, path: '/chat/mtime-reconnect' });
		const context = chatContext(chat);
		const restoring = agent.getChatMetadata(chat, context, encodeGrokBuildChat({ sessionId, cwd: '/tmp/proj' }), { activation: 'restore' });
		const load = await readNextMessage(peer.outbound);
		assert.strictEqual(load.method, 'session/load');
		peer.push({ jsonrpc: '2.0', id: load.id, result: {} });
		await restoring;
		assert.strictEqual((await agent.getChatMetadata(chat, context))?.modifiedTime, preLoadMs);

		// Post-load list refresh caches grok's bumped updatedAt.
		const refreshed = agent.listChatsToMigrate();
		const refreshReq = await readNextMessage(peer.outbound);
		peer.push({
			jsonrpc: '2.0',
			id: refreshReq.id,
			result: { sessions: [{ sessionId, cwd: '/tmp/proj', title: 'Reconnect', updatedAt: postLoadIso }] },
		});
		const afterRefresh = await refreshed;
		assert.ok(Array.isArray(afterRefresh));
		assert.strictEqual(afterRefresh.find(entry => entry.summary === 'Reconnect')?.modifiedTime, preLoadMs);

		// New connection generation: second load must not adopt the bumped list time.
		const peer2 = store.add(makeFakePeer());
		const client2 = store.add(new AcpClient(peer2.transport));
		agent.bindTestClient(client2, LIVE_CAPABILITIES);
		const restoring2 = agent.getChatMetadata(chat, context, undefined, { activation: 'restore' });
		const load2 = await readNextMessage(peer2.outbound);
		assert.strictEqual(load2.method, 'session/load');
		peer2.push({ jsonrpc: '2.0', id: load2.id, result: {} });
		await restoring2;
		assert.strictEqual((await agent.getChatMetadata(chat, context))?.modifiedTime, preLoadMs);

		const listedAgain = agent.listChatsToMigrate();
		const listReq2 = await readNextMessage(peer2.outbound);
		peer2.push({
			jsonrpc: '2.0',
			id: listReq2.id,
			result: { sessions: [{ sessionId, cwd: '/tmp/proj', title: 'Reconnect', updatedAt: postReconnectIso }] },
		});
		const chats = await listedAgain;
		assert.ok(Array.isArray(chats));
		const row = chats.find(entry => entry.summary === 'Reconnect');
		assert.ok(row);
		assert.strictEqual(row.modifiedTime, preLoadMs);
		assert.strictEqual(row.startTime, preLoadMs);

		const beforeSend = Date.now();
		const send = agent.chats.sendMessage(chat, 'hi', [URI.file('/tmp/proj')], undefined, 'turn-reconnect-mtime', undefined, context);
		const prompt = await readNextMessage(peer2.outbound);
		assert.strictEqual(prompt.method, 'session/prompt');
		peer2.push({ jsonrpc: '2.0', id: prompt.id, result: { stopReason: 'end_turn' } });
		await send;
		const afterTurn = await agent.getChatMetadata(chat, context);
		assert.ok((afterTurn?.modifiedTime ?? 0) >= beforeSend);
		assert.notStrictEqual(afterTurn?.modifiedTime, preLoadMs);
	});

	test('invalid or missing updatedAt lists as 0, never Date.now()', async () => {
		const peer = store.add(makeFakePeer());
		const client = store.add(new AcpClient(peer.transport));
		const agent = createAgent();
		agent.bindTestClient(client, LIVE_CAPABILITIES);
		const before = Date.now();

		const listed = agent.listChatsToMigrate();
		const listReq = await readNextMessage(peer.outbound);
		peer.push({
			jsonrpc: '2.0',
			id: listReq.id,
			result: {
				sessions: [
					{ sessionId: 'sess-no-updated', cwd: '/tmp/a', title: 'No stamp' },
					{ sessionId: 'sess-bad-updated', cwd: '/tmp/b', title: 'Bad stamp', updatedAt: 'not-a-date' },
				],
			},
		});
		const chats = await listed;
		assert.ok(Array.isArray(chats));
		assert.strictEqual(chats.length, 2);
		for (const entry of chats) {
			assert.strictEqual(entry.modifiedTime, 0);
			assert.strictEqual(entry.startTime, 0);
			assert.ok(entry.modifiedTime < before);
		}
	});

	test('changeModel and title updates do not bump modifiedTime', async () => {
		const peer = store.add(makeFakePeer());
		const client = store.add(new AcpClient(peer.transport));
		const agent = createAgent();
		agent.bindTestClient(client, LIVE_CAPABILITIES);

		const sessionId = 'sess-mtime-model';
		const preLoadIso = '2026-03-01T00:00:00.000Z';
		const preLoadMs = Date.parse(preLoadIso);

		const seedList = agent.listChatsToMigrate();
		const seedReq = await readNextMessage(peer.outbound);
		peer.push({
			jsonrpc: '2.0',
			id: seedReq.id,
			result: {
				sessions: [{ sessionId, cwd: '/tmp/proj', title: 'Model chat', updatedAt: preLoadIso }],
			},
		});
		await seedList;

		const chat = URI.from({ scheme: GROK_BUILD_AGENT_PROVIDER_ID, path: '/chat/mtime-model' });
		const context = chatContext(chat);
		const restoring = agent.getChatMetadata(chat, context, encodeGrokBuildChat({
			sessionId,
			cwd: '/tmp/proj',
			model: { id: 'grok-4.7' },
		}), { activation: 'restore' });
		const load = await readNextMessage(peer.outbound);
		peer.push({
			jsonrpc: '2.0',
			id: load.id,
			result: {
				models: {
					currentModelId: 'grok-4.7',
					availableModels: [
						{ modelId: 'grok-4.7', name: 'Grok 4.7' },
						{ modelId: 'grok-4.7-build-fast', name: 'Grok 4.7 Fast' },
					],
				},
			},
		});
		await restoring;
		assert.strictEqual((await agent.getChatMetadata(chat, context))?.modifiedTime, preLoadMs);

		pushUpdate(peer, sessionId, { sessionUpdate: 'session_info_update', title: 'Renamed live' });
		// Title updates are applied synchronously on the notification path.
		await new Promise(resolve => setImmediate(resolve));
		const afterTitle = await agent.getChatMetadata(chat, context);
		assert.strictEqual(afterTitle?.summary, 'Renamed live');
		assert.strictEqual(afterTitle?.modifiedTime, preLoadMs);

		const change = agent.chats.changeModel!(chat, { id: 'grok-4.7-build-fast' }, context);
		const setModel = await readNextMessage(peer.outbound);
		assert.strictEqual(setModel.method, 'session/set_model');
		peer.push({ jsonrpc: '2.0', id: setModel.id, result: {} });
		await change;
		const afterModel = await agent.getChatMetadata(chat, context);
		assert.strictEqual(afterModel?.model?.id, 'grok-4.7-build-fast');
		assert.strictEqual(afterModel?.modifiedTime, preLoadMs);
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
		assert.strictEqual(resume.params.sessionId, 'sess-resume');
		assert.strictEqual(resume.params.cwd, '/tmp/proj');
		assertClientToolsMcpServer(resume.params.mcpServers);
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
		assert.strictEqual(load.params.sessionId, 'sess-crash');
		assert.strictEqual(load.params.cwd, '/tmp/proj');
		assertClientToolsMcpServer(load.params.mcpServers);
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
		// Turn end may re-persist providerData (contextTokens); cwd must stay /tmp/a.
		assert.deepStrictEqual(changes.slice(0, persisted.length), persisted);
		for (const blob of changes) {
			assert.strictEqual(decodeGrokBuildChat(blob)?.cwd, '/tmp/a');
		}
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
		assert.strictEqual(load.params.sessionId, sessionId);
		assert.strictEqual(load.params.cwd, '/tmp/proj');
		assertClientToolsMcpServer(load.params.mcpServers);
		peer.push({
			jsonrpc: '2.0',
			id: load.id,
			result: { models: { currentModelId: 'grok-4.7', availableModels: [{ modelId: 'grok-4.7', name: 'Grok 4.7' }] }, configOptions: [] },
		});
		const result = await recovered;
		const decoded = decodeGrokBuildChat(result.providerData);
		assert.strictEqual(decoded?.sessionId, sessionId);
		assert.strictEqual(decoded?.cwd, '/tmp/proj');
		// CLI currentModelId is not pinned into providerData.model.
		assert.strictEqual(decoded?.model, undefined);
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
		assert.strictEqual(load.params.sessionId, 'sess-title');
		assert.strictEqual(load.params.cwd, '/tmp/proj');
		assertClientToolsMcpServer(load.params.mcpServers);
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
		assert.strictEqual(decoded?.model, undefined);
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
		assert.strictEqual(load.params.sessionId, sessionId);
		assert.strictEqual(load.params.cwd, '/tmp/proj');
		assertClientToolsMcpServer(load.params.mcpServers);
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
		assert.strictEqual(load2.params.sessionId, session2);
		assert.strictEqual(load2.params.cwd, '/tmp/other');
		assertClientToolsMcpServer(load2.params.mcpServers);
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
		assert.strictEqual(load.params.sessionId, '00000000-0000-0000-0000-000000000000');
		assert.strictEqual(load.params.cwd, '/tmp/proj');
		assertClientToolsMcpServer(load.params.mcpServers);
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

	test('getChatMetadata restore opens a session known only from session/list at its own cwd', async () => {
		const peer = store.add(makeFakePeer());
		const client = store.add(new AcpClient(peer.transport));
		const agent = createAgent();
		agent.bindTestClient(client, LIVE_CAPABILITIES);
		const sessionId = '01a19b21-3ef2-7d01-b5ea-12a2b30fa7d4';
		const chat = URI.from({ scheme: GROK_BUILD_AGENT_PROVIDER_ID, path: `/chat/${sessionId}` });
		const context = chatContextForSession(chat, sessionId);

		const restoring = agent.getChatMetadata(chat, context, undefined, { activation: 'restore' });
		const list = await readNextMessage(peer.outbound);
		assert.strictEqual(list.method, 'session/list');
		assert.deepStrictEqual(list.params, {});
		peer.push({
			jsonrpc: '2.0',
			id: list.id,
			result: {
				sessions: [{ sessionId, cwd: '/tmp/other-cli-cwd', title: 'CLI session', updatedAt: '2026-03-01T00:00:00.000Z' }],
			},
		});
		const load = await readNextMessage(peer.outbound);
		assert.strictEqual(load.method, 'session/load');
		assert.strictEqual(load.params.sessionId, sessionId);
		assert.strictEqual(load.params.cwd, '/tmp/other-cli-cwd');
		assertClientToolsMcpServer(load.params.mcpServers);
		pushUpdate(peer, sessionId, { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'hello from cli' }, _meta: { promptIndex: 0 } });
		pushUpdate(peer, sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi' }, _meta: { promptIndex: 0 } });
		peer.push({
			jsonrpc: '2.0',
			id: load.id,
			result: { models: { currentModelId: 'grok-4.7', availableModels: [{ modelId: 'grok-4.7', name: 'Grok 4.7' }] }, configOptions: [] },
		});
		const metadata = await restoring;
		assert.strictEqual(metadata?.summary, 'CLI session');
		assert.strictEqual(metadata?.model?.id, 'grok-4.7');
		assert.strictEqual(metadata?.workingDirectories?.[0].fsPath, '/tmp/other-cli-cwd');
		const history = await agent.chats.getMessages(chat, context);
		assert.deepStrictEqual(history.map(turn => ({ text: turn.message.text, markdown: markdownOf(turn) })), [
			{ text: 'hello from cli', markdown: 'hi' },
		]);
		assert.strictEqual(await readIfAny(peer.outbound), undefined);
	});

	test('getChatMetadata restore of a vanished folder is AHP_SESSION_NOT_FOUND, not a silent miss', async () => {
		const peer = store.add(makeFakePeer());
		const client = store.add(new AcpClient(peer.transport));
		const agent = createAgent();
		agent.bindTestClient(client, LIVE_CAPABILITIES);
		const sessionId = 'vanished-folder-session';
		const chat = URI.from({ scheme: GROK_BUILD_AGENT_PROVIDER_ID, path: `/chat/${sessionId}` });
		const context = chatContextForSession(chat, sessionId);

		const restoring = agent.getChatMetadata(chat, context, undefined, { activation: 'restore' });
		const list = await readNextMessage(peer.outbound);
		assert.strictEqual(list.method, 'session/list');
		peer.push({
			jsonrpc: '2.0',
			id: list.id,
			result: { sessions: [{ sessionId, cwd: '/tmp/gone', title: 'Gone folder' }] },
		});
		const load = await readNextMessage(peer.outbound);
		assert.strictEqual(load.method, 'session/load');
		assert.strictEqual(load.params.sessionId, sessionId);
		assert.strictEqual(load.params.cwd, '/tmp/gone');
		assertClientToolsMcpServer(load.params.mcpServers);
		peer.push({
			jsonrpc: '2.0',
			id: load.id,
			error: { code: -32603, message: 'Path not found.', data: { detail: 'No such file or directory (os error 2)', code: 'FS_NOT_FOUND' } },
		});
		await assert.rejects(restoring, (err: unknown) => {
			assert.ok(err instanceof ProtocolError);
			assert.strictEqual(err.code, AHP_SESSION_NOT_FOUND);
			assert.strictEqual(err.message, grokSessionMissingError().message);
			return true;
		});
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

	test('exit_plan_mode review content matches planContent; approve/feedback/abandon map correctly', async () => {
		const peer = store.add(makeFakePeer());
		const client = store.add(new AcpClient(peer.transport));
		const agent = createAgent();
		agent.bindTestClient(client);
		const chat = URI.from({ scheme: GROK_BUILD_AGENT_PROVIDER_ID, path: '/chat/exit-plan' });
		const context = chatContext(chat);
		const signals: AgentSignal[] = [];
		store.add(agent.onDidChatProgress(signal => signals.push(signal)));

		const create = agent.chats.createChat(chat, context, { workingDirectories: [URI.file('/tmp/plan-cwd')] });
		const sessionNew = await readNextMessage(peer.outbound);
		peer.push({ jsonrpc: '2.0', id: sessionNew.id, result: { sessionId: 'sess-exit-plan', models: { currentModelId: 'm', availableModels: [{ modelId: 'm', name: 'm' }] } } });
		await create;

		const send = agent.chats.sendMessage(chat, 'make a plan', [URI.file('/tmp/plan-cwd')], undefined, 'turn-exit-plan', undefined, context);
		const prompt = await readNextMessage(peer.outbound);
		assert.strictEqual(prompt.method, 'session/prompt');

		pushUpdate(peer, 'sess-exit-plan', {
			sessionUpdate: 'tool_call',
			toolCallId: 'call-exit-1',
			title: 'exit_plan_mode',
			rawInput: {},
			_meta: { 'x.ai/tool': { name: 'exit_plan_mode', kind: 'exit_plan', label: 'Exit Plan Mode', read_only: true } },
		});
		const planContent = '# Add README\n\n- append README\n';
		peer.push({
			jsonrpc: '2.0',
			id: 50,
			method: '_x.ai/exit_plan_mode',
			params: { sessionId: 'sess-exit-plan', toolCallId: 'call-exit-1', planContent },
		});
		await new Promise(r => setTimeout(r, 30));

		const requested = signals.find(signal => signal.kind === 'action' && signal.action.type === ActionType.ChatInputRequested);
		assert.ok(requested && requested.kind === 'action' && requested.action.type === ActionType.ChatInputRequested);
		const request = requested.action.request as ChatInputRequestWithPlanReview;
		assert.strictEqual(readChatInputRequestPurpose(request), ChatInputRequestPurpose.PlanReview);
		assert.strictEqual(request.planReview?.content, planContent);
		assert.ok(request.planReview?.actions.every(action => action.permissionLevel !== 'autopilot'));
		assert.ok(request.planReview?.actions.some(action => action.id === 'approve' && /implement plan/i.test(action.label)));
		assert.ok(request.planReview?.actions.some(action => action.id === 'abandon'));
		assert.ok(!request.planReview?.actions.some(action => /autopilot|allow.?all|always/i.test(action.id + action.label)));

		const questionId = request.planReview!.answerQuestionId;
		agent.respondToUserInputRequest(request.id, ChatInputResponseKind.Accept, {
			[questionId]: {
				state: ChatInputAnswerState.Submitted,
				value: { kind: ChatInputAnswerValueKind.Selected, value: 'approve' },
			},
		});
		const approved = await readNextMessage(peer.outbound);
		assert.strictEqual(approved.id, 50);
		assert.deepStrictEqual(approved.result, { outcome: 'approved' });

		peer.push({
			jsonrpc: '2.0',
			id: 51,
			method: '_x.ai/exit_plan_mode',
			params: { sessionId: 'sess-exit-plan', toolCallId: 'call-exit-2', planContent: '# revised' },
		});
		await new Promise(r => setTimeout(r, 30));
		const reviseRequest = signals.map(s => s.kind === 'action' && s.action.type === ActionType.ChatInputRequested ? s.action.request as ChatInputRequestWithPlanReview : undefined)
			.filter((r): r is ChatInputRequestWithPlanReview => !!r)
			.at(-1)!;
		agent.respondToUserInputRequest(reviseRequest.id, ChatInputResponseKind.Accept, {
			[reviseRequest.planReview!.answerQuestionId]: {
				state: ChatInputAnswerState.Submitted,
				value: { kind: ChatInputAnswerValueKind.Selected, value: 'approve', freeformValues: ['Use DOCS'] },
			},
		});
		const revised = await readNextMessage(peer.outbound);
		assert.strictEqual(revised.id, 51);
		assert.deepStrictEqual(revised.result, { outcome: 'revise', feedback: 'Use DOCS' });

		peer.push({
			jsonrpc: '2.0',
			id: 52,
			method: '_x.ai/exit_plan_mode',
			params: { sessionId: 'sess-exit-plan', toolCallId: 'call-exit-3', planContent: '# abandon me' },
		});
		await new Promise(r => setTimeout(r, 30));
		const abandonRequest = signals.map(s => s.kind === 'action' && s.action.type === ActionType.ChatInputRequested ? s.action.request as ChatInputRequestWithPlanReview : undefined)
			.filter((r): r is ChatInputRequestWithPlanReview => !!r)
			.at(-1)!;
		agent.respondToUserInputRequest(abandonRequest.id, ChatInputResponseKind.Accept, {
			[abandonRequest.planReview!.answerQuestionId]: {
				state: ChatInputAnswerState.Submitted,
				value: { kind: ChatInputAnswerValueKind.Selected, value: 'abandon' },
			},
		});
		const abandoned = await readNextMessage(peer.outbound);
		assert.strictEqual(abandoned.id, 52);
		assert.deepStrictEqual(abandoned.result, { outcome: 'abandoned' });

		peer.push({ jsonrpc: '2.0', id: prompt.id, result: { stopReason: 'end_turn' } });
		await send;
	});

	test('exit_plan_mode decline/skip/unknown/no turn/unknown session never approve', async () => {
		const peer = store.add(makeFakePeer());
		const client = store.add(new AcpClient(peer.transport));
		const agent = createAgent();
		agent.bindTestClient(client);
		const chat = URI.from({ scheme: GROK_BUILD_AGENT_PROVIDER_ID, path: '/chat/exit-plan-failclosed' });
		const context = chatContext(chat);
		const signals: AgentSignal[] = [];
		store.add(agent.onDidChatProgress(signal => signals.push(signal)));

		const create = agent.chats.createChat(chat, context, { workingDirectories: [URI.file('/tmp')] });
		const sessionNew = await readNextMessage(peer.outbound);
		peer.push({ jsonrpc: '2.0', id: sessionNew.id, result: { sessionId: 'sess-failclosed', models: { currentModelId: 'm', availableModels: [{ modelId: 'm', name: 'm' }] } } });
		await create;

		peer.push({
			jsonrpc: '2.0',
			id: 60,
			method: '_x.ai/exit_plan_mode',
			params: { sessionId: 'unknown-session', toolCallId: 'c', planContent: '# x' },
		});
		const unknownSession = await readNextMessage(peer.outbound);
		assert.deepStrictEqual(unknownSession.result, { outcome: 'revise' });

		peer.push({
			jsonrpc: '2.0',
			id: 61,
			method: '_x.ai/exit_plan_mode',
			params: { sessionId: 'sess-failclosed', toolCallId: 'c', planContent: '# x' },
		});
		const noTurn = await readNextMessage(peer.outbound);
		assert.deepStrictEqual(noTurn.result, { outcome: 'revise' });

		const send = agent.chats.sendMessage(chat, 'plan', [URI.file('/tmp')], undefined, 'turn-failclosed', undefined, context);
		const prompt = await readNextMessage(peer.outbound);
		pushUpdate(peer, 'sess-failclosed', {
			sessionUpdate: 'tool_call',
			toolCallId: 'call-fc',
			rawInput: {},
			_meta: { 'x.ai/tool': { name: 'exit_plan_mode', kind: 'exit_plan' } },
		});

		const cases: Array<{ id: number; response: ChatInputResponseKind; answers?: Record<string, ChatInputAnswer> }> = [
			{ id: 62, response: ChatInputResponseKind.Decline },
			{ id: 63, response: ChatInputResponseKind.Cancel },
			{ id: 64, response: ChatInputResponseKind.Accept, answers: undefined },
			{
				id: 65,
				response: ChatInputResponseKind.Accept,
				answers: {
					placeholder: {
						state: ChatInputAnswerState.Skipped,
					},
				},
			},
			{
				id: 66,
				response: ChatInputResponseKind.Accept,
				answers: {
					placeholder: {
						state: ChatInputAnswerState.Submitted,
						value: { kind: ChatInputAnswerValueKind.Selected, value: 'mystery' },
					},
				},
			},
		];

		for (const testCase of cases) {
			peer.push({
				jsonrpc: '2.0',
				id: testCase.id,
				method: '_x.ai/exit_plan_mode',
				params: { sessionId: 'sess-failclosed', toolCallId: `call-${testCase.id}`, planContent: '# x' },
			});
			await new Promise(r => setTimeout(r, 20));
			const request = signals.map(s => s.kind === 'action' && s.action.type === ActionType.ChatInputRequested ? s.action.request as ChatInputRequestWithPlanReview : undefined)
				.filter((r): r is ChatInputRequestWithPlanReview => !!r)
				.at(-1)!;
			const answers = testCase.answers
				? Object.fromEntries(Object.entries(testCase.answers).map(([, answer]) => [request.planReview!.answerQuestionId, answer]))
				: testCase.response === ChatInputResponseKind.Accept && testCase.id === 64
					? undefined
					: testCase.answers;
			agent.respondToUserInputRequest(request.id, testCase.response, answers);
			const reply = await readNextMessage(peer.outbound);
			assert.strictEqual(reply.id, testCase.id);
			assert.deepStrictEqual(reply.result, { outcome: 'revise' }, `case ${testCase.id}`);
		}

		peer.push({ jsonrpc: '2.0', id: prompt.id, result: { stopReason: 'cancelled' } });
		await send;
	});

	test('cancel/dispose while exit_plan_mode pending resolves revise and closes the tool card', async () => {
		const peer = store.add(makeFakePeer());
		const client = store.add(new AcpClient(peer.transport));
		const agent = createAgent();
		agent.bindTestClient(client);
		const chat = URI.from({ scheme: GROK_BUILD_AGENT_PROVIDER_ID, path: '/chat/exit-plan-cancel' });
		const context = chatContext(chat);
		const signals: AgentSignal[] = [];
		store.add(agent.onDidChatProgress(signal => signals.push(signal)));

		const create = agent.chats.createChat(chat, context, { workingDirectories: [URI.file('/tmp')] });
		const sessionNew = await readNextMessage(peer.outbound);
		peer.push({ jsonrpc: '2.0', id: sessionNew.id, result: { sessionId: 'sess-exit-cancel', models: { currentModelId: 'm', availableModels: [{ modelId: 'm', name: 'm' }] } } });
		await create;

		const send = agent.chats.sendMessage(chat, 'plan', [URI.file('/tmp')], undefined, 'turn-exit-cancel', undefined, context);
		const prompt = await readNextMessage(peer.outbound);
		pushUpdate(peer, 'sess-exit-cancel', {
			sessionUpdate: 'tool_call',
			toolCallId: 'call-cancel-exit',
			rawInput: {},
			_meta: { 'x.ai/tool': { name: 'exit_plan_mode', kind: 'exit_plan' } },
		});
		peer.push({
			jsonrpc: '2.0',
			id: 70,
			method: '_x.ai/exit_plan_mode',
			params: { sessionId: 'sess-exit-cancel', toolCallId: 'call-cancel-exit', planContent: '# cancel me' },
		});
		await new Promise(r => setTimeout(r, 30));
		assert.ok(signals.some(signal => signal.kind === 'action' && signal.action.type === ActionType.ChatInputRequested));

		const outbound: any[] = [];
		const onOutbound = (chunk: Buffer | string) => {
			const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
			for (const line of text.split('\n')) {
				const trimmed = line.trim();
				if (!trimmed) {
					continue;
				}
				try {
					outbound.push(JSON.parse(trimmed));
				} catch {
					outbound.push({ raw: trimmed });
				}
			}
		};
		peer.outbound.on('data', onOutbound);
		try {
			await agent.chats.abort(chat, context);
			await new Promise(r => setTimeout(r, 20));
		} finally {
			peer.outbound.off('data', onOutbound);
		}
		assert.ok(signals.some(signal =>
			signal.kind === 'action'
			&& signal.action.type === ActionType.ChatInputCompleted
			&& signal.action.response === ChatInputResponseKind.Cancel
		), 'expected plan review UI dismissal');
		assert.ok(signals.some(signal =>
			signal.kind === 'action'
			&& signal.action.type === ActionType.ChatToolCallComplete
			&& signal.action.toolCallId === 'call-cancel-exit'
			&& signal.action.result.success === false
		), 'expected local exit_plan tool card cancellation');
		assert.ok(
			outbound.some(message => message.method === 'session/cancel'),
			`expected session/cancel among ${JSON.stringify(outbound)}`,
		);
		assert.ok(
			outbound.some(message => message.id === 70 && message.result?.outcome === 'revise'),
			`expected revise reply among ${JSON.stringify(outbound)}`,
		);

		peer.push({ jsonrpc: '2.0', id: prompt.id, result: { stopReason: 'cancelled' } });
		await send;
	});

	test('approved exit_plan_mode + current_mode_update default writes interactive chat mode', async () => {
		const patches: Array<{ target: IAgentChatConfigurationTarget; patch: Record<string, unknown> }> = [];
		const peer = store.add(makeFakePeer());
		const client = store.add(new AcpClient(peer.transport));
		const agent = createAgent(new NullLogService(), {
			getChatConfigValues: () => ({ [SessionConfigKey.Mode]: 'plan' }),
			configPatches: patches,
		});
		agent.bindTestClient(client);
		const chat = URI.from({ scheme: GROK_BUILD_AGENT_PROVIDER_ID, path: '/chat/exit-plan-mode-sync' });
		const context = chatContext(chat);
		const signals: AgentSignal[] = [];
		store.add(agent.onDidChatProgress(signal => signals.push(signal)));

		const create = agent.chats.createChat(chat, context, {
			workingDirectories: [URI.file('/tmp')],
			config: { [SessionConfigKey.Mode]: 'plan' },
		});
		const sessionNew = await readNextMessage(peer.outbound);
		peer.push({ jsonrpc: '2.0', id: sessionNew.id, result: { sessionId: 'sess-mode-sync', models: { currentModelId: 'm', availableModels: [{ modelId: 'm', name: 'm' }] } } });
		const setMode = await readNextMessage(peer.outbound);
		assert.deepStrictEqual(setMode.params, { sessionId: 'sess-mode-sync', modeId: 'plan' });
		peer.push({ jsonrpc: '2.0', id: setMode.id, result: {} });
		await create;

		const send = agent.chats.sendMessage(chat, 'plan', [URI.file('/tmp')], undefined, 'turn-mode-sync', undefined, context);
		const prompt = await readNextMessage(peer.outbound);
		assert.strictEqual(prompt.method, 'session/prompt');
		pushUpdate(peer, 'sess-mode-sync', {
			sessionUpdate: 'tool_call',
			toolCallId: 'call-mode-sync',
			rawInput: {},
			_meta: { 'x.ai/tool': { name: 'exit_plan_mode', kind: 'exit_plan' } },
		});
		peer.push({
			jsonrpc: '2.0',
			id: 80,
			method: '_x.ai/exit_plan_mode',
			params: { sessionId: 'sess-mode-sync', toolCallId: 'call-mode-sync', planContent: '# sync' },
		});
		await new Promise(r => setTimeout(r, 30));
		const request = signals.map(s => s.kind === 'action' && s.action.type === ActionType.ChatInputRequested ? s.action.request as ChatInputRequestWithPlanReview : undefined)
			.filter((r): r is ChatInputRequestWithPlanReview => !!r)
			.at(-1)!;
		agent.respondToUserInputRequest(request.id, ChatInputResponseKind.Accept, {
			[request.planReview!.answerQuestionId]: {
				state: ChatInputAnswerState.Submitted,
				value: { kind: ChatInputAnswerValueKind.Selected, value: 'approve' },
			},
		});
		const approved = await readNextMessage(peer.outbound);
		assert.deepStrictEqual(approved.result, { outcome: 'approved' });
		pushUpdate(peer, 'sess-mode-sync', { sessionUpdate: 'current_mode_update', currentModeId: 'default' });
		await new Promise(r => setTimeout(r, 20));
		assert.ok(patches.some(entry => entry.patch[SessionConfigKey.Mode] === 'interactive'));
		assert.deepStrictEqual([...GROK_BUILD_ACP_ARGV], ['--no-auto-update', '--permission-mode', 'default', 'agent', '--no-leader', 'stdio']);

		peer.push({ jsonrpc: '2.0', id: prompt.id, result: { stopReason: 'end_turn' } });
		await send;
	});

	test('ask_user_question accepted single / multi-select / free text map by question text', async () => {
		const peer = store.add(makeFakePeer());
		const client = store.add(new AcpClient(peer.transport));
		const agent = createAgent();
		agent.bindTestClient(client);
		const chat = URI.from({ scheme: GROK_BUILD_AGENT_PROVIDER_ID, path: '/chat/ask-user' });
		const context = chatContext(chat);
		const signals: AgentSignal[] = [];
		store.add(agent.onDidChatProgress(signal => signals.push(signal)));

		const create = agent.chats.createChat(chat, context, { workingDirectories: [URI.file('/tmp/ask-cwd')] });
		const sessionNew = await readNextMessage(peer.outbound);
		peer.push({ jsonrpc: '2.0', id: sessionNew.id, result: { sessionId: 'sess-ask', models: { currentModelId: 'm', availableModels: [{ modelId: 'm', name: 'm' }] } } });
		await create;

		const send = agent.chats.sendMessage(chat, 'ask me', [URI.file('/tmp/ask-cwd')], undefined, 'turn-ask', undefined, context);
		const prompt = await readNextMessage(peer.outbound);
		assert.strictEqual(prompt.method, 'session/prompt');
		pushUpdate(peer, 'sess-ask', {
			sessionUpdate: 'tool_call',
			toolCallId: 'call-ask-1',
			title: 'ask_user_question',
			rawInput: { questions: [] },
			_meta: { 'x.ai/tool': { name: 'ask_user_question', kind: 'ask_user', label: 'Ask User', read_only: true } },
		});

		const qSingle = 'Which of the two options do you prefer?';
		const qMulti = 'Pick any that apply';
		const qFree = 'Anything else?';
		peer.push({
			jsonrpc: '2.0',
			id: 90,
			method: '_x.ai/ask_user_question',
			params: {
				sessionId: 'sess-ask',
				toolCallId: 'call-ask-1',
				mode: 'default',
				questions: [
					{
						question: qSingle,
						options: [{ label: 'A', description: 'Option A' }, { label: 'B', description: 'Option B' }],
						multiSelect: null,
					},
					{
						question: qMulti,
						options: [{ label: 'X', description: 'ex' }, { label: 'Y', description: 'why' }],
						multiSelect: true,
					},
					{
						question: qFree,
						options: [{ label: 'None', description: 'nothing' }],
						multiSelect: false,
					},
				],
			},
		});
		await new Promise(r => setTimeout(r, 30));

		const requested = signals.find(signal => signal.kind === 'action' && signal.action.type === ActionType.ChatInputRequested);
		assert.ok(requested && requested.kind === 'action' && requested.action.type === ActionType.ChatInputRequested);
		const request = requested.action.request as ChatInputRequest;
		assert.strictEqual(readChatInputRequestPurpose(request), ChatInputRequestPurpose.AskUser);
		assert.strictEqual(request.questions?.length, 4);
		assert.strictEqual(request.questions?.[0].kind, ChatInputQuestionKind.SingleSelect);
		assert.strictEqual(request.questions?.[0].message, qSingle);
		assert.ok(request.questions?.[0].kind === ChatInputQuestionKind.SingleSelect && request.questions[0].allowFreeformInput);
		assert.strictEqual(request.questions?.[1].kind, ChatInputQuestionKind.MultiSelect);
		assert.strictEqual(request.questions?.[2].kind, ChatInputQuestionKind.SingleSelect);
		assert.strictEqual(request.questions?.[3].id, 'grok-ask-user-skip');

		agent.respondToUserInputRequest(request.id, ChatInputResponseKind.Accept, {
			'q-0': {
				state: ChatInputAnswerState.Submitted,
				value: { kind: ChatInputAnswerValueKind.Selected, value: 'B' },
			},
			'q-1': {
				state: ChatInputAnswerState.Submitted,
				value: { kind: ChatInputAnswerValueKind.SelectedMany, value: ['X', 'Y'] },
			},
			'q-2': {
				state: ChatInputAnswerState.Submitted,
				value: { kind: ChatInputAnswerValueKind.Selected, value: 'None', freeformValues: ['Ship it tomorrow'] },
			},
		});
		const accepted = await readNextMessage(peer.outbound);
		assert.strictEqual(accepted.id, 90);
		assert.deepStrictEqual(accepted.result, {
			outcome: 'accepted',
			answers: {
				[qSingle]: 'B',
				[qMulti]: ['X', 'Y'],
				[qFree]: 'Ship it tomorrow',
			},
		});

		peer.push({ jsonrpc: '2.0', id: prompt.id, result: { stopReason: 'end_turn' } });
		await send;
	});

	test('ask_user_question skip_interview and decline/cancel map correctly', async () => {
		const peer = store.add(makeFakePeer());
		const client = store.add(new AcpClient(peer.transport));
		const agent = createAgent();
		agent.bindTestClient(client);
		const chat = URI.from({ scheme: GROK_BUILD_AGENT_PROVIDER_ID, path: '/chat/ask-user-skip' });
		const context = chatContext(chat);
		const signals: AgentSignal[] = [];
		store.add(agent.onDidChatProgress(signal => signals.push(signal)));

		const create = agent.chats.createChat(chat, context, { workingDirectories: [URI.file('/tmp')] });
		const sessionNew = await readNextMessage(peer.outbound);
		peer.push({ jsonrpc: '2.0', id: sessionNew.id, result: { sessionId: 'sess-ask-skip', models: { currentModelId: 'm', availableModels: [{ modelId: 'm', name: 'm' }] } } });
		await create;

		const send = agent.chats.sendMessage(chat, 'ask', [URI.file('/tmp')], undefined, 'turn-ask-skip', undefined, context);
		const prompt = await readNextMessage(peer.outbound);
		pushUpdate(peer, 'sess-ask-skip', {
			sessionUpdate: 'tool_call',
			toolCallId: 'call-ask-skip',
			rawInput: {},
			_meta: { 'x.ai/tool': { name: 'ask_user_question', kind: 'ask_user' } },
		});

		const askParams = {
			sessionId: 'sess-ask-skip',
			toolCallId: 'call-ask-skip',
			mode: 'plan',
			questions: [{
				question: 'Ready?',
				options: [{ label: 'Yes', description: 'y' }, { label: 'No', description: 'n' }],
				multiSelect: null,
			}],
		};

		peer.push({ jsonrpc: '2.0', id: 91, method: '_x.ai/ask_user_question', params: askParams });
		await new Promise(r => setTimeout(r, 20));
		let request = signals.map(s => s.kind === 'action' && s.action.type === ActionType.ChatInputRequested ? s.action.request as ChatInputRequest : undefined)
			.filter((r): r is ChatInputRequest => !!r)
			.at(-1)!;
		agent.respondToUserInputRequest(request.id, ChatInputResponseKind.Accept, {
			'grok-ask-user-skip': {
				state: ChatInputAnswerState.Submitted,
				value: { kind: ChatInputAnswerValueKind.Selected, value: 'skip' },
			},
		});
		const skipped = await readNextMessage(peer.outbound);
		assert.deepStrictEqual(skipped.result, { outcome: 'skip_interview' });

		peer.push({ jsonrpc: '2.0', id: 92, method: '_x.ai/ask_user_question', params: { ...askParams, toolCallId: 'call-ask-empty' } });
		await new Promise(r => setTimeout(r, 20));
		request = signals.map(s => s.kind === 'action' && s.action.type === ActionType.ChatInputRequested ? s.action.request as ChatInputRequest : undefined)
			.filter((r): r is ChatInputRequest => !!r)
			.at(-1)!;
		agent.respondToUserInputRequest(request.id, ChatInputResponseKind.Accept, {});
		const emptySkip = await readNextMessage(peer.outbound);
		assert.deepStrictEqual(emptySkip.result, { outcome: 'skip_interview' });

		peer.push({ jsonrpc: '2.0', id: 93, method: '_x.ai/ask_user_question', params: { ...askParams, toolCallId: 'call-ask-decline' } });
		await new Promise(r => setTimeout(r, 20));
		request = signals.map(s => s.kind === 'action' && s.action.type === ActionType.ChatInputRequested ? s.action.request as ChatInputRequest : undefined)
			.filter((r): r is ChatInputRequest => !!r)
			.at(-1)!;
		agent.respondToUserInputRequest(request.id, ChatInputResponseKind.Decline);
		const declined = await readNextMessage(peer.outbound);
		assert.deepStrictEqual(declined.result, { outcome: 'cancelled' });

		peer.push({ jsonrpc: '2.0', id: 94, method: '_x.ai/ask_user_question', params: { ...askParams, toolCallId: 'call-ask-cancel' } });
		await new Promise(r => setTimeout(r, 20));
		request = signals.map(s => s.kind === 'action' && s.action.type === ActionType.ChatInputRequested ? s.action.request as ChatInputRequest : undefined)
			.filter((r): r is ChatInputRequest => !!r)
			.at(-1)!;
		agent.respondToUserInputRequest(request.id, ChatInputResponseKind.Cancel);
		const cancelled = await readNextMessage(peer.outbound);
		assert.deepStrictEqual(cancelled.result, { outcome: 'cancelled' });

		peer.push({ jsonrpc: '2.0', id: prompt.id, result: { stopReason: 'end_turn' } });
		await send;
	});

	test('ask_user_question malformed / unknown session / no turn fail closed; cancel-while-pending cleans up', async () => {
		const peer = store.add(makeFakePeer());
		const client = store.add(new AcpClient(peer.transport));
		const agent = createAgent();
		agent.bindTestClient(client);
		const chat = URI.from({ scheme: GROK_BUILD_AGENT_PROVIDER_ID, path: '/chat/ask-user-fail' });
		const context = chatContext(chat);
		const signals: AgentSignal[] = [];
		store.add(agent.onDidChatProgress(signal => signals.push(signal)));

		const create = agent.chats.createChat(chat, context, { workingDirectories: [URI.file('/tmp')] });
		const sessionNew = await readNextMessage(peer.outbound);
		peer.push({ jsonrpc: '2.0', id: sessionNew.id, result: { sessionId: 'sess-ask-fail', models: { currentModelId: 'm', availableModels: [{ modelId: 'm', name: 'm' }] } } });
		await create;

		peer.push({
			jsonrpc: '2.0',
			id: 100,
			method: '_x.ai/ask_user_question',
			params: { sessionId: 'sess-ask-fail', toolCallId: 'c', mode: 'default', questions: 'nope' },
		});
		const malformed = await readNextMessage(peer.outbound);
		assert.strictEqual(malformed.id, 100);
		assert.strictEqual(malformed.error?.code, -32602);

		peer.push({
			jsonrpc: '2.0',
			id: 101,
			method: '_x.ai/ask_user_question',
			params: {
				sessionId: 'unknown',
				toolCallId: 'c',
				mode: 'default',
				questions: [{ question: 'Q?', options: [{ label: 'A', description: 'a' }], multiSelect: null }],
			},
		});
		const unknownSession = await readNextMessage(peer.outbound);
		assert.deepStrictEqual(unknownSession.result, { outcome: 'cancelled' });

		peer.push({
			jsonrpc: '2.0',
			id: 102,
			method: '_x.ai/ask_user_question',
			params: {
				sessionId: 'sess-ask-fail',
				toolCallId: 'c',
				mode: 'default',
				questions: [{ question: 'Q?', options: [{ label: 'A', description: 'a' }], multiSelect: null }],
			},
		});
		const noTurn = await readNextMessage(peer.outbound);
		assert.deepStrictEqual(noTurn.result, { outcome: 'cancelled' });

		const send = agent.chats.sendMessage(chat, 'ask', [URI.file('/tmp')], undefined, 'turn-ask-fail', undefined, context);
		const prompt = await readNextMessage(peer.outbound);
		pushUpdate(peer, 'sess-ask-fail', {
			sessionUpdate: 'tool_call',
			toolCallId: 'call-ask-pending',
			rawInput: {},
			_meta: { 'x.ai/tool': { name: 'ask_user_question', kind: 'ask_user' } },
		});
		peer.push({
			jsonrpc: '2.0',
			id: 103,
			method: '_x.ai/ask_user_question',
			params: {
				sessionId: 'sess-ask-fail',
				toolCallId: 'call-ask-pending',
				mode: 'default',
				questions: [{ question: 'Pending?', options: [{ label: 'A', description: 'a' }], multiSelect: null }],
			},
		});
		await new Promise(r => setTimeout(r, 30));
		assert.ok(signals.some(signal => signal.kind === 'action' && signal.action.type === ActionType.ChatInputRequested));

		const outbound: any[] = [];
		const onOutbound = (chunk: Buffer | string) => {
			const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
			for (const line of text.split('\n')) {
				const trimmed = line.trim();
				if (!trimmed) {
					continue;
				}
				try {
					outbound.push(JSON.parse(trimmed));
				} catch {
					outbound.push({ raw: trimmed });
				}
			}
		};
		peer.outbound.on('data', onOutbound);
		try {
			await agent.chats.abort(chat, context);
			await new Promise(r => setTimeout(r, 20));
		} finally {
			peer.outbound.off('data', onOutbound);
		}
		assert.ok(signals.some(signal =>
			signal.kind === 'action'
			&& signal.action.type === ActionType.ChatInputCompleted
			&& signal.action.response === ChatInputResponseKind.Cancel
		), 'expected ask-user UI dismissal');
		assert.ok(signals.some(signal =>
			signal.kind === 'action'
			&& signal.action.type === ActionType.ChatToolCallComplete
			&& signal.action.toolCallId === 'call-ask-pending'
			&& signal.action.result.success === false
		), 'expected local ask_user tool card cancellation');
		assert.ok(outbound.some(message => message.method === 'session/cancel'));
		assert.ok(
			outbound.some(message => message.id === 103 && message.result?.outcome === 'cancelled'),
			`expected cancelled reply among ${JSON.stringify(outbound)}`,
		);

		// Late reply after cleanup must not throw.
		const request = signals.map(s => s.kind === 'action' && s.action.type === ActionType.ChatInputRequested ? s.action.request as ChatInputRequest : undefined)
			.filter((r): r is ChatInputRequest => !!r)
			.at(-1)!;
		agent.respondToUserInputRequest(request.id, ChatInputResponseKind.Accept, {
			'q-0': {
				state: ChatInputAnswerState.Submitted,
				value: { kind: ChatInputAnswerValueKind.Selected, value: 'A' },
			},
		});

		peer.push({ jsonrpc: '2.0', id: prompt.id, result: { stopReason: 'cancelled' } });
		await send;
	});

	test('ask_user_question terminal tool_call_update abandons UI without ACP reply', async () => {
		const peer = store.add(makeFakePeer());
		const client = store.add(new AcpClient(peer.transport));
		const agent = createAgent();
		agent.bindTestClient(client);
		const chat = URI.from({ scheme: GROK_BUILD_AGENT_PROVIDER_ID, path: '/chat/ask-timeout' });
		const context = chatContext(chat);
		const signals: AgentSignal[] = [];
		store.add(agent.onDidChatProgress(signal => signals.push(signal)));

		const create = agent.chats.createChat(chat, context, { workingDirectories: [URI.file('/tmp')] });
		const sessionNew = await readNextMessage(peer.outbound);
		peer.push({ jsonrpc: '2.0', id: sessionNew.id, result: { sessionId: 'sess-ask-timeout', models: { currentModelId: 'm', availableModels: [{ modelId: 'm', name: 'm' }] } } });
		await create;

		const send = agent.chats.sendMessage(chat, 'ask', [URI.file('/tmp')], undefined, 'turn-ask-timeout', undefined, context);
		const prompt = await readNextMessage(peer.outbound);
		pushUpdate(peer, 'sess-ask-timeout', {
			sessionUpdate: 'tool_call',
			toolCallId: 'call-ask-timeout',
			title: 'ask_user_question',
			rawInput: { questions: [{ question: 'Timeout?', options: [{ label: 'A', description: 'a' }], multiSelect: null }] },
			_meta: { 'x.ai/tool': { name: 'ask_user_question', kind: 'ask_user', label: 'Ask User', read_only: true } },
		});
		peer.push({
			jsonrpc: '2.0',
			id: 110,
			method: '_x.ai/ask_user_question',
			params: {
				sessionId: 'sess-ask-timeout',
				toolCallId: 'call-ask-timeout',
				mode: 'default',
				questions: [{ question: 'Timeout?', options: [{ label: 'A', description: 'a' }], multiSelect: null }],
			},
		});
		await new Promise(r => setTimeout(r, 30));
		const request = signals.map(s => s.kind === 'action' && s.action.type === ActionType.ChatInputRequested ? s.action.request as ChatInputRequest : undefined)
			.filter((r): r is ChatInputRequest => !!r)
			.at(-1)!;
		assert.ok(request);

		const outbound: any[] = [];
		const onOutbound = (chunk: Buffer | string) => {
			const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
			for (const line of text.split('\n')) {
				const trimmed = line.trim();
				if (!trimmed) {
					continue;
				}
				try {
					outbound.push(JSON.parse(trimmed));
				} catch {
					outbound.push({ raw: trimmed });
				}
			}
		};
		peer.outbound.on('data', onOutbound);
		try {
			pushUpdate(peer, 'sess-ask-timeout', {
				sessionUpdate: 'tool_call_update',
				toolCallId: 'call-ask-timeout',
				status: 'completed',
				content: [{ type: 'content', content: { type: 'text', text: 'User declined to answer the questions. Continue with the task using your best judgment, or ask different questions.' } }],
				rawOutput: { type: 'AskUserQuestion', UserAnswered: { message: 'User declined to answer the questions. Continue with the task using your best judgment, or ask different questions.' } },
			});
			await new Promise(r => setTimeout(r, 30));
		} finally {
			peer.outbound.off('data', onOutbound);
		}

		assert.ok(signals.some(signal =>
			signal.kind === 'action'
			&& signal.action.type === ActionType.ChatInputCompleted
			&& signal.action.requestId === request.id
			&& signal.action.response === ChatInputResponseKind.Cancel
		), 'expected ask-user UI dismissal after timeout completion');
		assert.ok(
			!outbound.some(message => message.id === 110),
			`expected no ACP reply for timed-out ask among ${JSON.stringify(outbound)}`,
		);

		agent.respondToUserInputRequest(request.id, ChatInputResponseKind.Accept, {
			'q-0': {
				state: ChatInputAnswerState.Submitted,
				value: { kind: ChatInputAnswerValueKind.Selected, value: 'A' },
			},
		});
		await new Promise(r => setTimeout(r, 20));
		assert.ok(!outbound.some(message => message.id === 110), 'late accept after abandon must not write');

		peer.push({ jsonrpc: '2.0', id: prompt.id, result: { stopReason: 'end_turn' } });
		await send;
	});

	test('ask_user_question and exit_plan_mode are abandoned without reply when the turn ends', async () => {
		const peer = store.add(makeFakePeer());
		const client = store.add(new AcpClient(peer.transport));
		const agent = createAgent();
		agent.bindTestClient(client);
		const chat = URI.from({ scheme: GROK_BUILD_AGENT_PROVIDER_ID, path: '/chat/ask-finally' });
		const context = chatContext(chat);
		const signals: AgentSignal[] = [];
		store.add(agent.onDidChatProgress(signal => signals.push(signal)));

		const create = agent.chats.createChat(chat, context, { workingDirectories: [URI.file('/tmp')] });
		const sessionNew = await readNextMessage(peer.outbound);
		peer.push({ jsonrpc: '2.0', id: sessionNew.id, result: { sessionId: 'sess-ask-finally', models: { currentModelId: 'm', availableModels: [{ modelId: 'm', name: 'm' }] } } });
		await create;

		const send = agent.chats.sendMessage(chat, 'ask', [URI.file('/tmp')], undefined, 'turn-ask-finally', undefined, context);
		const prompt = await readNextMessage(peer.outbound);
		pushUpdate(peer, 'sess-ask-finally', {
			sessionUpdate: 'tool_call',
			toolCallId: 'call-ask-finally',
			rawInput: {},
			_meta: { 'x.ai/tool': { name: 'ask_user_question', kind: 'ask_user' } },
		});
		peer.push({
			jsonrpc: '2.0',
			id: 111,
			method: '_x.ai/ask_user_question',
			params: {
				sessionId: 'sess-ask-finally',
				toolCallId: 'call-ask-finally',
				mode: 'default',
				questions: [{ question: 'Still there?', options: [{ label: 'A', description: 'a' }], multiSelect: null }],
			},
		});
		await new Promise(r => setTimeout(r, 20));
		pushUpdate(peer, 'sess-ask-finally', {
			sessionUpdate: 'tool_call',
			toolCallId: 'call-exit-finally',
			rawInput: {},
			_meta: { 'x.ai/tool': { name: 'exit_plan_mode', kind: 'exit_plan' } },
		});
		peer.push({
			jsonrpc: '2.0',
			id: 112,
			method: '_x.ai/exit_plan_mode',
			params: { sessionId: 'sess-ask-finally', toolCallId: 'call-exit-finally', planContent: '# finally' },
		});
		await new Promise(r => setTimeout(r, 20));
		assert.ok(signals.filter(s => s.kind === 'action' && s.action.type === ActionType.ChatInputRequested).length >= 2);

		const outbound: any[] = [];
		const onOutbound = (chunk: Buffer | string) => {
			const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
			for (const line of text.split('\n')) {
				const trimmed = line.trim();
				if (!trimmed) {
					continue;
				}
				try {
					outbound.push(JSON.parse(trimmed));
				} catch {
					outbound.push({ raw: trimmed });
				}
			}
		};
		peer.outbound.on('data', onOutbound);
		try {
			peer.push({ jsonrpc: '2.0', id: prompt.id, result: { stopReason: 'end_turn' } });
			await send;
			await new Promise(r => setTimeout(r, 20));
		} finally {
			peer.outbound.off('data', onOutbound);
		}

		const completed = signals.filter(s => s.kind === 'action' && s.action.type === ActionType.ChatInputCompleted);
		assert.ok(completed.length >= 2, 'expected both ask and plan-review UIs dismissed on turn end');
		assert.ok(!outbound.some(message => message.id === 111), `expected no ask reply among ${JSON.stringify(outbound)}`);
		assert.ok(!outbound.some(message => message.id === 112), `expected no exit_plan reply among ${JSON.stringify(outbound)}`);
	});

	test('dispose and process exit while ask_user_question pending resolve cancelled', async () => {
		const peer = store.add(makeFakePeer());
		const client = store.add(new AcpClient(peer.transport));
		const agent = createAgent();
		agent.bindTestClient(client);
		const chat = URI.from({ scheme: GROK_BUILD_AGENT_PROVIDER_ID, path: '/chat/ask-dispose' });
		const context = chatContext(chat);
		const signals: AgentSignal[] = [];
		store.add(agent.onDidChatProgress(signal => signals.push(signal)));

		const create = agent.chats.createChat(chat, context, { workingDirectories: [URI.file('/tmp')] });
		const sessionNew = await readNextMessage(peer.outbound);
		peer.push({ jsonrpc: '2.0', id: sessionNew.id, result: { sessionId: 'sess-ask-dispose', models: { currentModelId: 'm', availableModels: [{ modelId: 'm', name: 'm' }] } } });
		await create;

		const send = agent.chats.sendMessage(chat, 'ask', [URI.file('/tmp')], undefined, 'turn-ask-dispose', undefined, context);
		const prompt = await readNextMessage(peer.outbound);
		pushUpdate(peer, 'sess-ask-dispose', {
			sessionUpdate: 'tool_call',
			toolCallId: 'call-ask-dispose',
			rawInput: {},
			_meta: { 'x.ai/tool': { name: 'ask_user_question', kind: 'ask_user' } },
		});
		peer.push({
			jsonrpc: '2.0',
			id: 113,
			method: '_x.ai/ask_user_question',
			params: {
				sessionId: 'sess-ask-dispose',
				toolCallId: 'call-ask-dispose',
				mode: 'default',
				questions: [{ question: 'Dispose?', options: [{ label: 'A', description: 'a' }], multiSelect: null }],
			},
		});
		await new Promise(r => setTimeout(r, 30));
		assert.ok(signals.some(s => s.kind === 'action' && s.action.type === ActionType.ChatInputRequested));

		const outbound: any[] = [];
		const onOutbound = (chunk: Buffer | string) => {
			const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
			for (const line of text.split('\n')) {
				const trimmed = line.trim();
				if (!trimmed) {
					continue;
				}
				try {
					outbound.push(JSON.parse(trimmed));
				} catch {
					outbound.push({ raw: trimmed });
				}
			}
		};
		peer.outbound.on('data', onOutbound);
		try {
			await agent.chats.disposeChat(chat, context);
			await new Promise(r => setTimeout(r, 20));
		} finally {
			peer.outbound.off('data', onOutbound);
		}
		assert.ok(signals.some(signal =>
			signal.kind === 'action'
			&& signal.action.type === ActionType.ChatInputCompleted
			&& signal.action.response === ChatInputResponseKind.Cancel
		), 'expected ask UI dismissal on disposeChat');
		assert.ok(
			outbound.some(message => message.id === 113 && message.result?.outcome === 'cancelled'),
			`expected cancelled reply on dispose among ${JSON.stringify(outbound)}`,
		);

		peer.push({ jsonrpc: '2.0', id: prompt.id, result: { stopReason: 'cancelled' } });
		await send.catch(() => undefined);

		const peer2 = store.add(makeFakePeer());
		const client2 = store.add(new AcpClient(peer2.transport));
		const agent2 = createAgent();
		agent2.bindTestClient(client2);
		const chat2 = URI.from({ scheme: GROK_BUILD_AGENT_PROVIDER_ID, path: '/chat/ask-exit' });
		const context2 = chatContext(chat2);
		const signals2: AgentSignal[] = [];
		store.add(agent2.onDidChatProgress(signal => signals2.push(signal)));
		const create2 = agent2.chats.createChat(chat2, context2, { workingDirectories: [URI.file('/tmp')] });
		const sessionNew2 = await readNextMessage(peer2.outbound);
		peer2.push({ jsonrpc: '2.0', id: sessionNew2.id, result: { sessionId: 'sess-ask-exit', models: { currentModelId: 'm', availableModels: [{ modelId: 'm', name: 'm' }] } } });
		await create2;
		const send2 = agent2.chats.sendMessage(chat2, 'ask', [URI.file('/tmp')], undefined, 'turn-ask-exit', undefined, context2);
		const prompt2 = await readNextMessage(peer2.outbound);
		pushUpdate(peer2, 'sess-ask-exit', {
			sessionUpdate: 'tool_call',
			toolCallId: 'call-ask-exit',
			rawInput: {},
			_meta: { 'x.ai/tool': { name: 'ask_user_question', kind: 'ask_user' } },
		});
		peer2.push({
			jsonrpc: '2.0',
			id: 114,
			method: '_x.ai/ask_user_question',
			params: {
				sessionId: 'sess-ask-exit',
				toolCallId: 'call-ask-exit',
				mode: 'default',
				questions: [{ question: 'Exit?', options: [{ label: 'A', description: 'a' }], multiSelect: null }],
			},
		});
		await new Promise(r => setTimeout(r, 30));

		const outbound2: any[] = [];
		const onOutbound2 = (chunk: Buffer | string) => {
			const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
			for (const line of text.split('\n')) {
				const trimmed = line.trim();
				if (!trimmed) {
					continue;
				}
				try {
					outbound2.push(JSON.parse(trimmed));
				} catch {
					outbound2.push({ raw: trimmed });
				}
			}
		};
		peer2.outbound.on('data', onOutbound2);
		try {
			peer2.exit(1, null);
			await new Promise(r => setTimeout(r, 30));
		} finally {
			peer2.outbound.off('data', onOutbound2);
		}
		assert.ok(signals2.some(signal =>
			signal.kind === 'action'
			&& signal.action.type === ActionType.ChatInputCompleted
			&& signal.action.response === ChatInputResponseKind.Cancel
		), 'expected ask UI dismissal on process exit');
		// Transport is already marked exited, so the cancelled ACP reply may not
		// be writable; the important part is the UI/pending map were cleared.
		const request2 = signals2.map(s => s.kind === 'action' && s.action.type === ActionType.ChatInputRequested ? s.action.request as ChatInputRequest : undefined)
			.filter((r): r is ChatInputRequest => !!r)
			.at(-1)!;
		agent2.respondToUserInputRequest(request2.id, ChatInputResponseKind.Accept, {
			'q-0': {
				state: ChatInputAnswerState.Submitted,
				value: { kind: ChatInputAnswerValueKind.Selected, value: 'A' },
			},
		});
		assert.ok(!outbound2.some(message => message.id === 114 && message.result?.outcome === 'accepted'));
		await send2.catch(() => undefined);
		void prompt2;
	});

	test('clientToolsMcp setting off keeps mcpServers empty on session/new', async () => {
		const peer = store.add(makeFakePeer());
		const client = store.add(new AcpClient(peer.transport));
		const agent = createAgent(new NullLogService(), { clientToolsMcpEnabled: false });
		agent.bindTestClient(client);
		const chat = URI.from({ scheme: GROK_BUILD_AGENT_PROVIDER_ID, path: '/chat/mcp-off' });
		const createPromise = agent.chats.createChat(chat, chatContext(chat), {
			workingDirectories: [URI.file('/tmp/proj')],
		});
		const sessionNew = await readNextMessage(peer.outbound);
		assert.strictEqual(sessionNew.method, 'session/new');
		assert.deepStrictEqual(sessionNew.params.mcpServers, []);
		peerPushSession(peer, sessionNew.id, 'sess-mcp-off');
		await createPromise;
	});

	test('session/load and session/resume pass client HTTP mcpServers', async () => {
		const peer = store.add(makeFakePeer());
		const client = store.add(new AcpClient(peer.transport));
		const agent = createAgent();
		agent.bindTestClient(client, LIVE_CAPABILITIES);

		const loadChat = URI.from({ scheme: GROK_BUILD_AGENT_PROVIDER_ID, path: '/chat/mcp-load-only' });
		const loadContext = chatContext(loadChat);
		const loadPromise = agent.materializeChat(loadChat, loadContext, encodeGrokBuildChat({
			sessionId: 'sess-mcp-load-only',
			cwd: '/tmp/proj',
		}));
		const load = await readNextMessage(peer.outbound);
		assert.strictEqual(load.method, 'session/load');
		assertClientToolsMcpServer(load.params.mcpServers);
		peer.push({ jsonrpc: '2.0', id: load.id, result: {} });
		await answerSessionList(peer);
		await loadPromise;

		const resumePeer = store.add(makeFakePeer());
		const resumeClient = store.add(new AcpClient(resumePeer.transport));
		const resumeAgent = createAgent();
		resumeAgent.bindTestClient(resumeClient, { loadSession: false, sessionCapabilities: { resume: {}, close: {} } });
		const resumeChat = URI.from({ scheme: GROK_BUILD_AGENT_PROVIDER_ID, path: '/chat/mcp-resume-only' });
		const resumeContext = chatContext(resumeChat);
		const resumePromise = resumeAgent.materializeChat(resumeChat, resumeContext, encodeGrokBuildChat({
			sessionId: 'sess-mcp-resume-only',
			cwd: '/tmp/proj',
		}));
		const resume = await readNextMessage(resumePeer.outbound);
		assert.strictEqual(resume.method, 'session/resume');
		assertClientToolsMcpServer(resume.params.mcpServers);
		resumePeer.push({ jsonrpc: '2.0', id: resume.id, result: {} });
		await resumePromise;
	});

	test('live use_tool client__ approve yields one Client card finished from MCP', async () => {
		const peer = store.add(makeFakePeer());
		const client = store.add(new AcpClient(peer.transport));
		const agent = createAgent();
		agent.bindTestClient(client);
		const chat = URI.from({ scheme: GROK_BUILD_AGENT_PROVIDER_ID, path: '/chat/mcp-client' });
		const context = chatContext(chat);

		const active = agent.getOrCreateActiveClient(chat, context, { clientId: 'workbench-1', displayName: 'VS Code' });
		active.tools = [{
			name: 'workspace_echo',
			description: 'echo for tests',
			inputSchema: { type: 'object', properties: { msg: { type: 'string' } } },
		}];

		const signals: AgentSignal[] = [];
		store.add(agent.onDidChatProgress(s => signals.push(s)));

		const createPromise = agent.chats.createChat(chat, context, { workingDirectories: [URI.file('/tmp/proj')] });
		const sessionNew = await readNextMessage(peer.outbound);
		assertClientToolsMcpServer(sessionNew.params.mcpServers);
		const mcp = sessionNew.params.mcpServers[0]!;
		peerPushSession(peer, sessionNew.id, 'sess-mcp-client');
		await createPromise;

		const sendPromise = agent.chats.sendMessage(chat, 'hi', [URI.file('/tmp/proj')], undefined, 'turn-mcp', undefined, context);
		const prompt = await readNextMessage(peer.outbound);
		assert.strictEqual(prompt.method, 'session/prompt');

		const auth = mcp.headers[0]!.value;
		const listRes = await fetch(mcp.url, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', Authorization: auth },
			body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
		});
		assert.strictEqual(listRes.status, 200);
		const listJson = await listRes.json() as { result: { tools: Array<{ name: string }> } };
		assert.ok(listJson.result.tools.some(t => t.name === 'workspace_echo'));

		agent.onClientToolCallComplete(chat, 'grok-native-tool-id', {
			success: true,
			pastTenseMessage: 'native done',
			content: [{ type: ToolResultContentType.Text, text: 'should-not-buffer' }],
		});
		assert.strictEqual(peekPendingClientToolCalls(agent, chat).hasBufferedResult('grok-native-tool-id'), false);

		const grokToolCallId = 'grok-use-tool-1';
		peer.push({
			jsonrpc: '2.0',
			method: 'session/update',
			params: {
				sessionId: 'sess-mcp-client',
				update: {
					sessionUpdate: 'tool_call',
					toolCallId: grokToolCallId,
					title: 'use_tool',
					kind: 'other',
					status: 'pending',
					rawInput: { tool_name: 'client__workspace_echo', tool_input: { msg: 'ping' } },
					_meta: { 'x.ai/tool': { name: 'use_tool', namespace: 'grok_build' } },
				},
			},
		});
		await new Promise(r => setTimeout(r, 20));
		assert.strictEqual(
			signals.filter(s => s.kind === 'action' && s.action.type === ActionType.ChatToolCallStart).length,
			0,
			'no card until MCP tools/call',
		);

		peer.push({
			jsonrpc: '2.0',
			id: 42,
			method: 'session/request_permission',
			params: {
				sessionId: 'sess-mcp-client',
				toolCall: { toolCallId: grokToolCallId, title: 'use_tool' },
				options: LIVE_PERMISSION_OPTIONS,
			},
		});
		await new Promise(r => setTimeout(r, 20));
		assert.ok(!signals.some(s => s.kind === 'pending_confirmation'), 'client tools use ChatInput, not pending_confirmation');
		answerClientToolApproval(agent, signals, true);
		const permReply = await readNextMessage(peer.outbound);
		assert.strictEqual(permReply.id, 42);
		assert.strictEqual(permReply.result.outcome.optionId, 'allow-once');
		assert.notStrictEqual(permReply.result.outcome.optionId, 'allow-edits-session');

		const callPromise = fetch(mcp.url, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', Authorization: auth },
			body: JSON.stringify({
				jsonrpc: '2.0',
				id: 2,
				method: 'tools/call',
				params: { name: 'workspace_echo', arguments: { msg: 'ping' } },
			}),
		});
		await new Promise(r => setTimeout(r, 20));

		const starts = signals.filter(s =>
			s.kind === 'action'
			&& s.action.type === ActionType.ChatToolCallStart
			&& (s.action as { toolName?: string }).toolName === 'workspace_echo'
		);
		assert.strictEqual(starts.length, 1, 'exactly one Client card at MCP');
		const start = starts[0]!;
		assert.ok(start.kind === 'action' && start.action.type === ActionType.ChatToolCallStart);
		assert.strictEqual(start.action.toolCallId, grokToolCallId);
		assert.deepStrictEqual(start.action.contributor, { kind: ToolCallContributorKind.Client, clientId: 'workbench-1' });

		const clientReady = signals.find(s =>
			s.kind === 'action'
			&& s.action.type === ActionType.ChatToolCallReady
			&& (s.action as { toolCallId?: string }).toolCallId === grokToolCallId
		);
		assert.ok(clientReady && clientReady.kind === 'action' && clientReady.action.type === ActionType.ChatToolCallReady);
		assert.strictEqual(clientReady.action.toolInput, JSON.stringify({ msg: 'ping' }));
		assert.strictEqual(clientReady.action.confirmed, 'not-needed');
		assert.strictEqual(clientReady.action.contributor, undefined, 'Client already on Start');

		agent.onClientToolCallComplete(chat, grokToolCallId, {
			success: true,
			pastTenseMessage: 'echoed',
			content: [{ type: ToolResultContentType.Text, text: 'pong' }],
		});
		const callRes = await callPromise;
		assert.strictEqual(callRes.status, 200);
		const callJson = await callRes.json() as { result: { content: Array<{ type: string; text: string }> } };
		assert.deepStrictEqual(callJson.result.content, [{ type: 'text', text: 'pong' }]);

		const completesBeforeGrok = signals.filter(s =>
			s.kind === 'action'
			&& s.action.type === ActionType.ChatToolCallComplete
			&& (s.action as { toolCallId?: string }).toolCallId === grokToolCallId
		).length;
		peer.push({
			jsonrpc: '2.0',
			method: 'session/update',
			params: {
				sessionId: 'sess-mcp-client',
				update: {
					sessionUpdate: 'tool_call_update',
					toolCallId: grokToolCallId,
					title: 'client__workspace_echo',
					status: 'completed',
					rawOutput: { type: 'MCP', tool_name: 'workspace_echo', server_name: 'client', output: 'pong' },
				},
			},
		});
		await new Promise(r => setTimeout(r, 20));
		assert.strictEqual(
			signals.filter(s =>
				s.kind === 'action'
				&& s.action.type === ActionType.ChatToolCallComplete
				&& (s.action as { toolCallId?: string }).toolCallId === grokToolCallId
			).length,
			completesBeforeGrok,
			'grok terminal update ignored after Client card started',
		);

		peer.push({ jsonrpc: '2.0', id: prompt.id, result: { stopReason: 'end_turn' } });
		await sendPromise;
	});

	test('live use_tool client__ reject ends one card without MCP tools/call', async () => {
		const peer = store.add(makeFakePeer());
		const client = store.add(new AcpClient(peer.transport));
		const agent = createAgent();
		agent.bindTestClient(client);
		const chat = URI.from({ scheme: GROK_BUILD_AGENT_PROVIDER_ID, path: '/chat/mcp-reject' });
		const context = chatContext(chat);
		agent.getOrCreateActiveClient(chat, context, { clientId: 'workbench-1' }).tools = [{
			name: 'workspace_echo',
			description: 'echo',
			inputSchema: { type: 'object', properties: { msg: { type: 'string' } } },
		}];

		const signals: AgentSignal[] = [];
		store.add(agent.onDidChatProgress(s => signals.push(s)));

		const createPromise = agent.chats.createChat(chat, context, { workingDirectories: [URI.file('/tmp/proj')] });
		const sessionNew = await readNextMessage(peer.outbound);
		assertClientToolsMcpServer(sessionNew.params.mcpServers);
		const mcp = sessionNew.params.mcpServers[0]!;
		peerPushSession(peer, sessionNew.id, 'sess-mcp-reject');
		await createPromise;

		const sendPromise = agent.chats.sendMessage(chat, 'hi', [URI.file('/tmp/proj')], undefined, 'turn-reject', undefined, context);
		const prompt = await readNextMessage(peer.outbound);

		const grokToolCallId = 'grok-reject-1';
		peer.push({
			jsonrpc: '2.0',
			method: 'session/update',
			params: {
				sessionId: 'sess-mcp-reject',
				update: {
					sessionUpdate: 'tool_call',
					toolCallId: grokToolCallId,
					title: 'use_tool',
					status: 'pending',
					rawInput: { tool_name: 'client__workspace_echo', tool_input: { msg: 'nope' } },
					_meta: { 'x.ai/tool': { name: 'use_tool', namespace: 'grok_build' } },
				},
			},
		});
		peer.push({
			jsonrpc: '2.0',
			id: 77,
			method: 'session/request_permission',
			params: {
				sessionId: 'sess-mcp-reject',
				toolCall: { toolCallId: grokToolCallId, title: 'use_tool' },
				options: LIVE_PERMISSION_OPTIONS,
			},
		});
		await new Promise(r => setTimeout(r, 20));
		answerClientToolApproval(agent, signals, false);
		const permReply = await readNextMessage(peer.outbound);
		assert.strictEqual(permReply.result.outcome.optionId, 'reject-once');

		peer.push({
			jsonrpc: '2.0',
			method: 'session/update',
			params: {
				sessionId: 'sess-mcp-reject',
				update: {
					sessionUpdate: 'tool_call_update',
					toolCallId: grokToolCallId,
					title: 'client__workspace_echo',
					status: 'failed',
					rawOutput: { error: 'rejected' },
				},
			},
		});
		await new Promise(r => setTimeout(r, 20));

		assert.strictEqual(
			signals.filter(s => s.kind === 'action' && s.action.type === ActionType.ChatToolCallStart).length,
			1,
		);
		assert.ok(signals.some(s =>
			s.kind === 'action'
			&& s.action.type === ActionType.ChatToolCallComplete
			&& (s.action as { toolCallId?: string }).toolCallId === grokToolCallId
			&& (s.action as { result?: { success?: boolean } }).result?.success === false
		));
		assert.strictEqual([...peekPendingClientToolCalls(agent, chat).entries()].length, 0);

		const listRes = await fetch(mcp.url, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', Authorization: mcp.headers[0]!.value },
			body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
		});
		assert.strictEqual(listRes.status, 200);

		peer.push({ jsonrpc: '2.0', id: prompt.id, result: { stopReason: 'end_turn' } });
		await sendPromise;
	});

	test('live use_tool client__ failure before MCP ends the card', async () => {
		const peer = store.add(makeFakePeer());
		const client = store.add(new AcpClient(peer.transport));
		const agent = createAgent();
		agent.bindTestClient(client);
		const chat = URI.from({ scheme: GROK_BUILD_AGENT_PROVIDER_ID, path: '/chat/mcp-fail' });
		const context = chatContext(chat);
		agent.getOrCreateActiveClient(chat, context, { clientId: 'workbench-1' }).tools = [{
			name: 'workspace_echo',
			description: 'echo',
			inputSchema: { type: 'object', properties: {} },
		}];

		const signals: AgentSignal[] = [];
		store.add(agent.onDidChatProgress(s => signals.push(s)));

		const createPromise = agent.chats.createChat(chat, context, { workingDirectories: [URI.file('/tmp/proj')] });
		const sessionNew = await readNextMessage(peer.outbound);
		peerPushSession(peer, sessionNew.id, 'sess-mcp-fail');
		await createPromise;

		const sendPromise = agent.chats.sendMessage(chat, 'hi', [URI.file('/tmp/proj')], undefined, 'turn-fail', undefined, context);
		const prompt = await readNextMessage(peer.outbound);

		const grokToolCallId = 'grok-fail-1';
		peer.push({
			jsonrpc: '2.0',
			method: 'session/update',
			params: {
				sessionId: 'sess-mcp-fail',
				update: {
					sessionUpdate: 'tool_call',
					toolCallId: grokToolCallId,
					title: 'use_tool',
					status: 'pending',
					rawInput: { tool_name: 'client__workspace_echo', tool_input: {} },
					_meta: { 'x.ai/tool': { name: 'use_tool', namespace: 'grok_build' } },
				},
			},
		});
		peer.push({
			jsonrpc: '2.0',
			method: 'session/update',
			params: {
				sessionId: 'sess-mcp-fail',
				update: {
					sessionUpdate: 'tool_call_update',
					toolCallId: grokToolCallId,
					title: 'client__workspace_echo',
					status: 'failed',
					rawOutput: { error: 'boom before mcp' },
				},
			},
		});
		await new Promise(r => setTimeout(r, 20));

		assert.strictEqual(
			signals.filter(s => s.kind === 'action' && s.action.type === ActionType.ChatToolCallStart).length,
			1,
		);
		assert.ok(signals.some(s =>
			s.kind === 'action'
			&& s.action.type === ActionType.ChatToolCallReady
			&& (s.action as { confirmed?: string }).confirmed === 'not-needed'
		));
		assert.ok(signals.some(s =>
			s.kind === 'action'
			&& s.action.type === ActionType.ChatToolCallComplete
			&& (s.action as { toolCallId?: string }).toolCallId === grokToolCallId
			&& (s.action as { result?: { success?: boolean } }).result?.success === false
		));

		peer.push({ jsonrpc: '2.0', id: prompt.id, result: { stopReason: 'end_turn' } });
		await sendPromise;
	});

	test('clientToolsMcp off leaves user MCP server named client untouched', async () => {
		const peer = store.add(makeFakePeer());
		const client = store.add(new AcpClient(peer.transport));
		const agent = createAgent(new NullLogService(), { clientToolsMcpEnabled: false });
		agent.bindTestClient(client);
		const chat = URI.from({ scheme: GROK_BUILD_AGENT_PROVIDER_ID, path: '/chat/mcp-user-client' });
		const context = chatContext(chat);

		const signals: AgentSignal[] = [];
		store.add(agent.onDidChatProgress(s => signals.push(s)));

		const createPromise = agent.chats.createChat(chat, context, { workingDirectories: [URI.file('/tmp/proj')] });
		const sessionNew = await readNextMessage(peer.outbound);
		assert.deepStrictEqual(sessionNew.params.mcpServers, []);
		peerPushSession(peer, sessionNew.id, 'sess-user-client');
		await createPromise;

		const sendPromise = agent.chats.sendMessage(chat, 'hi', [URI.file('/tmp/proj')], undefined, 'turn-user', undefined, context);
		const prompt = await readNextMessage(peer.outbound);

		peer.push({
			jsonrpc: '2.0',
			method: 'session/update',
			params: {
				sessionId: 'sess-user-client',
				update: {
					sessionUpdate: 'tool_call',
					toolCallId: 'user-client-1',
					title: 'use_tool',
					status: 'pending',
					rawInput: { tool_name: 'client__workspace_echo', tool_input: { msg: 'x' } },
					_meta: { 'x.ai/tool': { name: 'use_tool', namespace: 'grok_build' } },
				},
			},
		});
		await new Promise(r => setTimeout(r, 20));

		const start = signals.find(s => s.kind === 'action' && s.action.type === ActionType.ChatToolCallStart);
		assert.ok(start && start.kind === 'action' && start.action.type === ActionType.ChatToolCallStart);
		assert.strictEqual(start.action.toolName, 'use_tool');
		assert.strictEqual(start.action.displayName, 'use_tool');
		assert.strictEqual(start.action.contributor, undefined);

		peer.push({ jsonrpc: '2.0', id: prompt.id, result: { stopReason: 'end_turn' } });
		await sendPromise;
	});

	test('concurrent same-tool client use_tool calls correlate by args FIFO', async () => {
		const peer = store.add(makeFakePeer());
		const client = store.add(new AcpClient(peer.transport));
		const agent = createAgent();
		agent.bindTestClient(client);
		const chat = URI.from({ scheme: GROK_BUILD_AGENT_PROVIDER_ID, path: '/chat/mcp-fifo' });
		const context = chatContext(chat);
		agent.getOrCreateActiveClient(chat, context, { clientId: 'workbench-1' }).tools = [{
			name: 'workspace_echo',
			description: 'echo',
			inputSchema: { type: 'object', properties: { msg: { type: 'string' } } },
		}];

		const signals: AgentSignal[] = [];
		store.add(agent.onDidChatProgress(s => signals.push(s)));

		const createPromise = agent.chats.createChat(chat, context, { workingDirectories: [URI.file('/tmp/proj')] });
		const sessionNew = await readNextMessage(peer.outbound);
		assertClientToolsMcpServer(sessionNew.params.mcpServers);
		const mcp = sessionNew.params.mcpServers[0]!;
		peerPushSession(peer, sessionNew.id, 'sess-mcp-fifo');
		await createPromise;

		const sendPromise = agent.chats.sendMessage(chat, 'hi', [URI.file('/tmp/proj')], undefined, 'turn-fifo', undefined, context);
		const prompt = await readNextMessage(peer.outbound);

		for (const [id, msg] of [['grok-a', 'alpha'], ['grok-b', 'beta']] as const) {
			peer.push({
				jsonrpc: '2.0',
				method: 'session/update',
				params: {
					sessionId: 'sess-mcp-fifo',
					update: {
						sessionUpdate: 'tool_call',
						toolCallId: id,
						title: 'use_tool',
						status: 'pending',
						rawInput: { tool_name: 'client__workspace_echo', tool_input: { msg } },
						_meta: { 'x.ai/tool': { name: 'use_tool', namespace: 'grok_build' } },
					},
				},
			});
			peer.push({
				jsonrpc: '2.0',
				id: id === 'grok-a' ? 101 : 102,
				method: 'session/request_permission',
				params: {
					sessionId: 'sess-mcp-fifo',
					toolCall: { toolCallId: id, title: 'use_tool' },
					options: LIVE_PERMISSION_OPTIONS,
				},
			});
			await new Promise(r => setTimeout(r, 10));
			answerClientToolApproval(agent, signals, true);
			const reply = await readNextMessage(peer.outbound);
			assert.strictEqual(reply.result.outcome.optionId, 'allow-once');
		}

		const auth = mcp.headers[0]!.value;
		const callB = fetch(mcp.url, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', Authorization: auth },
			body: JSON.stringify({
				jsonrpc: '2.0',
				id: 2,
				method: 'tools/call',
				params: { name: 'workspace_echo', arguments: { msg: 'beta' } },
			}),
		});
		const callA = fetch(mcp.url, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', Authorization: auth },
			body: JSON.stringify({
				jsonrpc: '2.0',
				id: 3,
				method: 'tools/call',
				params: { name: 'workspace_echo', arguments: { msg: 'alpha' } },
			}),
		});
		await new Promise(r => setTimeout(r, 30));

		agent.onClientToolCallComplete(chat, 'grok-b', {
			success: true,
			pastTenseMessage: 'beta done',
			content: [{ type: ToolResultContentType.Text, text: 'beta-out' }],
		});
		agent.onClientToolCallComplete(chat, 'grok-a', {
			success: true,
			pastTenseMessage: 'alpha done',
			content: [{ type: ToolResultContentType.Text, text: 'alpha-out' }],
		});

		const [resB, resA] = await Promise.all([callB, callA]);
		const jsonB = await resB.json() as { result: { content: Array<{ text: string }> } };
		const jsonA = await resA.json() as { result: { content: Array<{ text: string }> } };
		assert.deepStrictEqual(jsonB.result.content, [{ type: 'text', text: 'beta-out' }]);
		assert.deepStrictEqual(jsonA.result.content, [{ type: 'text', text: 'alpha-out' }]);

		peer.push({ jsonrpc: '2.0', id: prompt.id, result: { stopReason: 'end_turn' } });
		await sendPromise;
	});

	test('pending client tool calls are rejected on turn cancel and turn end', async () => {
		const peer = store.add(makeFakePeer());
		const client = store.add(new AcpClient(peer.transport));
		const agent = createAgent();
		agent.bindTestClient(client);
		const chat = URI.from({ scheme: GROK_BUILD_AGENT_PROVIDER_ID, path: '/chat/mcp-cancel' });
		const context = chatContext(chat);
		agent.getOrCreateActiveClient(chat, context, { clientId: 'workbench-1' }).tools = [{
			name: 'workspace_echo',
			description: 'echo',
			inputSchema: { type: 'object', properties: {} },
		}];

		const signals: AgentSignal[] = [];
		store.add(agent.onDidChatProgress(s => signals.push(s)));

		const createPromise = agent.chats.createChat(chat, context, { workingDirectories: [URI.file('/tmp/proj')] });
		const sessionNew = await readNextMessage(peer.outbound);
		assertClientToolsMcpServer(sessionNew.params.mcpServers);
		const mcp = sessionNew.params.mcpServers[0]!;
		peerPushSession(peer, sessionNew.id, 'sess-mcp-cancel');
		await createPromise;

		const sendPromise = agent.chats.sendMessage(chat, 'hi', [URI.file('/tmp/proj')], undefined, 'turn-cancel', undefined, context);
		const prompt = await readNextMessage(peer.outbound);
		assert.strictEqual(prompt.method, 'session/prompt');

		peer.push({
			jsonrpc: '2.0',
			method: 'session/update',
			params: {
				sessionId: 'sess-mcp-cancel',
				update: {
					sessionUpdate: 'tool_call',
					toolCallId: 'grok-cancel-1',
					title: 'use_tool',
					status: 'pending',
					rawInput: { tool_name: 'client__workspace_echo', tool_input: {} },
					_meta: { 'x.ai/tool': { name: 'use_tool', namespace: 'grok_build' } },
				},
			},
		});
		peer.push({
			jsonrpc: '2.0',
			id: 55,
			method: 'session/request_permission',
			params: {
				sessionId: 'sess-mcp-cancel',
				toolCall: { toolCallId: 'grok-cancel-1', title: 'use_tool' },
				options: LIVE_PERMISSION_OPTIONS,
			},
		});
		await new Promise(r => setTimeout(r, 20));
		answerClientToolApproval(agent, signals, true);
		await readNextMessage(peer.outbound);

		const readyPromise = Event.toPromise(Event.filter(agent.onDidChatProgress, signal =>
			signal.kind === 'action' && signal.action.type === ActionType.ChatToolCallReady
		));
		const callPromise = fetch(mcp.url, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', Authorization: mcp.headers[0]!.value },
			body: JSON.stringify({
				jsonrpc: '2.0',
				id: 2,
				method: 'tools/call',
				params: { name: 'workspace_echo', arguments: {} },
			}),
		});
		await readyPromise;
		const pending = peekPendingClientToolCalls(agent, chat);
		assert.strictEqual([...pending.entries()].length, 1);

		await agent.chats.abort(chat, context);
		assert.strictEqual([...pending.entries()].length, 0);

		const callRes = await callPromise;
		assert.strictEqual(callRes.status, 200);
		const callJson = await callRes.json() as { result: { isError?: boolean } };
		assert.strictEqual(callJson.result.isError, true);

		peer.push({ jsonrpc: '2.0', id: prompt.id, result: { stopReason: 'cancelled' } });
		await sendPromise.catch(() => undefined);
	});

	test('disposeChat closes the client MCP listening port', async () => {
		const peer = store.add(makeFakePeer());
		const client = store.add(new AcpClient(peer.transport));
		const agent = createAgent();
		agent.bindTestClient(client);
		const chat = URI.from({ scheme: GROK_BUILD_AGENT_PROVIDER_ID, path: '/chat/mcp-dispose' });
		const context = chatContext(chat);

		const createPromise = agent.chats.createChat(chat, context, { workingDirectories: [URI.file('/tmp/proj')] });
		const sessionNew = await readNextMessage(peer.outbound);
		assertClientToolsMcpServer(sessionNew.params.mcpServers);
		const mcpUrl = sessionNew.params.mcpServers[0]!.url;
		peerPushSession(peer, sessionNew.id, 'sess-mcp-dispose');
		await createPromise;

		await agent.chats.disposeChat(chat, context);

		const port = Number(new URL(mcpUrl).port);
		await new Promise<void>((resolve, reject) => {
			const req = http.request({ hostname: '127.0.0.1', port, path: '/mcp', method: 'POST' }, res => {
				res.resume();
				reject(new Error(`expected connection refused, got ${res.statusCode}`));
			});
			req.on('error', (err: NodeJS.ErrnoException) => {
				assert.ok(err.code === 'ECONNREFUSED' || err.code === 'ECONNRESET', err.message);
				resolve();
			});
			req.end();
		});
	});

	/**
	 * Folds live grok wire signals through {@link chatReducer}. Client-tool
	 * approval uses ChatInput (not pending_confirmation); Client contributor
	 * is stamped only at Start from MCP tools/call.
	 */
	suite('client tools via chatReducer + ChatInput approval', () => {
		function makeChatState(): ChatState {
			const now = new Date().toISOString();
			return {
				resource: 'ahp-chat://grok-client-reducer',
				title: 'Test',
				status: SessionStatus.Idle,
				modifiedAt: now,
				origin: { kind: ChatOriginKind.User },
				turns: [],
				activeTurn: undefined,
			};
		}

		function findTool(chat: ChatState, toolCallId: string): ToolCallState | undefined {
			const part = chat.activeTurn?.responseParts.find(
				p => p.kind === ResponsePartKind.ToolCall && p.toolCall.toolCallId === toolCallId,
			);
			return part?.kind === ResponsePartKind.ToolCall ? part.toolCall : undefined;
		}

		function findInputRequest(chat: ChatState): ChatInputRequest | undefined {
			const part = [...(chat.activeTurn?.responseParts ?? [])].reverse().find(
				p => p.kind === ResponsePartKind.InputRequest && p.response === undefined,
			);
			return part?.kind === ResponsePartKind.InputRequest ? part.request : undefined;
		}

		function answerInputRequest(agent: GrokBuildAgent, chat: ChatState, allow: boolean): string {
			const request = findInputRequest(chat);
			assert.ok(request, 'expected pending ChatInput request');
			agent.respondToUserInputRequest(request.id, ChatInputResponseKind.Accept, {
				'grok-client-tool-approval': {
					state: ChatInputAnswerState.Submitted,
					value: {
						kind: ChatInputAnswerValueKind.Selected,
						value: allow ? 'allow-once' : 'reject',
					},
				},
			});
			return request.id;
		}

		function foldSignals(chat: ChatState, signals: AgentSignal[]): ChatState {
			let next = chat;
			for (const signal of signals.splice(0)) {
				if (signal.kind === 'action') {
					next = chatReducer(next, signal.action as ChatAction);
				}
			}
			return next;
		}

		function toolCardCount(chat: ChatState): number {
			return (chat.activeTurn?.responseParts ?? []).filter(p => p.kind === ResponsePartKind.ToolCall).length;
		}

		function assertNoStreaming(chat: ChatState): void {
			for (const part of chat.activeTurn?.responseParts ?? []) {
				if (part.kind === ResponsePartKind.ToolCall) {
					assert.notStrictEqual(part.toolCall.status, ToolCallStatus.Streaming);
				}
			}
		}

		test('approve → MCP: ChatInput, Client at Start, toolInput, one completed card', async () => {
			const peer = store.add(makeFakePeer());
			const client = store.add(new AcpClient(peer.transport));
			const agent = createAgent();
			agent.bindTestClient(client);
			const chat = URI.from({ scheme: GROK_BUILD_AGENT_PROVIDER_ID, path: '/chat/reducer-allow' });
			const context = chatContext(chat);
			const args = { filePaths: ['/a.ts'] };
			agent.getOrCreateActiveClient(chat, context, { clientId: 'workbench-1' }).tools = [{
				name: 'get_errors',
				description: 'errors',
				inputSchema: { type: 'object', properties: { filePaths: { type: 'array' } } },
			}];

			const signals: AgentSignal[] = [];
			store.add(agent.onDidChatProgress(s => signals.push(s)));

			const createPromise = agent.chats.createChat(chat, context, { workingDirectories: [URI.file('/tmp/proj')] });
			const sessionNew = await readNextMessage(peer.outbound);
			assertClientToolsMcpServer(sessionNew.params.mcpServers);
			const mcp = sessionNew.params.mcpServers[0]!;
			peerPushSession(peer, sessionNew.id, 'sess-reducer-allow');
			await createPromise;

			const turnId = 'turn-reducer-allow';
			const sendPromise = agent.chats.sendMessage(chat, 'hi', [URI.file('/tmp/proj')], undefined, turnId, undefined, context);
			const prompt = await readNextMessage(peer.outbound);

			let chatState = chatReducer(makeChatState(), {
				type: ActionType.ChatTurnStarted,
				turnId,
				startedAt: new Date().toISOString(),
				message: { text: 'hi', origin: { kind: MessageKind.User } },
			});

			const grokToolCallId = 'grok-reducer-allow';
			peer.push({
				jsonrpc: '2.0',
				method: 'session/update',
				params: {
					sessionId: 'sess-reducer-allow',
					update: {
						sessionUpdate: 'tool_call',
						toolCallId: grokToolCallId,
						title: 'use_tool',
						status: 'pending',
						rawInput: { tool_name: 'client__get_errors', tool_input: args },
						_meta: { 'x.ai/tool': { name: 'use_tool', namespace: 'grok_build' } },
					},
				},
			});
			await new Promise(r => setTimeout(r, 20));
			chatState = foldSignals(chatState, signals);
			assert.strictEqual(toolCardCount(chatState), 0);

			peer.push({
				jsonrpc: '2.0',
				id: 42,
				method: 'session/request_permission',
				params: {
					sessionId: 'sess-reducer-allow',
					toolCall: { toolCallId: grokToolCallId, title: 'use_tool' },
					options: LIVE_PERMISSION_OPTIONS,
				},
			});
			await new Promise(r => setTimeout(r, 20));
			chatState = foldSignals(chatState, signals);
			const inputReq = findInputRequest(chatState);
			assert.ok(inputReq, 'ChatInput approval shown');
			assert.match(inputReq.message ?? '', /get_errors/);
			assert.match(inputReq.message ?? '', /filePaths/);
			assert.ok(inputReq.message?.includes('```'), 'args rendered inside a code fence');
			assert.ok(
				inputReq.questions?.[0]?.kind === ChatInputQuestionKind.SingleSelect
				&& inputReq.questions[0].allowFreeformInput === false,
			);

			const requestId = answerInputRequest(agent, chatState, true);
			chatState = chatReducer(chatState, {
				type: ActionType.ChatInputCompleted,
				requestId,
				response: ChatInputResponseKind.Accept,
			});
			const permReply = await readNextMessage(peer.outbound);
			assert.strictEqual(permReply.result.outcome.optionId, 'allow-once');
			assert.notStrictEqual(permReply.result.outcome.optionId, 'allow-edits-session');

			const callPromise = fetch(mcp.url, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', Authorization: mcp.headers[0]!.value },
				body: JSON.stringify({
					jsonrpc: '2.0',
					id: 2,
					method: 'tools/call',
					params: { name: 'get_errors', arguments: args },
				}),
			});
			await new Promise(r => setTimeout(r, 30));
			chatState = foldSignals(chatState, signals);

			const tc = findTool(chatState, grokToolCallId);
			assert.ok(tc);
			assert.strictEqual(tc.status, ToolCallStatus.Running);
			assert.deepStrictEqual(tc.contributor, { kind: ToolCallContributorKind.Client, clientId: 'workbench-1' });
			assert.strictEqual('toolInput' in tc ? tc.toolInput : undefined, JSON.stringify(args));
			assert.strictEqual(toolCardCount(chatState), 1);

			agent.onClientToolCallComplete(chat, grokToolCallId, {
				success: true,
				pastTenseMessage: 'got errors',
				content: [{ type: ToolResultContentType.Text, text: 'no errors' }],
			});
			chatState = chatReducer(chatState, {
				type: ActionType.ChatToolCallComplete,
				turnId,
				toolCallId: grokToolCallId,
				result: {
					success: true,
					pastTenseMessage: 'got errors',
					content: [{ type: ToolResultContentType.Text, text: 'no errors' }],
				},
			});
			const callRes = await callPromise;
			assert.strictEqual(callRes.status, 200);
			const callJson = await callRes.json() as { result: { content: Array<{ text: string }>; isError?: boolean } };
			assert.deepStrictEqual(callJson.result.content, [{ type: 'text', text: 'no errors' }]);
			assert.ok(!callJson.result.isError);

			peer.push({
				jsonrpc: '2.0',
				method: 'session/update',
				params: {
					sessionId: 'sess-reducer-allow',
					update: {
						sessionUpdate: 'tool_call_update',
						toolCallId: grokToolCallId,
						title: 'client__get_errors',
						status: 'completed',
						rawOutput: { type: 'MCP', output: 'no errors' },
					},
				},
			});
			await new Promise(r => setTimeout(r, 20));
			chatState = foldSignals(chatState, signals);

			assert.strictEqual(toolCardCount(chatState), 1);
			assert.strictEqual(findTool(chatState, grokToolCallId)?.status, ToolCallStatus.Completed);
			assertNoStreaming(chatState);

			peer.push({ jsonrpc: '2.0', id: prompt.id, result: { stopReason: 'end_turn' } });
			await sendPromise;
		});

		test('reject → no MCP call, one failed non-Client card', async () => {
			const peer = store.add(makeFakePeer());
			const client = store.add(new AcpClient(peer.transport));
			const agent = createAgent();
			agent.bindTestClient(client);
			const chat = URI.from({ scheme: GROK_BUILD_AGENT_PROVIDER_ID, path: '/chat/reducer-reject' });
			const context = chatContext(chat);
			agent.getOrCreateActiveClient(chat, context, { clientId: 'workbench-1' }).tools = [{
				name: 'get_errors',
				description: 'errors',
				inputSchema: { type: 'object', properties: {} },
			}];

			const signals: AgentSignal[] = [];
			store.add(agent.onDidChatProgress(s => signals.push(s)));

			const createPromise = agent.chats.createChat(chat, context, { workingDirectories: [URI.file('/tmp/proj')] });
			const sessionNew = await readNextMessage(peer.outbound);
			peerPushSession(peer, sessionNew.id, 'sess-reducer-reject');
			await createPromise;

			const turnId = 'turn-reducer-reject';
			const sendPromise = agent.chats.sendMessage(chat, 'hi', [URI.file('/tmp/proj')], undefined, turnId, undefined, context);
			const prompt = await readNextMessage(peer.outbound);

			let chatState = chatReducer(makeChatState(), {
				type: ActionType.ChatTurnStarted,
				turnId,
				startedAt: new Date().toISOString(),
				message: { text: 'hi', origin: { kind: MessageKind.User } },
			});

			const grokToolCallId = 'grok-reducer-reject';
			peer.push({
				jsonrpc: '2.0',
				method: 'session/update',
				params: {
					sessionId: 'sess-reducer-reject',
					update: {
						sessionUpdate: 'tool_call',
						toolCallId: grokToolCallId,
						title: 'use_tool',
						status: 'pending',
						rawInput: { tool_name: 'client__get_errors', tool_input: { filePaths: ['/a.ts'] } },
						_meta: { 'x.ai/tool': { name: 'use_tool', namespace: 'grok_build' } },
					},
				},
			});
			peer.push({
				jsonrpc: '2.0',
				id: 77,
				method: 'session/request_permission',
				params: {
					sessionId: 'sess-reducer-reject',
					toolCall: { toolCallId: grokToolCallId, title: 'use_tool' },
					options: LIVE_PERMISSION_OPTIONS,
				},
			});
			await new Promise(r => setTimeout(r, 20));
			chatState = foldSignals(chatState, signals);
			assert.ok(findInputRequest(chatState));

			const requestId = answerInputRequest(agent, chatState, false);
			chatState = chatReducer(chatState, {
				type: ActionType.ChatInputCompleted,
				requestId,
				response: ChatInputResponseKind.Accept,
			});
			const permReply = await readNextMessage(peer.outbound);
			assert.strictEqual(permReply.result.outcome.optionId, 'reject-once');

			peer.push({
				jsonrpc: '2.0',
				method: 'session/update',
				params: {
					sessionId: 'sess-reducer-reject',
					update: {
						sessionUpdate: 'tool_call_update',
						toolCallId: grokToolCallId,
						title: 'client__get_errors',
						status: 'failed',
						rawOutput: { error: 'rejected' },
					},
				},
			});
			await new Promise(r => setTimeout(r, 20));
			chatState = foldSignals(chatState, signals);

			assert.strictEqual(toolCardCount(chatState), 1);
			const tc = findTool(chatState, grokToolCallId);
			assert.ok(tc);
			assert.strictEqual(tc.contributor, undefined);
			assert.strictEqual(tc.status, ToolCallStatus.Completed);
			assert.strictEqual(tc.status === ToolCallStatus.Completed ? tc.success : undefined, false);
			assertNoStreaming(chatState);

			peer.push({ jsonrpc: '2.0', id: prompt.id, result: { stopReason: 'end_turn' } });
			await sendPromise;
		});

		test('approve args A then MCP args B → re-ask; reject → User declined, no execution', async () => {
			const peer = store.add(makeFakePeer());
			const client = store.add(new AcpClient(peer.transport));
			const agent = createAgent();
			agent.bindTestClient(client);
			const chat = URI.from({ scheme: GROK_BUILD_AGENT_PROVIDER_ID, path: '/chat/reducer-args-mismatch' });
			const context = chatContext(chat);
			const approvedArgs = { filePaths: ['/a.ts'] };
			const mcpArgs = { filePaths: ['/etc/shadow'] };
			agent.getOrCreateActiveClient(chat, context, { clientId: 'workbench-1' }).tools = [{
				name: 'get_errors',
				description: 'errors',
				inputSchema: { type: 'object', properties: { filePaths: { type: 'array' } } },
			}];

			const signals: AgentSignal[] = [];
			store.add(agent.onDidChatProgress(s => signals.push(s)));

			const createPromise = agent.chats.createChat(chat, context, { workingDirectories: [URI.file('/tmp/proj')] });
			const sessionNew = await readNextMessage(peer.outbound);
			assertClientToolsMcpServer(sessionNew.params.mcpServers);
			const mcp = sessionNew.params.mcpServers[0]!;
			peerPushSession(peer, sessionNew.id, 'sess-reducer-args-mismatch');
			await createPromise;

			const turnId = 'turn-reducer-args-mismatch';
			const sendPromise = agent.chats.sendMessage(chat, 'hi', [URI.file('/tmp/proj')], undefined, turnId, undefined, context);
			const prompt = await readNextMessage(peer.outbound);

			let chatState = chatReducer(makeChatState(), {
				type: ActionType.ChatTurnStarted,
				turnId,
				startedAt: new Date().toISOString(),
				message: { text: 'hi', origin: { kind: MessageKind.User } },
			});

			const grokToolCallId = 'grok-reducer-args-mismatch';
			peer.push({
				jsonrpc: '2.0',
				method: 'session/update',
				params: {
					sessionId: 'sess-reducer-args-mismatch',
					update: {
						sessionUpdate: 'tool_call',
						toolCallId: grokToolCallId,
						title: 'use_tool',
						status: 'pending',
						rawInput: { tool_name: 'client__get_errors', tool_input: approvedArgs },
						_meta: { 'x.ai/tool': { name: 'use_tool', namespace: 'grok_build' } },
					},
				},
			});
			peer.push({
				jsonrpc: '2.0',
				id: 61,
				method: 'session/request_permission',
				params: {
					sessionId: 'sess-reducer-args-mismatch',
					toolCall: { toolCallId: grokToolCallId, title: 'use_tool' },
					options: LIVE_PERMISSION_OPTIONS,
				},
			});
			await new Promise(r => setTimeout(r, 20));
			chatState = foldSignals(chatState, signals);
			const firstAsk = findInputRequest(chatState);
			assert.ok(firstAsk);
			assert.match(firstAsk.message ?? '', /\/a\.ts/);
			const firstRequestId = answerInputRequest(agent, chatState, true);
			chatState = chatReducer(chatState, {
				type: ActionType.ChatInputCompleted,
				requestId: firstRequestId,
				response: ChatInputResponseKind.Accept,
			});
			const permReply = await readNextMessage(peer.outbound);
			assert.strictEqual(permReply.result.outcome.optionId, 'allow-once');

			const callPromise = fetch(mcp.url, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', Authorization: mcp.headers[0]!.value },
				body: JSON.stringify({
					jsonrpc: '2.0',
					id: 2,
					method: 'tools/call',
					params: { name: 'get_errors', arguments: mcpArgs },
				}),
			});
			await new Promise(r => setTimeout(r, 40));
			chatState = foldSignals(chatState, signals);
			const secondAsk = findInputRequest(chatState);
			assert.ok(secondAsk, 'MCP args B must re-ask with real args');
			assert.match(secondAsk.message ?? '', /\/etc\/shadow/);
			assert.ok(!secondAsk.message?.includes('/a.ts') || secondAsk.message.includes('/etc/shadow'));
			assert.strictEqual(toolCardCount(chatState), 0);

			const secondRequestId = answerInputRequest(agent, chatState, false);
			chatState = chatReducer(chatState, {
				type: ActionType.ChatInputCompleted,
				requestId: secondRequestId,
				response: ChatInputResponseKind.Accept,
			});
			const callRes = await callPromise;
			assert.strictEqual(callRes.status, 200);
			const callJson = await callRes.json() as { result: { isError?: boolean; content: Array<{ text: string }> } };
			assert.strictEqual(callJson.result.isError, true);
			assert.ok(callJson.result.content.some(c => c.text.includes('User declined')));
			chatState = foldSignals(chatState, signals);
			assert.strictEqual(toolCardCount(chatState), 0);

			peer.push({ jsonrpc: '2.0', id: prompt.id, result: { stopReason: 'end_turn' } });
			await sendPromise;
		});

		test('auto-allow still asks ChatInput before MCP; reject → isError User declined', async () => {
			const peer = store.add(makeFakePeer());
			const client = store.add(new AcpClient(peer.transport));
			const agent = createAgent();
			agent.bindTestClient(client);
			const chat = URI.from({ scheme: GROK_BUILD_AGENT_PROVIDER_ID, path: '/chat/reducer-auto' });
			const context = chatContext(chat);
			const args = { filePaths: ['/a.ts'] };
			agent.getOrCreateActiveClient(chat, context, { clientId: 'workbench-1' }).tools = [{
				name: 'get_errors',
				description: 'errors',
				inputSchema: { type: 'object', properties: { filePaths: { type: 'array' } } },
			}];

			const signals: AgentSignal[] = [];
			store.add(agent.onDidChatProgress(s => signals.push(s)));

			const createPromise = agent.chats.createChat(chat, context, { workingDirectories: [URI.file('/tmp/proj')] });
			const sessionNew = await readNextMessage(peer.outbound);
			assertClientToolsMcpServer(sessionNew.params.mcpServers);
			const mcp = sessionNew.params.mcpServers[0]!;
			peerPushSession(peer, sessionNew.id, 'sess-reducer-auto');
			await createPromise;

			const turnId = 'turn-reducer-auto';
			const sendPromise = agent.chats.sendMessage(chat, 'hi', [URI.file('/tmp/proj')], undefined, turnId, undefined, context);
			const prompt = await readNextMessage(peer.outbound);

			let chatState = chatReducer(makeChatState(), {
				type: ActionType.ChatTurnStarted,
				turnId,
				startedAt: new Date().toISOString(),
				message: { text: 'hi', origin: { kind: MessageKind.User } },
			});

			const grokToolCallId = 'grok-reducer-auto';
			peer.push({
				jsonrpc: '2.0',
				method: 'session/update',
				params: {
					sessionId: 'sess-reducer-auto',
					update: {
						sessionUpdate: 'tool_call',
						toolCallId: grokToolCallId,
						title: 'use_tool',
						status: 'pending',
						rawInput: { tool_name: 'client__get_errors', tool_input: args },
						_meta: { 'x.ai/tool': { name: 'use_tool', namespace: 'grok_build' } },
					},
				},
			});
			await new Promise(r => setTimeout(r, 20));
			chatState = foldSignals(chatState, signals);
			assert.strictEqual(toolCardCount(chatState), 0);

			const callPromise = fetch(mcp.url, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', Authorization: mcp.headers[0]!.value },
				body: JSON.stringify({
					jsonrpc: '2.0',
					id: 2,
					method: 'tools/call',
					params: { name: 'get_errors', arguments: args },
				}),
			});
			await new Promise(r => setTimeout(r, 30));
			chatState = foldSignals(chatState, signals);
			assert.ok(findInputRequest(chatState), 'auto-allow still asks');
			assert.strictEqual(toolCardCount(chatState), 0);

			const requestId = answerInputRequest(agent, chatState, false);
			chatState = chatReducer(chatState, {
				type: ActionType.ChatInputCompleted,
				requestId,
				response: ChatInputResponseKind.Accept,
			});
			const callRes = await callPromise;
			assert.strictEqual(callRes.status, 200);
			const callJson = await callRes.json() as { result: { isError?: boolean; content: Array<{ text: string }> } };
			assert.strictEqual(callJson.result.isError, true);
			assert.ok(callJson.result.content.some(c => c.text.includes('User declined')));
			chatState = foldSignals(chatState, signals);
			assert.strictEqual(toolCardCount(chatState), 0);

			peer.push({ jsonrpc: '2.0', id: prompt.id, result: { stopReason: 'end_turn' } });
			await sendPromise;
		});

		test('auto-allow approve → Client Start with real args', async () => {
			const peer = store.add(makeFakePeer());
			const client = store.add(new AcpClient(peer.transport));
			const agent = createAgent();
			agent.bindTestClient(client);
			const chat = URI.from({ scheme: GROK_BUILD_AGENT_PROVIDER_ID, path: '/chat/reducer-auto-allow' });
			const context = chatContext(chat);
			const args = { filePaths: ['/b.ts'] };
			agent.getOrCreateActiveClient(chat, context, { clientId: 'workbench-1' }).tools = [{
				name: 'get_errors',
				description: 'errors',
				inputSchema: { type: 'object', properties: { filePaths: { type: 'array' } } },
			}];

			const signals: AgentSignal[] = [];
			store.add(agent.onDidChatProgress(s => signals.push(s)));

			const createPromise = agent.chats.createChat(chat, context, { workingDirectories: [URI.file('/tmp/proj')] });
			const sessionNew = await readNextMessage(peer.outbound);
			assertClientToolsMcpServer(sessionNew.params.mcpServers);
			const mcp = sessionNew.params.mcpServers[0]!;
			peerPushSession(peer, sessionNew.id, 'sess-reducer-auto-allow');
			await createPromise;

			const turnId = 'turn-reducer-auto-allow';
			const sendPromise = agent.chats.sendMessage(chat, 'hi', [URI.file('/tmp/proj')], undefined, turnId, undefined, context);
			const prompt = await readNextMessage(peer.outbound);

			let chatState = chatReducer(makeChatState(), {
				type: ActionType.ChatTurnStarted,
				turnId,
				startedAt: new Date().toISOString(),
				message: { text: 'hi', origin: { kind: MessageKind.User } },
			});

			const grokToolCallId = 'grok-reducer-auto-allow';
			peer.push({
				jsonrpc: '2.0',
				method: 'session/update',
				params: {
					sessionId: 'sess-reducer-auto-allow',
					update: {
						sessionUpdate: 'tool_call',
						toolCallId: grokToolCallId,
						title: 'use_tool',
						status: 'pending',
						rawInput: { tool_name: 'client__get_errors', tool_input: args },
						_meta: { 'x.ai/tool': { name: 'use_tool', namespace: 'grok_build' } },
					},
				},
			});
			await new Promise(r => setTimeout(r, 20));

			const callPromise = fetch(mcp.url, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', Authorization: mcp.headers[0]!.value },
				body: JSON.stringify({
					jsonrpc: '2.0',
					id: 2,
					method: 'tools/call',
					params: { name: 'get_errors', arguments: args },
				}),
			});
			await new Promise(r => setTimeout(r, 30));
			chatState = foldSignals(chatState, signals);
			assert.ok(findInputRequest(chatState));
			const requestId = answerInputRequest(agent, chatState, true);
			chatState = chatReducer(chatState, {
				type: ActionType.ChatInputCompleted,
				requestId,
				response: ChatInputResponseKind.Accept,
			});
			await new Promise(r => setTimeout(r, 30));
			chatState = foldSignals(chatState, signals);

			const tc = findTool(chatState, grokToolCallId);
			assert.ok(tc);
			assert.deepStrictEqual(tc.contributor, { kind: ToolCallContributorKind.Client, clientId: 'workbench-1' });
			assert.strictEqual('toolInput' in tc ? tc.toolInput : undefined, JSON.stringify(args));

			agent.onClientToolCallComplete(chat, grokToolCallId, {
				success: true,
				pastTenseMessage: 'ok',
				content: [{ type: ToolResultContentType.Text, text: 'done' }],
			});
			chatState = chatReducer(chatState, {
				type: ActionType.ChatToolCallComplete,
				turnId,
				toolCallId: grokToolCallId,
				result: {
					success: true,
					pastTenseMessage: 'ok',
					content: [{ type: ToolResultContentType.Text, text: 'done' }],
				},
			});
			const callRes = await callPromise;
			assert.strictEqual(callRes.status, 200);
			assert.strictEqual(toolCardCount(chatState), 1);
			assertNoStreaming(chatState);

			peer.push({ jsonrpc: '2.0', id: prompt.id, result: { stopReason: 'end_turn' } });
			await sendPromise;
		});

		test('cancel during question → 0 cards, grok cancelled', async () => {
			const peer = store.add(makeFakePeer());
			const client = store.add(new AcpClient(peer.transport));
			const agent = createAgent();
			agent.bindTestClient(client);
			const chat = URI.from({ scheme: GROK_BUILD_AGENT_PROVIDER_ID, path: '/chat/reducer-cancel-q' });
			const context = chatContext(chat);
			agent.getOrCreateActiveClient(chat, context, { clientId: 'workbench-1' }).tools = [{
				name: 'get_errors',
				description: 'errors',
				inputSchema: { type: 'object', properties: {} },
			}];

			const signals: AgentSignal[] = [];
			store.add(agent.onDidChatProgress(s => signals.push(s)));

			const createPromise = agent.chats.createChat(chat, context, { workingDirectories: [URI.file('/tmp/proj')] });
			const sessionNew = await readNextMessage(peer.outbound);
			peerPushSession(peer, sessionNew.id, 'sess-reducer-cancel-q');
			await createPromise;

			const turnId = 'turn-reducer-cancel-q';
			const sendPromise = agent.chats.sendMessage(chat, 'hi', [URI.file('/tmp/proj')], undefined, turnId, undefined, context);
			const prompt = await readNextMessage(peer.outbound);

			let chatState = chatReducer(makeChatState(), {
				type: ActionType.ChatTurnStarted,
				turnId,
				startedAt: new Date().toISOString(),
				message: { text: 'hi', origin: { kind: MessageKind.User } },
			});

			const grokToolCallId = 'grok-reducer-cancel-q';
			peer.push({
				jsonrpc: '2.0',
				method: 'session/update',
				params: {
					sessionId: 'sess-reducer-cancel-q',
					update: {
						sessionUpdate: 'tool_call',
						toolCallId: grokToolCallId,
						title: 'use_tool',
						status: 'pending',
						rawInput: { tool_name: 'client__get_errors', tool_input: {} },
						_meta: { 'x.ai/tool': { name: 'use_tool', namespace: 'grok_build' } },
					},
				},
			});
			peer.push({
				jsonrpc: '2.0',
				id: 88,
				method: 'session/request_permission',
				params: {
					sessionId: 'sess-reducer-cancel-q',
					toolCall: { toolCallId: grokToolCallId, title: 'use_tool' },
					options: LIVE_PERMISSION_OPTIONS,
				},
			});
			await new Promise(r => setTimeout(r, 20));
			chatState = foldSignals(chatState, signals);
			const requestId = findInputRequest(chatState)!.id;
			agent.respondToUserInputRequest(requestId, ChatInputResponseKind.Cancel);
			chatState = chatReducer(chatState, {
				type: ActionType.ChatInputCompleted,
				requestId,
				response: ChatInputResponseKind.Cancel,
			});
			const permReply = await readNextMessage(peer.outbound);
			assert.strictEqual(permReply.result.outcome.outcome, 'cancelled');

			peer.push({
				jsonrpc: '2.0',
				method: 'session/update',
				params: {
					sessionId: 'sess-reducer-cancel-q',
					update: {
						sessionUpdate: 'tool_call_update',
						toolCallId: grokToolCallId,
						status: 'failed',
						rawOutput: { error: 'cancelled' },
					},
				},
			});
			await new Promise(r => setTimeout(r, 20));
			chatState = foldSignals(chatState, signals);
			assert.strictEqual(toolCardCount(chatState), 0);

			peer.push({ jsonrpc: '2.0', id: prompt.id, result: { stopReason: 'end_turn' } });
			await sendPromise;
		});

		test('MCP abort during approval question closes ChatInput as Cancel', async () => {
			const peer = store.add(makeFakePeer());
			const client = store.add(new AcpClient(peer.transport));
			const agent = createAgent();
			agent.bindTestClient(client);
			const chat = URI.from({ scheme: GROK_BUILD_AGENT_PROVIDER_ID, path: '/chat/reducer-abort-ask' });
			const context = chatContext(chat);
			const args = { filePaths: ['/a.ts'] };
			agent.getOrCreateActiveClient(chat, context, { clientId: 'workbench-1' }).tools = [{
				name: 'get_errors',
				description: 'errors',
				inputSchema: { type: 'object', properties: { filePaths: { type: 'array' } } },
			}];

			const signals: AgentSignal[] = [];
			store.add(agent.onDidChatProgress(s => signals.push(s)));

			const createPromise = agent.chats.createChat(chat, context, { workingDirectories: [URI.file('/tmp/proj')] });
			const sessionNew = await readNextMessage(peer.outbound);
			assertClientToolsMcpServer(sessionNew.params.mcpServers);
			const mcp = sessionNew.params.mcpServers[0]!;
			peerPushSession(peer, sessionNew.id, 'sess-reducer-abort-ask');
			await createPromise;

			const turnId = 'turn-reducer-abort-ask';
			const sendPromise = agent.chats.sendMessage(chat, 'hi', [URI.file('/tmp/proj')], undefined, turnId, undefined, context);
			const prompt = await readNextMessage(peer.outbound);

			let chatState = chatReducer(makeChatState(), {
				type: ActionType.ChatTurnStarted,
				turnId,
				startedAt: new Date().toISOString(),
				message: { text: 'hi', origin: { kind: MessageKind.User } },
			});

			const grokToolCallId = 'grok-reducer-abort-ask';
			peer.push({
				jsonrpc: '2.0',
				method: 'session/update',
				params: {
					sessionId: 'sess-reducer-abort-ask',
					update: {
						sessionUpdate: 'tool_call',
						toolCallId: grokToolCallId,
						title: 'use_tool',
						status: 'pending',
						rawInput: { tool_name: 'client__get_errors', tool_input: args },
						_meta: { 'x.ai/tool': { name: 'use_tool', namespace: 'grok_build' } },
					},
				},
			});
			await new Promise(r => setTimeout(r, 20));

			const abort = new AbortController();
			const callPromise = fetch(mcp.url, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', Authorization: mcp.headers[0]!.value },
				body: JSON.stringify({
					jsonrpc: '2.0',
					id: 2,
					method: 'tools/call',
					params: { name: 'get_errors', arguments: args },
				}),
				signal: abort.signal,
			});
			await new Promise(r => setTimeout(r, 40));
			chatState = foldSignals(chatState, signals);
			const pendingAsk = findInputRequest(chatState);
			assert.ok(pendingAsk, 'approval question shown before abort');

			abort.abort();
			await callPromise.catch(() => undefined);
			await new Promise(r => setTimeout(r, 50));
			const cancelSignal = signals.find(s =>
				s.kind === 'action'
				&& s.action.type === ActionType.ChatInputCompleted
				&& s.action.requestId === pendingAsk.id
				&& s.action.response === ChatInputResponseKind.Cancel
			);
			assert.ok(cancelSignal, 'pending question closed with ChatInputCompleted Cancel');
			chatState = foldSignals(chatState, signals);
			assert.strictEqual(findInputRequest(chatState), undefined);
			assert.strictEqual(toolCardCount(chatState), 0);

			peer.push({ jsonrpc: '2.0', id: prompt.id, result: { stopReason: 'end_turn' } });
			await sendPromise;
		});

		test('grok failed before MCP → one non-Client terminal card', async () => {
			const peer = store.add(makeFakePeer());
			const client = store.add(new AcpClient(peer.transport));
			const agent = createAgent();
			agent.bindTestClient(client);
			const chat = URI.from({ scheme: GROK_BUILD_AGENT_PROVIDER_ID, path: '/chat/reducer-fail' });
			const context = chatContext(chat);
			agent.getOrCreateActiveClient(chat, context, { clientId: 'workbench-1' }).tools = [{
				name: 'get_errors',
				description: 'errors',
				inputSchema: { type: 'object', properties: {} },
			}];

			const signals: AgentSignal[] = [];
			store.add(agent.onDidChatProgress(s => signals.push(s)));

			const createPromise = agent.chats.createChat(chat, context, { workingDirectories: [URI.file('/tmp/proj')] });
			const sessionNew = await readNextMessage(peer.outbound);
			peerPushSession(peer, sessionNew.id, 'sess-reducer-fail');
			await createPromise;

			const turnId = 'turn-reducer-fail';
			const sendPromise = agent.chats.sendMessage(chat, 'hi', [URI.file('/tmp/proj')], undefined, turnId, undefined, context);
			const prompt = await readNextMessage(peer.outbound);

			let chatState = chatReducer(makeChatState(), {
				type: ActionType.ChatTurnStarted,
				turnId,
				startedAt: new Date().toISOString(),
				message: { text: 'hi', origin: { kind: MessageKind.User } },
			});

			const grokToolCallId = 'grok-reducer-fail';
			peer.push({
				jsonrpc: '2.0',
				method: 'session/update',
				params: {
					sessionId: 'sess-reducer-fail',
					update: {
						sessionUpdate: 'tool_call',
						toolCallId: grokToolCallId,
						title: 'use_tool',
						status: 'pending',
						rawInput: { tool_name: 'client__get_errors', tool_input: {} },
						_meta: { 'x.ai/tool': { name: 'use_tool', namespace: 'grok_build' } },
					},
				},
			});
			peer.push({
				jsonrpc: '2.0',
				method: 'session/update',
				params: {
					sessionId: 'sess-reducer-fail',
					update: {
						sessionUpdate: 'tool_call_update',
						toolCallId: grokToolCallId,
						title: 'client__get_errors',
						status: 'failed',
						rawOutput: { error: 'boom before permission' },
					},
				},
			});
			await new Promise(r => setTimeout(r, 20));
			chatState = foldSignals(chatState, signals);

			assert.strictEqual(toolCardCount(chatState), 1);
			const tc = findTool(chatState, grokToolCallId);
			assert.ok(tc);
			assert.strictEqual(tc.contributor, undefined);
			assert.strictEqual(tc.status, ToolCallStatus.Completed);
			assert.strictEqual(tc.status === ToolCallStatus.Completed ? tc.success : undefined, false);
			assertNoStreaming(chatState);

			peer.push({ jsonrpc: '2.0', id: prompt.id, result: { stopReason: 'end_turn' } });
			await sendPromise;
		});

		test('workbench failure settles MCP with isError', async () => {
			const peer = store.add(makeFakePeer());
			const client = store.add(new AcpClient(peer.transport));
			const agent = createAgent();
			agent.bindTestClient(client);
			const chat = URI.from({ scheme: GROK_BUILD_AGENT_PROVIDER_ID, path: '/chat/reducer-wb-fail' });
			const context = chatContext(chat);
			agent.getOrCreateActiveClient(chat, context, { clientId: 'workbench-1' }).tools = [{
				name: 'get_errors',
				description: 'errors',
				inputSchema: { type: 'object', properties: {} },
			}];

			const signals: AgentSignal[] = [];
			store.add(agent.onDidChatProgress(s => signals.push(s)));

			const createPromise = agent.chats.createChat(chat, context, { workingDirectories: [URI.file('/tmp/proj')] });
			const sessionNew = await readNextMessage(peer.outbound);
			assertClientToolsMcpServer(sessionNew.params.mcpServers);
			const mcp = sessionNew.params.mcpServers[0]!;
			peerPushSession(peer, sessionNew.id, 'sess-reducer-wb-fail');
			await createPromise;

			const turnId = 'turn-reducer-wb-fail';
			const sendPromise = agent.chats.sendMessage(chat, 'hi', [URI.file('/tmp/proj')], undefined, turnId, undefined, context);
			const prompt = await readNextMessage(peer.outbound);

			let chatState = chatReducer(makeChatState(), {
				type: ActionType.ChatTurnStarted,
				turnId,
				startedAt: new Date().toISOString(),
				message: { text: 'hi', origin: { kind: MessageKind.User } },
			});

			const grokToolCallId = 'grok-reducer-wb-fail';
			peer.push({
				jsonrpc: '2.0',
				method: 'session/update',
				params: {
					sessionId: 'sess-reducer-wb-fail',
					update: {
						sessionUpdate: 'tool_call',
						toolCallId: grokToolCallId,
						title: 'use_tool',
						status: 'pending',
						rawInput: { tool_name: 'client__get_errors', tool_input: {} },
						_meta: { 'x.ai/tool': { name: 'use_tool', namespace: 'grok_build' } },
					},
				},
			});
			peer.push({
				jsonrpc: '2.0',
				id: 91,
				method: 'session/request_permission',
				params: {
					sessionId: 'sess-reducer-wb-fail',
					toolCall: { toolCallId: grokToolCallId, title: 'use_tool' },
					options: LIVE_PERMISSION_OPTIONS,
				},
			});
			await new Promise(r => setTimeout(r, 20));
			chatState = foldSignals(chatState, signals);
			const requestId = answerInputRequest(agent, chatState, true);
			chatState = chatReducer(chatState, {
				type: ActionType.ChatInputCompleted,
				requestId,
				response: ChatInputResponseKind.Accept,
			});
			await readNextMessage(peer.outbound);

			const callPromise = fetch(mcp.url, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', Authorization: mcp.headers[0]!.value },
				body: JSON.stringify({
					jsonrpc: '2.0',
					id: 2,
					method: 'tools/call',
					params: { name: 'get_errors', arguments: {} },
				}),
			});
			await new Promise(r => setTimeout(r, 30));
			chatState = foldSignals(chatState, signals);
			assert.strictEqual(toolCardCount(chatState), 1);

			agent.onClientToolCallComplete(chat, grokToolCallId, {
				success: false,
				pastTenseMessage: 'failed',
				content: [{ type: ToolResultContentType.Text, text: 'workbench blew up' }],
				error: { message: 'workbench blew up' },
			});
			chatState = chatReducer(chatState, {
				type: ActionType.ChatToolCallComplete,
				turnId,
				toolCallId: grokToolCallId,
				result: {
					success: false,
					pastTenseMessage: 'failed',
					content: [{ type: ToolResultContentType.Text, text: 'workbench blew up' }],
					error: { message: 'workbench blew up' },
				},
			});
			const callRes = await callPromise;
			assert.strictEqual(callRes.status, 200);
			const callJson = await callRes.json() as { result: { isError?: boolean } };
			assert.strictEqual(callJson.result.isError, true);
			assertNoStreaming(chatState);

			peer.push({ jsonrpc: '2.0', id: prompt.id, result: { stopReason: 'end_turn' } });
			await sendPromise;
		});
	});
});

function answerClientToolApproval(agent: GrokBuildAgent, signals: AgentSignal[], allow: boolean): void {
	const requested = [...signals].reverse().find(s =>
		s.kind === 'action' && s.action.type === ActionType.ChatInputRequested
	);
	assert.ok(requested && requested.kind === 'action' && requested.action.type === ActionType.ChatInputRequested);
	const request = requested.action.request as ChatInputRequest;
	agent.respondToUserInputRequest(request.id, ChatInputResponseKind.Accept, {
		'grok-client-tool-approval': {
			state: ChatInputAnswerState.Submitted,
			value: {
				kind: ChatInputAnswerValueKind.Selected,
				value: allow ? 'allow-once' : 'reject',
			},
		},
	});
}

function peekPendingClientToolCalls(agent: GrokBuildAgent, chat: URI): {
	hasBufferedResult(key: string): boolean;
	entries(): IterableIterator<readonly [string, unknown]>;
} {
	const backings = (agent as unknown as {
		_backings: Map<string, { pendingClientToolCalls: {
			hasBufferedResult(key: string): boolean;
			entries(): IterableIterator<readonly [string, unknown]>;
		} }>;
	})._backings;
	const backing = backings.get(chat.toString());
	assert.ok(backing, 'expected chat backing');
	return backing.pendingClientToolCalls;
}

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
