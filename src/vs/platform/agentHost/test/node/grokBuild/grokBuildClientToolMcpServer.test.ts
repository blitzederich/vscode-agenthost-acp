/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import * as http from 'http';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ToolResultContentType, type ToolCallResult } from '../../../common/state/protocol/channels-chat/state.js';
import type { ToolDefinition } from '../../../common/state/protocol/state.js';
import { structuralEquals } from '../../../../../base/common/equals.js';
import {
	extractBearerToken,
	GROK_CLIENT_MCP_MAX_BODY_BYTES,
	GROK_CLIENT_MCP_PROTOCOL_VERSION,
	GROK_CLIENT_MCP_SERVER_NAME,
	handleGrokClientMcpHttpRequest,
	handleGrokClientMcpRequest,
	hasClientToolNamePrefix,
	isAllowedGrokClientMcpHost,
	parseGrokClientToolTarget,
	startGrokClientToolMcpServer,
	stripClientToolNamePrefix,
	takePendingGrokClientToolCall,
	tokensEqual,
	type IGrokPendingClientToolCall,
} from '../../../node/grokBuild/grokBuildClientToolMcpServer.js';

function tool(over: Partial<ToolDefinition> = {}): ToolDefinition {
	return {
		name: 'echo',
		description: 'echoes input',
		inputSchema: { type: 'object', properties: { msg: { type: 'string' } }, required: ['msg'] },
		...over,
	};
}

function okResult(text = ''): ToolCallResult {
	return {
		success: true,
		pastTenseMessage: 'done',
		content: text ? [{ type: ToolResultContentType.Text, text }] : [],
	};
}

