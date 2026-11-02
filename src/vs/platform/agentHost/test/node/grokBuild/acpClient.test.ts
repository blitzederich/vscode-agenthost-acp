/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { PassThrough } from 'stream';
import { Emitter } from '../../../../../base/common/event.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	AcpClient,
	AcpJsonRpcError,
	AcpJsonRpcErrorCode,
	type IAcpTransport,
} from '../../../node/grokBuild/acpClient.js';

interface IFakePeer {
	readonly transport: IAcpTransport;
	readonly outbound: PassThrough;
	push(message: object): void;
	exit(code: number | null, signal?: NodeJS.Signals | null): void;
	dispose(): void;
}

function makeFakePeer(): IFakePeer {
	const clientStdin = new PassThrough();
	const clientStdout = new PassThrough();
	const exitEmitter = new Emitter<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }>();
	const onceExitListeners: ((e: { readonly code: number | null; readonly signal: NodeJS.Signals | null }) => void)[] = [];
	let killed = false;
	const fireExit = (e: { readonly code: number | null; readonly signal: NodeJS.Signals | null }) => {
		exitEmitter.fire(e);
		for (const listener of onceExitListeners.splice(0)) {
			listener(e);
		}
	};

	const transport: IAcpTransport = {
		stdin: clientStdin,
		stdout: clientStdout,
		kill(_signal) {
			if (killed) {
				return false;
			}
			killed = true;
			fireExit({ code: null, signal: _signal ?? null });
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
		exit(code, signal = null) {
			fireExit({ code, signal });
		},
		dispose() {
			onceExitListeners.length = 0;
			exitEmitter.dispose();
			clientStdin.destroy();
			clientStdout.destroy();
		},
	};
}

