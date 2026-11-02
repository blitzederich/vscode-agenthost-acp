/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { generateUuid } from '../../../../base/common/uuid.js';
import { AgentPermissionKind, type IAgentToolPendingConfirmationSignal } from '../../common/agent.js';
import { ActionType, type ChatAction, type SessionAction } from '../../common/state/sessionActions.js';
import { createErrorResponsePart, MessageKind, ResponsePartKind, ToolCallConfirmationReason, ToolCallStatus, ToolResultContentType, type ToolCallPendingConfirmationState, type ToolCallResult, type UsageInfo } from '../../common/state/sessionState.js';
import { URI } from '../../../../base/common/uri.js';
import type {
	AcpPermissionOption,
	AcpRequestPermissionParams,
	AcpSessionUpdate,
	AcpSessionUpdateParams,
	AcpStopReason,
	AcpToolCallDiffContent,
	AcpToolCallUpdate,
	AcpUsage,
	AcpXaiToolMeta,
} from './protocol/acpTypes.js';

export interface IGrokBuildMapState {
	readonly turnId: string;
	markdownPartId: string | undefined;
	reasoningPartId: string | undefined;
	readonly toolCalls: Map<string, {
		readonly toolCallId: string;
		readonly toolName: string;
		readonly displayName: string;
		readonly permissionKind: AgentPermissionKind;
		readonly permissionPath?: string;
		started: boolean;
		completed: boolean;
	}>;
}

export function createGrokBuildMapState(turnId: string): IGrokBuildMapState {
	return {
		turnId,
		markdownPartId: undefined,
		reasoningPartId: undefined,
		toolCalls: new Map(),
	};
}

export function mapTurnStarted(turnId: string, userText: string): (SessionAction | ChatAction)[] {
	return [{
		type: ActionType.ChatTurnStarted,
		turnId,
		startedAt: new Date().toISOString(),
		message: {
			text: userText,
			origin: { kind: MessageKind.User },
		},
	}];
}

export function mapSessionUpdate(
	state: IGrokBuildMapState,
	params: AcpSessionUpdateParams,
): (SessionAction | ChatAction)[] {
	const update = params.update;
	if (!update || typeof update !== 'object' || typeof update.sessionUpdate !== 'string') {
		return [];
	}

	switch (update.sessionUpdate) {
		case 'agent_message_chunk':
			return mapAgentMessageChunk(state, update);
		case 'agent_thought_chunk':
			return mapAgentThoughtChunk(state, update);
		case 'tool_call':
		case 'tool_call_update':
			return mapToolCall(state, update as AcpToolCallUpdate);
		case 'available_commands_update':
		case 'session_info_update':
		case 'user_message_chunk':
		case 'tool_call_delta_chunk':
		case 'response_completed':
		case 'turn_completed':
		case 'session_summary_generated':
		case 'pending_interaction':
		case 'interaction_resolved':
			// Known non-mapped or non-standard kinds — tolerate silently.
			return [];
		default:
			// Unknown future kinds — never crash.
			return [];
	}
}

function textFromContent(content: unknown): string {
	if (!content || typeof content !== 'object') {
		return '';
	}
	const c = content as { type?: string; text?: string };
	if (typeof c.text === 'string') {
		return c.text;
	}
	return '';
}

function mapAgentMessageChunk(state: IGrokBuildMapState, update: AcpSessionUpdate): (SessionAction | ChatAction)[] {
	const text = textFromContent((update as { content?: unknown }).content);
	if (!text) {
		return [];
	}
	if (!state.markdownPartId) {
		state.markdownPartId = generateUuid();
		return [
			{
				type: ActionType.ChatResponsePart,
				turnId: state.turnId,
				part: {
					kind: ResponsePartKind.Markdown,
					id: state.markdownPartId,
					content: text,
				},
			},
		];
	}
	return [{
		type: ActionType.ChatDelta,
		turnId: state.turnId,
		partId: state.markdownPartId,
		content: text,
	}];
}