suite('grokBuildClientToolMcpServer', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('extractBearerToken and tokensEqual', () => {
		assert.strictEqual(extractBearerToken('Bearer abc'), 'abc');
		assert.strictEqual(extractBearerToken('bearer xyz'), 'xyz');
		assert.strictEqual(extractBearerToken('Basic abc'), undefined);
		assert.strictEqual(extractBearerToken(undefined), undefined);
		assert.strictEqual(tokensEqual('same', 'same'), true);
		assert.strictEqual(tokensEqual('a', 'b'), false);
	});

	test('hasClientToolNamePrefix / stripClientToolNamePrefix', () => {
		assert.strictEqual(hasClientToolNamePrefix('client__echo'), true);
		assert.strictEqual(hasClientToolNamePrefix('shell'), false);
		assert.strictEqual(stripClientToolNamePrefix('client__echo'), 'echo');
		assert.strictEqual(stripClientToolNamePrefix('shell'), 'shell');
	});

	test('parseGrokClientToolTarget accepts live use_tool and later client__ title', () => {
		assert.deepStrictEqual(parseGrokClientToolTarget({
			title: 'use_tool',
			rawInput: { tool_name: 'client__workspace_echo', tool_input: { msg: 'hi' } },
			_meta: { 'x.ai/tool': { name: 'use_tool', namespace: 'grok_build' } },
		}), { toolName: 'workspace_echo', args: { msg: 'hi' } });

		assert.deepStrictEqual(parseGrokClientToolTarget({
			title: 'client__workspace_echo',
			rawInput: { msg: 'hi' },
		}), { toolName: 'workspace_echo', args: { msg: 'hi' } });

		assert.strictEqual(parseGrokClientToolTarget({
			title: 'use_tool',
			rawInput: { tool_name: 'other__echo', tool_input: {} },
		}), undefined);
	});

	test('takePendingGrokClientToolCall matches args then falls back to FIFO by name', () => {
		const pending: IGrokPendingClientToolCall[] = [
			{ toolCallId: 'a', toolName: 'echo', args: { msg: 'one' }, invoked: false },
			{ toolCallId: 'b', toolName: 'echo', args: { msg: 'two' }, invoked: false },
		];
		const matchTwo = takePendingGrokClientToolCall(pending, 'echo', { msg: 'two' }, structuralEquals);
		assert.strictEqual(matchTwo?.toolCallId, 'b');
		assert.strictEqual(matchTwo?.invoked, true);

		const matchFallback = takePendingGrokClientToolCall(pending, 'echo', { msg: 'missing' }, structuralEquals);
		assert.strictEqual(matchFallback?.toolCallId, 'a');

		assert.strictEqual(
			takePendingGrokClientToolCall(pending, 'echo', { msg: 'one' }, structuralEquals),
			undefined,
		);
	});

	test('isAllowedGrokClientMcpHost accepts only loopback with port', () => {
		assert.strictEqual(isAllowedGrokClientMcpHost('127.0.0.1:3456', 3456), true);
		assert.strictEqual(isAllowedGrokClientMcpHost('localhost:3456', 3456), true);
		assert.strictEqual(isAllowedGrokClientMcpHost('LOCALHOST:3456', 3456), true);
		assert.strictEqual(isAllowedGrokClientMcpHost('127.0.0.1:9999', 3456), false);
		assert.strictEqual(isAllowedGrokClientMcpHost('example.com:3456', 3456), false);
		assert.strictEqual(isAllowedGrokClientMcpHost('127.0.0.1', 3456), false);
		assert.strictEqual(isAllowedGrokClientMcpHost(undefined, 3456), false);
	});

	test('initialize returns protocolVersion and tools capability', async () => {
		const response = await handleGrokClientMcpRequest(
			{ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: GROK_CLIENT_MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'test', version: '0' } } },
			[],
			{ invoke: async () => okResult() },
		);
		assert.ok(response);
		assert.strictEqual('result' in response, true);
		if (!('result' in response)) {
			return;
		}
		const result = response.result as {
			protocolVersion: string;
			capabilities: { tools?: { listChanged?: boolean } };
			serverInfo: { name: string };
		};
		assert.strictEqual(result.protocolVersion, GROK_CLIENT_MCP_PROTOCOL_VERSION);
		assert.strictEqual(result.capabilities.tools?.listChanged, true);
		assert.strictEqual(result.serverInfo.name, GROK_CLIENT_MCP_SERVER_NAME);
	});

	test('tools/list returns snapshot names and schemas', async () => {
		const response = await handleGrokClientMcpRequest(
			{ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
			[tool({ name: 'a' }), tool({ name: 'b', description: 'bee' })],
			{ invoke: async () => okResult() },
		);
		assert.ok(response && 'result' in response);
		const tools = (response as { result: { tools: Array<{ name: string; description: string }> } }).result.tools;
		assert.deepStrictEqual(tools.map(t => t.name), ['a', 'b']);
		assert.strictEqual(tools[1]!.description, 'bee');
	});

	test('tools/call invokes callback and returns MCP content', async () => {
		let seen: { name: string; args: Record<string, unknown>; id: string } | undefined;
		const response = await handleGrokClientMcpRequest(
			{ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'echo', arguments: { msg: 'hi' } } },
			[tool()],
			{
				invoke: async (name, args, toolCallId) => {
					seen = { name, args, id: toolCallId };
					return okResult('pong');
				},
			},
			() => 'fixed-id',
		);
		assert.deepStrictEqual(seen, { name: 'echo', args: { msg: 'hi' }, id: 'fixed-id' });
		assert.ok(response && 'result' in response);
		assert.deepStrictEqual((response as { result: unknown }).result, {
			content: [{ type: 'text', text: 'pong' }],
		});
	});

	test('tools/call unknown tool is -32602', async () => {
		const response = await handleGrokClientMcpRequest(
			{ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'missing', arguments: {} } },
			[tool()],
			{ invoke: async () => okResult() },
		);
		assert.ok(response && 'error' in response);
		assert.strictEqual((response as { error: { code: number } }).error.code, -32602);
	});

	test('server/discover returns -32601', async () => {
		const response = await handleGrokClientMcpRequest(
			{ jsonrpc: '2.0', id: 5, method: 'server/discover', params: {} },
			[],
			{ invoke: async () => okResult() },
		);
		assert.ok(response && 'error' in response);
		assert.strictEqual((response as { error: { code: number } }).error.code, -32601);
	});

	test('HTTP rejects missing bearer token', async () => {
		const response = await handleGrokClientMcpHttpRequest({
			method: 'POST',
			authorizationHeader: undefined,
			expectedToken: 'secret',
			bodyText: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
			tools: [],
			invoker: { invoke: async () => okResult() },
		});
		assert.strictEqual(response.status, 401);
	});

	test('HTTP rejects wrong bearer token', async () => {
		const response = await handleGrokClientMcpHttpRequest({
			method: 'POST',
			authorizationHeader: 'Bearer other',
			expectedToken: 'secret',
			bodyText: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
			tools: [],
			invoker: { invoke: async () => okResult() },
		});
		assert.strictEqual(response.status, 401);
	});

	test('HTTP rejects disallowed Host header', async () => {
		const response = await handleGrokClientMcpHttpRequest({
			method: 'POST',
			authorizationHeader: 'Bearer secret',
			expectedToken: 'secret',
			hostHeader: 'evil.example:1234',
			listenPort: 1234,
			bodyText: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
			tools: [],
			invoker: { invoke: async () => okResult() },
		});
		assert.strictEqual(response.status, 403);
	});

	test('HTTP rejects oversized body with 413', async () => {
		const response = await handleGrokClientMcpHttpRequest({
			method: 'POST',
			authorizationHeader: 'Bearer secret',
			expectedToken: 'secret',
			hostHeader: '127.0.0.1:9',
			listenPort: 9,
			bodyText: 'x'.repeat(GROK_CLIENT_MCP_MAX_BODY_BYTES + 1),
			tools: [],
			invoker: { invoke: async () => okResult() },
		});
		assert.strictEqual(response.status, 413);
	});

	test('HTTP GET returns 405', async () => {
		const response = await handleGrokClientMcpHttpRequest({
			method: 'GET',
			authorizationHeader: 'Bearer secret',
			expectedToken: 'secret',
			bodyText: '',
			tools: [],
			invoker: { invoke: async () => okResult() },
		});
		assert.strictEqual(response.status, 405);
	});

	test('HTTP POST with valid token runs initialize', async () => {
		const response = await handleGrokClientMcpHttpRequest({
			method: 'POST',
			authorizationHeader: 'Bearer secret',
			expectedToken: 'secret',
			hostHeader: '127.0.0.1:9',
			listenPort: 9,
			bodyText: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'initialize', params: {} }),
			tools: [],
			invoker: { invoke: async () => okResult() },
		});
		assert.strictEqual(response.status, 200);
		assert.ok(response.body);
		const parsed = JSON.parse(response.body!) as { result: { serverInfo: { name: string } } };
		assert.strictEqual(parsed.result.serverInfo.name, GROK_CLIENT_MCP_SERVER_NAME);
	});

	test('live server checks auth before body and rejects bad Host', async () => {
		const handle = store.add(await startGrokClientToolMcpServer({ invoke: async () => okResult() }));
		const port = Number(new URL(handle.url).port);

		const unauthorized = await new Promise<{ status: number }>((resolve, reject) => {
			const req = http.request(handle.url, { method: 'POST', headers: { Host: `127.0.0.1:${port}`, 'Content-Type': 'application/json' } }, res => {
				res.resume();
				resolve({ status: res.statusCode ?? 0 });
			});
			req.on('error', reject);
			req.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }));
			req.end();
		});
		assert.strictEqual(unauthorized.status, 401);

		const forbidden = await new Promise<{ status: number }>((resolve, reject) => {
			const req = http.request({
				hostname: '127.0.0.1',
				port,
				path: '/mcp',
				method: 'POST',
				headers: {
					Host: `evil.local:${port}`,
					Authorization: `Bearer ${handle.token}`,
					'Content-Type': 'application/json',
				},
			}, res => {
				res.resume();
				resolve({ status: res.statusCode ?? 0 });
			});
			req.on('error', reject);
			req.write('{}');
			req.end();
		});
		assert.strictEqual(forbidden.status, 403);
	});

	test('dispose closes the listening port', async () => {
		const handle = await startGrokClientToolMcpServer({ invoke: async () => okResult() });
		const port = Number(new URL(handle.url).port);
		handle.dispose();
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
});
