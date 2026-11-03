/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as http from 'http';
import { createHash, randomBytes } from 'crypto';
import { Disposable } from '../../../../base/common/lifecycle.js';
import type { ToolDefinition } from '../../common/state/protocol/state.js';
import { convertToolCallResult, type GrokMcpCallToolResult } from './grokBuildClientToolResult.js';
import type { ToolCallResult } from '../../common/state/protocol/channels-chat/state.js';

/**
 * ACP / grok MCP server name. Grok exposes tools as `<server>__<tool>` via
 * search_tool / use_tool. Matches Claude's in-process `client` server name.
 */
export const GROK_CLIENT_MCP_SERVER_NAME = 'client';

/** MCP protocol version accepted for initialize (streamable HTTP with plain JSON). */
export const GROK_CLIENT_MCP_PROTOCOL_VERSION = '2024-11-05';

/**
 * ACP `mcpServers` HTTP entry for grok 1.0.70:
 * `{ type: 'http', name, url, headers: [{ name, value }] }`.
 */
export interface IGrokAcpHttpMcpServer {
	readonly type: 'http';
	readonly name: string;
	readonly url: string;
	readonly headers: readonly { readonly name: string; readonly value: string }[];
}

export interface IGrokClientMcpToolInvoker {
	/**
	 * Run a workbench client tool: fire ChatToolCallStart/Ready with a Client
	 * contributor, then resolve when {@link IAgent.onClientToolCallComplete}
	 * delivers the result for `toolCallId`.
	 */
	invoke(toolName: string, args: Record<string, unknown>, toolCallId: string): Promise<ToolCallResult>;
}

export interface IGrokClientMcpServerHandle extends Disposable {
	readonly url: string;
	readonly token: string;
	/** Replace the live tools/list snapshot (name + description + inputSchema). */
	setTools(tools: readonly ToolDefinition[]): void;
	/** Current snapshot (for tests / diagnostics). */
	getTools(): readonly ToolDefinition[];
	/** ACP mcpServers entry for session/new and session/load. */
	toAcpMcpServer(): IGrokAcpHttpMcpServer;
}

interface IJsonRpcRequest {
	readonly jsonrpc?: unknown;
	readonly id?: unknown;
	readonly method?: unknown;
	readonly params?: unknown;
}

interface IJsonRpcSuccess {
	readonly jsonrpc: '2.0';
	readonly id: string | number | null;
	readonly result: unknown;
}

interface IJsonRpcFailure {
	readonly jsonrpc: '2.0';
	readonly id: string | number | null;
	readonly error: { readonly code: number; readonly message: string; readonly data?: unknown };
}

export type GrokMcpJsonRpcResponse = IJsonRpcSuccess | IJsonRpcFailure;

export interface IGrokMcpHttpResponse {
	readonly status: number;
	readonly headers?: Record<string, string>;
	readonly body?: string;
}

/**
 * Pure MCP JSON-RPC dispatcher used by the HTTP server and unit tests.
 * Auth is checked by the caller before invoking this.
 */
