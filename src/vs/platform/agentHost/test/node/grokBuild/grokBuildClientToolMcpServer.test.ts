/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ToolResultContentType, type ToolCallResult } from '../../../common/state/protocol/channels-chat/state.js';
import type { ToolDefinition } from '../../../common/state/protocol/state.js';
import {
	extractBearerToken,
	GROK_CLIENT_MCP_PROTOCOL_VERSION,
	GROK_CLIENT_MCP_SERVER_NAME,
	handleGrokClientMcpHttpRequest,
	handleGrokClientMcpRequest,
	tokensEqual,
} from '../../../node/grokBuild/grokBuildClientToolMcpServer.js';

function tool(over: Partial<ToolDefinition> = {}): ToolDefinition {
	return {
		name: 'echo',
		description: 'echoes input',
		inputSchema: { type: 'object', properties: { msg: { type: 'string' } }, required: ['msg'] },
		...over,
	};
}

suite('grokBuildClientToolMcpServer', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('extractBearerToken and tokensEqual', () => {
		assert.strictEqual(extractBearerToken('Bearer abc'), 'abc');
		assert.strictEqual(extractBearerToken('bearer xyz'), 'xyz');
		assert.strictEqual(extractBearerToken('Basic abc'), undefined);
		assert.strictEqual(extractBearerToken(undefined), undefined);
		assert.strictEqual(tokensEqual('same', 'same'), true);
		assert.strictEqual(tokensEqual('a', 'b'), false);
	});

	test('initialize returns protocolVersion and tools capability', async () => {
		const response = await handleGrokClientMcpRequest(
			{ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: GROK_CLIENT_MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'test', version: '0' } } },
			[],
			{ invoke: async () => ({ success: true, content: [] }) },
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
			{ invoke: async () => ({ success: true, content: [] }) },
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
					const result: ToolCallResult = {
						success: true,
						content: [{ type: ToolResultContentType.Text, text: 'pong' }],
					};
					return result;
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
			{ invoke: async () => ({ success: true, content: [] }) },
		);
		assert.ok(response && 'error' in response);
		assert.strictEqual((response as { error: { code: number } }).error.code, -32602);
	});

	test('server/discover returns -32601', async () => {
		const response = await handleGrokClientMcpRequest(
			{ jsonrpc: '2.0', id: 5, method: 'server/discover', params: {} },
			[],
			{ invoke: async () => ({ success: true, content: [] }) },
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
			invoker: { invoke: async () => ({ success: true, content: [] }) },
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
			invoker: { invoke: async () => ({ success: true, content: [] }) },
		});
		assert.strictEqual(response.status, 401);
	});

	test('HTTP GET returns 405', async () => {
		const response = await handleGrokClientMcpHttpRequest({
			method: 'GET',
			authorizationHeader: 'Bearer secret',
			expectedToken: 'secret',
			bodyText: '',
			tools: [],
			invoker: { invoke: async () => ({ success: true, content: [] }) },
		});
		assert.strictEqual(response.status, 405);
	});

	test('HTTP POST with valid token runs initialize', async () => {
		const response = await handleGrokClientMcpHttpRequest({
			method: 'POST',
			authorizationHeader: 'Bearer secret',
			expectedToken: 'secret',
			bodyText: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'initialize', params: {} }),
			tools: [],
			invoker: { invoke: async () => ({ success: true, content: [] }) },
		});
		assert.strictEqual(response.status, 200);
		assert.ok(response.body);
		const parsed = JSON.parse(response.body!) as { result: { serverInfo: { name: string } } };
		assert.strictEqual(parsed.result.serverInfo.name, GROK_CLIENT_MCP_SERVER_NAME);
	});
});
