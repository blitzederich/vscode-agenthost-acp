/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { PassThrough } from 'stream';
import { Emitter } from '../../../../../base/common/event.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../log/common/log.js';
import { fixedChatOwnerRef, GROK_BUILD_AGENT_PROVIDER_ID, type AgentSignal, type IAgentChatContext } from '../../../common/agent.js';
import { ActionType } from '../../../common/state/sessionActions.js';
import {
	AcpClient,
	type IAcpTransport,
} from '../../../node/grokBuild/acpClient.js';
import { GrokBuildAgent } from '../../../node/grokBuild/grokBuildAgent.js';
import { GROK_BUILD_ACP_ARGV, grokNotLoggedInError } from '../../../node/grokBuild/grokBuildLaunchConfig.js';

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

interface IFakePeer {
	readonly transport: IAcpTransport;
	readonly outbound: PassThrough;
	push(message: object): void;
	dispose(): void;
}

function makeFakePeer(): IFakePeer {
	const clientStdin = new PassThrough();
	const clientStdout = new PassThrough();
	const exitEmitter = new Emitter<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }>();
	const onceExitListeners: ((e: { readonly code: number | null; readonly signal: NodeJS.Signals | null }) => void)[] = [];

	const transport: IAcpTransport = {
		stdin: clientStdin,
		stdout: clientStdout,
		kill() {
			exitEmitter.fire({ code: null, signal: 'SIGTERM' });
			return true;
		},
		onExit: exitEmitter.event,
		onExitOnce(listener) {
			onceExitListeners.push(listener);
		},
	};

	return {
		transport,
		outbound: clientStdin,
		push(message: object) {
			clientStdout.write(JSON.stringify(message) + '\n');
		},
		dispose() {
			onceExitListeners.length = 0;
			exitEmitter.dispose();
			clientStdin.destroy();
			clientStdout.destroy();
		},
	};
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

	function createAgent(): GrokBuildAgent {
		return store.add(new GrokBuildAgent(new NullLogService(), new TestProductService() as any));
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
		const peer = store.add(makeFakePeer());
		const agent = createAgent();
		let spawnCount = 0;
		agent.bindTestSpawn(launch => {
			spawnCount++;
			assert.deepStrictEqual([...launch.args], [...GROK_BUILD_ACP_ARGV]);
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
	});
});