function readNextMessage(stream: PassThrough, timeoutMs = 1_000): Promise<unknown> {
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
			reject(new Error('stream ended before message arrived'));
		};
		const timer = setTimeout(() => {
			cleanup();
			reject(new Error('timed out waiting for message'));
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

suite('GrokBuild AcpClient', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('initialize + authenticate handshake includes jsonrpc 2.0', async () => {
		const peer = store.add(makeFakePeer());
		const client = store.add(new AcpClient(peer.transport));

		const initPromise = client.request('initialize', {
			protocolVersion: 1,
			clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
		});
		const initSent = await readNextMessage(peer.outbound) as { jsonrpc: string; id: number; method: string };
		assert.strictEqual(initSent.jsonrpc, '2.0');
		assert.strictEqual(initSent.method, 'initialize');
		peer.push({
			jsonrpc: '2.0',
			id: initSent.id,
			result: {
				protocolVersion: 1,
				authMethods: [{ id: 'grok.com', name: 'Grok' }],
				_meta: { agentVersion: '1.0.70' },
			},
		});
		const initResult = await initPromise;
		assert.strictEqual(initResult.protocolVersion, 1);

		const authPromise = client.request('authenticate', { methodId: 'grok.com' });
		const authSent = await readNextMessage(peer.outbound) as { method: string; params: { methodId: string } };
		assert.strictEqual(authSent.method, 'authenticate');
		assert.strictEqual(authSent.params.methodId, 'grok.com');
		peer.push({ jsonrpc: '2.0', id: (authSent as unknown as { id: number }).id, result: {} });
		await authPromise;
	});

	test('auth-required error rejects with response error', async () => {
		const peer = store.add(makeFakePeer());
		const client = store.add(new AcpClient(peer.transport));
		const promise = client.request('session/new', { cwd: '/tmp', mcpServers: [] });
		const sent = await readNextMessage(peer.outbound) as { id: number };
		peer.push({ jsonrpc: '2.0', id: sent.id, error: { code: -32000, message: 'Authentication required' } });
		await assert.rejects(promise, (err: unknown) => {
			assert.ok(err instanceof AcpJsonRpcError);
			assert.strictEqual(err.code, -32000);
			assert.match(err.message, /Authentication required/);
			return true;
		});
	});

	test('unknown notifications are ignored via unhandled hook', async () => {
		const peer = store.add(makeFakePeer());
		const client = store.add(new AcpClient(peer.transport));
		const seen: string[] = [];
		store.add(client.onUnhandledNotification(method => seen.push(method)));
		peer.push({ jsonrpc: '2.0', method: '_x.ai/models/update', params: { models: [] } });
		peer.push({ jsonrpc: '2.0', method: '_x.ai/session/setup', params: { sessionId: null } });
		await new Promise(r => setTimeout(r, 20));
		assert.deepStrictEqual(seen, ['_x.ai/models/update', '_x.ai/session/setup']);
	});

	test('permission request round trip', async () => {
		const peer = store.add(makeFakePeer());
		const client = store.add(new AcpClient(peer.transport));
		store.add(client.onRequest('session/request_permission', async params => {
			assert.strictEqual(params.sessionId, 'sess-1');
			assert.ok(params.options.length >= 1);
			const allow = params.options.find(o => o.kind === 'allow_once');
			assert.ok(allow);
			return { result: { outcome: { outcome: 'selected', optionId: allow!.optionId } } };
		}));

		peer.push({
			jsonrpc: '2.0',
			id: 99,
			method: 'session/request_permission',
			params: {
				sessionId: 'sess-1',
				toolCall: { toolCallId: 'call-1' },
				options: [
					{ optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
					{ optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
				],
			},
		});
		const reply = await readNextMessage(peer.outbound) as { id: number; result: { outcome: { outcome: string; optionId: string } } };
		assert.strictEqual(reply.id, 99);
		assert.strictEqual(reply.result.outcome.outcome, 'selected');
		assert.strictEqual(reply.result.outcome.optionId, 'allow-once');
	});

	test('exit_plan_mode server request reaches a registered handler', async () => {
		const peer = store.add(makeFakePeer());
		const client = store.add(new AcpClient(peer.transport));
		store.add(client.onRequest('_x.ai/exit_plan_mode', async params => {
			assert.strictEqual(params.sessionId, 'sess-plan');
			assert.strictEqual(params.toolCallId, 'call-plan');
			assert.strictEqual(params.planContent, '# Plan');
			return { result: { outcome: 'approved' } };
		}));

		peer.push({
			jsonrpc: '2.0',
			id: 7,
			method: '_x.ai/exit_plan_mode',
			params: {
				sessionId: 'sess-plan',
				toolCallId: 'call-plan',
				planContent: '# Plan',
			},
		});
		const reply = await readNextMessage(peer.outbound) as { id: number; result: { outcome: string } };
		assert.strictEqual(reply.id, 7);
		assert.strictEqual(reply.result.outcome, 'approved');
	});

	test('unregistered exit_plan_mode still returns MethodNotFound', async () => {
		const peer = store.add(makeFakePeer());
		store.add(new AcpClient(peer.transport));
		peer.push({
			jsonrpc: '2.0',
			id: 8,
			method: '_x.ai/exit_plan_mode',
			params: { sessionId: 's', toolCallId: 'c', planContent: '# x' },
		});
		const reply = await readNextMessage(peer.outbound) as { id: number; error: { code: number; message: string } };
		assert.strictEqual(reply.id, 8);
		assert.strictEqual(reply.error.code, AcpJsonRpcErrorCode.MethodNotFound);
		assert.match(reply.error.message, /Method not found/);
	});

	test('session/cancel notification is written with jsonrpc', async () => {
		const peer = store.add(makeFakePeer());
		const client = store.add(new AcpClient(peer.transport));
		client.notify('session/cancel', { sessionId: 'sess-1' });
		const sent = await readNextMessage(peer.outbound) as { jsonrpc: string; method: string; params: { sessionId: string } };
		assert.strictEqual(sent.jsonrpc, '2.0');
		assert.strictEqual(sent.method, 'session/cancel');
		assert.strictEqual(sent.params.sessionId, 'sess-1');
	});

	test('exit rejects pending requests', async () => {
		const peer = store.add(makeFakePeer());
		const client = store.add(new AcpClient(peer.transport));
		const promise = client.request('initialize', {
			protocolVersion: 1,
			clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
		});
		await readNextMessage(peer.outbound);
		peer.exit(1);
		await assert.rejects(promise, (err: unknown) => {
			assert.ok(err instanceof AcpJsonRpcError);
			assert.strictEqual(err.code, AcpJsonRpcErrorCode.InternalError);
			return true;
		});
	});
});