export async function handleGrokClientMcpRequest(
	message: unknown,
	tools: readonly ToolDefinition[],
	invoker: IGrokClientMcpToolInvoker,
	mintToolCallId: () => string = () => randomBytes(16).toString('hex'),
): Promise<GrokMcpJsonRpcResponse | undefined> {
	if (!message || typeof message !== 'object' || Array.isArray(message)) {
		return jsonRpcError(null, -32600, 'Invalid Request');
	}
	const req = message as IJsonRpcRequest;
	if (req.jsonrpc !== '2.0' || typeof req.method !== 'string') {
		return jsonRpcError(normalizeId(req.id), -32600, 'Invalid Request');
	}
	const id = normalizeId(req.id);
	const isNotification = req.id === undefined;

	switch (req.method) {
		case 'initialize':
			return jsonRpcResult(id, {
				protocolVersion: GROK_CLIENT_MCP_PROTOCOL_VERSION,
				capabilities: {
					tools: { listChanged: true },
				},
				serverInfo: {
					name: GROK_CLIENT_MCP_SERVER_NAME,
					version: '1.0.0',
				},
			});
		case 'notifications/initialized':
		case 'notifications/cancelled':
			return undefined;
		case 'ping':
			return isNotification ? undefined : jsonRpcResult(id, {});
		case 'tools/list':
			return jsonRpcResult(id, {
				tools: tools.map(tool => ({
					name: tool.name,
					description: tool.description ?? '',
					inputSchema: tool.inputSchema ?? { type: 'object', properties: {} },
				})),
			});
		case 'tools/call': {
			if (isNotification) {
				return undefined;
			}
			const params = req.params;
			if (!params || typeof params !== 'object' || Array.isArray(params)) {
				return jsonRpcError(id, -32602, 'Invalid params');
			}
			const name = (params as { name?: unknown }).name;
			const argsRaw = (params as { arguments?: unknown }).arguments;
			if (typeof name !== 'string' || name.length === 0) {
				return jsonRpcError(id, -32602, 'Invalid params: name required');
			}
			const tool = tools.find(t => t.name === name);
			if (!tool) {
				return jsonRpcError(id, -32602, `Unknown tool: ${name}`);
			}
			const args = (argsRaw && typeof argsRaw === 'object' && !Array.isArray(argsRaw))
				? argsRaw as Record<string, unknown>
				: {};
			const toolCallId = mintToolCallId();
			try {
				const protocolResult = await invoker.invoke(name, args, toolCallId);
				const mcpResult: GrokMcpCallToolResult = convertToolCallResult(protocolResult, toolCallId);
				return jsonRpcResult(id, mcpResult);
			} catch (err) {
				const text = err instanceof Error ? err.message : String(err);
				return jsonRpcResult(id, {
					content: [{ type: 'text', text }],
					isError: true,
				} satisfies GrokMcpCallToolResult);
			}
		}
		case 'server/discover':
			// grok 1.0.70 POSTs this first; answering method-not-found is OK.
			return jsonRpcError(id, -32601, 'Method not found');
		default:
			return isNotification ? undefined : jsonRpcError(id, -32601, 'Method not found');
	}
}

/** Extract and validate the Bearer token from an Authorization header value. */
export function extractBearerToken(authorizationHeader: string | undefined): string | undefined {
	if (typeof authorizationHeader !== 'string') {
		return undefined;
	}
	const match = /^Bearer\s+(\S+)\s*$/i.exec(authorizationHeader.trim());
	return match?.[1];
}

/** Constant-time token compare. */
export function tokensEqual(a: string, b: string): boolean {
	const left = createHash('sha256').update(a).digest();
	const right = createHash('sha256').update(b).digest();
	if (left.length !== right.length) {
		return false;
	}
	let diff = 0;
	for (let i = 0; i < left.length; i++) {
		diff |= left[i]! ^ right[i]!;
	}
	return diff === 0;
}

/**
 * HTTP request handler for one MCP endpoint. Used by unit tests without
 * binding a port. Rejects missing/invalid bearer tokens with 401.
 */
