/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { generateUuid } from '../../../../base/common/uuid.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { AgentPermissionKind, type IAgentToolPendingConfirmationSignal } from '../../common/agent.js';
import { ContextSizeConfigKey, createContextSizeConfigSchemaPropertyFromLimits } from '../../common/agentModelConfiguration.js';
import { grokBuildTodoListMetaKey, toToolCallMeta } from '../../common/meta/agentToolCallMeta.js';
import type { ConfigPropertySchema, ConfigSchema } from '../../common/state/protocol/common/state.js';
import { ActionType, type ChatAction, type SessionAction } from '../../common/state/sessionActions.js';
import { createErrorResponsePart, MessageKind, ResponsePartKind, ToolCallConfirmationReason, ToolCallStatus, ToolResultContentType, type ToolCallPendingConfirmationState, type ToolCallResult, type UsageInfo } from '../../common/state/sessionState.js';
import {
	GROK_SUBAGENT_TOOL_NAME,
	GROK_TODO_TOOL_NAME,
	isSubagentTool,
	todosFromPlanEntries,
	todosFromToolInput,
	type IGrokTodoItem,
} from './grokBuildUx.js';
import { hasClientToolNamePrefix } from './grokBuildClientToolMcpServer.js';
import type {
	AcpModelState,
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

export interface IGrokBuildToolCallEntry {
	readonly toolCallId: string;
	readonly toolName: string;
	displayName: string;
	readonly permissionKind: AgentPermissionKind;
	readonly permissionPath?: string;
	readonly toolKind?: 'subagent' | 'exit_plan' | 'ask_user';
	readonly subagentDescription?: string;
	/** Plan markdown attached when `_x.ai/exit_plan_mode` arrives. */
	planContent?: string;
	started: boolean;
	completed: boolean;
}

export interface IGrokBuildMapState {
	readonly turnId: string;
	markdownPartId: string | undefined;
	reasoningPartId: string | undefined;
	readonly toolCalls: Map<string, IGrokBuildToolCallEntry>;
	planSnapshots: number;
	/**
	 * Live grok emits `todo_write` and ACP `plan` for the same list.
	 * The first source that produces todos owns the turn.
	 */
	todoSource?: 'tool' | 'plan';
}

/** Host display title for grok's `exit_plan_mode` / `_x.ai/exit_plan_mode` tool card. */
export const GROK_PRESENT_PLAN_DISPLAY_NAME = localize('grokBuild.tool.presentPlan', "Present plan");
/** Host display title for grok's `ask_user_question` / `_x.ai/ask_user_question` tool card. */
export const GROK_ASK_USER_DISPLAY_NAME = localize('grokBuild.tool.askUser', "Ask User");

export function createGrokBuildMapState(turnId: string): IGrokBuildMapState {
	return {
		turnId,
		markdownPartId: undefined,
		reasoningPartId: undefined,
		toolCalls: new Map(),
		planSnapshots: 0,
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
		case 'plan':
			return mapPlanUpdate(state, (update as { entries?: unknown }).entries);
		case 'available_commands_update':
		case 'session_info_update':
		case 'config_option_update':
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
	const actions: (SessionAction | ChatAction)[] = [];
	if (!state.reasoningPartId) {
		// Reducer drops ChatReasoning for unknown part ids — seed an empty
		// Reasoning part first (same pattern as Codex ensureReasoningPart).
		state.reasoningPartId = generateUuid();
		actions.push({
			type: ActionType.ChatResponsePart,
			turnId: state.turnId,
			part: {
				kind: ResponsePartKind.Reasoning,
				id: state.reasoningPartId,
				content: '',
			},
		});
	}
	actions.push({
		type: ActionType.ChatReasoning,
		turnId: state.turnId,
		partId: state.reasoningPartId,
		content: text,
	});
	return actions;
}

function xaiToolMeta(update: AcpToolCallUpdate): AcpXaiToolMeta | undefined {
	const metaBag = update._meta;
	const meta = metaBag?.['x.ai/tool'];
	return meta && typeof meta === 'object' ? meta : undefined;
}

function resolveToolIdentity(update: AcpToolCallUpdate): {
	toolName: string;
	displayName: string;
	permissionKind: AgentPermissionKind;
	permissionPath?: string;
	isEdit: boolean;
	toolKind?: 'subagent' | 'exit_plan' | 'ask_user';
	subagentDescription?: string;
} {
	const xai = xaiToolMeta(update);
	const kind = (xai?.kind ?? update.kind ?? '').toLowerCase();
	const name = xai?.name ?? update.title ?? 'tool';
	const label = xai?.label ?? update.title ?? name;
	const path = extractPath(update);

	if (kind === 'exit_plan' || name === 'exit_plan_mode') {
		return {
			toolName: 'exit_plan_mode',
			displayName: GROK_PRESENT_PLAN_DISPLAY_NAME,
			permissionKind: AgentPermissionKind.Read,
			permissionPath: path,
			isEdit: false,
			toolKind: 'exit_plan',
		};
	}

	if (kind === 'ask_user' || name === 'ask_user_question') {
		return {
			toolName: 'ask_user_question',
			displayName: GROK_ASK_USER_DISPLAY_NAME,
			permissionKind: AgentPermissionKind.Read,
			permissionPath: path,
			isEdit: false,
			toolKind: 'ask_user',
		};
	}

	if (isSubagentTool(kind, typeof name === 'string' ? name : undefined) || name === 'spawn_subagent') {
		const description = subagentDescription(update) ?? (typeof label === 'string' ? label : name);
		return {
			toolName: GROK_SUBAGENT_TOOL_NAME,
			displayName: typeof label === 'string' ? label : 'Subagent',
			permissionKind: AgentPermissionKind.CustomTool,
			permissionPath: path,
			isEdit: false,
			toolKind: 'subagent',
			subagentDescription: typeof description === 'string' ? description : undefined,
		};
	}

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

function subagentDescription(update: AcpToolCallUpdate): string | undefined {
	const raw = update.rawInput;
	if (!raw || typeof raw !== 'object') {
		return undefined;
	}
	const record = raw as { prompt?: unknown; description?: unknown; task?: unknown };
	for (const value of [record.description, record.prompt, record.task]) {
		if (typeof value === 'string' && value.length > 0) {
			return value;
		}
	}
	return undefined;
}

function toolCallMeta(entry: { readonly toolKind?: 'subagent' | 'exit_plan' | 'ask_user'; readonly subagentDescription?: string }): Record<string, unknown> | undefined {
	if (entry.toolKind === 'subagent') {
		return toToolCallMeta({ toolKind: 'subagent', subagentDescription: entry.subagentDescription });
	}
	return undefined;
}

function isStickyToolKind(kind: IGrokBuildToolCallEntry['toolKind'] | undefined): kind is 'exit_plan' | 'ask_user' {
	return kind === 'exit_plan' || kind === 'ask_user';
}

function stickyDisplayName(kind: 'exit_plan' | 'ask_user'): string {
	return kind === 'ask_user' ? GROK_ASK_USER_DISPLAY_NAME : GROK_PRESENT_PLAN_DISPLAY_NAME;
}

/** Prefer `UserAnswered.message` from ask_user_question rawOutput over the raw JSON object. */
function askUserAnsweredMessage(rawOutput: unknown): string | undefined {
	if (!rawOutput || typeof rawOutput !== 'object') {
		return undefined;
	}
	const answered = (rawOutput as { UserAnswered?: { message?: unknown } }).UserAnswered;
	return answered && typeof answered.message === 'string' ? answered.message : undefined;
}

/** Nested ACP `{ type: 'content', content: { type: 'text', text } }` blocks become tool result text. */
export function textFromToolCallContent(content: readonly unknown[] | undefined): string | undefined {
	if (!content || content.length === 0) {
		return undefined;
	}
	const parts: string[] = [];
	for (const block of content) {
		if (!block || typeof block !== 'object') {
			continue;
		}
		const record = block as { type?: unknown; content?: unknown; text?: unknown };
		if (record.type === 'content' && record.content && typeof record.content === 'object') {
			const nested = record.content as { type?: unknown; text?: unknown };
			if (typeof nested.text === 'string' && nested.text.length > 0) {
				parts.push(nested.text);
			}
			continue;
		}
		if (record.type === 'text' && typeof record.text === 'string' && record.text.length > 0) {
			parts.push(record.text);
		}
	}
	return parts.length > 0 ? parts.join('\n') : undefined;
}

function isExitPlanPlaceholderInput(raw: unknown): boolean {
	if (raw === undefined || raw === null) {
		return true;
	}
	if (typeof raw !== 'object' || Array.isArray(raw)) {
		return false;
	}
	const keys = Object.keys(raw as Record<string, unknown>);
	if (keys.length === 0) {
		return true;
	}
	return keys.length === 1 && (raw as { variant?: unknown }).variant === 'ExitPlanMode';
}

function mapPlanUpdate(state: IGrokBuildMapState, entries: unknown): (SessionAction | ChatAction)[] {
	if (state.todoSource === 'tool') {
		return [];
	}
	const todos = todosFromPlanEntries(entries);
	if (todos.length === 0) {
		return [];
	}
	state.todoSource = 'plan';
	return completedTodoCall(state, undefined, todos);
}

function completedTodoCall(state: IGrokBuildMapState, toolCallId: string | undefined, todos: readonly IGrokTodoItem[]): (SessionAction | ChatAction)[] {
	state.planSnapshots++;
	const id = toolCallId ?? `plan-${state.planSnapshots}`;
	if (state.toolCalls.get(id)?.completed) {
		return [];
	}
	state.markdownPartId = undefined;
	const input = JSON.stringify({ todoList: todos });
	state.toolCalls.set(id, {
		toolCallId: id,
		toolName: GROK_TODO_TOOL_NAME,
		displayName: 'Update todo list',
		permissionKind: AgentPermissionKind.Read,
		started: true,
		completed: true,
	});
	const result: ToolCallResult = {
		success: true,
		pastTenseMessage: 'Updated todo list',
		content: [],
	};
	const callMeta = toToolCallMeta({ [grokBuildTodoListMetaKey]: true });
	return [
		{
			type: ActionType.ChatToolCallStart,
			turnId: state.turnId,
			toolCallId: id,
			toolName: GROK_TODO_TOOL_NAME,
			displayName: 'Update todo list',
			...(callMeta ? { _meta: callMeta } : {}),
		},
		{
			type: ActionType.ChatToolCallReady,
			turnId: state.turnId,
			toolCallId: id,
			invocationMessage: 'Update todo list',
			toolInput: input,
			confirmed: ToolCallConfirmationReason.NotNeeded,
			...(callMeta ? { _meta: callMeta } : {}),
		},
		{
			type: ActionType.ChatToolCallComplete,
			turnId: state.turnId,
			toolCallId: id,
			result,
			...(callMeta ? { _meta: callMeta } : {}),
		},
	];
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
	const xaiPath = xaiToolMeta(update)?.input?.path;
	return typeof xaiPath === 'string' ? xaiPath : undefined;
}

function toolInputText(update: AcpToolCallUpdate, entry?: IGrokBuildToolCallEntry): string {
	if (entry?.toolKind === 'exit_plan' || xaiToolMeta(update)?.kind === 'exit_plan' || xaiToolMeta(update)?.name === 'exit_plan_mode') {
		if (entry?.planContent) {
			return entry.planContent;
		}
		if (isExitPlanPlaceholderInput(update.rawInput)) {
			return '';
		}
	}
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

/**
 * Whether this ACP tool_call / tool_call_update targets a workbench client
 * tool (`client__…`). Those cards are owned by the HTTP MCP `tools/call`
 * path ({@link GrokBuildAgent} `_invokeClientTool`) so the mapper must not
 * emit a second Start/Ready/Complete for the same invocation.
 */
export function isGrokClientToolCallUpdate(update: AcpToolCallUpdate): boolean {
	const xaiName = xaiToolMeta(update)?.name;
	if (typeof xaiName === 'string' && hasClientToolNamePrefix(xaiName)) {
		return true;
	}
	const title = update.title;
	return typeof title === 'string' && hasClientToolNamePrefix(title);
}

function mapToolCall(state: IGrokBuildMapState, update: AcpToolCallUpdate): (SessionAction | ChatAction)[] {
	const toolCallId = update.toolCallId;
	if (!toolCallId) {
		return [];
	}

	// Grok emits tool_call for `client__*` before POSTing MCP tools/call.
	// Suppress the ACP card; the MCP invoker shows the single Client card.
	if (isGrokClientToolCallUpdate(update)) {
		return [];
	}

	const xaiName = xaiToolMeta(update)?.name;
	if (xaiName === 'todo_write' || update.title === 'todo_write') {
		const todos = todosFromToolInput(update.rawInput);
		if (todos) {
			if (state.todoSource === 'plan') {
				return [];
			}
			state.todoSource = 'tool';
			return completedTodoCall(state, toolCallId, todos);
		}
	}

	const identity = resolveToolIdentity(update);
	let entry = state.toolCalls.get(toolCallId);
	const actions: (SessionAction | ChatAction)[] = [];
	const meta = () => toolCallMeta(entry!);

	if (!entry) {
		entry = {
			toolCallId,
			toolName: identity.toolName,
			displayName: identity.displayName,
			permissionKind: identity.permissionKind,
			permissionPath: identity.permissionPath,
			toolKind: identity.toolKind,
			subagentDescription: identity.subagentDescription,
			started: false,
			completed: false,
		};
		state.toolCalls.set(toolCallId, entry);
	} else if (update.title || identity.displayName !== entry.displayName || identity.toolKind) {
		const stickyKind = isStickyToolKind(entry.toolKind)
			? entry.toolKind
			: (isStickyToolKind(identity.toolKind) ? identity.toolKind : undefined);
		entry = {
			...entry,
			displayName: stickyKind
				? stickyDisplayName(stickyKind)
				: (update.title ?? identity.displayName),
			permissionPath: identity.permissionPath ?? entry.permissionPath,
			permissionKind: identity.permissionKind,
			toolName: identity.toolKind === 'subagent' || isStickyToolKind(identity.toolKind)
				? identity.toolName
				: identity.isEdit ? 'file_edit' : entry.toolName,
			toolKind: identity.toolKind ?? entry.toolKind,
			subagentDescription: identity.subagentDescription ?? entry.subagentDescription,
		};
		state.toolCalls.set(toolCallId, entry);
	}

	if (!entry.started) {
		entry.started = true;
		// Post-tool assistant text must open a new markdown part.
		state.markdownPartId = undefined;
		const input = toolInputText(update, entry);
		const callMeta = meta();
		actions.push(
			{
				type: ActionType.ChatToolCallStart,
				turnId: state.turnId,
				toolCallId,
				toolName: entry.toolName,
				displayName: entry.displayName,
				...(callMeta ? { _meta: callMeta } : {}),
			},
			...(input ? [{
				type: ActionType.ChatToolCallDelta as const,
				turnId: state.turnId,
				toolCallId,
				content: input,
				...(callMeta ? { _meta: callMeta } : {}),
			}] : []),
			{
				type: ActionType.ChatToolCallReady,
				turnId: state.turnId,
				toolCallId,
				invocationMessage: entry.displayName,
				toolInput: input,
				confirmed: ToolCallConfirmationReason.NotNeeded,
				...(callMeta ? { _meta: callMeta } : {}),
			},
		);
	} else if (update.title && update.sessionUpdate === 'tool_call_update' && !isStickyToolKind(entry.toolKind)) {
		// Refresh invocation presentation when Grok upgrades the title (e.g. edit path).
		const input = toolInputText(update, entry);
		if (input) {
			actions.push({
				type: ActionType.ChatToolCallDelta,
				turnId: state.turnId,
				toolCallId,
				content: input,
			});
		}
	}

	const diffContent = mapDiffContents(update);
	const contentText = textFromToolCallContent(update.content);
	const contentBlocks: { type: ToolResultContentType.Text; text: string }[] = [
		...diffContent,
		...(contentText && isStickyToolKind(entry.toolKind)
			? [{ type: ToolResultContentType.Text as const, text: contentText }]
			: []),
		...(entry.planContent && entry.toolKind === 'exit_plan' && !contentText
			? [{ type: ToolResultContentType.Text as const, text: entry.planContent }]
			: []),
	];
	if (contentBlocks.length > 0 && (diffContent.length > 0 || (isStickyToolKind(entry.toolKind) && (contentText || entry.planContent) && !entry.completed))) {
		actions.push({
			type: ActionType.ChatToolCallContentChanged,
			turnId: state.turnId,
			toolCallId,
			content: contentBlocks,
		});
	}

	const status = (update.status ?? '').toLowerCase();
	if ((status === 'completed' || status === 'failed' || status === 'cancelled') && !entry.completed) {
		entry.completed = true;
		const contentMessage = textFromToolCallContent(update.content);
		const rawOutputText = rawOutputAsText(update.rawOutput);
		// Prefer ACP content text for exit_plan / ask_user cards. Ask cards also
		// accept rawOutput.UserAnswered.message when content is absent — never the
		// raw JSON object. Other tools keep rawOutput (e.g. grep stdout) and fall
		// back to content when absent so failures still show nested rejection text.
		const outputText = entry.toolKind === 'ask_user'
			? (contentMessage ?? askUserAnsweredMessage(update.rawOutput))
			: entry.toolKind === 'exit_plan'
				? (contentMessage ?? rawOutputText)
				: (rawOutputText ?? contentMessage);
		const success = status === 'completed';
		const failureMessage = outputText || 'Tool call failed';
		const resultContent: { type: ToolResultContentType.Text; text: string }[] = [
			...diffContent,
			...(entry.planContent && entry.toolKind === 'exit_plan'
				? [{ type: ToolResultContentType.Text as const, text: entry.planContent }]
				: []),
			...(outputText && outputText !== entry.planContent
				? [{ type: ToolResultContentType.Text as const, text: outputText }]
				: []),
		];
		const result: ToolCallResult = {
			success,
			pastTenseMessage: success
				? (isStickyToolKind(entry.toolKind) ? stickyDisplayName(entry.toolKind) : entry.displayName)
				: (status === 'cancelled'
					? cancelledToolMessage(entry.displayName)
					: `${entry.displayName} failed`),
			content: resultContent,
			...(status === 'failed' ? { error: { message: failureMessage } } : {}),
		};
		const callMeta = meta();
		actions.push({
			type: ActionType.ChatToolCallComplete,
			turnId: state.turnId,
			toolCallId,
			result,
			...(callMeta ? { _meta: callMeta } : {}),
		});
	}

	return actions;
}

function rawOutputAsText(rawOutput: unknown): string | undefined {
	if (rawOutput === undefined) {
		return undefined;
	}
	if (typeof rawOutput === 'string') {
		return rawOutput;
	}
	try {
		return JSON.stringify(rawOutput);
	} catch {
		return '';
	}
}

function cancelledToolMessage(displayName: string): string {
	return localize('grokBuild.tool.cancelled', "{0} cancelled", displayName);
}

/**
 * Attach plan markdown to an in-flight `exit_plan` tool card so the plan stays
 * visible in chat history after the review UI closes.
 */
export function mapExitPlanContent(
	state: IGrokBuildMapState,
	toolCallId: string,
	planContent: string,
): (SessionAction | ChatAction)[] {
	const entry = state.toolCalls.get(toolCallId);
	if (!entry) {
		return [];
	}
	entry.planContent = planContent;
	entry.displayName = GROK_PRESENT_PLAN_DISPLAY_NAME;
	if (entry.completed || !planContent) {
		return [];
	}
	return [{
		type: ActionType.ChatToolCallContentChanged,
		turnId: state.turnId,
		toolCallId,
		content: [{ type: ToolResultContentType.Text, text: planContent }],
	}];
}

/**
 * Locally complete a tool card as cancelled when grok abandons a pending
 * agent→client request without a `tool_call_update` (`exit_plan_mode` review
 * or `ask_user_question`). Preserves any attached plan markdown on the card.
 */
export function mapPendingRequestCancelled(
	state: IGrokBuildMapState,
	toolCallId: string,
): (SessionAction | ChatAction)[] {
	const entry = state.toolCalls.get(toolCallId);
	if (!entry || entry.completed) {
		return [];
	}
	entry.completed = true;
	const content = entry.planContent
		? [{ type: ToolResultContentType.Text as const, text: entry.planContent }]
		: [];
	return [{
		type: ActionType.ChatToolCallComplete,
		turnId: state.turnId,
		toolCallId,
		result: {
			success: false,
			pastTenseMessage: cancelledToolMessage(entry.displayName),
			content,
		},
	}];
}

/**
 * Prompt-result / update `_meta` for grok usage. Top-level
 * `inputTokens` / `outputTokens` / `cachedReadTokens` are the **last model
 * call**. Nested `usage` (when present) is the **turn sum** across every
 * model call. Older grok builds may only send `usage`.
 */
export type GrokPromptUsageMeta = Record<string, unknown> & {
	readonly inputTokens?: unknown;
	readonly outputTokens?: unknown;
	readonly cachedReadTokens?: unknown;
	readonly totalTokens?: unknown;
	readonly usage?: unknown;
};

export interface IGrokContextUsageInfo {
	readonly currentTokens: number;
	readonly tokenLimit: number;
	readonly messagesLength: number;
}

/** Session `_meta` key read by {@link import('../../common/meta/copilotd/copilotdMetadataReader.js').readCopilotContextUsage}. */
export const GROK_COPILOT_USAGE_INFO_KEY = 'copilot.usageInfo';

function readFiniteNumber(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** Positive finite integer, used for context-window limits. */
export function readGrokPositiveInt(value: unknown): number | undefined {
	const n = readFiniteNumber(value);
	return n !== undefined && Number.isInteger(n) && n > 0 ? n : undefined;
}

/** Non-negative finite integer token count (0 allowed). */
function readTokenCount(value: unknown): number | undefined {
	const n = readFiniteNumber(value);
	return n !== undefined && Number.isInteger(n) && n >= 0 ? n : undefined;
}

/**
 * Published model `maxContextWindow`: the model default from
 * `_meta.totalContextTokens`. Per-session `_meta.contextWindow` on a model
 * entry (e.g. a restored 500k selection) must not change the shared list.
 */
export function readGrokMaxContextWindow(meta: Record<string, unknown> | undefined): number | undefined {
	return readGrokPositiveInt(meta?.totalContextTokens);
}

/**
 * Selected window on the current model entry in a `session/load` or
 * `session/resume` models payload. Live grok puts it at
 * `availableModels[i]._meta.contextWindow` where `modelId === currentModelId`;
 * result `_meta` does not carry `contextWindow`.
 */
export function readGrokCurrentModelContextWindow(models: AcpModelState | undefined): number | undefined {
	if (!models) {
		return undefined;
	}
	const currentId = models.currentModelId;
	if (typeof currentId !== 'string' || currentId.length === 0) {
		return undefined;
	}
	const entry = models.availableModels?.find(model => model.modelId === currentId);
	return readGrokPositiveInt(entry?._meta?.contextWindow);
}

/**
 * Offered context-window sizes from model `_meta.contextWindows` (e.g.
 * `[256000, 500000]`). Empty / malformed arrays yield `undefined`.
 */
export function readGrokContextWindows(meta: Record<string, unknown> | undefined): readonly number[] | undefined {
	const raw = meta?.contextWindows;
	if (!Array.isArray(raw) || raw.length === 0) {
		return undefined;
	}
	const windows: number[] = [];
	for (const entry of raw) {
		const size = readGrokPositiveInt(entry);
		if (size !== undefined && !windows.includes(size)) {
			windows.push(size);
		}
	}
	return windows.length > 0 ? windows : undefined;
}

/**
 * Model-picker Context Size property when grok advertises more than one
 * window. Uses {@link createContextSizeConfigSchemaPropertyFromLimits} with
 * `totalContextTokens` as the default and `max(contextWindows)` as the long
 * tier (Codex pattern).
 */
export function createGrokContextSizeConfigSchemaProperty(meta: Record<string, unknown> | undefined): ConfigPropertySchema | undefined {
	const windows = readGrokContextWindows(meta);
	if (!windows || windows.length < 2) {
		return undefined;
	}
	return createContextSizeConfigSchemaPropertyFromLimits(
		readGrokPositiveInt(meta?.totalContextTokens),
		Math.max(...windows),
	);
}

/** Merge model config schemas (reasoning effort + context size) without dropping properties. */
export function mergeGrokModelConfigSchema(...parts: readonly (ConfigSchema | undefined)[]): ConfigSchema | undefined {
	const properties: ConfigSchema['properties'] = {};
	for (const part of parts) {
		if (part?.properties) {
			Object.assign(properties, part.properties);
		}
	}
	return Object.keys(properties).length > 0 ? { type: 'object', properties } : undefined;
}

/** Wrap a single Context Size property as a model config schema. */
export function contextSizeConfigSchema(property: ConfigPropertySchema | undefined): ConfigSchema | undefined {
	return property ? { type: 'object', properties: { [ContextSizeConfigKey]: property } } : undefined;
}

/**
 * Live context-size gauge from grok. `0` is ignored (transient after
 * `/compact`); the next non-zero update restores the bar.
 */
export function readGrokTotalTokens(meta: Record<string, unknown> | undefined): number | undefined {
	const n = readTokenCount(meta?.totalTokens);
	return n === undefined || n === 0 ? undefined : n;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === 'object' && !Array.isArray(value)
		? value as Record<string, unknown>
		: undefined;
}

function readAcpUsage(value: unknown): AcpUsage | undefined {
	const record = asRecord(value);
	if (!record) {
		return undefined;
	}
	if (readTokenCount(record.inputTokens) === undefined
		&& readTokenCount(record.outputTokens) === undefined
		&& readTokenCount(record.cachedReadTokens) === undefined) {
		return undefined;
	}
	return record as AcpUsage;
}

function turnTokenTotalsFromUsage(usage: AcpUsage | undefined, modelId: string | undefined): UsageInfo['_meta'] | undefined {
	if (!usage || !modelId) {
		return undefined;
	}
	const inputTokens = readTokenCount(usage.inputTokens) ?? 0;
	const cachedTokens = readTokenCount(usage.cachedReadTokens) ?? 0;
	const outputTokens = readTokenCount(usage.outputTokens) ?? 0;
	return {
		turnTokenTotals: [{ model: modelId, inputTokens, cachedTokens, outputTokens }],
	};
}

/**
 * Maps grok prompt `_meta` to AHP {@link UsageInfo}. Prefer last-call
 * top-level fields; keep turn sums in `_meta.turnTokenTotals` (Codex shape).
 * Fall back to nested `usage` when top-level fields are absent.
 */
export function toGrokUsageInfo(meta: GrokPromptUsageMeta | undefined, modelId?: string): UsageInfo | undefined {
	if (!meta) {
		return undefined;
	}
	const turnUsage = readAcpUsage(meta.usage);
	const inputTokens = readTokenCount(meta.inputTokens) ?? readTokenCount(turnUsage?.inputTokens);
	const outputTokens = readTokenCount(meta.outputTokens) ?? readTokenCount(turnUsage?.outputTokens);
	const cacheReadTokens = readTokenCount(meta.cachedReadTokens) ?? readTokenCount(turnUsage?.cachedReadTokens);
	if (inputTokens === undefined && outputTokens === undefined && cacheReadTokens === undefined) {
		return undefined;
	}
	const turnMeta = turnTokenTotalsFromUsage(turnUsage, modelId);
	return {
		inputTokens,
		outputTokens,
		cacheReadTokens,
		...(modelId ? { model: modelId } : {}),
		...(turnMeta ? { _meta: turnMeta } : {}),
	};
}

/**
 * Build a {@link ActionType.ChatUsage} action from grok prompt `_meta`.
 * Prefer last-call top-level fields; nested `usage` becomes turn totals when
 * `modelId` is known. A bare {@link AcpUsage} (older fixtures / grok) is
 * treated as last-call fallback.
 */
export function mapUsage(turnId: string, meta: GrokPromptUsageMeta | AcpUsage | undefined, modelId?: string): (SessionAction | ChatAction)[] {
	const info = toGrokUsageInfo(asRecord(meta) as GrokPromptUsageMeta | undefined, modelId);
	if (!info) {
		return [];
	}
	return [{
		type: ActionType.ChatUsage,
		turnId,
		usage: info,
	}];
}

/** Merge `copilot.usageInfo` into session `_meta` without dropping other keys. */
export function withGrokContextUsage(meta: Record<string, unknown> | undefined, usage: IGrokContextUsageInfo): Record<string, unknown> {
	return { ...meta, [GROK_COPILOT_USAGE_INFO_KEY]: usage };
}

/**
 * Wire envelope for `_x.ai/session_notification` / replay `_x.ai/session/update`:
 * `{ sessionId, update: { sessionUpdate: "...", ... } }` where `sessionUpdate`
 * is the serde discriminator (tag = "sessionUpdate").
 */
function readGrokExtensionUpdate(params: unknown): Record<string, unknown> | undefined {
	const outer = asRecord(params);
	if (!outer) {
		return undefined;
	}
	return asRecord(outer.update);
}

/**
 * Current-context tokens from grok compaction notifications.
 * Real shapes:
 * - `update.sessionUpdate === "auto_compact_completed"` → `tokens_after`
 *   (`tokens_before` is Option and may be absent on older shells)
 * - `update.sessionUpdate === "auto_compact_started"` → `tokens_used`
 * Do not read `context_window` from started events as a session override.
 */
export function readGrokCompactionCurrentTokens(params: unknown): number | undefined {
	const update = readGrokExtensionUpdate(params);
	if (!update) {
		return undefined;
	}
	const kind = update.sessionUpdate;
	if (kind === 'auto_compact_completed') {
		return readTokenCount(update.tokens_after);
	}
	if (kind === 'auto_compact_started') {
		const used = readTokenCount(update.tokens_used);
		return used !== undefined && used > 0 ? used : undefined;
	}
	return undefined;
}

/**
 * Context-gauge tokens from a single-call `turn_completed` extension update.
 * `usage.inputTokens + usage.outputTokens` when `modelCalls === 1`. Multi-call
 * turns (`modelCalls !== 1`) are ignored — their input is a turn sum.
 * Accepts either the full `{ update }` envelope or the inner update object.
 */
export function readGrokTurnCompletedSingleCallTokens(paramsOrUpdate: unknown): number | undefined {
	const update = readGrokExtensionUpdate(paramsOrUpdate) ?? asRecord(paramsOrUpdate);
	if (!update || update.sessionUpdate !== 'turn_completed') {
		return undefined;
	}
	const usage = asRecord(update.usage);
	if (!usage) {
		return undefined;
	}
	if (usage.modelCalls !== 1) {
		return undefined;
	}
	const input = readTokenCount(usage.inputTokens);
	const output = readTokenCount(usage.outputTokens);
	if (input === undefined || output === undefined) {
		return undefined;
	}
	return input + output;
}

/**
 * `model_changed` window selection from the extension notification update.
 * Returns `undefined` when the notification is not `model_changed`.
 * `selection` is the chosen window, or `undefined` when the field is omitted /
 * null (model default — callers must clear any override).
 */
export function readGrokModelChangedContextWindow(params: unknown): { readonly selection: number | undefined } | undefined {
	const update = readGrokExtensionUpdate(params);
	if (!update || update.sessionUpdate !== 'model_changed') {
		return undefined;
	}
	const raw = update.context_window_selection;
	// Absent / null / undefined → model default (caller clears override).
	if (raw === null || raw === undefined) {
		return { selection: undefined };
	}
	return { selection: readGrokPositiveInt(raw) };
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
	const subjectToolCallId = params.subject?.toolCallId;
	const toolCallId =
		params.toolCall?.toolCallId
		?? params.subject?.toolCall?.toolCallId
		?? (typeof subjectToolCallId === 'string' ? subjectToolCallId : undefined);
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
 * Live grok 1.0.70 edit permissions expose `allow_once`, `allow_always`
 * (`allow-edits-session`), and `reject_once` — no `reject_always`.
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