function mapAgentThoughtChunk(state: IGrokBuildMapState, update: AcpSessionUpdate): (SessionAction | ChatAction)[] {
	const text = textFromContent((update as { content?: unknown }).content);
	if (!text) {
		return [];
	}
	if (!state.reasoningPartId) {
		state.reasoningPartId = generateUuid();
	}
	return [{
		type: ActionType.ChatReasoning,
		turnId: state.turnId,
		partId: state.reasoningPartId,
		content: text,
	}];
}

function xaiToolMeta(update: AcpToolCallUpdate): AcpXaiToolMeta | undefined {
	const meta = update._meta?.['x.ai/tool'];
	return meta && typeof meta === 'object' ? meta : undefined;
}

function resolveToolIdentity(update: AcpToolCallUpdate): {
	toolName: string;
	displayName: string;
	permissionKind: AgentPermissionKind;
	permissionPath?: string;
	isEdit: boolean;
} {
	const xai = xaiToolMeta(update);
	const kind = (xai?.kind ?? update.kind ?? '').toLowerCase();
	const name = xai?.name ?? update.title ?? 'tool';
	const label = xai?.label ?? update.title ?? name;
	const path = extractPath(update);

	if (kind === 'edit' || name === 'search_replace' || name === 'write' || name === 'edit') {
		return {
			toolName: 'file_edit',
			displayName: typeof label === 'string' ? label : 'Edit',
			permissionKind: AgentPermissionKind.Write,
			permissionPath: path,
			isEdit: true,
		};
	}
	if (kind === 'execute' || kind === 'shell' || name === 'bash' || name === 'shell') {
		return {
			toolName: 'shell',
			displayName: typeof label === 'string' ? label : 'Run shell command',
			permissionKind: AgentPermissionKind.Shell,
			permissionPath: path,
			isEdit: false,
		};
	}
	if (kind === 'read' || xai?.read_only === true) {
		return {
			toolName: name,
			displayName: typeof label === 'string' ? label : name,
			permissionKind: AgentPermissionKind.Read,
			permissionPath: path,
			isEdit: false,
		};
	}
	return {
		toolName: name,
		displayName: typeof label === 'string' ? label : name,
		permissionKind: AgentPermissionKind.CustomTool,
		permissionPath: path,
		isEdit: false,
	};
}

function extractPath(update: AcpToolCallUpdate): string | undefined {
	const raw = update.rawInput;
	if (raw && typeof raw === 'object') {
		const r = raw as Record<string, unknown>;
		for (const key of ['file_path', 'path', 'absolute_path']) {
			if (typeof r[key] === 'string') {
				return r[key] as string;
			}
		}
	}
	const loc = update.locations?.[0]?.path;
	if (typeof loc === 'string') {
		return loc;
	}
	const xaiPath = xaiToolMeta(update)?.input?.['path'];
	return typeof xaiPath === 'string' ? xaiPath : undefined;
}

function toolInputText(update: AcpToolCallUpdate): string {
	if (update.rawInput === undefined || update.rawInput === null) {
		return update.title ?? '';
	}
	if (typeof update.rawInput === 'string') {
		return update.rawInput;
	}
	try {
		return JSON.stringify(update.rawInput);
	} catch {
		return update.title ?? '';
	}
}

function mapDiffContents(update: AcpToolCallUpdate): { type: ToolResultContentType.Text; text: string }[] {
	const diffs = (update.content ?? []).filter((c): c is AcpToolCallDiffContent => !!c && typeof c === 'object' && (c as AcpToolCallDiffContent).type === 'diff');
	if (diffs.length === 0) {
		return [];
	}
	const text = diffs.map(d => {
		const path = d.path ?? 'file';
		const oldText = d.oldText ?? '';
		const newText = d.newText ?? '';
		return `--- ${path}\n+++ ${path}\n@@\n${formatUnified(oldText, newText)}`;
	}).join('\n');
	return text ? [{ type: ToolResultContentType.Text, text }] : [];
}

function formatUnified(oldText: string, newText: string): string {
	const oldLines = oldText === '' ? [] : oldText.split('\n');
	const newLines = newText === '' ? [] : newText.split('\n');
	const lines: string[] = [];
	for (const line of oldLines) {
		lines.push(`-${line}`);
	}
	for (const line of newLines) {
		lines.push(`+${line}`);
	}
	return lines.join('\n');
}