export async function handleGrokClientMcpHttpRequest(options: {
	readonly method: string;
	readonly authorizationHeader: string | undefined;
	readonly expectedToken: string;
	readonly bodyText: string;
	readonly tools: readonly ToolDefinition[];
	readonly invoker: IGrokClientMcpToolInvoker;
	readonly mintToolCallId?: () => string;
}): Promise<IGrokMcpHttpResponse> {
	const method = options.method.toUpperCase();
	if (method === 'GET' || method === 'HEAD') {
		// Streamable HTTP clients may probe with GET; 405 is acceptable.
		return { status: 405, headers: { Allow: 'POST' }, body: 'Method Not Allowed' };
	}
	if (method !== 'POST') {
		return { status: 405, headers: { Allow: 'POST' }, body: 'Method Not Allowed' };
	}

	const token = extractBearerToken(options.authorizationHeader);
	if (!token || !tokensEqual(token, options.expectedToken)) {
		return { status: 401, body: 'Unauthorized' };
	}

	let parsed: unknown;
	try {
		parsed = options.bodyText.length === 0 ? null : JSON.parse(options.bodyText);
	} catch {
		return {
			status: 200,
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(jsonRpcError(null, -32700, 'Parse error')),
		};
	}

	const response = await handleGrokClientMcpRequest(
		parsed,
		options.tools,
		options.invoker,
		options.mintToolCallId,
	);
	if (response === undefined) {
		// JSON-RPC notification — empty success.
		return { status: 202 };
	}
	return {
		status: 200,
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(response),
	};
}

/**
 * Bind a 127.0.0.1 HTTP MCP server that surfaces workbench client tools to
 * grok via ACP `mcpServers`. The live tool snapshot is mutable via
 * {@link IGrokClientMcpServerHandle.setTools}.
 */
export async function startGrokClientToolMcpServer(
	invoker: IGrokClientMcpToolInvoker,
	initialTools: readonly ToolDefinition[] = [],
): Promise<IGrokClientMcpServerHandle> {
	const token = randomBytes(32).toString('hex');
	let tools: readonly ToolDefinition[] = initialTools.slice();

	const server = http.createServer((req, res) => {
		void (async () => {
			const chunks: Buffer[] = [];
			for await (const chunk of req) {
				chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
			}
			const bodyText = Buffer.concat(chunks).toString('utf8');
			const response = await handleGrokClientMcpHttpRequest({
				method: req.method ?? 'GET',
				authorizationHeader: headerValue(req.headers.authorization),
				expectedToken: token,
				bodyText,
				tools,
				invoker,
			});
			res.writeHead(response.status, response.headers);
			res.end(response.body);
		})().catch(() => {
			if (!res.headersSent) {
				res.writeHead(500);
			}
			res.end();
		});
	});

	await new Promise<void>((resolve, reject) => {
		server.once('error', reject);
		server.listen(0, '127.0.0.1', () => {
			server.removeListener('error', reject);
			resolve();
		});
	});

	const address = server.address();
	if (!address || typeof address === 'string') {
		server.close();
		throw new Error('Grok client MCP server failed to bind a TCP port');
	}
	const url = `http://127.0.0.1:${address.port}/mcp`;

	return new class extends Disposable implements IGrokClientMcpServerHandle {
		readonly url = url;
		readonly token = token;

		constructor() {
			super();
			this._register({
				dispose: () => {
					server.close();
				},
			});
		}

		setTools(next: readonly ToolDefinition[]): void {
			tools = next.slice();
		}

		getTools(): readonly ToolDefinition[] {
			return tools;
		}

		toAcpMcpServer(): IGrokAcpHttpMcpServer {
			return {
				type: 'http',
				name: GROK_CLIENT_MCP_SERVER_NAME,
				url: this.url,
				headers: [
					{ name: 'Authorization', value: `Bearer ${this.token}` },
				],
			};
		}
	};
}

function headerValue(value: string | string[] | undefined): string | undefined {
	if (Array.isArray(value)) {
		return value[0];
	}
	return value;
}

function normalizeId(id: unknown): string | number | null {
	if (typeof id === 'string' || typeof id === 'number') {
		return id;
	}
	return null;
}

function jsonRpcResult(id: string | number | null, result: unknown): IJsonRpcSuccess {
	return { jsonrpc: '2.0', id, result };
}

function jsonRpcError(id: string | number | null, code: number, message: string, data?: unknown): IJsonRpcFailure {
	return {
		jsonrpc: '2.0',
		id,
		error: data === undefined ? { code, message } : { code, message, data },
	};
}
