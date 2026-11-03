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

/** Max JSON-RPC body size accepted by the client-tools HTTP MCP server. */
export const GROK_CLIENT_MCP_MAX_BODY_BYTES = 8 * 1024 * 1024;

/** Prefix grok applies to tools from the `client` MCP server (`client__<tool>`). */
export const GROK_CLIENT_TOOL_NAME_PREFIX = `${GROK_CLIENT_MCP_SERVER_NAME}__`;

/**
 * Whether an ACP tool title / x.ai tool name targets a workbench client tool
 * (`client__…`). Used by the session-update mapper to suppress a duplicate card
 * — the HTTP MCP `tools/call` path owns the single Client-contributor card.
 */
export function hasClientToolNamePrefix(toolName: string): boolean {
	return toolName.startsWith(GROK_CLIENT_TOOL_NAME_PREFIX);
}

/**
 * Strip the `client__` prefix grok applies to MCP client tools. Returns the
 * input unchanged when it does not carry the prefix.
 */
export function stripClientToolNamePrefix(toolName: string): string {
	return hasClientToolNamePrefix(toolName) ? toolName.slice(GROK_CLIENT_TOOL_NAME_PREFIX.length) : toolName;
}

/**
 * Accept only loopback Host headers for the ephemeral MCP port.
 * `Host` must be `127.0.0.1:<port>` or `localhost:<port>` (optional brackets
 * around IPv4 are rejected; no other hosts).
 */
export function isAllowedGrokClientMcpHost(hostHeader: string | undefined, port: number): boolean {
	if (typeof hostHeader !== 'string') {
		return false;
	}
	const host = hostHeader.trim().toLowerCase();
	const expectedPort = String(port);
	return host === `127.0.0.1:${expectedPort}` || host === `localhost:${expectedPort}`;
}

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
	 *
	 * `signal` is aborted when the HTTP request socket closes so the parked
	 * pending call can be cleaned up instead of hanging.
	 */
	invoke(toolName: string, args: Record<string, unknown>, toolCallId: string, signal?: AbortSignal): Promise<ToolCallResult>;
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
	signal?: AbortSignal,
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
				const protocolResult = await invoker.invoke(name, args, toolCallId, signal);
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
 * binding a port. Rejects missing/invalid bearer tokens with 401 and
 * disallowed Host headers with 403. Callers that bind a real socket should
 * check auth (and Host) before reading the body; this helper still validates
 * both for pure unit tests that already hold `bodyText`.
 */
export async function handleGrokClientMcpHttpRequest(options: {
	readonly method: string;
	readonly authorizationHeader: string | undefined;
	readonly expectedToken: string;
	readonly bodyText: string;
	readonly tools: readonly ToolDefinition[];
	readonly invoker: IGrokClientMcpToolInvoker;
	readonly mintToolCallId?: () => string;
	readonly hostHeader?: string;
	readonly listenPort?: number;
	readonly signal?: AbortSignal;
}): Promise<IGrokMcpHttpResponse> {
	const method = options.method.toUpperCase();
	if (method === 'GET' || method === 'HEAD') {
		// Streamable HTTP clients may probe with GET; 405 is acceptable.
		return { status: 405, headers: { Allow: 'POST' }, body: 'Method Not Allowed' };
	}
	if (method !== 'POST') {
		return { status: 405, headers: { Allow: 'POST' }, body: 'Method Not Allowed' };
	}

	if (options.listenPort !== undefined && !isAllowedGrokClientMcpHost(options.hostHeader, options.listenPort)) {
		return { status: 403, body: 'Forbidden' };
	}

	const token = extractBearerToken(options.authorizationHeader);
	if (!token || !tokensEqual(token, options.expectedToken)) {
		return { status: 401, body: 'Unauthorized' };
	}

	if (Buffer.byteLength(options.bodyText, 'utf8') > GROK_CLIENT_MCP_MAX_BODY_BYTES) {
		return { status: 413, body: 'Payload Too Large' };
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
		options.signal,
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
 *
 * Auth and Host are checked before the body is read. Bodies larger than
 * {@link GROK_CLIENT_MCP_MAX_BODY_BYTES} return 413. Socket close aborts the
 * in-flight `tools/call` so pending client invocations do not hang.
 */
export async function startGrokClientToolMcpServer(
	invoker: IGrokClientMcpToolInvoker,
	initialTools: readonly ToolDefinition[] = [],
): Promise<IGrokClientMcpServerHandle> {
	const token = randomBytes(32).toString('hex');
	let tools: readonly ToolDefinition[] = initialTools.slice();
	let listenPort = 0;

	const server = http.createServer((req, res) => {
		void (async () => {
			const method = (req.method ?? 'GET').toUpperCase();
			if (method === 'GET' || method === 'HEAD' || method !== 'POST') {
				res.writeHead(405, { Allow: 'POST' });
				res.end('Method Not Allowed');
				req.resume();
				return;
			}

			if (!isAllowedGrokClientMcpHost(headerValue(req.headers.host), listenPort)) {
				res.writeHead(403);
				res.end('Forbidden');
				req.resume();
				return;
			}

			const bearer = extractBearerToken(headerValue(req.headers.authorization));
			if (!bearer || !tokensEqual(bearer, token)) {
				res.writeHead(401);
				res.end('Unauthorized');
				req.resume();
				return;
			}

			const contentLengthHeader = headerValue(req.headers['content-length']);
			if (contentLengthHeader !== undefined) {
				const contentLength = Number(contentLengthHeader);
				if (Number.isFinite(contentLength) && contentLength > GROK_CLIENT_MCP_MAX_BODY_BYTES) {
					res.writeHead(413);
					res.end('Payload Too Large');
					req.resume();
					return;
				}
			}

			// Abort only when the client drops the connection mid-handler, not
			// when the request body stream ends normally (IncomingMessage 'close').
			const abort = new AbortController();
			const onClientGone = () => {
				if (!res.writableFinished) {
					abort.abort();
				}
			};
			req.on('aborted', onClientGone);
			res.on('close', onClientGone);

			let bodyText: string;
			try {
				bodyText = await readRequestBodyCapped(req, GROK_CLIENT_MCP_MAX_BODY_BYTES);
			} catch (err) {
				req.off('aborted', onClientGone);
				res.off('close', onClientGone);
				if (err instanceof BodyTooLargeError) {
					if (!res.headersSent) {
						res.writeHead(413);
						res.end('Payload Too Large');
					}
					return;
				}
				throw err;
			}

			const response = await handleGrokClientMcpHttpRequest({
				method: 'POST',
				authorizationHeader: headerValue(req.headers.authorization),
				expectedToken: token,
				bodyText,
				tools,
				invoker,
				hostHeader: headerValue(req.headers.host),
				listenPort,
				signal: abort.signal,
			});
			req.off('aborted', onClientGone);
			res.off('close', onClientGone);
			if (abort.signal.aborted) {
				if (!res.headersSent) {
					res.writeHead(499);
					res.end();
				}
				return;
			}
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
	listenPort = address.port;
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

class BodyTooLargeError extends Error {
	constructor() {
		super('Payload Too Large');
		this.name = 'BodyTooLargeError';
	}
}

async function readRequestBodyCapped(req: http.IncomingMessage, maxBytes: number): Promise<string> {
	const chunks: Buffer[] = [];
	let total = 0;
	for await (const chunk of req) {
		const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		total += buf.length;
		if (total > maxBytes) {
			req.resume();
			throw new BodyTooLargeError();
		}
		chunks.push(buf);
	}
	return Buffer.concat(chunks).toString('utf8');
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