function mapToolCall(state: IGrokBuildMapState, update: AcpToolCallUpdate): (SessionAction | ChatAction)[] {
	const toolCallId = update.toolCallId;
	if (!toolCallId) {
		return [];
	}

	const identity = resolveToolIdentity(update);
	let entry = state.toolCalls.get(toolCallId);
	const actions: (SessionAction | ChatAction)[] = [];

	if (!entry) {
		entry = {
			toolCallId,
			toolName: identity.toolName,
			displayName: identity.displayName,
			permissionKind: identity.permissionKind,
			permissionPath: identity.permissionPath,
			started: false,
			completed: false,
		};
		state.toolCalls.set(toolCallId, entry);
	} else if (update.title || identity.displayName !== entry.displayName) {
		entry = {
			...entry,
			displayName: update.title ?? identity.displayName,
			permissionPath: identity.permissionPath ?? entry.permissionPath,
			permissionKind: identity.permissionKind,
			toolName: identity.isEdit ? 'file_edit' : entry.toolName,
		};
		state.toolCalls.set(toolCallId, entry);
	}

	if (!entry.started) {
		entry.started = true;
		const input = toolInputText(update);
		actions.push(
			{
				type: ActionType.ChatToolCallStart,
				turnId: state.turnId,
				toolCallId,
				toolName: entry.toolName,
				displayName: entry.displayName,
			},
			{
				type: ActionType.ChatToolCallDelta,
				turnId: state.turnId,
				toolCallId,
				content: input,
			},
			{
				type: ActionType.ChatToolCallReady,
				turnId: state.turnId,
				toolCallId,
				invocationMessage: entry.displayName,
				toolInput: input,
				confirmed: ToolCallConfirmationReason.NotNeeded,
			},
		);
	} else if (update.title && update.sessionUpdate === 'tool_call_update') {
		// Refresh invocation presentation when Grok upgrades the title (e.g. edit path).
		actions.push({
			type: ActionType.ChatToolCallDelta,
			turnId: state.turnId,
			toolCallId,
			content: toolInputText(update),
		});
	}

	const diffContent = mapDiffContents(update);
	if (diffContent.length > 0) {
		actions.push({
			type: ActionType.ChatToolCallContentChanged,
			turnId: state.turnId,
			toolCallId,
			content: diffContent,
		});
	}

	const status = (update.status ?? '').toLowerCase();
	if ((status === 'completed' || status === 'failed' || status === 'cancelled') && !entry.completed) {
		entry.completed = true;
		const outputText = update.rawOutput !== undefined
			? (typeof update.rawOutput === 'string' ? update.rawOutput : (() => { try { return JSON.stringify(update.rawOutput); } catch { return ''; } })())
			: undefined;
		const success = status === 'completed';
		const result: ToolCallResult = {
			success,
			pastTenseMessage: success ? entry.displayName : `${entry.displayName} failed`,
			content: [
				...diffContent,
				...(outputText ? [{ type: ToolResultContentType.Text as const, text: outputText }] : []),
			],
			...(status === 'failed' ? { error: { message: outputText || 'Tool call failed' } } : {}),
		};
		actions.push({
			type: ActionType.ChatToolCallComplete,
			turnId: state.turnId,
			toolCallId,
			result,
		});
	}

	return actions;
}

export function mapUsage(turnId: string, usage: AcpUsage | undefined): (SessionAction | ChatAction)[] {
	if (!usage) {
		return [];
	}
	const info: UsageInfo = {
		inputTokens: typeof usage.inputTokens === 'number' ? usage.inputTokens : undefined,
		outputTokens: typeof usage.outputTokens === 'number' ? usage.outputTokens : undefined,
		cacheReadTokens: typeof usage.cachedTokens === 'number' ? usage.cachedTokens : undefined,
	};
	if (info.inputTokens === undefined && info.outputTokens === undefined && info.cacheReadTokens === undefined) {
		return [];
	}
	return [{
		type: ActionType.ChatUsage,
		turnId,
		usage: info,
	}];
}

