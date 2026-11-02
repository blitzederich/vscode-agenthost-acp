/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { Readable, Writable } from 'stream';
import { CancellationError } from '../../../../base/common/errors.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, type IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import type {
	AcpClientNotificationMethod,
	AcpClientNotificationParams,
	AcpClientRequestMethod,
	AcpClientRequestParams,
	AcpClientRequestResult,
	AcpJsonRpcId,
	AcpServerNotificationMethod,
	AcpServerRequestMethod,
	AcpServerRequestParams,
	AcpServerRequestResult,
} from './protocol/acpTypes.js';

/**
 * JSON-RPC 2.0 over NDJSON for ACP. Unlike the Codex app-server convention,
 * ACP includes `"jsonrpc": "2.0"` on every message (verified grok 1.0.70).
 */

export const enum AcpJsonRpcErrorCode {
	ParseError = -32700,
	InvalidRequest = -32600,
	MethodNotFound = -32601,
	InvalidParams = -32602,
	InternalError = -32603,
	/** Common application error used by Grok for auth failures. */
	ApplicationError = -32000,
}

export class AcpJsonRpcError extends Error {
	constructor(
		readonly code: number,
		message: string,
		readonly data?: unknown,
	) {
		super(message);
		this.name = 'AcpJsonRpcError';
	}
}

export class AcpJsonRpcResponseError extends AcpJsonRpcError { }

export type AcpServerRequestHandlerResult<R = unknown> =
	| { readonly result: R; readonly error?: undefined }
	| { readonly result?: undefined; readonly error: { readonly code: number; readonly message: string; readonly data?: unknown } };

export interface IAcpTransport {
	readonly stdin: Writable;
	readonly stdout: Readable;
	kill(signal?: NodeJS.Signals): boolean;
	readonly onExit: Event<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }>;
	onExitOnce(listener: (e: { readonly code: number | null; readonly signal: NodeJS.Signals | null }) => void): void;
}

export interface IAcpClient extends IDisposable {
	readonly onExit: Event<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }>;
	readonly onTransportError: Event<Error>;

	request<M extends AcpClientRequestMethod>(
		method: M,
		params: AcpClientRequestParams[M],
	): Promise<AcpClientRequestResult[M]>;

	notify<M extends AcpClientNotificationMethod>(
		method: M,
		params: AcpClientNotificationParams[M],
	): void;

	/**
	 * Reject every in-flight request (e.g. child process EACCES / EPIPE).
	 * Does not dispose the client.
	 */
	rejectAllPending(reason: unknown): void;

	onNotification(
		method: AcpServerNotificationMethod,
		handler: (params: unknown) => void,
	): IDisposable;

	/**
	 * Catch-all for notifications whose method is not registered via
	 * {@link onNotification}. Used to swallow `_x.ai/*` and future kinds.
	 */
	onUnhandledNotification(handler: (method: string, params: unknown) => void): IDisposable;

	onRequest<M extends AcpServerRequestMethod>(
		method: M,
		handler: (params: AcpServerRequestParams[M]) => Promise<AcpServerRequestHandlerResult<AcpServerRequestResult[M]>> | AcpServerRequestHandlerResult<AcpServerRequestResult[M]>,
	): IDisposable;
}

interface IPendingRequest {
	resolve(value: unknown): void;
	reject(reason: unknown): void;
	readonly method: string;
}

interface IWireMessage {
	readonly jsonrpc?: string;
	readonly id?: AcpJsonRpcId;
	readonly method?: string;
	readonly params?: unknown;
	readonly result?: unknown;
	readonly error?: { readonly code: number; readonly message: string; readonly data?: unknown };
}

const GRACE_KILL_MS = 2_000;

export class AcpClient extends Disposable implements IAcpClient {

