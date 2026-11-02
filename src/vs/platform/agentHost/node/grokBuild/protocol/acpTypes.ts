/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Hand-written ACP v1 types for the Grok Build stdio agent.
 *
 * Shapes follow the public Agent Client Protocol schema and the verified
 * grok 1.0.70 wire logs. Unknown `_meta` / `_x.ai/*` fields are tolerated as
 * `unknown` bags — never crash on forward-compatible extensions.
 *
 * No runtime npm ACP SDK dependency.
 */

export const ACP_PROTOCOL_VERSION = 1 as const;

export type AcpJsonRpcId = number | string;

export interface AcpJsonRpcError {
	readonly code: number;
	readonly message: string;
	readonly data?: unknown;
}

export interface AcpContentText {
	readonly type: 'text';
	readonly text: string;
	readonly _meta?: Record<string, unknown>;
}

export type AcpContentBlock = AcpContentText | { readonly type: string; readonly [key: string]: unknown };

export interface AcpAuthMethod {
	readonly id: string;
	readonly name?: string;
	readonly description?: string;
	readonly _meta?: Record<string, unknown>;
}

export interface AcpModelInfo {
	readonly modelId: string;
	readonly name?: string;
	readonly description?: string;
	readonly _meta?: Record<string, unknown>;
}

export interface AcpModelState {
	readonly currentModelId?: string;
	readonly availableModels?: readonly AcpModelInfo[];
}

export interface AcpInitializeParams {
	readonly protocolVersion: typeof ACP_PROTOCOL_VERSION | number;
	readonly clientCapabilities: {
		readonly fs?: { readonly readTextFile?: boolean; readonly writeTextFile?: boolean };
		readonly terminal?: boolean;
	};
	readonly clientInfo?: { readonly name?: string; readonly version?: string };
	readonly _meta?: Record<string, unknown>;
}

export interface AcpInitializeResult {
	readonly protocolVersion: number;
	readonly agentCapabilities?: Record<string, unknown>;
	readonly authMethods?: readonly AcpAuthMethod[];
	readonly _meta?: Record<string, unknown> & {
		readonly agentVersion?: string;
		readonly modelState?: AcpModelState;
		readonly defaultAuthMethodId?: string;
	};
}

export interface AcpAuthenticateParams {
	readonly methodId: string;
	readonly _meta?: Record<string, unknown>;
}

export interface AcpAuthenticateResult {
	readonly _meta?: Record<string, unknown>;
}

export interface AcpSessionNewParams {
	readonly cwd: string;
	readonly mcpServers: readonly unknown[];
	readonly _meta?: Record<string, unknown>;
}

export interface AcpSessionNewResult {
	readonly sessionId: string;
	readonly models?: AcpModelState;
	readonly _meta?: Record<string, unknown>;
}

export interface AcpSessionPromptParams {
	readonly sessionId: string;
	readonly prompt: readonly AcpContentBlock[];
	readonly _meta?: Record<string, unknown>;
}

export type AcpStopReason = 'end_turn' | 'max_tokens' | 'max_turn_requests' | 'refusal' | 'cancelled' | string;

export interface AcpSessionPromptResult {
	readonly stopReason: AcpStopReason;
	readonly _meta?: Record<string, unknown> & {
		readonly usage?: AcpUsage;
	};
}

export interface AcpUsage {
	readonly inputTokens?: number;
	readonly outputTokens?: number;
	readonly totalTokens?: number;
	/** Live grok 1.0.70 field name (not `cachedTokens`). */
	readonly cachedReadTokens?: number;
	readonly [key: string]: unknown;
}

export interface AcpSessionSetModelParams {
	readonly sessionId: string;
	readonly modelId: string;
	readonly _meta?: Record<string, unknown>;
}

export interface AcpSessionSetModelResult {
	readonly _meta?: Record<string, unknown> & {
		readonly model?: { readonly Ok?: string;[key: string]: unknown };
	};
}

export interface AcpSessionCancelParams {
	readonly sessionId: string;
}

export interface AcpSessionCloseParams {
	readonly sessionId: string;
}

export type AcpPermissionOptionKind = 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always' | 'reject' | string;

export interface AcpPermissionOption {
	readonly optionId: string;
	readonly name: string;
	readonly kind: AcpPermissionOptionKind;
	readonly _meta?: Record<string, unknown>;
}

/**
 * ACP v1 `session/request_permission` params. Grok 1.0.70 follows the v1
 * `toolCall` form; v2 `title`/`subject` fields are optional for tolerance.
 */
export interface AcpRequestPermissionParams {
	readonly sessionId: string;
	readonly options: readonly AcpPermissionOption[];
	readonly toolCall?: {
		readonly toolCallId: string;
		readonly title?: string;
		readonly kind?: string;
		readonly status?: string;
		readonly content?: readonly unknown[];
		readonly rawInput?: unknown;
		readonly locations?: readonly { readonly path?: string }[];
		readonly _meta?: Record<string, unknown>;
	};
	readonly title?: string;
	readonly description?: string;
	readonly subject?: {
		readonly type?: string;
		readonly toolCall?: { readonly toolCallId?: string };
		readonly [key: string]: unknown;
	};
	readonly _meta?: Record<string, unknown>;
}