export function mapTurnCompleted(turnId: string, stopReason: AcpStopReason | undefined, duration = 0): (SessionAction | ChatAction)[] {
	if (stopReason === 'cancelled') {
		return [{ type: ActionType.ChatTurnCancelled, turnId, duration }];
	}
	return [{ type: ActionType.ChatTurnComplete, turnId, duration }];
}

export function mapAuthRequiredAsTurnError(turnId: string, message: string, duration = 0): (SessionAction | ChatAction)[] {
	return [{
		type: ActionType.ChatError,
		turnId,
		duration,
		part: createErrorResponsePart({ errorType: 'GrokAuthRequired', message }),
	}];
}

/**
 * Build a host `pending_confirmation` signal from an ACP permission request.
 * `requestId` for {@link import('../../common/agent.js').IAgent.respondToPermissionRequest}
 * is the tool call id (AHP convention), not the JSON-RPC id.
 */
export function mapPermissionRequest(
	chat: URI,
	turnId: string,
	params: AcpRequestPermissionParams,
	state: IGrokBuildMapState | undefined,
): { signal: IAgentToolPendingConfirmationSignal; toolCallId: string; options: readonly AcpPermissionOption[] } | undefined {
	const toolCallId =
		params.toolCall?.toolCallId
		?? params.subject?.toolCall?.toolCallId
		?? (typeof params.subject?.['toolCallId'] === 'string' ? params.subject['toolCallId'] as string : undefined);
	if (!toolCallId) {
		return undefined;
	}

	const entry = state?.toolCalls.get(toolCallId);
	const title = params.title
		?? params.toolCall?.title
		?? entry?.displayName
		?? 'Permission required';
	const path = entry?.permissionPath
		?? params.toolCall?.locations?.[0]?.path
		?? extractPathFromUnknown(params.toolCall?.rawInput);

	const confirmationState: ToolCallPendingConfirmationState = {
		status: ToolCallStatus.PendingConfirmation,
		toolCallId,
		toolName: entry?.toolName ?? 'tool',
		displayName: entry?.displayName ?? title,
		invocationMessage: title,
		confirmationTitle: title,
		...(params.description ? { confirmationMessage: params.description } : {}),
		...(path ? { toolInput: path } : {}),
	};

	return {
		toolCallId,
		options: params.options,
		signal: {
			kind: 'pending_confirmation',
			chat,
			state: confirmationState,
			permissionKind: entry?.permissionKind ?? AgentPermissionKind.Write,
			...(path ? { permissionPath: path } : {}),
		},
	};
}

function extractPathFromUnknown(raw: unknown): string | undefined {
	if (!raw || typeof raw !== 'object') {
		return undefined;
	}
	const r = raw as Record<string, unknown>;
	for (const key of ['file_path', 'path', 'absolute_path']) {
		if (typeof r[key] === 'string') {
			return r[key] as string;
		}
	}
	return undefined;
}

/**
 * Map an AHP permission response onto an ACP optionId.
 * Prefers allow_once / reject_once; falls back to allow_always / reject* kinds.
 */
export function selectPermissionOptionId(
	options: readonly { readonly optionId: string; readonly kind: string }[],
	approved: boolean,
): string | undefined {
	const kindPref = approved
		? ['allow_once', 'allow_always']
		: ['reject_once', 'reject', 'reject_always'];
	for (const kind of kindPref) {
		const match = options.find(o => o.kind === kind);
		if (match) {
			return match.optionId;
		}
	}
	// Last resort: first option whose kind string contains allow/reject.
	const fuzzy = options.find(o => approved ? o.kind.includes('allow') : o.kind.includes('reject'));
	return fuzzy?.optionId ?? options[0]?.optionId;
}

/** Whether an ACP session update kind should be ignored by the mapper. */
export function isIgnorableSessionUpdate(kind: string): boolean {
	return mapSessionUpdate(
		createGrokBuildMapState('probe'),
		{ sessionId: 's', update: { sessionUpdate: kind } },
	).length === 0 && kind !== 'agent_message_chunk' && kind !== 'agent_thought_chunk' && kind !== 'tool_call' && kind !== 'tool_call_update';
}