	private readonly _onExit = this._register(new Emitter<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }>());
	readonly onExit = this._onExit.event;

	private readonly _onTransportError = this._register(new Emitter<Error>());
	readonly onTransportError = this._onTransportError.event;

	private _nextId = 1;
	private readonly _pending = new Map<number, IPendingRequest>();
	private readonly _notificationHandlers = new Map<string, (params: unknown) => void>();
	private readonly _requestHandlers = new Map<string, (params: unknown) => Promise<AcpServerRequestHandlerResult<unknown>>>();
	private _unhandledNotificationHandler: ((method: string, params: unknown) => void) | undefined;

	private _exited = false;
	private _disposed = false;
	private _buf = '';

	constructor(
		private readonly _transport: IAcpTransport,
		private readonly _onLog?: (level: 'info' | 'warn' | 'error' | 'trace', message: string) => void,
		private readonly _graceKillMs = GRACE_KILL_MS,
	) {
		super();
		this._register(this._transport.onExit(e => this._handleExit(e)));
		this._transport.stdout.setEncoding?.('utf8');
		this._register(this._listenToStdout());
	}

	private _listenToStdout(): IDisposable {
		const onData = (chunk: string | Buffer) => {
			const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
			this._buf += text;
			let nl: number;
			while ((nl = this._buf.indexOf('\n')) >= 0) {
				const line = this._buf.slice(0, nl);
				this._buf = this._buf.slice(nl + 1);
				const trimmed = line.trim();
				if (trimmed.length === 0) {
					continue;
				}
				let parsed: IWireMessage;
				try {
					parsed = JSON.parse(trimmed) as IWireMessage;
				} catch {
					// The line can be an authenticate result. Keep the payload off the error log.
					this._log('error', 'parse error on ACP line');
					this._log('trace', `parse error on ACP line: ${trimmed.slice(0, 200)}`);
					continue;
				}
				this._dispatch(parsed);
			}
		};
		this._transport.stdout.on('data', onData);
		return toDisposable(() => this._transport.stdout.off('data', onData));
	}

	private _dispatch(msg: IWireMessage): void {
		const hasId = msg.id !== undefined;
		const hasMethod = typeof msg.method === 'string';
		const hasResult = Object.prototype.hasOwnProperty.call(msg, 'result');
		const hasError = Object.prototype.hasOwnProperty.call(msg, 'error');

		if (hasId && !hasMethod && (hasResult || hasError)) {
			if (typeof msg.id !== 'number') {
				this._log('warn', `unsolicited response id=${String(msg.id)}`);
				return;
			}
			const pending = this._pending.get(msg.id);
			if (!pending) {
				this._log('warn', `unsolicited response id=${msg.id}`);
				return;
			}
			this._pending.delete(msg.id);
			if (msg.error) {
				pending.reject(new AcpJsonRpcResponseError(msg.error.code, msg.error.message, msg.error.data));
			} else {
				pending.resolve(msg.result);
			}
			return;
		}

		if (hasMethod && hasId && msg.method !== undefined && msg.id !== undefined) {
			void this._handleServerRequest(msg.method, msg.id, msg.params);
			return;
		}

		if (hasMethod && msg.method !== undefined) {
			this._handleServerNotification(msg.method, msg.params);
			return;
		}

		this._log('warn', 'unrecognized ACP message');
		this._log('trace', `unrecognized ACP message: ${JSON.stringify(msg).slice(0, 200)}`);
	}

	private async _handleServerRequest(method: string, id: AcpJsonRpcId, params: unknown): Promise<void> {
		const handler = this._requestHandlers.get(method);
		if (!handler) {
			this._writeMessage({
				jsonrpc: '2.0',
				id,
				error: {
					code: AcpJsonRpcErrorCode.MethodNotFound,
					message: `Method not found: ${method}`,
				},
			});
			return;
		}
		try {
			const result = await handler(params);
			if (result.error) {
				this._writeMessage({ jsonrpc: '2.0', id, error: result.error });
			} else {
				this._writeMessage({ jsonrpc: '2.0', id, result: result.result });
			}
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			this._log('error', `handler for ${method} threw: ${message}`);
			this._writeMessage({
				jsonrpc: '2.0',
				id,
				error: { code: AcpJsonRpcErrorCode.InternalError, message },
			});
		}
	}

	private _handleServerNotification(method: string, params: unknown): void {
		const handler = this._notificationHandlers.get(method);
		if (!handler) {
			try {
				this._unhandledNotificationHandler?.(method, params);
			} catch (err) {
				this._log('error', `unhandled notification hook for ${method} threw: ${err instanceof Error ? err.message : String(err)}`);
			}
			return;
		}
		try {
			handler(params);
		} catch (err) {
			this._log('error', `notification handler ${method} threw: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	private _writeMessage(message: unknown): boolean {
		if (this._exited || this._disposed) {
			return false;
		}
		try {
			this._transport.stdin.write(JSON.stringify(message) + '\n');
			return true;
		} catch (err) {
			this._onTransportError.fire(err instanceof Error ? err : new Error(String(err)));
			return false;
		}
	}

	private _handleExit(e: { code: number | null; signal: NodeJS.Signals | null }): void {
		if (this._exited) {
			return;
		}
		this._exited = true;
		const reason = `grok acp process exited (code=${e.code}, signal=${e.signal})`;
		for (const [id, pending] of this._pending) {
			pending.reject(new AcpJsonRpcError(AcpJsonRpcErrorCode.InternalError, `${reason}; request id=${id} (${pending.method}) aborted`));
		}
		this._pending.clear();
		this._onExit.fire(e);
	}

	request<M extends AcpClientRequestMethod>(
		method: M,
		params: AcpClientRequestParams[M],
	): Promise<AcpClientRequestResult[M]> {
		if (this._disposed) {
			return Promise.reject(new CancellationError());
		}
		if (this._exited) {
			return Promise.reject(new AcpJsonRpcError(AcpJsonRpcErrorCode.InternalError, 'transport has exited'));
		}
		const id = this._nextId++;
		return new Promise<AcpClientRequestResult[M]>((resolve, reject) => {
			this._pending.set(id, { method, resolve: resolve as (v: unknown) => void, reject });
			const ok = this._writeMessage({
				jsonrpc: '2.0',
				id,
				method,
				params,
			});
			if (!ok) {
				this._pending.delete(id);
				reject(new AcpJsonRpcError(AcpJsonRpcErrorCode.InternalError, 'write failed; transport closed'));
			}
		});
	}

	notify<M extends AcpClientNotificationMethod>(
		method: M,
		params: AcpClientNotificationParams[M],
	): void {
		this._writeMessage({
			jsonrpc: '2.0',
			method,
			params,
		});
	}

	rejectAllPending(reason: unknown): void {
		for (const pending of this._pending.values()) {
			pending.reject(reason);
		}
		this._pending.clear();
	}

	onNotification(
		method: AcpServerNotificationMethod,
		handler: (params: unknown) => void,
	): IDisposable {
		this._notificationHandlers.set(method, handler);
		return toDisposable(() => {
			if (this._notificationHandlers.get(method) === handler) {
				this._notificationHandlers.delete(method);
			}
		});
	}

	onUnhandledNotification(handler: (method: string, params: unknown) => void): IDisposable {
		this._unhandledNotificationHandler = handler;
		return toDisposable(() => {
			if (this._unhandledNotificationHandler === handler) {
				this._unhandledNotificationHandler = undefined;
			}
		});
	}

	onRequest<M extends AcpServerRequestMethod>(
		method: M,
		handler: (params: AcpServerRequestParams[M]) => Promise<AcpServerRequestHandlerResult<AcpServerRequestResult[M]>> | AcpServerRequestHandlerResult<AcpServerRequestResult[M]>,
	): IDisposable {
		const wrapped = async (params: unknown): Promise<AcpServerRequestHandlerResult<unknown>> => {
			return await handler(params as AcpServerRequestParams[M]);
		};
		this._requestHandlers.set(method, wrapped);
		return toDisposable(() => {
			if (this._requestHandlers.get(method) === wrapped) {
				this._requestHandlers.delete(method);
			}
		});
	}

	override dispose(): void {
		if (this._disposed) {
			return;
		}
		this._disposed = true;
		for (const pending of this._pending.values()) {
			pending.reject(new CancellationError());
		}
		this._pending.clear();
		try {
			this._transport.stdin.end();
		} catch { /* already closed */ }
		if (!this._exited) {
			const timer = setTimeout(() => {
				try {
					this._transport.kill('SIGKILL');
				} catch { /* already dead */ }
			}, this._graceKillMs) as unknown as { unref?(): void };
			this._transport.onExitOnce(() => {
				clearTimeout(timer as unknown as ReturnType<typeof setTimeout>);
			});
			timer.unref?.();
		}
		super.dispose();
	}

	private _log(level: 'info' | 'warn' | 'error' | 'trace', message: string): void {
		this._onLog?.(level, message);
	}
}

export function transportFromChildProcess(
	child: {
		stdin: Writable | null;
		stdout: Readable | null;
		kill: (signal?: NodeJS.Signals) => boolean;
		on: (event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void) => unknown;
		once: (event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void) => unknown;
		removeListener: (event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void) => unknown;
	},
): IAcpTransport {
	if (!child.stdin || !child.stdout) {
		throw new Error('Child process has no stdio pair');
	}
	return {
		stdin: child.stdin,
		stdout: child.stdout,
		kill: signal => child.kill(signal),
		onExit: Event.fromNodeEventEmitter(child, 'exit', (code: number | null, signal: NodeJS.Signals | null) => ({ code, signal })),
		onExitOnce: listener => child.once('exit', (code, signal) => listener({ code, signal })),
	};
}