export type AcpRequestPermissionOutcome =
	| { readonly outcome: 'selected'; readonly optionId: string }
	| { readonly outcome: 'cancelled' };

export interface AcpRequestPermissionResult {
	readonly outcome: AcpRequestPermissionOutcome;
	readonly _meta?: Record<string, unknown>;
}

export type AcpSessionUpdateKind =
	| 'agent_message_chunk'
	| 'agent_thought_chunk'
	| 'tool_call'
	| 'tool_call_update'
	| 'available_commands_update'
	| 'session_info_update'
	| 'user_message_chunk'
	| 'tool_call_delta_chunk'
	| 'response_completed'
	| 'turn_completed'
	| 'session_summary_generated'
	| 'pending_interaction'
	| 'interaction_resolved'
	| string;

export interface AcpXaiToolMeta {
	readonly name?: string;
	readonly kind?: string;
	readonly namespace?: string;
	readonly label?: string;
	readonly read_only?: boolean;
	readonly version?: number;
	readonly input?: Record<string, unknown>;
	readonly [key: string]: unknown;
}

export interface AcpToolCallDiffContent {
	readonly type: 'diff';
	readonly path: string;
	readonly oldText?: string | null;
	readonly newText?: string | null;
	readonly _meta?: Record<string, unknown>;
}

export interface AcpSessionUpdateBase {
	readonly sessionUpdate: AcpSessionUpdateKind;
	readonly _meta?: Record<string, unknown>;
}

export interface AcpAgentMessageChunkUpdate extends AcpSessionUpdateBase {
	readonly sessionUpdate: 'agent_message_chunk';
	readonly content: AcpContentBlock;
}

export interface AcpAgentThoughtChunkUpdate extends AcpSessionUpdateBase {
	readonly sessionUpdate: 'agent_thought_chunk';
	readonly content: AcpContentBlock;
}

export interface AcpToolCallUpdate extends AcpSessionUpdateBase {
	readonly sessionUpdate: 'tool_call' | 'tool_call_update';
	readonly toolCallId: string;
	readonly title?: string;
	readonly kind?: string;
	readonly status?: string | null;
	readonly rawInput?: unknown;
	readonly rawOutput?: unknown;
	readonly content?: readonly (AcpToolCallDiffContent | { readonly type: string; readonly [key: string]: unknown })[];
	readonly locations?: readonly { readonly path?: string }[];
	readonly _meta?: Record<string, unknown> & {
		readonly 'x.ai/tool'?: AcpXaiToolMeta;
	};
}

export interface AcpSessionInfoUpdate extends AcpSessionUpdateBase {
	readonly sessionUpdate: 'session_info_update';
	readonly title?: string;
}

export type AcpSessionUpdate =
	| AcpAgentMessageChunkUpdate
	| AcpAgentThoughtChunkUpdate
	| AcpToolCallUpdate
	| AcpSessionInfoUpdate
	| AcpSessionUpdateBase;

export interface AcpSessionUpdateParams {
	readonly sessionId: string;
	readonly update: AcpSessionUpdate;
	readonly _meta?: Record<string, unknown>;
}

/** Client → agent request methods used by the MVP. */
export type AcpClientRequestMethod =
	| 'initialize'
	| 'authenticate'
	| 'session/new'
	| 'session/set_model'
	| 'session/prompt'
	| 'session/close';

/** Client → agent notification methods used by the MVP. */
export type AcpClientNotificationMethod = 'session/cancel';

/** Agent → client request methods handled by the MVP. */
export type AcpServerRequestMethod = 'session/request_permission';

/** Agent → client notification methods. Unknown methods are ignored. */
export type AcpServerNotificationMethod = 'session/update' | string;

export type AcpClientRequestParams = {
	'initialize': AcpInitializeParams;
	'authenticate': AcpAuthenticateParams;
	'session/new': AcpSessionNewParams;
	'session/set_model': AcpSessionSetModelParams;
	'session/prompt': AcpSessionPromptParams;
	'session/close': AcpSessionCloseParams;
};

export type AcpClientRequestResult = {
	'initialize': AcpInitializeResult;
	'authenticate': AcpAuthenticateResult;
	'session/new': AcpSessionNewResult;
	'session/set_model': AcpSessionSetModelResult;
	'session/prompt': AcpSessionPromptResult;
	'session/close': unknown;
};

export type AcpClientNotificationParams = {
	'session/cancel': AcpSessionCancelParams;
};

export type AcpServerRequestParams = {
	'session/request_permission': AcpRequestPermissionParams;
};

export type AcpServerRequestResult = {
	'session/request_permission': AcpRequestPermissionResult;
};

export type AcpServerNotificationParams = {
	'session/update': AcpSessionUpdateParams;
};
