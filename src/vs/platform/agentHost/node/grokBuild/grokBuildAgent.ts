/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { CancellationError } from '../../../../base/common/errors.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { appendEscapedMarkdownInlineCode } from '../../../../base/common/htmlContent.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { structuralEquals } from '../../../../base/common/equals.js';
import { equals } from '../../../../base/common/objects.js';
import { type IObservable, observableValue } from '../../../../base/common/observable.js';
import { extUri } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { localize } from '../../../../nls.js';
import { ILogService } from '../../../log/common/log.js';
import { IProductService } from '../../../product/common/productService.js';
import { deriveLegacyDefaultChat } from '../../common/agentHostLegacyDefaultChat.js';
import { ContextSizeConfigKey, getModelContextSize } from '../../common/agentModelConfiguration.js';
import {
	AgentChatMigrationResult,
	AgentSession,
	GROK_BUILD_AGENT_PROVIDER_ID,
	type AgentProvider,
	type IActiveClient,
	type IAgent,
	type IAgentChatConfigCompletionsParams,
	type IAgentChatContext,
	type IAgentChatDataChange,
	type IAgentChatMetadata,
	type IAgentChatMetadataOptions,
	type IAgentCreateChatOptions,
	type IAgentChats,
	type IAgentCreateChatResult,
	type IAgentDescriptor,
	type IAgentDiscoveredChat,
	type IAgentListedChat,
	type IAgentMaterializeChatEvent,
	type IAgentModelInfo,
	type IAgentResolveChatConfigParams,
	type IAgentSpawnChatEvent,
	type IAgentToolPendingConfirmationSignal,
	type IAgentPermissionResponseContext,
	type IAgentChatOwnerRef,
	AgentSignal,
	resolveAgentChatContext,
} from '../../common/agent.js';
import { type ChatInputRequestWithPlanReview, type IAgentHostPlanReviewAction } from '../../common/agentHostPlanReview.js';
import { AgentHostGrokBuildClientToolsMcpEnabledConfigKey, platformRootSchema } from '../../common/agentHostSchema.js';
import { AgentHostGrokBuildBinaryPathEnvVar } from '../../common/agentService.js';
import { PendingRequestRegistry } from '../../common/pendingRequestRegistry.js';
import { ChatInputRequestPurpose, withChatInputRequestPurpose } from '../../common/meta/agentChatInputRequestMeta.js';
import { SessionConfigKey } from '../../common/sessionConfigKeys.js';
import type { ConfigSchema } from '../../common/state/protocol/common/state.js';
import { IAgentConfigurationService, type IAgentChatConfigurationChangeEvent } from '../agentConfigurationService.js';
import { AgentHostStateManager, IAgentHostStateManager } from '../agentHostStateManager.js';
import { ActiveClientToolSet } from '../activeClientState.js';
import { ActionType, type ChatAction, type SessionAction } from '../../common/state/sessionActions.js';
import { ChatInputAnswerState, ChatInputAnswerValueKind, ChatInputQuestionKind, ChatInputResponseKind, createErrorResponsePart, MessageKind, ResponsePartKind, ToolCallConfirmationReason, ToolCallContributorKind, ToolResultContentType, TurnState, type ChatInputAnswer, type ChatInputQuestion, type ClientPluginCustomization, type Customization, type ModelSelection, type ToolCallResult, type Turn } from '../../common/state/sessionState.js';
import type { ProtectedResourceMetadata, ToolDefinition } from '../../common/state/protocol/state.js';
import type { ResolveSessionConfigResult, SessionConfigCompletionsResult } from '../../common/state/protocol/commands.js';
import { AHP_SESSION_NOT_FOUND, ProtocolError } from '../../common/state/sessionProtocol.js';
import {
	parseGrokClientToolTarget,
	startGrokClientToolMcpServer,
	takePendingGrokClientToolCall,
	type IGrokAcpHttpMcpServer,
	type IGrokClientMcpServerHandle,
	type IGrokPendingClientToolCall,
} from './grokBuildClientToolMcpServer.js';
import {
	AcpClient,
	AcpJsonRpcErrorCode,
	AcpJsonRpcResponseError,
	transportFromChildProcess,
	type IAcpClient,
	type IAcpTransport,
	type AcpServerRequestHandlerResult,
} from './acpClient.js';
import { decodeGrokBuildChat, encodeGrokBuildChat, type IGrokBuildPersistedChat } from './grokBuildChatBacking.js';
import {
	appendStderrTail,
	buildGrokBuildLaunchConfig,
	GROK_BUILD_MIN_VERSION,
	grokCannotRestoreSessionError,
	grokCliMissingError,
	grokExitStatusError,
	grokHandshakeTimeoutError,
	grokLogSummary,
	grokNotLoggedInError,
	GrokSessionMissingError,
	grokProcessExitedError,
	grokSessionMissingError,
	grokSpawnFailureError,
	grokUnreadableVersionWarning,
	grokWorkingDirectoryRejectedError,
	redactGrokAuthenticateText,
	resolveGrokBinary,
	withStderrTail,
	type IGrokBuildLaunchConfig,
	type IGrokBuildResolvedBinary,
} from './grokBuildLaunchConfig.js';
import {
	contextSizeConfigSchema,
	createGrokBuildMapState,
	createGrokContextSizeConfigSchemaProperty,
	mapExitPlanContent,
	mapPendingRequestCancelled,
	mapPermissionRequest,
	mapSessionUpdate,
	mapTurnCompleted,
	mapTurnStarted,
	mapUsage,
	markGrokClientToolCancelledBeforeStart,
	markGrokClientToolExecutionStarted,
	mergeGrokModelConfigSchema,
	GROK_COPILOT_USAGE_INFO_KEY,
	readGrokCompactionCurrentTokens,
	readGrokCurrentModelContextWindow,
	readGrokMaxContextWindow,
	readGrokModelChangedContextWindow,
	readGrokTotalTokens,
	readGrokTurnCompletedSingleCallTokens,
	formatGrokClientToolApprovalMessage,
	selectClientToolPermissionOptionId,
	selectPermissionOptionId,
	toGrokUsageInfo,
	withGrokContextUsage,
	type IGrokBuildMapState,
	type IGrokContextUsageInfo,
} from './grokBuildMapSessionUpdates.js';
import {
	applyGrokHistoryUpdate,
	createGrokHistoryReplay,
	finishGrokHistoryReplay,
	readGrokSessionTitle,
	type IGrokHistoryReplay,
	type IGrokReplayedTurn,
} from './grokBuildSessionReplay.js';
import {
	allowEditsOnceOptionId,
	buildGrokCommandCustomizations,
	grokBuildSessionSchema,
	grokPlanModeFailedError,
	GROK_DEFAULT_MODE_ID,
	GROK_PERMISSION_PRESET_ALLOW_EDITS,
	GROK_PLAN_MODE_ID,
	GROK_REASONING_CONFIG_ID,
	rejectedGrokSlashCommand,
	modeIdForSessionMode,
	modelWithContextSize,
	modelWithThinkingLevel,
	readAvailableCommands,
	readPermissionPreset,
	readReasoningEffortOption,
	reasoningEffortConfigSchema,
	sameCommands,
	thinkingLevelOf,
	type IGrokAvailableCommand,
} from './grokBuildUx.js';
import {
	type AcpAgentCapabilities,
	type AcpAskUserQuestion,
	type AcpAskUserQuestionOption,
	type AcpAskUserQuestionParams,
	type AcpAskUserQuestionResult,
	type AcpConfigOption,
	type AcpExitPlanModeParams,
	type AcpExitPlanModeResult,
	type AcpModelInfo,
	type AcpModelState,
	type AcpRequestPermissionParams,
	type AcpRequestPermissionResult,
	type AcpSessionInfo,
	type AcpSessionListParams,
	type AcpSessionListResult,
	type AcpSessionSetModelParams,
	type AcpSessionUpdate,
	type AcpSessionUpdateParams,
	type AcpToolCallUpdate,
	ACP_PROTOCOL_VERSION,
} from './protocol/acpTypes.js';

function isAcpToolCallUpdate(update: AcpSessionUpdate): update is AcpToolCallUpdate {
	return update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update';
}

function readSessionId(params: unknown): string | undefined {
	if (!params || typeof params !== 'object') {
		return undefined;
	}
	const sessionId = (params as { sessionId?: unknown }).sessionId;
	return typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : undefined;
}

/** Plan-review action: approve and leave plan mode so grok can execute. */
const GROK_PLAN_REVIEW_APPROVE_ID = 'approve';
/** Plan-review action: leave plan mode without executing. */
const GROK_PLAN_REVIEW_ABANDON_ID = 'abandon';
/** Chat-input question id for the optional skip-interview control. */
const GROK_ASK_USER_SKIP_QUESTION_ID = 'grok-ask-user-skip';
/** Option id that maps Accept → `{ outcome: 'skip_interview' }`. */
const GROK_ASK_USER_SKIP_OPTION_ID = 'skip';
/** Chat-input question id for client-tool allow/reject. */
const GROK_CLIENT_TOOL_APPROVAL_QUESTION_ID = 'grok-client-tool-approval';
/** Allow the client tool for this call only (never session-wide). */
const GROK_CLIENT_TOOL_ALLOW_ONCE_OPTION_ID = 'allow-once';
/** Reject the client tool for this call. */
const GROK_CLIENT_TOOL_REJECT_OPTION_ID = 'reject';

function askUserQuestionId(index: number): string {
	return `q-${index}`;
}

/**
 * Flatten one chat-input answer into the grok wire value. Multi-select is a
 * string array; single-select / free text is a string. Freeform text that does
 * not match an option label is passed through as-is.
 */
function askUserAnswerFromChatInput(answer: ChatInputAnswer | undefined, multiSelect: boolean): string | string[] | undefined {
	if (!answer || answer.state === ChatInputAnswerState.Skipped) {
		return undefined;
	}
	const value = answer.value;
	switch (value.kind) {
		case ChatInputAnswerValueKind.Text: {
			const text = value.value.trim();
			if (!text) {
				return undefined;
			}
			return multiSelect ? [text] : text;
		}
		case ChatInputAnswerValueKind.Selected: {
			const freeform = value.freeformValues?.map(s => s.trim()).filter(s => s.length > 0) ?? [];
			if (freeform.length > 0) {
				return multiSelect ? freeform : freeform[0];
			}
			const selected = value.value.trim();
			if (!selected) {
				return undefined;
			}
			return multiSelect ? [selected] : selected;
		}
		case ChatInputAnswerValueKind.SelectedMany: {
			const selected = value.value.map(s => s.trim()).filter(s => s.length > 0);
			const freeform = value.freeformValues?.map(s => s.trim()).filter(s => s.length > 0) ?? [];
			const all = [...selected, ...freeform];
			if (all.length === 0) {
				return undefined;
			}
			return multiSelect ? all : all[0];
		}
		default:
			return undefined;
	}
}

function buildAskUserChatInputQuestions(questions: readonly AcpAskUserQuestion[]): ChatInputQuestion[] {
	return questions.map((question, index): ChatInputQuestion => {
		const options = (question.options ?? []).map(option => ({
			id: option.label,
			label: option.label,
			...(option.description ? { description: option.description } : {}),
		}));
		const multiSelect = question.multiSelect === true;
		if (multiSelect) {
			return {
				kind: ChatInputQuestionKind.MultiSelect,
				id: askUserQuestionId(index),
				title: localize('grokBuild.askUser.questionTitle', "Question"),
				message: question.question,
				required: false,
				options,
				allowFreeformInput: true,
			};
		}
		return {
			kind: ChatInputQuestionKind.SingleSelect,
			id: askUserQuestionId(index),
			title: localize('grokBuild.askUser.questionTitle', "Question"),
			message: question.question,
			required: false,
			options,
			allowFreeformInput: true,
		};
	});
}

const HANDSHAKE_TIMEOUT_MS = 30_000;
const GROK_SESSION_LIST_MAX_PAGES = 20;

/** AcpClient rejects in-flight RPCs with this text before the agent sees the exit event. */
const GROK_TRANSPORT_EXIT = /grok acp process exited \(code=(-?\d+|null), signal=([^;)]+)\)/;

function grokExitFromTransportError(err: unknown): { code: number | null; signal: NodeJS.Signals | null } | undefined {
	const message = err instanceof Error ? err.message : undefined;
	const match = message ? GROK_TRANSPORT_EXIT.exec(message) : undefined;
	if (!match) {
		return undefined;
	}
	const code = match[1] === 'null' ? null : Number(match[1]);
	const signal = match[2] === 'null' ? null : match[2] as NodeJS.Signals;
	return { code, signal };
}

/**
 * Bound a promise without leaving a rejection unhandled when the timer wins.
 * `raceTimeout` settles on the timer and still rejects the original promise.
 */
function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | undefined> {
	let settled = false;
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			if (settled) {
				return;
			}
			settled = true;
			resolve(undefined);
		}, timeoutMs);
		promise.then(value => {
			if (settled) {
				return;
			}
			settled = true;
			clearTimeout(timer);
			resolve(value);
		}, error => {
			if (settled) {
				return;
			}
			settled = true;
			clearTimeout(timer);
			reject(error);
		});
	});
}

export type GrokBuildTestSpawnResult = {
	readonly transport: IAcpTransport;
	readonly child?: ChildProcessWithoutNullStreams;
	readonly onDispose?: () => void;
};

export type GrokBuildTestSpawn = (launch: IGrokBuildLaunchConfig) => GrokBuildTestSpawnResult;

interface IGrokBuildTurnRecord {
	readonly id: string;
	readonly userText: string;
	readonly assistantMarkdown: string;
	readonly state: TurnState;
	readonly usage?: Turn['usage'];
	readonly errorMessage?: string;
	/** ACP `user_message_chunk._meta.promptIndex` for this turn, when known. */
	readonly promptIndex?: number;
}

interface IGrokBuildChatBacking {
	readonly chat: URI;
	sessionId: string;
	model?: ModelSelection;
	summary?: string;
	readonly startTime: number;
	modifiedTime: number;
	workingDirectories?: readonly URI[];
	turns: IGrokBuildTurnRecord[];
	/** Connection generation that created or loaded this session. Undefined means it must be restored. Changing it clears `appliedModeId`. */
	loadedGeneration?: number;
	activeTurnId?: string;
	mapState?: IGrokBuildMapState;
	turnAssistantMarkdown?: string;
	turnUserText?: string;
	/** Prompt index of the in-flight turn. Stored on the turn record when it finishes. */
	turnPromptIndex?: number;
	/** Reasoning effort last applied or adopted from grok. Persisted in provider data. */
	reasoningEffort?: string;
	/** ACP available commands for this session. Live entries are `{ name, description, input: null | { hint }, _meta? }`. */
	commands?: readonly IGrokAvailableCommand[];
	/** Read at use. Not the URI `get()` returned earlier. */
	ownerRef?: IAgentChatOwnerRef;
	/** Last `session/set_mode` id accepted on the current grok process. Cleared when `loadedGeneration` changes. */
	appliedModeId?: string;
	/**
	 * Cwd to try on the next `session/load` when the backing has none yet.
	 * Not copied into providerData until that load succeeds.
	 */
	pendingLoadCwd?: string;
	/**
	 * Latest non-zero `_meta.totalTokens` (or compaction `tokens_after` /
	 * `tokens_used`). Drives `copilot.usageInfo.currentTokens`.
	 */
	lastTotalTokens?: number;
	/**
	 * Non-default window for this chat (usage `tokenLimit`). Set from
	 * `changeModel`, `model_changed.context_window_selection`, or
	 * `session/load` `_meta.contextWindow`. Cleared when the selection is
	 * the model default. Never written into the shared `_models` list.
	 */
	contextWindowOverride?: number;
	/** Last published `copilot.usageInfo` (dedupe). */
	publishedContextUsage?: IGrokContextUsageInfo;
	/**
	 * `models.currentModelId` from the latest `session/new` or `session/load`.
	 * Used for restore history modelId / tokenLimit when the user has not
	 * pinned `backing.model` (and must not be written into providerData).
	 */
	cliCurrentModelId?: string;
	/**
	 * During `session/load` replay: after a single-call `turn_completed` (or
	 * compaction), ignore further `agent_message_chunk` totalTokens until the
	 * next `user_message_chunk` so a late/under-reported chunk cannot clobber
	 * the better gauge for the same turn.
	 */
	replaySuppressChunkTotals?: boolean;
	/** Workbench client tools keyed by clientId (merged into the HTTP MCP server). */
	clientToolSet: ActiveClientToolSet;
	/** Parks MCP tools/call handlers until {@link GrokBuildAgent.onClientToolCallComplete}. */
	pendingClientToolCalls: PendingRequestRegistry<ToolCallResult>;
	/**
	 * Grok ACP `use_tool` cards for our `client` MCP server, awaiting
	 * `tools/call` correlation (FIFO by name+args, then name).
	 */
	pendingGrokClientToolCalls: IGrokPendingClientToolCall[];
	/**
	 * toolCallId → args the user allowed via ChatInput (request_permission or
	 * the auto-allow gate). Cleared each turn. MCP must present structurally
	 * equal args for the same id; otherwise ask again. Never `allow_always`.
	 */
	approvedClientCalls: Map<string, Record<string, unknown>>;
	/** Live HTTP MCP server for this chat, when client-tools MCP is enabled. */
	clientMcpServer?: IGrokClientMcpServerHandle;
	/** In-flight ensure of {@link clientMcpServer}. */
	clientMcpServerInFlight?: Promise<IGrokClientMcpServerHandle | undefined>;
}

/**
 * Active-client handle that writes tools into the chat's
 * {@link ActiveClientToolSet} and refreshes the HTTP MCP tools/list snapshot.
 */
class GrokBuildActiveClientHandle implements IActiveClient {
	private _tools: readonly ToolDefinition[] = [];
	private _customizations: readonly ClientPluginCustomization[] = [];

	constructor(
		readonly clientId: string,
		readonly displayName: string | undefined,
		private readonly _resolveBacking: () => IGrokBuildChatBacking | undefined,
		private readonly _onToolsChanged: (backing: IGrokBuildChatBacking) => void,
	) { }

	get tools(): readonly ToolDefinition[] {
		return this._tools;
	}
	set tools(tools: readonly ToolDefinition[]) {
		this._tools = tools;
		const backing = this._resolveBacking();
		if (!backing) {
			return;
		}
		backing.clientToolSet.set(this.clientId, tools);
		backing.clientMcpServer?.setTools(backing.clientToolSet.merged());
		this._onToolsChanged(backing);
	}

	get customizations(): readonly ClientPluginCustomization[] {
		return this._customizations;
	}
	set customizations(customizations: readonly ClientPluginCustomization[]) {
		this._customizations = customizations;
	}

	remove(): void {
		const backing = this._resolveBacking();
		if (!backing) {
			return;
		}
		backing.clientToolSet.delete(this.clientId);
		backing.clientMcpServer?.setTools(backing.clientToolSet.merged());
		this._onToolsChanged(backing);
	}
}

interface IPendingPermission {
	readonly chat: URI;
	readonly turnId: string;
	readonly options: AcpRequestPermissionParams['options'];
	resolve(result: AcpServerRequestHandlerResult<AcpRequestPermissionResult>): void;
}

interface IPendingPlanReview {
	readonly chat: URI;
	readonly sessionId: string;
	readonly turnId: string;
	readonly toolCallId: string;
	readonly questionId: string;
	resolve(result: AcpServerRequestHandlerResult<AcpExitPlanModeResult>): void;
}

interface IPendingAskUserQuestion {
	readonly chat: URI;
	readonly sessionId: string;
	readonly turnId: string;
	readonly toolCallId: string;
	/** Wire questions in order; chat-input ids are `q-${index}`. */
	readonly questions: readonly AcpAskUserQuestion[];
	resolve(result: AcpServerRequestHandlerResult<AcpAskUserQuestionResult>): void;
}

type GrokClientToolApprovalOutcome = 'allow' | 'reject' | 'cancelled';

/**
 * Parked ChatInput for a tracked client-tool call — either grok's
 * `session/request_permission` or a host-side gate when grok auto-allowed.
 */
interface IPendingClientToolApproval {
	readonly chat: URI;
	readonly sessionId: string | undefined;
	readonly toolCallId: string;
	/** Args shown (and stored on allow) for the approval; compared at MCP. */
	readonly args: Record<string, unknown>;
	resolve(outcome: GrokClientToolApprovalOutcome): void;
}

interface IConnection {
	readonly client: IAcpClient;
	readonly child: ChildProcessWithoutNullStreams | undefined;
	readonly store: DisposableStore;
}

interface IGrokAdvertisedCapabilities {
	readonly loadSession: boolean;
	readonly list: boolean;
	readonly resume: boolean;
	readonly close: boolean;
}

const noGrokCapabilities: IGrokAdvertisedCapabilities = {
	loadSession: false,
	list: false,
	resume: false,
	close: false,
};

function chatKey(chat: URI): string {
	return chat.toString();
}

function isGrokAuthError(error: unknown): boolean {
	if (!(error instanceof AcpJsonRpcResponseError)) {
		return false;
	}
	return error.code === -32000 && /authentication required/i.test(error.message);
}

/** grok 1.0.70: `session/load` of an unknown id or a missing folder is -32603 / `FS_NOT_FOUND`. */
function isGrokFsNotFound(error: unknown): boolean {
	if (!(error instanceof AcpJsonRpcResponseError) || error.code !== AcpJsonRpcErrorCode.InternalError) {
		return false;
	}
	const data = error.data;
	return !!data && typeof data === 'object' && (data as { code?: unknown }).code === 'FS_NOT_FOUND';
}

function promptIndexUserTextConflicts(previous: IGrokBuildTurnRecord, turn: IGrokReplayedTurn): boolean {
	return previous.userText.length > 0 && turn.userText.length > 0 && previous.userText !== turn.userText;
}

/**
 * Replay replaces in-memory turns. A user-only replay stays `Cancelled`
 * (or `Error` when a local error matches) and is never marked complete.
 * A `promptIndex` match also requires the user text to match when both
 * sides have text, so a synthesized index cannot attach a failure to a
 * different turn. A local error with no index, or an index that does not
 * match this replay row, adopts grok's index when the user text matches.
 */
export function mergeRestoredTurns(local: readonly IGrokBuildTurnRecord[], replayed: readonly IGrokReplayedTurn[]): IGrokBuildTurnRecord[] {
	const byPrompt = new Map<number, IGrokBuildTurnRecord>();
	for (const turn of local) {
		if (typeof turn.promptIndex === 'number') {
			byPrompt.set(turn.promptIndex, turn);
		}
	}
	const consumed = new Set<IGrokBuildTurnRecord>();
	return replayed.map(turn => {
		let previous = typeof turn.promptIndex === 'number' ? byPrompt.get(turn.promptIndex) : undefined;
		if (previous && promptIndexUserTextConflicts(previous, turn)) {
			previous = undefined;
		}
		if (previous) {
			consumed.add(previous);
		} else {
			previous = local.find(candidate =>
				!consumed.has(candidate)
				&& candidate.state === TurnState.Error
				&& candidate.userText.length > 0
				&& candidate.userText === turn.userText
				&& (candidate.promptIndex === undefined || candidate.promptIndex !== turn.promptIndex)
			);
			if (previous) {
				consumed.add(previous);
			}
		}
		const promptIndex = turn.promptIndex ?? previous?.promptIndex;
		if (previous?.state === TurnState.Error) {
			return {
				id: previous.id,
				userText: turn.userText || previous.userText,
				assistantMarkdown: turn.assistantMarkdown || previous.assistantMarkdown,
				state: TurnState.Error,
				usage: previous.usage,
				errorMessage: previous.errorMessage,
				promptIndex,
			};
		}
		if (turn.userText.length > 0 && turn.assistantMarkdown.length === 0) {
			return {
				id: previous?.id ?? turn.id,
				userText: turn.userText,
				assistantMarkdown: '',
				state: TurnState.Cancelled,
				promptIndex,
			};
		}
		return {
			id: previous?.id ?? turn.id,
			userText: turn.userText,
			assistantMarkdown: turn.assistantMarkdown,
			state: TurnState.Complete,
			usage: previous?.usage,
			promptIndex,
		};
	});
}

function readGrokCapabilities(capabilities: AcpAgentCapabilities | undefined): IGrokAdvertisedCapabilities {
	const session = capabilities?.sessionCapabilities ?? undefined;
	const advertised = (value: unknown): boolean => value !== undefined && value !== null;
	return {
		loadSession: capabilities?.loadSession === true,
		list: advertised(session?.list),
		resume: advertised(session?.resume),
		close: advertised(session?.close),
	};
}

/**
 * Surface ACP JSON-RPC failures with `error.data` when present (live grok
 * puts detail such as `unknown model id` / `unknown session id` there).
 */
export function formatAcpError(error: unknown): Error {
	if (error instanceof AcpJsonRpcResponseError) {
		const detail = error.data === undefined || error.data === null
			? ''
			: typeof error.data === 'string'
				? `: ${error.data}`
				: `: ${JSON.stringify(error.data)}`;
		const formatted = new Error(`${error.message}${detail}`);
		formatted.name = error.name;
		return formatted;
	}
	if (error instanceof Error) {
		return error;
	}
	return new Error(String(error));
}

function rethrowAcpFailure(error: unknown): never {
	if (isGrokAuthError(error)) {
		throw grokNotLoggedInError();
	}
	throw formatAcpError(error);
}

function toAgentModelInfo(model: AcpModelInfo, provider: AgentProvider, reasoningSchema: ConfigSchema | undefined): IAgentModelInfo {
	const maxContextWindow = readGrokMaxContextWindow(model._meta);
	const configSchema = mergeGrokModelConfigSchema(
		reasoningSchema,
		contextSizeConfigSchema(createGrokContextSizeConfigSchemaProperty(model._meta)),
	);
	return {
		provider,
		id: model.modelId,
		name: model.name ?? model.modelId,
		supportsVision: false,
		...(maxContextWindow !== undefined ? { maxContextWindow } : {}),
		...(configSchema ? { configSchema } : {}),
	};
}

function applyModelState(
	setModels: (models: readonly IAgentModelInfo[]) => void,
	provider: AgentProvider,
	state: AcpModelState | undefined,
	reasoningSchema: ConfigSchema | undefined,
): void {
	const available = state?.availableModels;
	if (!available?.length) {
		return;
	}
	setModels(available.map(m => toAgentModelInfo(m, provider, reasoningSchema)));
}

function textFromSessionUpdate(params: AcpSessionUpdateParams): string | undefined {
	const update = params.update;
	if (!update || typeof update !== 'object') {
		return undefined;
	}
	if ((update as { sessionUpdate?: string }).sessionUpdate !== 'agent_message_chunk') {
		return undefined;
	}
	const content = (update as { content?: { type?: string; text?: string } }).content;
	if (content && typeof content.text === 'string') {
		return content.text;
	}
	return undefined;
}

function turnRecordToTurn(record: IGrokBuildTurnRecord, model?: ModelSelection): Turn {
	const responseParts = [];
	if (record.assistantMarkdown) {
		responseParts.push({ kind: ResponsePartKind.Markdown as const, id: generateUuid(), content: record.assistantMarkdown });
	}
	if (record.errorMessage) {
		responseParts.push(createErrorResponsePart({ errorType: 'GrokProcessExited', message: record.errorMessage }));
	}
	return {
		id: record.id,
		message: {
			text: record.userText,
			origin: { kind: MessageKind.User },
			...(model ? { model } : {}),
		},
		responseParts,
		usage: record.usage,
		state: record.state,
	};
}

/** Explicit user/provider selection wins over the CLI's currentModelId. */
function modelForTurnRecords(backing: IGrokBuildChatBacking): ModelSelection | undefined {
	if (backing.model) {
		return backing.model;
	}
	return backing.cliCurrentModelId ? { id: backing.cliCurrentModelId } : undefined;
}

function spawnGrokBuildProcess(launch: IGrokBuildLaunchConfig): GrokBuildTestSpawnResult {
	const child = spawn(launch.binaryPath, [...launch.args], {
		stdio: ['pipe', 'pipe', 'pipe'],
		env: launch.env,
	});
	return { child, transport: transportFromChildProcess(child) };
}

export class GrokBuildAgent extends Disposable implements IAgent {
	readonly id: AgentProvider = GROK_BUILD_AGENT_PROVIDER_ID;
	/**
	 * grok 1.0.70 cannot `session/load` a session outside the directory it was
	 * created in (`FS_NOT_FOUND`). The host must not offer a worktree conversion.
	 */
	readonly agentHostCapabilities = { workspaceConversion: false } as const;

	private readonly _onDidChatProgress = this._register(new Emitter<AgentSignal>());
	readonly onDidChatProgress = this._onDidChatProgress.event;

	private readonly _onDidMaterializeChat = this._register(new Emitter<IAgentMaterializeChatEvent>());
	readonly onDidMaterializeChat = this._onDidMaterializeChat.event;

	private readonly _onDidChangeChatData = this._register(new Emitter<IAgentChatDataChange>());
	readonly onDidChangeChatData = this._onDidChangeChatData.event;

	private readonly _onDidSpawnChat = this._register(new Emitter<IAgentSpawnChatEvent>());
	readonly onDidSpawnChat = this._onDidSpawnChat.event;

	private readonly _onDidDiscoverChats = this._register(new Emitter<readonly IAgentDiscoveredChat[]>());
	readonly onDidDiscoverChats = this._onDidDiscoverChats.event;

	private readonly _models = observableValue<readonly IAgentModelInfo[]>(this, []);
	readonly models: IObservable<readonly IAgentModelInfo[]> = this._models;

	private readonly _backings = new Map<string, IGrokBuildChatBacking>();
	private readonly _sessionToChat = new Map<string, URI>();
	private readonly _pendingPermissions = new Map<string, IPendingPermission>();
	/** Pending `_x.ai/exit_plan_mode` reviews, keyed by chat-input request id. */
	private readonly _pendingPlanReviews = new Map<string, IPendingPlanReview>();
	/** Pending `_x.ai/ask_user_question` prompts, keyed by chat-input request id. */
	private readonly _pendingAskUserQuestions = new Map<string, IPendingAskUserQuestion>();
	/** Pending client-tool allow/reject ChatInputs, keyed by chat-input request id. */
	private readonly _pendingClientToolApprovals = new Map<string, IPendingClientToolApproval>();
	/**
	 * ACP session ids that left plan via approve/abandon and are waiting for
	 * `current_mode_update` `default` so chat config can move to interactive.
	 */
	private readonly _sessionsExitingPlanMode = new Set<string>();
	private readonly _activeClients = new Map<string, Map<string, GrokBuildActiveClientHandle>>();
	private readonly _restoreInFlight = new Map<string, Promise<void>>();
	private readonly _tornDown = new WeakSet<IAcpClient>();

	private _connection: IConnection | undefined;
	private _connectionInFlight: Promise<IAcpClient> | undefined;
	private _connectionGeneration = 0;
	private _capabilities: IGrokAdvertisedCapabilities = noGrokCapabilities;
	private _stderrTail = '';
	/** In-flight `session/load` replays, keyed by ACP session id so concurrent restores do not share one buffer. */
	private readonly _historyReplays = new Map<string, IGrokHistoryReplay>();
	/** `session/list` rows, keyed by ACP session id. Discovery fills this; recovery reads cwd and title from it. */
	private readonly _listedSessions = new Map<string, AcpSessionInfo>();
	/**
	 * Pre-`session/load` / `session/resume` `updatedAt` from the cached list row.
	 * Grok bumps list `updatedAt` on every load; listing uses
	 * `min(recorded, grok updatedAt)` until a real turn clears the entry.
	 */
	private readonly _preLoadUpdatedAt = new Map<string, number>();
	private _discoveryPromise: Promise<void> | undefined;
	private _testClient: IAcpClient | undefined;
	private _reasoningOption: AcpConfigOption | undefined;
	private _spawn: GrokBuildTestSpawn = spawnGrokBuildProcess;
	private _handshakeTimeoutMs = HANDSHAKE_TIMEOUT_MS;
	private _resolveBinary: (configuredPath: string | undefined) => Promise<IGrokBuildResolvedBinary> = configuredPath => resolveGrokBinary(configuredPath);
	private _binaryResolverOverridden = false;

	private readonly _onDidCustomizationsChange = this._register(new Emitter<void>());
	readonly onDidCustomizationsChange: Event<void> = this._onDidCustomizationsChange.event;

	constructor(
		@ILogService private readonly _logService: ILogService,
		@IProductService private readonly _productService: IProductService,
		@IAgentConfigurationService private readonly _configurationService: IAgentConfigurationService,
		@IAgentHostStateManager private readonly _stateManager: AgentHostStateManager,
	) {
		super();
		this._register(this._configurationService.onDidChatConfigChange(event => this._onChatConfigChanged(event)));
	}

	getDescriptor(): IAgentDescriptor {
		return {
			provider: this.id,
			displayName: localize('grokBuild.descriptor.displayName', "Grok Build"),
			description: localize('grokBuild.descriptor.description', "Build and iterate on code with Grok through the Agent Client Protocol."),
		};
	}

	/**
	 * @internal Test seam: inject a pre-authenticated ACP client without spawning `grok`.
	 * `capabilities` is what a live `initialize` result would have advertised.
	 */
	bindTestClient(client: IAcpClient, capabilities?: AcpAgentCapabilities): void {
		this._disposeConnection();
		this._testClient = client;
		const store = new DisposableStore();
		store.add(client);
		this._connection = { client, child: undefined, store };
		this._connectionGeneration++;
		this._capabilities = capabilities ? readGrokCapabilities(capabilities) : noGrokCapabilities;
		this._wireClient(client, store);
	}

	/**
	 * @internal Test seam: replace process spawn. `_connect` always calls the
	 * injected function; it does not branch on a test flag.
	 */
	bindTestSpawn(spawnFn: GrokBuildTestSpawn): void {
		this._spawn = spawnFn;
		if (!this._binaryResolverOverridden) {
			this._resolveBinary = async () => ({ path: 'grok', version: GROK_BUILD_MIN_VERSION });
		}
	}

	/**
	 * @internal Test seam: shorten the initialize / authenticate wait.
	 * Session prompts are not timed out; a model turn has no fixed budget.
	 */
	bindTestHandshakeTimeout(timeoutMs: number): void {
		this._handshakeTimeoutMs = timeoutMs;
	}

	/**
	 * @internal Test seam: replace binary resolution (missing CLI, unreadable version).
	 */
	bindTestBinaryResolver(resolveBinary: (configuredPath: string | undefined) => Promise<IGrokBuildResolvedBinary>): void {
		this._binaryResolverOverridden = true;
		this._resolveBinary = resolveBinary;
	}

	readonly chats: IAgentChats = {
		createChat: (chat, context, options) => this._createChat(chat, context, options),
		disposeChat: (chat, _context) => this._disposeChat(chat),
		releaseChat: (chat, _context) => this._disposeChat(chat),
		sendMessage: (chat, prompt, workingDirectoriesOrDirectory, _attachments, turnId, _senderClientId, clientTypeOrContext, context) => {
			const operationContext = context ?? (typeof clientTypeOrContext === 'string' ? undefined : clientTypeOrContext);
			return this._sendMessage(chat, prompt, workingDirectoriesOrDirectory, turnId, operationContext);
		},
		abort: (chat, _context) => this._abort(chat),
		getMessages: (chat, _context) => {
			const backing = this._backings.get(chatKey(chat));
			if (!backing) {
				return Promise.resolve([]);
			}
			const model = modelForTurnRecords(backing);
			return Promise.resolve(backing.turns.map(turn => turnRecordToTurn(turn, model)));
		},
		changeModel: (chat, model, _context) => this._changeModel(chat, model),
		getModel: (chat, _context) => {
			const backing = this._backings.get(chatKey(chat));
			return backing ? modelForTurnRecords(backing) : undefined;
		},
		changeAgent: (_chat, _agent, _context) => Promise.resolve(),
	};

	async materializeChat(chat: URI, context: URI | IAgentChatContext, providerData: string | undefined): Promise<IAgentCreateChatResult | void> {
		resolveAgentChatContext(context, chat);
		if (providerData === undefined) {
			return this._recoverDiscoveredChat(chat, context);
		}
		const decoded = decodeGrokBuildChat(providerData);
		if (!decoded) {
			return;
		}
		const workingDirectories = decoded.cwd ? [URI.file(decoded.cwd)] : undefined;
		const backing = this._storeBacking(chat, decoded, workingDirectories);
		this._rememberOwner(backing, context);
		try {
			await this._ensureSessionAttached(backing);
		} catch (err) {
			if (err instanceof GrokSessionMissingError) {
				this._dropBacking(chat, decoded.sessionId);
			}
			throw err;
		}
		const encoded = this._persistProviderData(backing);
		const result: IAgentCreateChatResult = {
			providerData: encoded,
			resolvedWorkingDirectory: backing.workingDirectories?.[0],
		};
		this._onDidMaterializeChat.fire({
			chat,
			result,
			workingDirectories: backing.workingDirectories,
			project: undefined,
		});
		return result;
	}

	/**
	 * A discovered default chat has no persisted blob. The session id is the
	 * owner URI; cwd and title come from `session/list`. `session/load` runs
	 * at that original cwd and only then is canonical providerData returned.
	 */
	async recoverLegacyChat(chat: URI, context: URI | IAgentChatContext): Promise<IAgentCreateChatResult> {
		return this._recoverDiscoveredChat(chat, context);
	}

	getOrCreateActiveClient(
		chat: URI,
		_context: URI | IAgentChatContext,
		client: { readonly clientId: string; readonly displayName?: string },
		_hostCustomizations?: readonly Customization[],
	): IActiveClient {
		const key = chatKey(chat);
		let perChat = this._activeClients.get(key);
		if (!perChat) {
			perChat = new Map();
			this._activeClients.set(key, perChat);
		}
		let active = perChat.get(client.clientId);
		if (active) {
			return active;
		}
		active = new GrokBuildActiveClientHandle(
			client.clientId,
			client.displayName,
			() => this._backings.get(key),
			backing => {
				this._logService.trace(`[GrokBuild] client tools updated for ${backing.sessionId}: ${backing.clientToolSet.merged().map(t => t.name).join(', ') || '(none)'}`);
			},
		);
		perChat.set(client.clientId, active);
		return active;
	}

	removeActiveClient(chat: URI, _context: URI | IAgentChatContext, clientId: string): void {
		const key = chatKey(chat);
		const handle = this._activeClients.get(key)?.get(clientId);
		if (!handle) {
			return;
		}
		handle.remove();
		this._activeClients.get(key)?.delete(clientId);
	}

	onClientToolCallComplete(chat: URI, toolCallId: string, result: ToolCallResult, _context?: IAgentChatContext): void {
		const backing = this._backings.get(chatKey(chat));
		if (!backing) {
			return;
		}
		// AgentSideEffects forwards every ChatToolCallComplete (including grok's own
		// tools). Buffer only ids we expect from a client-tool card / MCP park —
		// never buffer unknowns forever (workbench may complete before MCP registers).
		const expected = backing.pendingGrokClientToolCalls.some(entry => entry.toolCallId === toolCallId)
			|| backing.pendingClientToolCalls.has(toolCallId);
		if (expected) {
			backing.pendingClientToolCalls.respondOrBuffer(toolCallId, result);
		} else {
			backing.pendingClientToolCalls.respond(toolCallId, result);
		}
	}

	respondToPermissionRequest(requestId: string, approved: boolean, _context?: IAgentPermissionResponseContext): void {
		const pending = this._pendingPermissions.get(requestId);
		if (!pending) {
			return;
		}
		const optionId = selectPermissionOptionId(pending.options, approved);
		if (optionId) {
			pending.resolve({ result: { outcome: { outcome: 'selected', optionId } } });
		} else {
			pending.resolve({ result: { outcome: { outcome: 'cancelled' } } });
		}
		this._pendingPermissions.delete(requestId);
	}

	respondToUserInputRequest(requestId: string, response: ChatInputResponseKind, answers?: Record<string, ChatInputAnswer>): void {
		const planPending = this._pendingPlanReviews.get(requestId);
		if (planPending) {
			const result = this._resolveExitPlanMode(planPending, response, answers);
			this._completePlanReview(requestId, { result });
			return;
		}
		const clientToolPending = this._pendingClientToolApprovals.get(requestId);
		if (clientToolPending) {
			this._completeClientToolApproval(requestId, this._resolveClientToolApproval(response, answers));
			return;
		}
		const askPending = this._pendingAskUserQuestions.get(requestId);
		if (!askPending) {
			return;
		}
		const result = this._resolveAskUserQuestion(askPending, response, answers);
		this._completeAskUserQuestion(requestId, { result });
	}

	async setWorkingDirectory(chat: URI, context: URI | IAgentChatContext, workingDirectory: URI): Promise<void> {
		resolveAgentChatContext(context, chat);
		this._logService.trace(`[GrokBuild] rejected working directory change to ${workingDirectory.toString()}`);
		throw grokWorkingDirectoryRejectedError();
	}

	resolveChatConfig(params: IAgentResolveChatConfigParams): Promise<ResolveSessionConfigResult> {
		return Promise.resolve({
			schema: grokBuildSessionSchema.toProtocol(),
			values: params.config ?? {},
		});
	}

	getInheritedChatConfig(_config: Readonly<Record<string, unknown>>): Record<string, unknown> | undefined {
		return undefined;
	}

	chatConfigCompletions(_params: IAgentChatConfigCompletionsParams): Promise<SessionConfigCompletionsResult> {
		return Promise.resolve({ items: [] });
	}

	async getChatCustomizations(chat: URI, context: URI | IAgentChatContext, hostCustomizations?: readonly Customization[]): Promise<readonly Customization[]> {
		this._rememberOwner(this._backings.get(chatKey(chat)), context);
		const commands = this._backings.get(chatKey(chat))?.commands;
		const container = commands ? buildGrokCommandCustomizations(commands) : undefined;
		return container ? [...(hostCustomizations ?? []), container] : (hostCustomizations ?? []);
	}

	getProtectedResources(): ProtectedResourceMetadata[] {
		return [];
	}

	async authenticate(_resource: string, _token: string, _expiresIn?: number): Promise<boolean> {
		return false;
	}

	async getChatMetadata(chat: URI, context: URI | IAgentChatContext, providerData?: string, options?: IAgentChatMetadataOptions): Promise<IAgentChatMetadata | undefined> {
		resolveAgentChatContext(context, chat);
		let backing = this._backings.get(chatKey(chat));
		this._rememberOwner(backing, context);
		try {
			if (!backing && providerData) {
				const decoded = decodeGrokBuildChat(providerData);
				if (!decoded) {
					return undefined;
				}
				if (options?.activation === 'restore') {
					backing = this._storeBacking(chat, decoded, decoded.cwd ? [URI.file(decoded.cwd)] : undefined);
					this._rememberOwner(backing, context);
					await this._ensureSessionAttached(backing);
				} else {
					// Passive unread metadata: never invent Date.now() or the row
					// jumps to the top of the sessions list until a real turn.
					return {
						chat,
						startTime: 0,
						modifiedTime: 0,
						model: decoded.model,
						workingDirectories: decoded.cwd ? [URI.file(decoded.cwd)] : undefined,
					};
				}
			}
			// CLI-created sessions are discovered via session/list with no host
			// providerData. AgentService restore calls getChatMetadata(activation:
			// 'restore') before materializeChat, and skips the catalog fallback for
			// external rows — so a miss here becomes "provider not ready". Recover
			// the same way as materializeChat(undefined) / recoverLegacyChat.
			if (!backing && options?.activation === 'restore') {
				await this._recoverDiscoveredChat(chat, context);
				backing = this._backings.get(chatKey(chat));
			}
			if (!backing) {
				return undefined;
			}
			if (options?.activation === 'restore') {
				await this._ensureSessionAttached(backing);
			}
			return this._metadataFromBacking(backing);
		} catch (err) {
			// ProtocolError so AgentService does not treat a registered external
			// session's authoritative absence as a transient "not ready" miss.
			if (options?.activation === 'restore' && err instanceof GrokSessionMissingError) {
				throw new ProtocolError(AHP_SESSION_NOT_FOUND, err.message);
			}
			throw err;
		}
	}

	async listChatsToMigrate(): Promise<AgentChatMigrationResult> {
		try {
			const sessions = await this._discoverSessions();
			return sessions.map(session => this._toListedChat(session));
		} catch (err) {
			this._logService.warn(`[GrokBuild] session/list failed: ${grokLogSummary(err instanceof Error ? err.message : String(err))}`);
			return undefined;
		}
	}

	startChatDiscovery(): Promise<void> {
		if (!this._discoveryPromise) {
			this._discoveryPromise = this._emitDiscoveredChats().catch(err => {
				this._logService.warn(`[GrokBuild] chat discovery failed: ${grokLogSummary(err instanceof Error ? err.message : String(err))}`);
			});
		}
		return this._discoveryPromise;
	}

	async shutdown(): Promise<void> {
		this._disposeConnection();
	}

	override dispose(): void {
		this._disposeConnection();
		for (const backing of this._backings.values()) {
			this._disposeClientMcp(backing);
		}
		this._backings.clear();
		this._sessionToChat.clear();
		this._preLoadUpdatedAt.clear();
		this._pendingPermissions.clear();
		this._pendingPlanReviews.clear();
		this._pendingAskUserQuestions.clear();
		this._pendingClientToolApprovals.clear();
		this._sessionsExitingPlanMode.clear();
		this._activeClients.clear();
		super.dispose();
	}

	/**
	 * @param initTimes Brand-new `session/new` chats pass creation times. Restores
	 * omit this and take the cached `session/list` `updatedAt` (or 0) — never `Date.now()`.
	 */
	private _storeBacking(chat: URI, persisted: IGrokBuildPersistedChat, workingDirectories: readonly URI[] | undefined, initTimes?: { readonly startTime: number; readonly modifiedTime: number }): IGrokBuildChatBacking {
		const existing = this._backings.get(chatKey(chat));
		const sameSession = existing?.sessionId === persisted.sessionId;
		if (existing && !sameSession) {
			// New session id for this chat — drop the prior HTTP MCP listener.
			this._disposeClientMcp(existing);
			this._clearPreLoadUpdatedAt(existing.sessionId);
			if (this._sessionToChat.get(existing.sessionId)?.toString() === chat.toString()) {
				this._sessionToChat.delete(existing.sessionId);
			}
		}
		const directories = workingDirectories
			?? (sameSession ? existing?.workingDirectories : undefined)
			?? (persisted.cwd ? [URI.file(persisted.cwd)] : undefined);
		const listedMs = this._listedUpdatedAtMs(persisted.sessionId);
		const startTime = sameSession && existing
			? existing.startTime
			: (initTimes?.startTime ?? listedMs ?? 0);
		const modifiedTime = sameSession && existing
			? existing.modifiedTime
			: (initTimes?.modifiedTime ?? listedMs ?? 0);
		const backing: IGrokBuildChatBacking = {
			chat,
			sessionId: persisted.sessionId,
			model: modelWithThinkingLevel(persisted.model ?? (sameSession ? existing?.model : undefined), persisted.reasoningEffort ?? (sameSession ? existing?.reasoningEffort : undefined)),
			summary: sameSession ? existing?.summary : undefined,
			startTime,
			modifiedTime,
			workingDirectories: directories,
			turns: sameSession && existing ? existing.turns : [],
			loadedGeneration: sameSession ? existing?.loadedGeneration : undefined,
			reasoningEffort: persisted.reasoningEffort ?? (sameSession ? existing?.reasoningEffort : undefined),
			commands: sameSession ? existing?.commands : undefined,
			ownerRef: sameSession ? existing?.ownerRef : undefined,
			appliedModeId: sameSession ? existing?.appliedModeId : undefined,
			// Prefer in-memory gauge; otherwise seed from persisted contextTokens.
			lastTotalTokens: sameSession ? existing?.lastTotalTokens : persisted.contextTokens,
			contextWindowOverride: sameSession ? existing?.contextWindowOverride : undefined,
			publishedContextUsage: sameSession ? existing?.publishedContextUsage : undefined,
			cliCurrentModelId: sameSession ? existing?.cliCurrentModelId : undefined,
			replaySuppressChunkTotals: sameSession ? existing?.replaySuppressChunkTotals : undefined,
			clientToolSet: sameSession && existing ? existing.clientToolSet : new ActiveClientToolSet(),
			pendingClientToolCalls: sameSession && existing
				? existing.pendingClientToolCalls
				: new PendingRequestRegistry<ToolCallResult>(),
			pendingGrokClientToolCalls: sameSession && existing
				? existing.pendingGrokClientToolCalls
				: [],
			approvedClientCalls: sameSession && existing
				? existing.approvedClientCalls
				: new Map<string, Record<string, unknown>>(),
			clientMcpServer: sameSession ? existing?.clientMcpServer : undefined,
			clientMcpServerInFlight: sameSession ? existing?.clientMcpServerInFlight : undefined,
		};
		this._backings.set(chatKey(chat), backing);
		this._sessionToChat.set(persisted.sessionId, chat);
		return backing;
	}

	private _persistProviderData(backing: IGrokBuildChatBacking): string {
		return encodeGrokBuildChat({
			sessionId: backing.sessionId,
			model: backing.model,
			cwd: backing.workingDirectories?.[0]?.fsPath,
			reasoningEffort: backing.reasoningEffort,
			contextTokens: backing.lastTotalTokens,
		});
	}

	private _emitProviderDataChange(chat: URI, backing: IGrokBuildChatBacking): void {
		const providerData = this._persistProviderData(backing);
		this._onDidChangeChatData.fire({ chat, providerData });
	}

	private _toListedChat(session: AcpSessionInfo): IAgentListedChat {
		const sessionUri = AgentSession.uri(this.id, session.sessionId);
		const chat = URI.parse(deriveLegacyDefaultChat(sessionUri));
		const modifiedTime = this._effectiveListedModifiedTime(session);
		const cwd = typeof session.cwd === 'string' && session.cwd.length > 0 ? URI.file(session.cwd) : undefined;
		const summary = typeof session.title === 'string' && session.title.trim().length > 0 ? session.title : undefined;
		return {
			chat,
			session: sessionUri,
			startTime: modifiedTime,
			modifiedTime,
			summary,
			workingDirectories: cwd ? [cwd] : undefined,
		};
	}

	/** Parse grok `updatedAt`; invalid/missing → undefined (callers use 0, never Date.now()). */
	private _parseUpdatedAtMs(updatedAt: string | null | undefined): number | undefined {
		if (!updatedAt) {
			return undefined;
		}
		const parsed = Date.parse(updatedAt);
		return Number.isFinite(parsed) ? parsed : undefined;
	}

	private _listedUpdatedAtMs(sessionId: string): number | undefined {
		return this._parseUpdatedAtMs(this._listedSessions.get(sessionId)?.updatedAt);
	}

	/**
	 * List/discovery recency. While a pre-load override is active, clamp to
	 * `min(recorded, grok updatedAt)` so grok's load bump does not resurface the row.
	 */
	private _effectiveListedModifiedTime(session: AcpSessionInfo): number {
		const grokMs = this._parseUpdatedAtMs(session.updatedAt);
		const preLoadMs = this._preLoadUpdatedAt.get(session.sessionId);
		if (preLoadMs !== undefined && grokMs !== undefined) {
			return Math.min(preLoadMs, grokMs);
		}
		if (preLoadMs !== undefined) {
			return preLoadMs;
		}
		if (grokMs !== undefined) {
			return grokMs;
		}
		return 0;
	}

	/** Snapshot list `updatedAt` before session/load or resume bumps it on grok. */
	private _capturePreLoadUpdatedAt(sessionId: string): void {
		const listedMs = this._listedUpdatedAtMs(sessionId);
		if (listedMs !== undefined) {
			this._preLoadUpdatedAt.set(sessionId, listedMs);
		}
	}

	private _clearPreLoadUpdatedAt(sessionId: string): void {
		this._preLoadUpdatedAt.delete(sessionId);
	}

	/** Apply a captured pre-load time onto a restore backing that still has none. */
	private _applyPreLoadModifiedTime(backing: IGrokBuildChatBacking): void {
		const captured = this._preLoadUpdatedAt.get(backing.sessionId);
		if (captured === undefined) {
			return;
		}
		if (backing.modifiedTime <= 0) {
			backing.modifiedTime = captured;
		}
	}

	private async _createChat(chat: URI, context: URI | IAgentChatContext, options?: IAgentCreateChatOptions): Promise<IAgentCreateChatResult | void> {
		resolveAgentChatContext(context, chat);
		const client = await this._ensureConnection();
		const requestedDirectories = options?.workingDirectories;
		const cwd = requestedDirectories?.[0]?.fsPath ?? process.cwd();
		const workingDirectories = requestedDirectories && requestedDirectories.length > 0 ? requestedDirectories : [URI.file(cwd)];

		const createMcp = await this._startClientMcpForChat(chat);
		let sessionNew;
		try {
			sessionNew = await client.request('session/new', {
				cwd,
				mcpServers: createMcp ? [createMcp.toAcpMcpServer()] : [],
			});
		} catch (err) {
			createMcp?.dispose();
			rethrowAcpFailure(err);
		}

		this._rememberReasoningOption(readReasoningEffortOption(sessionNew.configOptions));
		this._publishModels(sessionNew.models);
		const cliCurrentModelId = typeof sessionNew.models?.currentModelId === 'string' && sessionNew.models.currentModelId.length > 0
			? sessionNew.models.currentModelId
			: undefined;

		let model = options?.model;
		const createModelId = options?.model?.id ?? cliCurrentModelId;
		const createContext = createModelId
			? this._resolveContextWindowForSetModel(options?.model, createModelId, undefined)
			: undefined;
		const needsSetModel = !!options?.model?.id || createContext?.changed === true;
		let setModelApplied = false;
		if (needsSetModel && createModelId) {
			try {
				await client.request('session/set_model', this._setModelParams(sessionNew.sessionId, createModelId, createContext));
				setModelApplied = true;
			} catch (err) {
				const formatted = formatAcpError(err);
				this._logService.warn(`[GrokBuild] session/set_model failed; keeping the CLI default model: ${grokLogSummary(formatted.message)}`);
				const current = sessionNew.models?.currentModelId;
				model = current ? { id: current } : undefined;
			}
		}
		const requestedEffort = thinkingLevelOf(options?.model);
		let reasoningEffort = requestedEffort ?? this._reasoningOption?.currentValue;
		if (requestedEffort) {
			try {
				await client.request('session/set_config_option', {
					sessionId: sessionNew.sessionId,
					configId: GROK_REASONING_CONFIG_ID,
					value: requestedEffort,
				});
			} catch (err) {
				const formatted = formatAcpError(err);
				this._logService.warn(`[GrokBuild] session/set_config_option failed; keeping grok's reasoning effort: ${grokLogSummary(formatted.message)}`);
				reasoningEffort = this._reasoningOption?.currentValue;
			}
		}

		const createdAt = Date.now();
		const backing = this._storeBacking(
			chat,
			{ sessionId: sessionNew.sessionId, model: modelWithThinkingLevel(model, reasoningEffort), reasoningEffort },
			workingDirectories,
			{ startTime: createdAt, modifiedTime: createdAt },
		);
		backing.cliCurrentModelId = cliCurrentModelId;
		this._attachClientMcpServer(backing, createMcp);
		if (setModelApplied && createModelId && model?.id === createModelId && createContext && !createContext.ignored) {
			this._applyContextWindowSelection(backing, createModelId, createContext.effective);
		}
		this._rememberOwner(backing, context);
		this._setLoadedGeneration(backing, this._connectionGeneration);
		const modeId = modeIdForSessionMode(options?.config?.[SessionConfigKey.Mode]);
		if (modeId) {
			await this._applySessionMode(backing, modeId, false);
		}
		const providerData = this._persistProviderData(backing);
		const result: IAgentCreateChatResult = {
			providerData,
			project: options?.project,
			resolvedWorkingDirectory: workingDirectories[0],
		};

		this._onDidMaterializeChat.fire({
			chat,
			result,
			workingDirectories,
			project: options?.project,
		});
		this._emitProviderDataChange(chat, backing);
		return result;
	}

	private async _sendMessage(
		chat: URI,
		prompt: string,
		workingDirectoriesOrDirectory: readonly URI[] | URI | undefined,
		turnId: string | undefined,
		context: URI | IAgentChatContext | undefined,
	): Promise<void> {
		if (context) {
			resolveAgentChatContext(context, chat);
		}
		const backing = this._requireBacking(chat);
		const rejectedSlashCommand = rejectedGrokSlashCommand(prompt, backing.commands);
		if (rejectedSlashCommand) {
			throw rejectedSlashCommand;
		}
		this._rememberOwner(backing, context);
		const workingDirectories = this._resolveWorkingDirectories(workingDirectoriesOrDirectory);
		if (workingDirectories && workingDirectories.length > 0) {
			const next = workingDirectories[0];
			const previous = backing.workingDirectories?.[0];
			if (previous && !extUri.isEqual(previous, next)) {
				this._logService.trace(`[GrokBuild] ignoring working directory ${next.fsPath}; keeping session cwd ${previous.fsPath}`);
			}
		}
		await this._ensureSessionAttached(backing);
		await this._ensurePlanModeForPrompt(backing);
		const client = this._connection?.client;
		if (!client) {
			throw grokCliMissingError();
		}
		const turn = turnId ?? generateUuid();

		backing.activeTurnId = turn;
		backing.mapState = this._createMapState(backing, turn);
		backing.pendingGrokClientToolCalls.length = 0;
		backing.approvedClientCalls.clear();
		backing.turnAssistantMarkdown = '';
		backing.turnUserText = prompt;

		for (const action of mapTurnStarted(turn, prompt)) {
			this._fireAction(chat, action);
		}

		try {
			const result = await client.request('session/prompt', {
				sessionId: backing.sessionId,
				prompt: [{ type: 'text', text: prompt }],
			});
			const promptMeta = result._meta;
			const modelId = backing.model?.id ?? this._models.get()[0]?.id;
			const usage = toGrokUsageInfo(promptMeta, modelId);
			for (const action of mapUsage(turn, promptMeta, modelId)) {
				this._fireAction(chat, action);
			}
			this._noteTotalTokens(backing, promptMeta);
			for (const action of mapTurnCompleted(turn, result.stopReason)) {
				this._fireAction(chat, action);
			}
			// The prompt result means grok recorded the turn. Number it only then,
			// unless an update already carried grok's own promptIndex.
			this._notePromptAccepted(backing, promptMeta);
			this._finalizeTurn(backing, turn, result.stopReason === 'cancelled' ? TurnState.Cancelled : TurnState.Complete, usage);
			// Turn end: refresh the context bar (messagesLength and latest totalTokens).
			this._publishContextUsage(backing);
			this._emitProviderDataChange(chat, backing);
		} catch (err) {
			// A dead grok process records the turn before this rejection is delivered.
			// agentSideEffects maps a rejected sendMessage; do not also fire ChatError.
			if (isGrokAuthError(err)) {
				throw grokNotLoggedInError();
			}
			const recorded = backing.turns.find(record => record.id === turn)?.errorMessage;
			if (recorded) {
				throw new Error(recorded);
			}
			// The process is still alive, so grok did not accept the prompt.
			// Leave promptIndex unset and let the next session/load adopt grok's index.
			if (this._connection?.client) {
				backing.turnPromptIndex = undefined;
				const formatted = formatAcpError(err);
				this._finalizeTurn(backing, turn, TurnState.Error, undefined, formatted.message);
				throw formatted;
			}
			rethrowAcpFailure(err);
		} finally {
			// Grok may finish the ask/plan card (timeout, decline text) without
			// waiting for our ACP reply. Drop leftover UI without writing late results.
			this._abandonPendingInteractiveRequestsForChat(chat, { cancelToolCards: true });
			this._rejectPendingClientToolCalls(backing);
			backing.activeTurnId = undefined;
			backing.mapState = undefined;
			backing.turnAssistantMarkdown = undefined;
			backing.turnUserText = undefined;
			backing.turnPromptIndex = undefined;
		}
	}

	private async _abort(chat: URI): Promise<void> {
		const backing = this._backings.get(chatKey(chat));
		if (!backing) {
			return;
		}
		this._cancelPendingPermissionsForChat(chat);
		this._rejectPendingClientToolCalls(backing);
		const client = this._connection?.client;
		if (!client || backing.loadedGeneration !== this._connectionGeneration) {
			return;
		}
		try {
			client.notify('session/cancel', { sessionId: backing.sessionId });
		} catch (err) {
			this._logService.trace(`[GrokBuild] session/cancel failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	private async _changeModel(chat: URI, model: ModelSelection): Promise<void> {
		const backing = this._requireBacking(chat);
		await this._ensureSessionAttached(backing);
		const client = this._connection?.client;
		if (!client) {
			throw grokCliMissingError();
		}
		const sameModel = backing.model?.id === model.id;
		const context = this._resolveContextWindowForSetModel(
			model,
			model.id,
			sameModel ? backing.contextWindowOverride : undefined,
		);
		try {
			await client.request('session/set_model', this._setModelParams(backing.sessionId, model.id, context));
		} catch (err) {
			rethrowAcpFailure(err);
		}
		const requestedEffort = thinkingLevelOf(model);
		if (requestedEffort && requestedEffort !== backing.reasoningEffort) {
			try {
				await client.request('session/set_config_option', {
					sessionId: backing.sessionId,
					configId: GROK_REASONING_CONFIG_ID,
					value: requestedEffort,
				});
			} catch (err) {
				rethrowAcpFailure(err);
			}
			backing.reasoningEffort = requestedEffort;
		}
		const effort = backing.reasoningEffort;
		backing.model = modelWithThinkingLevel(model, effort);
		if (!context.ignored) {
			this._applyContextWindowSelection(backing, model.id, context.effective);
		} else if (!sameModel) {
			// Switching models without a supported contextSize clears any prior override.
			backing.contextWindowOverride = undefined;
		}
		this._emitProviderDataChange(chat, backing);
		this._publishContextUsage(backing);
	}

	/**
	 * Drop the in-memory chat. When `sessionCapabilities.close` was advertised,
	 * also `session/close`. The durable session id stays in host providerData;
	 * this does not delete the grok-side transcript.
	 */
	private async _disposeChat(chat: URI): Promise<void> {
		const key = chatKey(chat);
		const backing = this._backings.get(key);
		if (!backing) {
			return;
		}
		this._cancelPendingPermissionsForChat(chat);
		this._disposeClientMcp(backing);
		await this._closeSessionIfAdvertised(backing);
		this._clearPreLoadUpdatedAt(backing.sessionId);
		this._sessionToChat.delete(backing.sessionId);
		this._backings.delete(key);
		this._activeClients.delete(key);
	}

	private async _closeSessionIfAdvertised(backing: IGrokBuildChatBacking): Promise<void> {
		if (!this._capabilities.close) {
			return;
		}
		const client = this._connection?.client;
		if (!client || backing.loadedGeneration !== this._connectionGeneration) {
			return;
		}
		try {
			// grok 1.0.70 returns success for a resident session (`x.ai/closeOutcome: closed`)
			// and for an unknown or already-closed session (`notResident`). It does not use -32002.
			await client.request('session/close', { sessionId: backing.sessionId });
		} catch (err) {
			this._logService.trace(`[GrokBuild] session/close failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	private _requireBacking(chat: URI): IGrokBuildChatBacking {
		const backing = this._backings.get(chatKey(chat));
		if (!backing) {
			throw new Error(localize('grokBuild.unknownChat', "This Grok Build chat is not loaded in the agent host."));
		}
		return backing;
	}

	private _resolveWorkingDirectories(workingDirectoriesOrDirectory: readonly URI[] | URI | undefined): readonly URI[] | undefined {
		if (workingDirectoriesOrDirectory === undefined) {
			return undefined;
		}
		if (URI.isUri(workingDirectoriesOrDirectory)) {
			return [workingDirectoriesOrDirectory];
		}
		return workingDirectoriesOrDirectory;
	}

	private _finalizeTurn(backing: IGrokBuildChatBacking, turnId: string, state: TurnState, usage: Turn['usage'], errorMessage?: string): void {
		const userText = backing.turnUserText ?? '';
		const assistantMarkdown = backing.turnAssistantMarkdown ?? '';
		backing.turns.push({
			id: turnId,
			userText,
			assistantMarkdown,
			state,
			usage,
			errorMessage,
			promptIndex: backing.turnPromptIndex,
		});
		// Only a finished user turn advances recency — not restore, model, or title.
		backing.modifiedTime = Date.now();
		this._clearPreLoadUpdatedAt(backing.sessionId);
	}

	/**
	 * Remember grok's `promptIndex` once the prompt is in the session.
	 * A failure before that leaves the index unset, so the next prompt does
	 * not skip a number grok never recorded.
	 */
	private _notePromptAccepted(backing: IGrokBuildChatBacking, meta?: Record<string, unknown>): void {
		const fromGrok = meta?.promptIndex;
		if (typeof fromGrok === 'number' && Number.isFinite(fromGrok)) {
			backing.turnPromptIndex = fromGrok;
			return;
		}
		if (backing.turnPromptIndex === undefined) {
			backing.turnPromptIndex = this._nextPromptIndex(backing);
		}
	}

	private _nextPromptIndex(backing: IGrokBuildChatBacking): number {
		let max = -1;
		for (const turn of backing.turns) {
			if (typeof turn.promptIndex === 'number' && turn.promptIndex > max) {
				max = turn.promptIndex;
			}
		}
		return max >= 0 ? max + 1 : backing.turns.length;
	}

	private _fireAction(chat: URI, action: SessionAction | ChatAction): void {
		this._onDidChatProgress.fire({ kind: 'action', resource: chat, action });
	}

	/** @returns true when `lastTotalTokens` changed (caller may publish). */
	private _noteTotalTokens(backing: IGrokBuildChatBacking, meta: Record<string, unknown> | undefined): boolean {
		const total = readGrokTotalTokens(meta);
		if (total === undefined || total === backing.lastTotalTokens) {
			return false;
		}
		backing.lastTotalTokens = total;
		return true;
	}

	/**
	 * During load replay, apply chunk `_meta.totalTokens` unless a better
	 * same-turn `turn_completed` / compaction gauge already locked chunks out.
	 */
	private _noteReplayChunkTotalTokens(backing: IGrokBuildChatBacking, meta: Record<string, unknown> | undefined): boolean {
		if (backing.replaySuppressChunkTotals) {
			return false;
		}
		return this._noteTotalTokens(backing, meta);
	}

	/** Single-call `turn_completed` gauge during load replay (multi-call ignored). */
	private _noteReplayTurnCompletedTokens(backing: IGrokBuildChatBacking, update: unknown): boolean {
		const total = readGrokTurnCompletedSingleCallTokens(update);
		if (total === undefined || total === backing.lastTotalTokens) {
			return false;
		}
		backing.lastTotalTokens = total;
		backing.replaySuppressChunkTotals = true;
		return true;
	}

	/**
	 * Resolve the context-window size to send on `session/set_model`.
	 * Unsupported sizes are ignored (preserve current). When the model
	 * offers more than one window and the effective size is one of them,
	 * always send `_meta.contextWindow` — including the default 256k.
	 * Omitting `_meta` preserves grok's current window (`Preserve`), so a
	 * switch from 500k → 256k or onto another multi-window model must send
	 * the target size explicitly.
	 */
	private _resolveContextWindowForSetModel(
		model: ModelSelection | undefined,
		modelId: string,
		currentOverride: number | undefined,
	): {
		readonly effective: number | undefined;
		readonly meta: { readonly contextWindow: number } | undefined;
		readonly changed: boolean;
		readonly ignored: boolean;
	} {
		const modelInfo = this._models.get().find(candidate => candidate.id === modelId);
		const prop = modelInfo?.configSchema?.properties?.[ContextSizeConfigKey];
		const offered = prop?.enum;
		const defaultSize = typeof prop?.default === 'number'
			? prop.default
			: (Array.isArray(offered) && typeof offered[0] === 'number' ? offered[0] : undefined);
		const wanted = getModelContextSize(model);
		const supported = wanted !== undefined && Array.isArray(offered) && offered.includes(wanted);
		if (wanted !== undefined && !supported) {
			// Unsupported size — leave grok's window alone.
			const current = currentOverride ?? defaultSize ?? modelInfo?.maxContextWindow;
			return {
				effective: current,
				meta: this._contextWindowMeta(offered, current),
				changed: false,
				ignored: true,
			};
		}
		const effective = supported ? wanted : (currentOverride ?? defaultSize);
		const current = currentOverride ?? defaultSize;
		return {
			effective,
			meta: this._contextWindowMeta(offered, effective),
			changed: effective !== undefined && effective !== current,
			ignored: false,
		};
	}

	/**
	 * `_meta.contextWindow` when the model offers multiple sizes and the
	 * value is one of them (including the default). Otherwise omit `_meta`.
	 */
	private _contextWindowMeta(
		offered: readonly unknown[] | undefined,
		window: number | undefined,
	): { readonly contextWindow: number } | undefined {
		return window !== undefined && Array.isArray(offered) && offered.length > 1 && offered.includes(window)
			? { contextWindow: window }
			: undefined;
	}

	private _setModelParams(
		sessionId: string,
		modelId: string,
		context: { readonly meta: { readonly contextWindow: number } | undefined } | undefined,
	): AcpSessionSetModelParams {
		return context?.meta
			? { sessionId, modelId, _meta: context.meta }
			: { sessionId, modelId };
	}

	/**
	 * Apply a selected window to this chat only: per-session override for
	 * usage `tokenLimit`, and `model.config.contextSize` for the picker.
	 * Does not mutate the shared `_models` list (another chat's choice must
	 * not change published `maxContextWindow`).
	 */
	private _applyContextWindowSelection(backing: IGrokBuildChatBacking, modelId: string, effective: number | undefined): void {
		const modelInfo = this._models.get().find(candidate => candidate.id === modelId);
		const prop = modelInfo?.configSchema?.properties?.[ContextSizeConfigKey];
		const defaultSize = typeof prop?.default === 'number' ? prop.default : undefined;
		const offered = prop?.enum;
		backing.contextWindowOverride = effective !== undefined && defaultSize !== undefined && effective !== defaultSize
			? effective
			: undefined;
		if (effective !== undefined && Array.isArray(offered) && offered.includes(effective)) {
			backing.model = modelWithContextSize(backing.model ?? { id: modelId }, effective);
		}
	}

	/**
	 * Restore the chat's window from the current model entry after load/resume
	 * (`models.availableModels[i]._meta.contextWindow`). Result `_meta` does
	 * not carry this on live grok 1.0.70.
	 */
	private _applyRestoredContextWindow(backing: IGrokBuildChatBacking, models: AcpModelState | undefined): void {
		const window = readGrokCurrentModelContextWindow(models);
		const modelId = backing.model?.id
			?? (typeof models?.currentModelId === 'string' && models.currentModelId.length > 0 ? models.currentModelId : undefined)
			?? backing.cliCurrentModelId;
		if (window !== undefined && modelId) {
			this._applyContextWindowSelection(backing, modelId, window);
		}
	}

	/**
	 * `model_changed.context_window_selection` for this chat. During load
	 * replay the shared model list may not be published yet, so stash the
	 * raw selection (override + contextSize) without publishing usage.
	 */
	private _noteModelChangedContextWindow(backing: IGrokBuildChatBacking, params: unknown, publishUsage: boolean): void {
		const modelWindow = readGrokModelChangedContextWindow(params);
		if (!modelWindow) {
			return;
		}
		const modelId = backing.model?.id ?? backing.cliCurrentModelId;
		const modelInfo = modelId ? this._models.get().find(candidate => candidate.id === modelId) : undefined;
		const hasSchema = Array.isArray(modelInfo?.configSchema?.properties?.[ContextSizeConfigKey]?.enum);
		if (hasSchema) {
			// Absent / null selection means the model default — clear the override.
			const effective = modelWindow.selection ?? this._defaultContextWindow(modelId);
			const previous = backing.contextWindowOverride ?? this._defaultContextWindow(modelId);
			if (effective !== previous || getModelContextSize(backing.model) !== effective) {
				if (modelId && effective !== undefined) {
					this._applyContextWindowSelection(backing, modelId, effective);
				} else {
					backing.contextWindowOverride = undefined;
				}
				if (publishUsage) {
					this._publishContextUsage(backing);
				}
			}
			return;
		}
		// Replay before session/load publishes models: keep the raw selection.
		if (modelWindow.selection !== undefined) {
			backing.contextWindowOverride = modelWindow.selection;
			if (modelId) {
				backing.model = modelWithContextSize(backing.model ?? { id: modelId }, modelWindow.selection);
			}
		} else {
			backing.contextWindowOverride = undefined;
		}
	}

	private _defaultContextWindow(modelId: string | undefined): number | undefined {
		if (!modelId) {
			return undefined;
		}
		const modelInfo = this._models.get().find(candidate => candidate.id === modelId);
		const prop = modelInfo?.configSchema?.properties?.[ContextSizeConfigKey];
		if (typeof prop?.default === 'number') {
			return prop.default;
		}
		const offered = prop?.enum;
		if (Array.isArray(offered) && typeof offered[0] === 'number') {
			return offered[0];
		}
		return modelInfo?.maxContextWindow;
	}

	private _tokenLimitFor(backing: IGrokBuildChatBacking): number | undefined {
		if (backing.contextWindowOverride !== undefined) {
			return backing.contextWindowOverride;
		}
		const selection = modelForTurnRecords(backing);
		const fromConfig = getModelContextSize(selection);
		if (fromConfig !== undefined) {
			return fromConfig;
		}
		const models = this._models.get();
		const id = selection?.id;
		const match = id ? models.find(model => model.id === id) : undefined;
		return match?.maxContextWindow ?? models.find(model => model.maxContextWindow !== undefined)?.maxContextWindow;
	}

	private _contextUsageFor(backing: IGrokBuildChatBacking): IGrokContextUsageInfo | undefined {
		const tokenLimit = this._tokenLimitFor(backing);
		const currentTokens = backing.lastTotalTokens;
		if (tokenLimit === undefined || currentTokens === undefined) {
			return undefined;
		}
		return {
			currentTokens,
			tokenLimit,
			messagesLength: backing.turns.length,
		};
	}

	private _metadataFromBacking(backing: IGrokBuildChatBacking): IAgentChatMetadata {
		const usage = this._contextUsageFor(backing);
		return {
			chat: backing.chat,
			startTime: backing.startTime,
			modifiedTime: backing.modifiedTime,
			summary: backing.summary,
			model: modelForTurnRecords(backing),
			workingDirectories: backing.workingDirectories,
			...(usage ? { _meta: { [GROK_COPILOT_USAGE_INFO_KEY]: usage } } : {}),
		};
	}

	/**
	 * Publishes `_meta['copilot.usageInfo']` for the chat context bar.
	 * Merges with existing session `_meta` keys. No-ops when tokenLimit is
	 * unknown, currentTokens is unset, the payload is unchanged, or the host
	 * session state does not exist yet (restore publishes via getChatMetadata
	 * `_meta` instead — recording publishedContextUsage here would stick dedupe).
	 */
	private _publishContextUsage(backing: IGrokBuildChatBacking): void {
		const owner = backing.ownerRef?.get();
		if (!owner) {
			return;
		}
		const usage = this._contextUsageFor(backing);
		if (!usage) {
			return;
		}
		if (equals(backing.publishedContextUsage, usage)) {
			return;
		}
		// Protocol URI keys are strings; a URI object never hits the session map.
		const existingState = this._stateManager.getSessionState(owner.toString());
		if (!existingState) {
			return;
		}
		const nextMeta = withGrokContextUsage(existingState._meta, usage);
		backing.publishedContextUsage = usage;
		this._onDidChatProgress.fire({
			kind: 'action',
			resource: owner,
			action: { type: ActionType.SessionMetaChanged, _meta: nextMeta },
		});
	}

	private _cancelPendingPermissionsForChat(chat: URI): void {
		for (const [toolCallId, pending] of this._pendingPermissions) {
			if (!URI.isUri(pending.chat) || pending.chat.toString() !== chat.toString()) {
				continue;
			}
			pending.resolve({ result: { outcome: { outcome: 'cancelled' } } });
			this._pendingPermissions.delete(toolCallId);
		}
		this._cancelPendingPlanReviewsForChat(chat);
		this._cancelPendingAskUserQuestionsForChat(chat);
		this._cancelPendingClientToolApprovalsForChat(chat);
	}

	private _cancelAllPendingPermissions(): void {
		for (const [toolCallId, pending] of this._pendingPermissions) {
			pending.resolve({ result: { outcome: { outcome: 'cancelled' } } });
			this._pendingPermissions.delete(toolCallId);
		}
		this._cancelAllPendingPlanReviews();
		this._cancelAllPendingAskUserQuestions();
		this._cancelAllPendingClientToolApprovals();
	}

	private _cancelPendingPlanReviewsForChat(chat: URI): void {
		for (const [requestId, pending] of [...this._pendingPlanReviews]) {
			if (pending.chat.toString() !== chat.toString()) {
				continue;
			}
			this._dismissPlanReview(requestId, pending, { result: { outcome: 'revise' } });
		}
	}

	private _cancelAllPendingPlanReviews(): void {
		for (const [requestId, pending] of [...this._pendingPlanReviews]) {
			this._dismissPlanReview(requestId, pending, { result: { outcome: 'revise' } });
		}
	}

	private _cancelPendingAskUserQuestionsForChat(chat: URI): void {
		for (const [requestId, pending] of [...this._pendingAskUserQuestions]) {
			if (pending.chat.toString() !== chat.toString()) {
				continue;
			}
			this._dismissAskUserQuestion(requestId, pending, { result: { outcome: 'cancelled' } });
		}
	}

	private _cancelAllPendingAskUserQuestions(): void {
		for (const [requestId, pending] of [...this._pendingAskUserQuestions]) {
			this._dismissAskUserQuestion(requestId, pending, { result: { outcome: 'cancelled' } });
		}
	}

	/**
	 * Drop parked ask / plan-review UIs for a chat without writing ACP replies.
	 * Used when grok already finished the tool (timeout) or the turn ended.
	 */
	private _abandonPendingInteractiveRequestsForChat(chat: URI, options?: { readonly cancelToolCards?: boolean }): void {
		const chatKeyStr = chat.toString();
		for (const [requestId, pending] of [...this._pendingAskUserQuestions]) {
			if (pending.chat.toString() !== chatKeyStr) {
				continue;
			}
			this._abandonAskUserQuestion(requestId, pending, options?.cancelToolCards !== false);
		}
		for (const [requestId, pending] of [...this._pendingPlanReviews]) {
			if (pending.chat.toString() !== chatKeyStr) {
				continue;
			}
			this._abandonPlanReview(requestId, pending, options?.cancelToolCards !== false);
		}
		for (const [requestId, pending] of [...this._pendingClientToolApprovals]) {
			if (pending.chat.toString() !== chatKeyStr) {
				continue;
			}
			this._abandonClientToolApproval(requestId, pending);
		}
	}

	/**
	 * When grok completes/fails a tool card that still has a parked agent→client
	 * request, drop the ChatInput UI without sending a late ACP reply.
	 */
	private _abandonPendingInteractiveForToolCall(sessionId: string, toolCallId: string | undefined): void {
		if (!toolCallId) {
			return;
		}
		for (const [requestId, pending] of [...this._pendingAskUserQuestions]) {
			if (pending.sessionId !== sessionId || pending.toolCallId !== toolCallId) {
				continue;
			}
			this._abandonAskUserQuestion(requestId, pending, false);
		}
		for (const [requestId, pending] of [...this._pendingPlanReviews]) {
			if (pending.sessionId !== sessionId || pending.toolCallId !== toolCallId) {
				continue;
			}
			this._abandonPlanReview(requestId, pending, false);
		}
		for (const [requestId, pending] of [...this._pendingClientToolApprovals]) {
			if (pending.sessionId !== sessionId || pending.toolCallId !== toolCallId) {
				continue;
			}
			this._abandonClientToolApproval(requestId, pending);
		}
	}

	/**
	 * Resolve a parked plan review without approving, dismiss the review UI, and
	 * mark the exit_plan_mode tool card cancelled (grok sends no update for it).
	 */
	private _dismissPlanReview(
		requestId: string,
		pending: IPendingPlanReview,
		result: AcpServerRequestHandlerResult<AcpExitPlanModeResult>,
	): void {
		if (!this._pendingPlanReviews.has(requestId)) {
			return;
		}
		this._pendingPlanReviews.delete(requestId);
		this._sessionsExitingPlanMode.delete(pending.sessionId);
		pending.resolve(result);
		this._fireAction(pending.chat, {
			type: ActionType.ChatInputCompleted,
			requestId,
			response: ChatInputResponseKind.Cancel,
		});
		const backing = this._backings.get(chatKey(pending.chat));
		if (backing?.mapState) {
			for (const action of mapPendingRequestCancelled(backing.mapState, pending.toolCallId)) {
				this._fireAction(pending.chat, action);
			}
		}
	}

	/**
	 * Drop a parked plan review without an ACP reply (grok already finished the
	 * card or stopped waiting). Intentionally does not call `pending.resolve`.
	 */
	private _abandonPlanReview(requestId: string, pending: IPendingPlanReview, cancelToolCard: boolean): void {
		if (!this._pendingPlanReviews.has(requestId)) {
			return;
		}
		this._pendingPlanReviews.delete(requestId);
		this._sessionsExitingPlanMode.delete(pending.sessionId);
		this._fireAction(pending.chat, {
			type: ActionType.ChatInputCompleted,
			requestId,
			response: ChatInputResponseKind.Cancel,
		});
		if (!cancelToolCard) {
			return;
		}
		const backing = this._backings.get(chatKey(pending.chat));
		if (backing?.mapState) {
			for (const action of mapPendingRequestCancelled(backing.mapState, pending.toolCallId)) {
				this._fireAction(pending.chat, action);
			}
		}
	}

	private _completePlanReview(requestId: string, result: AcpServerRequestHandlerResult<AcpExitPlanModeResult>): void {
		const pending = this._pendingPlanReviews.get(requestId);
		if (!pending) {
			return;
		}
		this._pendingPlanReviews.delete(requestId);
		const outcome = result.result?.outcome;
		if (outcome === 'approved' || outcome === 'abandoned') {
			this._sessionsExitingPlanMode.add(pending.sessionId);
		} else {
			this._sessionsExitingPlanMode.delete(pending.sessionId);
		}
		pending.resolve(result);
	}

	/**
	 * Resolve a parked ask-user prompt without accepting, dismiss the input UI,
	 * and mark the ask_user_question tool card cancelled (grok sends no update).
	 */
	private _dismissAskUserQuestion(
		requestId: string,
		pending: IPendingAskUserQuestion,
		result: AcpServerRequestHandlerResult<AcpAskUserQuestionResult>,
	): void {
		if (!this._pendingAskUserQuestions.has(requestId)) {
			return;
		}
		this._pendingAskUserQuestions.delete(requestId);
		pending.resolve(result);
		this._fireAction(pending.chat, {
			type: ActionType.ChatInputCompleted,
			requestId,
			response: ChatInputResponseKind.Cancel,
		});
		const backing = this._backings.get(chatKey(pending.chat));
		if (backing?.mapState) {
			for (const action of mapPendingRequestCancelled(backing.mapState, pending.toolCallId)) {
				this._fireAction(pending.chat, action);
			}
		}
	}

	/**
	 * Drop a parked ask without an ACP reply (timeout / turn end). Intentionally
	 * does not call `pending.resolve` so AcpClient writes nothing.
	 */
	private _abandonAskUserQuestion(requestId: string, pending: IPendingAskUserQuestion, cancelToolCard: boolean): void {
		if (!this._pendingAskUserQuestions.has(requestId)) {
			return;
		}
		this._pendingAskUserQuestions.delete(requestId);
		this._fireAction(pending.chat, {
			type: ActionType.ChatInputCompleted,
			requestId,
			response: ChatInputResponseKind.Cancel,
		});
		if (!cancelToolCard) {
			return;
		}
		const backing = this._backings.get(chatKey(pending.chat));
		if (backing?.mapState) {
			for (const action of mapPendingRequestCancelled(backing.mapState, pending.toolCallId)) {
				this._fireAction(pending.chat, action);
			}
		}
	}

	private _completeAskUserQuestion(requestId: string, result: AcpServerRequestHandlerResult<AcpAskUserQuestionResult>): void {
		const pending = this._pendingAskUserQuestions.get(requestId);
		if (!pending) {
			return;
		}
		this._pendingAskUserQuestions.delete(requestId);
		pending.resolve(result);
	}

	private _cancelPendingClientToolApprovalsForChat(chat: URI): void {
		for (const [requestId, pending] of [...this._pendingClientToolApprovals]) {
			if (pending.chat.toString() !== chat.toString()) {
				continue;
			}
			this._abandonClientToolApproval(requestId, pending);
		}
	}

	private _cancelAllPendingClientToolApprovals(): void {
		for (const [requestId, pending] of [...this._pendingClientToolApprovals]) {
			this._abandonClientToolApproval(requestId, pending);
		}
	}

	/**
	 * Drop a parked client-tool approval ChatInput. Still resolves the waiter
	 * as cancelled so MCP / permission promises do not hang.
	 */
	private _abandonClientToolApproval(requestId: string, pending: IPendingClientToolApproval): void {
		if (!this._pendingClientToolApprovals.has(requestId)) {
			return;
		}
		this._pendingClientToolApprovals.delete(requestId);
		pending.resolve('cancelled');
		this._fireAction(pending.chat, {
			type: ActionType.ChatInputCompleted,
			requestId,
			response: ChatInputResponseKind.Cancel,
		});
		const backing = this._backings.get(chatKey(pending.chat));
		if (backing?.mapState) {
			markGrokClientToolCancelledBeforeStart(backing.mapState, pending.toolCallId);
		}
	}

	private _completeClientToolApproval(requestId: string, outcome: GrokClientToolApprovalOutcome): void {
		const pending = this._pendingClientToolApprovals.get(requestId);
		if (!pending) {
			return;
		}
		this._pendingClientToolApprovals.delete(requestId);
		if (outcome === 'allow') {
			const backing = this._backings.get(chatKey(pending.chat));
			backing?.approvedClientCalls.set(pending.toolCallId, pending.args);
		} else if (outcome === 'cancelled') {
			const backing = this._backings.get(chatKey(pending.chat));
			if (backing?.mapState) {
				markGrokClientToolCancelledBeforeStart(backing.mapState, pending.toolCallId);
			}
		}
		pending.resolve(outcome);
	}

	/** Close a parked approval for this chat+toolCallId (e.g. MCP request aborted). */
	private _abandonClientToolApprovalForCall(chat: URI, toolCallId: string): void {
		const chatKeyStr = chat.toString();
		for (const [requestId, pending] of [...this._pendingClientToolApprovals]) {
			if (pending.chat.toString() !== chatKeyStr || pending.toolCallId !== toolCallId) {
				continue;
			}
			this._abandonClientToolApproval(requestId, pending);
		}
	}

	private _resolveClientToolApproval(
		response: ChatInputResponseKind,
		answers?: Record<string, ChatInputAnswer>,
	): GrokClientToolApprovalOutcome {
		if (response !== ChatInputResponseKind.Accept) {
			return 'cancelled';
		}
		const answer = answers?.[GROK_CLIENT_TOOL_APPROVAL_QUESTION_ID];
		if (!answer || answer.state === ChatInputAnswerState.Skipped) {
			return 'cancelled';
		}
		const value = answer.value;
		if (value.kind !== ChatInputAnswerValueKind.Selected) {
			return 'cancelled';
		}
		if (value.value === GROK_CLIENT_TOOL_ALLOW_ONCE_OPTION_ID) {
			return 'allow';
		}
		if (value.value === GROK_CLIENT_TOOL_REJECT_OPTION_ID) {
			return 'reject';
		}
		return 'cancelled';
	}

	/**
	 * Ask Allow once / Reject for a client tool. Used for grok
	 * `session/request_permission` and for the MCP auto-allow gate.
	 */
	private _requestClientToolApproval(
		chat: URI,
		sessionId: string | undefined,
		toolCallId: string,
		toolName: string,
		args: Record<string, unknown>,
	): Promise<GrokClientToolApprovalOutcome> {
		const requestId = generateUuid();
		const safeName = appendEscapedMarkdownInlineCode(toolName);
		const inputRequest = {
			id: requestId,
			message: formatGrokClientToolApprovalMessage(toolName, args),
			questions: [{
				kind: ChatInputQuestionKind.SingleSelect as const,
				id: GROK_CLIENT_TOOL_APPROVAL_QUESTION_ID,
				title: localize('grokBuild.clientTool.approval.title', "Client tool"),
				message: localize(
					'grokBuild.clientTool.approval.question',
					"Run {0}?",
					safeName,
				),
				required: true,
				allowFreeformInput: false,
				options: [
					{
						id: GROK_CLIENT_TOOL_ALLOW_ONCE_OPTION_ID,
						label: localize('grokBuild.clientTool.approval.allowOnce', "Allow once"),
						recommended: true,
					},
					{
						id: GROK_CLIENT_TOOL_REJECT_OPTION_ID,
						label: localize('grokBuild.clientTool.approval.reject', "Reject"),
					},
				],
			}],
		};
		return new Promise<GrokClientToolApprovalOutcome>(resolve => {
			this._pendingClientToolApprovals.set(requestId, {
				chat,
				sessionId,
				toolCallId,
				args,
				resolve,
			});
			this._fireAction(chat, {
				type: ActionType.ChatInputRequested,
				request: inputRequest,
			});
		});
	}

	/**
	 * Maps a chat-input response to `_x.ai/ask_user_question` outcome.
	 * Decline / cancel → `cancelled`. Accept with the skip control →
	 * `skip_interview`. Accept with answers → `accepted` keyed by question text.
	 * Accept with no answers → `skip_interview`. Never emits `chat_about_this`.
	 */
	private _resolveAskUserQuestion(
		pending: IPendingAskUserQuestion,
		response: ChatInputResponseKind,
		answers?: Record<string, ChatInputAnswer>,
	): AcpAskUserQuestionResult {
		if (response !== ChatInputResponseKind.Accept) {
			return { outcome: 'cancelled' };
		}
		const skipAnswer = answers?.[GROK_ASK_USER_SKIP_QUESTION_ID];
		if (skipAnswer && skipAnswer.state !== ChatInputAnswerState.Skipped) {
			const skipValue = skipAnswer.value;
			if (skipValue.kind === ChatInputAnswerValueKind.Selected && skipValue.value === GROK_ASK_USER_SKIP_OPTION_ID) {
				return { outcome: 'skip_interview' };
			}
			if (skipValue.kind === ChatInputAnswerValueKind.Boolean && skipValue.value) {
				return { outcome: 'skip_interview' };
			}
		}
		const accepted: Record<string, string | string[]> = {};
		for (let index = 0; index < pending.questions.length; index++) {
			const question = pending.questions[index];
			const mapped = askUserAnswerFromChatInput(answers?.[askUserQuestionId(index)], question.multiSelect === true);
			if (mapped !== undefined) {
				accepted[question.question] = mapped;
			}
		}
		if (Object.keys(accepted).length === 0) {
			return { outcome: 'skip_interview' };
		}
		return { outcome: 'accepted', answers: accepted };
	}

	/**
	 * Maps a plan-review input response to `_x.ai/exit_plan_mode` outcome.
	 * Never defaults to `approved`: decline / skip / cancel / unknown → `revise`.
	 */
	private _resolveExitPlanMode(
		pending: IPendingPlanReview,
		response: ChatInputResponseKind,
		answers?: Record<string, ChatInputAnswer>,
	): AcpExitPlanModeResult {
		if (response !== ChatInputResponseKind.Accept) {
			return { outcome: 'revise' };
		}
		const answer = answers?.[pending.questionId];
		if (!answer || answer.state === ChatInputAnswerState.Skipped) {
			return { outcome: 'revise' };
		}
		const value = answer.value;
		let actionId: string | undefined;
		let feedback: string | undefined;
		if (value.kind === ChatInputAnswerValueKind.Selected) {
			actionId = value.value;
			feedback = value.freeformValues?.find(s => s.trim().length > 0)?.trim();
		} else if (value.kind === ChatInputAnswerValueKind.Text) {
			feedback = value.value.trim() || undefined;
		} else {
			return { outcome: 'revise' };
		}
		if (feedback) {
			return { outcome: 'revise', feedback };
		}
		if (actionId === GROK_PLAN_REVIEW_APPROVE_ID) {
			return { outcome: 'approved' };
		}
		if (actionId === GROK_PLAN_REVIEW_ABANDON_ID) {
			return { outcome: 'abandoned' };
		}
		return { outcome: 'revise' };
	}

	private _failActiveTurns(error: Error): void {
		for (const backing of this._backings.values()) {
			this._rejectPendingClientToolCalls(backing);
			const turnId = backing.activeTurnId;
			if (!turnId || backing.turns.some(record => record.id === turnId)) {
				continue;
			}
			this._finalizeTurn(backing, turnId, TurnState.Error, undefined, error.message);
			backing.activeTurnId = undefined;
			backing.mapState = undefined;
			backing.turnAssistantMarkdown = undefined;
			backing.turnUserText = undefined;
			backing.turnPromptIndex = undefined;
		}
	}

	private _invalidateLoadedSessions(): void {
		for (const backing of this._backings.values()) {
			this._setLoadedGeneration(backing, undefined);
		}
	}

	/** A new grok process does not keep the previous process's mode. */
	private _setLoadedGeneration(backing: IGrokBuildChatBacking, generation: number | undefined): void {
		if (backing.loadedGeneration === generation) {
			return;
		}
		backing.loadedGeneration = generation;
		backing.appliedModeId = undefined;
	}

	private _ensureSessionAttached(backing: IGrokBuildChatBacking): Promise<void> {
		if (backing.loadedGeneration === this._connectionGeneration && this._connection?.client) {
			return Promise.resolve();
		}
		const key = chatKey(backing.chat);
		const inFlight = this._restoreInFlight.get(key);
		if (inFlight) {
			return inFlight;
		}
		const promise = this._restoreSessionAfterConnect(backing).finally(() => {
			if (this._restoreInFlight.get(key) === promise) {
				this._restoreInFlight.delete(key);
			}
		});
		this._restoreInFlight.set(key, promise);
		return promise;
	}

	private async _restoreSessionAfterConnect(backing: IGrokBuildChatBacking): Promise<void> {
		await this._ensureConnection();
		if (backing.loadedGeneration === this._connectionGeneration) {
			return;
		}
		await this._restoreSession(backing);
	}

	/**
	 * Re-attach a persisted session id on the current grok process.
	 * Prefer `session/load` (replays history into `Turn[]`) when
	 * `agentCapabilities.loadSession` is set. Otherwise `session/resume`
	 * when `sessionCapabilities.resume` is advertised (no replay). A session
	 * id from a dead process is never used for `session/prompt` until one of
	 * those succeeds.
	 */
	private async _restoreSession(backing: IGrokBuildChatBacking): Promise<void> {
		const client = this._connection?.client;
		if (!client) {
			throw grokCannotRestoreSessionError();
		}
		const cwd = await this._cwdForLoad(backing);
		// cwd lookup may have filled `_listedSessions`; capture before grok bumps updatedAt.
		this._capturePreLoadUpdatedAt(backing.sessionId);
		this._applyPreLoadModifiedTime(backing);
		if (this._capabilities.loadSession) {
			const replay = createGrokHistoryReplay(backing.sessionId);
			this._historyReplays.set(backing.sessionId, replay);
			try {
				const mcpServers = await this._mcpServersForBacking(backing);
				const result = await client.request('session/load', {
					sessionId: backing.sessionId,
					cwd,
					mcpServers,
				});
				this._rememberReasoningOption(readReasoningEffortOption(result.configOptions));
				this._publishModels(result.models);
				const modelId = result.models?.currentModelId;
				if (typeof modelId === 'string' && modelId.length > 0) {
					// CLI default only — never pin into backing.model / providerData.
					backing.cliCurrentModelId = modelId;
				}
				const history = finishGrokHistoryReplay(replay);
				backing.turns = mergeRestoredTurns(backing.turns, history.turns);
				const listedTitle = await this._titleForRestore(backing.sessionId);
				if (listedTitle) {
					backing.summary = listedTitle;
				} else if (history.title) {
					backing.summary = history.title;
				}
				await this._reapplyReasoningEffort(client, backing);
				this._applyRestoredContextWindow(backing, result.models);
				backing.replaySuppressChunkTotals = undefined;
				// Prefer last replayed gauge (turn_completed / chunk / compaction);
				// otherwise the persisted contextTokens seed. No-ops when the host
				// session state is not created yet — usage rides on getChatMetadata._meta.
				this._publishContextUsage(backing);
			} catch (err) {
				if (isGrokFsNotFound(err)) {
					this._dropBacking(backing.chat, backing.sessionId);
					throw grokSessionMissingError();
				}
				rethrowAcpFailure(err);
			} finally {
				if (this._historyReplays.get(backing.sessionId) === replay) {
					this._historyReplays.delete(backing.sessionId);
				}
			}
		} else if (this._capabilities.resume) {
			try {
				const mcpServers = await this._mcpServersForBacking(backing);
				const result = await client.request('session/resume', {
					sessionId: backing.sessionId,
					cwd,
					mcpServers,
				});
				this._rememberReasoningOption(readReasoningEffortOption(result.configOptions));
				this._publishModels(result.models);
				const resumeModelId = result.models?.currentModelId;
				if (typeof resumeModelId === 'string' && resumeModelId.length > 0) {
					backing.cliCurrentModelId = resumeModelId;
				}
				await this._reapplyReasoningEffort(client, backing);
				this._applyRestoredContextWindow(backing, result.models);
			} catch (err) {
				rethrowAcpFailure(err);
			}
		} else {
			throw grokCannotRestoreSessionError();
		}
		if (!backing.workingDirectories?.length) {
			backing.workingDirectories = [URI.file(cwd)];
		}
		backing.pendingLoadCwd = undefined;
		this._setLoadedGeneration(backing, this._connectionGeneration);
		await this._reapplySessionMode(backing);
	}

	/**
	 * Cwd already stored on the backing wins. A discovered session supplies
	 * one via {@link IGrokBuildChatBacking.pendingLoadCwd} or `session/list`.
	 * Nothing is written onto the backing here: a failed load must not persist
	 * a directory the session was not created with.
	 */
	private async _cwdForLoad(backing: IGrokBuildChatBacking): Promise<string> {
		const existing = backing.workingDirectories?.[0]?.fsPath;
		if (existing) {
			return existing;
		}
		if (backing.pendingLoadCwd) {
			return backing.pendingLoadCwd;
		}
		const listed = await this._lookupListedSession(backing.sessionId);
		const listedCwd = listed?.cwd;
		if (typeof listedCwd === 'string' && listedCwd.length > 0) {
			return listedCwd;
		}
		throw grokSessionMissingError();
	}

	private async _recoverDiscoveredChat(chat: URI, context: URI | IAgentChatContext): Promise<IAgentCreateChatResult> {
		const sessionId = AgentSession.id(resolveAgentChatContext(context, chat).owner.get());
		if (!sessionId) {
			throw grokSessionMissingError();
		}
		const listed = await this._lookupListedSession(sessionId);
		const cwd = typeof listed?.cwd === 'string' && listed.cwd.length > 0 ? listed.cwd : undefined;
		if (!cwd) {
			throw grokSessionMissingError();
		}
		const backing = this._storeBacking(chat, { sessionId }, undefined);
		this._rememberOwner(backing, context);
		backing.pendingLoadCwd = cwd;
		try {
			await this._ensureSessionAttached(backing);
		} catch (err) {
			this._dropBacking(chat, sessionId);
			throw err;
		}
		backing.pendingLoadCwd = undefined;
		const encoded = this._persistProviderData(backing);
		const result: IAgentCreateChatResult = {
			providerData: encoded,
			resolvedWorkingDirectory: backing.workingDirectories?.[0],
		};
		this._onDidMaterializeChat.fire({
			chat,
			result,
			workingDirectories: backing.workingDirectories,
			project: undefined,
		});
		return result;
	}

	private async _lookupListedSession(sessionId: string): Promise<AcpSessionInfo | undefined> {
		const cached = this._listedSessions.get(sessionId);
		if (cached) {
			return cached;
		}
		// Capabilities stay empty until the handshake. A check before connect
		// makes a fresh recoverLegacyChat look like a missing session.
		await this._ensureConnection();
		if (!this._capabilities.list) {
			return undefined;
		}
		await this._listSessionPages(undefined);
		return this._listedSessions.get(sessionId);
	}

	/** Cached `session/list` title, or one lookup when discovery has not run. */
	private async _titleForRestore(sessionId: string): Promise<string | undefined> {
		const cached = this._listedTitle(sessionId);
		if (cached) {
			return cached;
		}
		const listed = await this._lookupListedSession(sessionId);
		const title = listed?.title;
		return typeof title === 'string' && title.trim().length > 0 ? title : undefined;
	}

	private _listedTitle(sessionId: string): string | undefined {
		const title = this._listedSessions.get(sessionId)?.title;
		return typeof title === 'string' && title.trim().length > 0 ? title : undefined;
	}

	private _dropBacking(chat: URI, sessionId: string): void {
		const key = chatKey(chat);
		const backing = this._backings.get(key);
		if (backing) {
			this._disposeClientMcp(backing);
		}
		this._backings.delete(key);
		this._clearPreLoadUpdatedAt(sessionId);
		if (this._sessionToChat.get(sessionId)?.toString() === chat.toString()) {
			this._sessionToChat.delete(sessionId);
		}
	}

	/** One unfiltered `session/list`. grok's cwd filter is an exact match and would hide other folders. */
	private async _discoverSessions(): Promise<readonly AcpSessionInfo[]> {
		await this._ensureConnection();
		if (!this._capabilities.list) {
			return [];
		}
		return this._listSessionPages(undefined);
	}

	private async _listSessionPages(cwd: string | undefined): Promise<readonly AcpSessionInfo[]> {
		const client = this._connection?.client;
		if (!client || !this._capabilities.list) {
			return [];
		}
		const sessions: AcpSessionInfo[] = [];
		const seenIds = new Set<string>();
		const seenCursors = new Set<string>();
		let cursor: string | undefined;
		for (let page = 0; page < GROK_SESSION_LIST_MAX_PAGES; page++) {
			const params: AcpSessionListParams = {
				...(cwd !== undefined ? { cwd } : {}),
				...(cursor !== undefined ? { cursor } : {}),
			};
			let result: AcpSessionListResult;
			try {
				result = await client.request('session/list', params);
			} catch (err) {
				rethrowAcpFailure(err);
			}
			if (result.sessions) {
				for (const session of result.sessions) {
					if (!session?.sessionId) {
						continue;
					}
					this._listedSessions.set(session.sessionId, session);
					if (seenIds.has(session.sessionId)) {
						continue;
					}
					seenIds.add(session.sessionId);
					sessions.push(session);
				}
			}
			const next = result.nextCursor;
			if (next === undefined || next === null) {
				return sessions;
			}
			if (seenCursors.has(next)) {
				this._logService.warn('[GrokBuild] session/list returned a repeated cursor; stopping pagination');
				return sessions;
			}
			seenCursors.add(next);
			cursor = next;
		}
		this._logService.warn(`[GrokBuild] session/list stopped after ${GROK_SESSION_LIST_MAX_PAGES} pages`);
		return sessions;
	}

	private async _emitDiscoveredChats(): Promise<void> {
		const sessions = await this._discoverSessions();
		const discovered: IAgentDiscoveredChat[] = [];
		for (const session of sessions) {
			if (this._sessionToChat.has(session.sessionId)) {
				continue;
			}
			discovered.push({ ...this._toListedChat(session), external: true });
		}
		if (discovered.length > 0) {
			this._onDidDiscoverChats.fire(discovered);
		}
	}

	private async _ensureConnection(): Promise<IAcpClient> {
		if (this._connection?.client) {
			return this._connection.client;
		}
		if (!this._connectionInFlight) {
			this._connectionInFlight = this._connect().finally(() => {
				this._connectionInFlight = undefined;
			});
		}
		return this._connectionInFlight;
	}

	private async _connect(): Promise<IAcpClient> {
		const configuredPath = process.env[AgentHostGrokBuildBinaryPathEnvVar];
		const resolved = await this._resolveBinary(configuredPath);
		if (resolved.versionUnreadable) {
			this._logService.warn(grokUnreadableVersionWarning(resolved.versionOutput));
		}
		const clientName = this._productService.nameShort || 'Code - OSS';
		const clientVersion = this._productService.version || '0.0.0';
		const launch = buildGrokBuildLaunchConfig(resolved.path, process.env, clientName, clientVersion);

		this._logService.info(`[GrokBuild] spawning ACP from ${launch.binaryPath}`);
		this._stderrTail = '';

		const spawned = this._spawn(launch);
		const child = spawned.child;
		const transport = spawned.transport;
		const client = new AcpClient(transport, (level, message) => {
			// Never write an authenticate result. Payloads stay at trace; error/warn stay summary-only.
			const safe = redactGrokAuthenticateText(message);
			if (level === 'error') {
				this._logService.error(`[GrokBuild ACP] ${safe}`);
			} else if (level === 'warn') {
				this._logService.warn(`[GrokBuild ACP] ${safe}`);
			} else {
				this._logService.trace(`[GrokBuild ACP] ${safe}`);
			}
		});

		const store = new DisposableStore();
		store.add(client);
		if (spawned.onDispose) {
			store.add(toDisposable(spawned.onDispose));
		}
		this._wireClient(client, store);
		this._attachChildStreams(child);

		const failConnection = (err: unknown) => {
			this._teardownFailedConnection(client, store, child, this._enrichError(err));
		};

		store.add(client.onExit(e => {
			const exited = grokExitStatusError(e.code, e.signal, this._stderrTail)
				?? grokProcessExitedError(e.code, e.signal, this._stderrTail);
			this._teardownFailedConnection(client, store, child, exited);
		}));
		store.add(client.onTransportError(err => {
			failConnection(err);
		}));

		if (child) {
			child.on('error', (err: Error) => {
				failConnection(grokSpawnFailureError(err) ?? err);
			});
			child.stdin.on('error', (err: Error) => {
				failConnection(grokSpawnFailureError(err) ?? err);
			});
		}

		let capabilities = noGrokCapabilities;
		try {
			const init = await withTimeout(
				client.request('initialize', {
					protocolVersion: ACP_PROTOCOL_VERSION,
					clientCapabilities: {
						fs: { readTextFile: false, writeTextFile: false },
						terminal: false,
					},
					clientInfo: { name: clientName, version: clientVersion },
				}),
				this._handshakeTimeoutMs,
			);
			if (init === undefined) {
				throw grokHandshakeTimeoutError('initialize');
			}
			capabilities = readGrokCapabilities(init.agentCapabilities);
			const initMeta = init._meta;
			this._publishModels(initMeta?.modelState);

			// Do not log the authenticate result — `_meta` includes email / team / tier.
			const auth = await withTimeout(
				client.request('authenticate', { methodId: 'grok.com' }),
				this._handshakeTimeoutMs,
			);
			if (auth === undefined) {
				throw grokHandshakeTimeoutError('authenticate');
			}
		} catch (err) {
			const transportExit = grokExitFromTransportError(err);
			const exitError = transportExit
				? grokExitStatusError(transportExit.code, transportExit.signal, this._stderrTail)
				?? grokProcessExitedError(transportExit.code, transportExit.signal, this._stderrTail)
				: undefined;
			const error = isGrokAuthError(err)
				? new Error(withStderrTail(grokNotLoggedInError().message, this._stderrTail))
				: exitError ?? this._enrichError(err);
			this._teardownFailedConnection(client, store, child, error);
			throw error;
		}

		// Publish only after a successful handshake so concurrent createChat
		// callers await `_connectionInFlight` instead of an un-handshaked client.
		this._capabilities = capabilities;
		this._connectionGeneration++;
		this._connection = { client, child, store };
		return client;
	}

	private _attachChildStreams(child: ChildProcessWithoutNullStreams | undefined): void {
		if (!child?.stderr) {
			return;
		}
		child.stderr.setEncoding('utf8');
		child.stderr.on('data', chunk => {
			const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
			this._stderrTail = redactGrokAuthenticateText(appendStderrTail(this._stderrTail, text));
			const line = redactGrokAuthenticateText(text).trimEnd();
			if (line.length > 0) {
				// Trace is below the default Info level. The error log records only the summary.
				this._logService.trace(`[GrokBuild stderr] ${line}`);
			}
		});
	}

	private _enrichError(err: unknown): Error {
		const base = formatAcpError(err);
		const message = withStderrTail(base.message, this._stderrTail);
		if (message === base.message) {
			return base;
		}
		const enriched = new Error(message);
		enriched.name = base.name;
		return enriched;
	}

	/**
	 * Shared teardown for handshake failure, transport failure, and process exit.
	 * Idempotent: the exit path and the in-flight request rejection both land here.
	 */
	private _teardownFailedConnection(
		client: IAcpClient,
		store: DisposableStore,
		child: ChildProcessWithoutNullStreams | undefined,
		error: Error,
	): void {
		if (this._tornDown.has(client)) {
			return;
		}
		this._tornDown.add(client);
		this._logService.error(`[GrokBuild] ${grokLogSummary(error.message)}`);
		this._failActiveTurns(error);
		this._cancelAllPendingPermissions();
		client.rejectAllPending(error);
		this._invalidateLoadedSessions();
		if (this._connection?.client === client) {
			this._disposeConnection();
			return;
		}
		store.dispose();
		this._killChild(child);
	}

	private _wireClient(client: IAcpClient, store: DisposableStore): void {
		store.add(client.onNotification('session/update', params => {
			this._handleSessionUpdate(params as AcpSessionUpdateParams);
		}));
		store.add(client.onNotification('_x.ai/session_notification', params => {
			this._handleGrokExtensionNotification(params);
		}));
		store.add(client.onNotification('_x.ai/session/update', params => {
			this._handleGrokExtensionNotification(params);
		}));
		store.add(client.onRequest('session/request_permission', params => {
			return this._handlePermissionRequest(params as AcpRequestPermissionParams);
		}));
		store.add(client.onRequest('_x.ai/exit_plan_mode', params => {
			return this._handleExitPlanModeRequest(params as AcpExitPlanModeParams);
		}));
		store.add(client.onRequest('_x.ai/ask_user_question', params => {
			return this._handleAskUserQuestionRequest(params as AcpAskUserQuestionParams);
		}));
		store.add(client.onUnhandledNotification((method, _params) => {
			this._logService.trace(`[GrokBuild] ignored notification ${method}`);
		}));
	}

	private _handleSessionUpdate(params: AcpSessionUpdateParams): void {
		this._captureSessionSideChannel(params);
		const replay = this._historyReplays.get(params.sessionId);
		if (replay) {
			applyGrokHistoryUpdate(replay, params.update);
			const replayChat = this._sessionToChat.get(params.sessionId);
			const replayBacking = replayChat ? this._backings.get(chatKey(replayChat)) : undefined;
			if (replayBacking) {
				if (params.update?.sessionUpdate === 'user_message_chunk') {
					replayBacking.replaySuppressChunkTotals = false;
				}
				this._noteReplayTurnCompletedTokens(replayBacking, params.update);
				this._noteReplayChunkTotalTokens(replayBacking, params.update?._meta);
				this._noteReplayChunkTotalTokens(replayBacking, params._meta);
			}
			return;
		}
		const chat = this._sessionToChat.get(params.sessionId);
		if (!chat) {
			return;
		}
		const backing = this._backings.get(chatKey(chat));
		if (!backing) {
			return;
		}
		const title = readGrokSessionTitle(params.update);
		if (title) {
			backing.summary = title;
		}
		const tokensChanged = this._noteTotalTokens(backing, params.update?._meta)
			|| this._noteTotalTokens(backing, params._meta);
		if (!backing.activeTurnId || !backing.mapState) {
			if (tokensChanged) {
				this._publishContextUsage(backing);
			}
			return;
		}
		this._notePromptAccepted(backing, params.update?._meta);
		const chunkText = textFromSessionUpdate(params);
		if (chunkText !== undefined && backing.turnAssistantMarkdown !== undefined) {
			backing.turnAssistantMarkdown += chunkText;
		}
		this._syncMapStateClientMcp(backing);
		const update = params.update;
		// Note client-tool correlation before firing actions so a terminal ACP
		// Complete does not respondOrBuffer after the workbench already settled MCP.
		if (isAcpToolCallUpdate(update)) {
			this._noteGrokClientToolCallUpdate(backing, update);
		}
		const actions = mapSessionUpdate(backing.mapState, params);
		for (const action of actions) {
			this._fireAction(chat, action);
		}
		if (isAcpToolCallUpdate(update)) {
			const status = (update.status ?? '').toLowerCase();
			if (status === 'completed' || status === 'failed' || status === 'cancelled') {
				// Grok finished the card (e.g. ask timeout) without waiting for our reply.
				this._abandonPendingInteractiveForToolCall(params.sessionId, update.toolCallId);
				this._publishContextUsage(backing);
			}
		} else if (tokensChanged) {
			// Live gauge: publish when totalTokens moves (deduped inside).
			this._publishContextUsage(backing);
		}
	}

	private _handleGrokExtensionNotification(params: unknown): void {
		const sessionId = readSessionId(params);
		if (!sessionId) {
			return;
		}
		const chat = this._sessionToChat.get(sessionId);
		const backing = chat ? this._backings.get(chatKey(chat)) : undefined;
		if (!backing) {
			return;
		}
		const replaying = this._historyReplays.has(sessionId);
		if (replaying) {
			// Load replay: prefer single-call turn_completed over chunk totalTokens.
			// Publish happens via getChatMetadata._meta after load (session state
			// does not exist yet). Still record model_changed window selection —
			// it arrives before the session/load result.
			this._noteReplayTurnCompletedTokens(backing, params);
			const compactionTokens = readGrokCompactionCurrentTokens(params);
			if (compactionTokens !== undefined) {
				backing.lastTotalTokens = compactionTokens;
				backing.replaySuppressChunkTotals = true;
			}
			this._noteModelChangedContextWindow(backing, params, false);
			return;
		}
		const compactionTokens = readGrokCompactionCurrentTokens(params);
		if (compactionTokens !== undefined) {
			backing.lastTotalTokens = compactionTokens;
			this._publishContextUsage(backing);
		}
		this._noteModelChangedContextWindow(backing, params, true);
	}

	private _handlePermissionRequest(params: AcpRequestPermissionParams): Promise<AcpServerRequestHandlerResult<AcpRequestPermissionResult>> {
		const chat = this._sessionToChat.get(params.sessionId);
		if (!chat) {
			return Promise.resolve({
				error: { code: AcpJsonRpcErrorCode.InternalError, message: 'Unknown Grok session' },
			});
		}
		const backing = this._backings.get(chatKey(chat));
		if (backing?.activeTurnId) {
			this._notePromptAccepted(backing);
		}
		const turnId = backing?.activeTurnId ?? generateUuid();

		const trackedClient = this._trackedClientToolPermission(backing, params);
		if (trackedClient) {
			// Client tools use ChatInput (Allow once / Reject), never pending_confirmation
			// — stamping Client at Start would otherwise let the workbench auto-run
			// read-only tools without asking.
			return this._requestClientToolApproval(
				chat,
				params.sessionId,
				trackedClient.toolCallId,
				trackedClient.toolName,
				trackedClient.args,
			).then(outcome => {
				if (outcome === 'allow') {
					const optionId = selectClientToolPermissionOptionId(params.options, true);
					if (!optionId) {
						return { result: { outcome: { outcome: 'cancelled' as const } } };
					}
					return { result: { outcome: { outcome: 'selected' as const, optionId } } };
				}
				if (outcome === 'reject') {
					const optionId = selectClientToolPermissionOptionId(params.options, false);
					if (!optionId) {
						return { result: { outcome: { outcome: 'cancelled' as const } } };
					}
					return { result: { outcome: { outcome: 'selected' as const, optionId } } };
				}
				return { result: { outcome: { outcome: 'cancelled' as const } } };
			});
		}

		const mapped = mapPermissionRequest(chat, turnId, params, backing?.mapState);
		if (!mapped) {
			return Promise.resolve({
				error: { code: AcpJsonRpcErrorCode.InvalidParams, message: 'Permission request missing tool call id' },
			});
		}

		const autoOptionId = this._autoEditOptionId(backing, params);
		if (autoOptionId) {
			return Promise.resolve({ result: { outcome: { outcome: 'selected', optionId: autoOptionId } } });
		}

		return new Promise<AcpServerRequestHandlerResult<AcpRequestPermissionResult>>(resolve => {
			this._pendingPermissions.set(mapped.toolCallId, {
				chat,
				turnId,
				options: mapped.options,
				resolve,
			});
			this._onDidChatProgress.fire(mapped.signal as IAgentToolPendingConfirmationSignal);
		});
	}

	/**
	 * When our `client` MCP is attached and the permission subject is a tracked
	 * pending grok client use_tool id, return that entry for the ChatInput path.
	 */
	private _trackedClientToolPermission(
		backing: IGrokBuildChatBacking | undefined,
		params: AcpRequestPermissionParams,
	): IGrokPendingClientToolCall | undefined {
		if (!backing?.clientMcpServer) {
			return undefined;
		}
		const subjectToolCallId = params.subject?.toolCallId;
		const toolCallId =
			params.toolCall?.toolCallId
			?? params.subject?.toolCall?.toolCallId
			?? (typeof subjectToolCallId === 'string' ? subjectToolCallId : undefined);
		if (!toolCallId) {
			return undefined;
		}
		return backing.pendingGrokClientToolCalls.find(entry => entry.toolCallId === toolCallId);
	}

	/**
	 * grok 1.0.70 presents the plan via `_x.ai/exit_plan_mode` (not
	 * `session/request_permission`). Reuses the Copilot plan-review UI
	 * ({@link ChatInputRequestPurpose.PlanReview}) with approve / abandon only —
	 * never autopilot / allow-all. Fail closed to `revise` when there is no
	 * active turn or the session is unknown.
	 */
	private _handleExitPlanModeRequest(params: AcpExitPlanModeParams): Promise<AcpServerRequestHandlerResult<AcpExitPlanModeResult>> {
		const chat = this._sessionToChat.get(params.sessionId);
		if (!chat) {
			this._logService.trace('[GrokBuild] exit_plan_mode for unknown session → revise');
			return Promise.resolve({ result: { outcome: 'revise' } });
		}
		const backing = this._backings.get(chatKey(chat));
		if (!backing?.activeTurnId) {
			this._logService.trace('[GrokBuild] exit_plan_mode without active turn → revise');
			return Promise.resolve({ result: { outcome: 'revise' } });
		}
		this._notePromptAccepted(backing);
		const planContent = typeof params.planContent === 'string' ? params.planContent : '';
		this._logService.trace(`[GrokBuild] exit_plan_mode toolCallId=${params.toolCallId} planChars=${planContent.length}`);
		if (backing.mapState && params.toolCallId) {
			for (const action of mapExitPlanContent(backing.mapState, params.toolCallId, planContent)) {
				this._fireAction(chat, action);
			}
		}

		const requestId = generateUuid();
		const questionId = generateUuid();
		const actions: IAgentHostPlanReviewAction[] = [
			{
				id: GROK_PLAN_REVIEW_APPROVE_ID,
				label: localize('grokBuild.planReview.approve.label', "Implement plan"),
				description: localize('grokBuild.planReview.approve.description', "Leave plan mode and start implementing the plan."),
				default: true,
			},
			{
				id: GROK_PLAN_REVIEW_ABANDON_ID,
				label: localize('grokBuild.planReview.abandon.label', "Abandon"),
				description: localize('grokBuild.planReview.abandon.description', "Leave plan mode without implementing the plan."),
			},
		];
		const inputRequest: ChatInputRequestWithPlanReview = withChatInputRequestPurpose({
			id: requestId,
			planReview: {
				title: localize('agentHost.planReview.title', "Review Plan"),
				content: planContent || localize('agentHost.planReview.fallbackSummary', "A plan is ready for review."),
				actions,
				canProvideFeedback: true,
				answerQuestionId: questionId,
			},
			questions: [{
				kind: ChatInputQuestionKind.SingleSelect,
				id: questionId,
				title: localize('agentHost.planReview.title', "Review Plan"),
				message: localize('agentHost.planReview.questionMessage', "How would you like to proceed?"),
				required: true,
				options: actions.map(action => ({
					id: action.id,
					label: action.label,
					...(action.description ? { description: action.description } : {}),
					...(action.default ? { recommended: true } : {}),
				})),
				allowFreeformInput: true,
			}],
		}, ChatInputRequestPurpose.PlanReview);

		return new Promise<AcpServerRequestHandlerResult<AcpExitPlanModeResult>>(resolve => {
			this._pendingPlanReviews.set(requestId, {
				chat,
				sessionId: params.sessionId,
				turnId: backing.activeTurnId!,
				toolCallId: params.toolCallId,
				questionId,
				resolve,
			});
			this._fireAction(chat, {
				type: ActionType.ChatInputRequested,
				request: inputRequest,
			});
		});
	}

	/**
	 * grok 1.0.70 asks clarifying questions via `_x.ai/ask_user_question` (not
	 * `session/request_permission`). Surfaces each question through
	 * {@link ChatInputRequestPurpose.AskUser} with single/multi select plus
	 * free-text, and an optional skip-interview control. Decline / cancel →
	 * `cancelled`; unknown session / no active turn / malformed params fail
	 * closed without hanging the tool.
	 */
	private _handleAskUserQuestionRequest(params: AcpAskUserQuestionParams): Promise<AcpServerRequestHandlerResult<AcpAskUserQuestionResult>> {
		if (!params || typeof params.sessionId !== 'string' || typeof params.toolCallId !== 'string' || !Array.isArray(params.questions) || params.questions.length === 0) {
			return Promise.resolve({
				error: { code: AcpJsonRpcErrorCode.InvalidParams, message: 'Invalid ask_user_question params' },
			});
		}
		const questions: AcpAskUserQuestion[] = [];
		for (const raw of params.questions) {
			if (!raw || typeof raw.question !== 'string' || !Array.isArray(raw.options)) {
				return Promise.resolve({
					error: { code: AcpJsonRpcErrorCode.InvalidParams, message: 'Invalid ask_user_question question' },
				});
			}
			questions.push({
				question: raw.question,
				options: raw.options.map((option: AcpAskUserQuestionOption | undefined) => ({
					label: typeof option?.label === 'string' ? option.label : '',
					description: typeof option?.description === 'string' ? option.description : '',
				})),
				multiSelect: raw.multiSelect === true ? true : raw.multiSelect === false ? false : null,
			});
		}
		const chat = this._sessionToChat.get(params.sessionId);
		if (!chat) {
			this._logService.trace('[GrokBuild] ask_user_question for unknown session → cancelled');
			return Promise.resolve({ result: { outcome: 'cancelled' } });
		}
		const backing = this._backings.get(chatKey(chat));
		if (!backing?.activeTurnId) {
			this._logService.trace('[GrokBuild] ask_user_question without active turn → cancelled');
			return Promise.resolve({ result: { outcome: 'cancelled' } });
		}
		this._notePromptAccepted(backing);
		this._logService.trace(`[GrokBuild] ask_user_question toolCallId=${params.toolCallId} questions=${questions.length} mode=${params.mode}`);

		const requestId = generateUuid();
		const inputQuestions = buildAskUserChatInputQuestions(questions);
		inputQuestions.push({
			kind: ChatInputQuestionKind.SingleSelect,
			id: GROK_ASK_USER_SKIP_QUESTION_ID,
			title: localize('grokBuild.askUser.skip.title', "Skip interview"),
			message: localize('grokBuild.askUser.skip.message', "Stop asking clarifying questions and continue with the answers so far."),
			required: false,
			options: [{
				id: GROK_ASK_USER_SKIP_OPTION_ID,
				label: localize('grokBuild.askUser.skip.label', "Skip interview"),
				description: localize('grokBuild.askUser.skip.description', "I have provided enough answers."),
			}],
		});
		const inputRequest = withChatInputRequestPurpose({
			id: requestId,
			message: localize('grokBuild.askUser.requestMessage', "Answer the agent's questions"),
			questions: inputQuestions,
		}, ChatInputRequestPurpose.AskUser);

		return new Promise<AcpServerRequestHandlerResult<AcpAskUserQuestionResult>>(resolve => {
			this._pendingAskUserQuestions.set(requestId, {
				chat,
				sessionId: params.sessionId,
				turnId: backing.activeTurnId!,
				toolCallId: params.toolCallId,
				questions,
				resolve,
			});
			this._fireAction(chat, {
				type: ActionType.ChatInputRequested,
				request: inputRequest,
			});
		});
	}

	private _killChild(child: ChildProcessWithoutNullStreams | undefined): void {
		if (child && child.exitCode === null && child.signalCode === null) {
			try {
				child.kill('SIGTERM');
			} catch {
				// already dead
			}
		}
	}

	private _rememberOwner(backing: IGrokBuildChatBacking | undefined, context: URI | IAgentChatContext | undefined): void {
		if (!backing || !context || URI.isUri(context)) {
			return;
		}
		backing.ownerRef = context.owner;
	}

	private _chatConfig(backing: IGrokBuildChatBacking): Record<string, unknown> | undefined {
		const owner = backing.ownerRef?.get();
		if (!owner) {
			return undefined;
		}
		return this._configurationService.getChatConfigValues({ session: owner.toString(), chat: backing.chat.toString() });
	}

	private _reasoningSchema(): ConfigSchema | undefined {
		return reasoningEffortConfigSchema(this._reasoningOption);
	}

	private _rememberReasoningOption(option: AcpConfigOption | undefined): void {
		if (option) {
			this._reasoningOption = option;
		}
	}

	private _publishModels(state: AcpModelState | undefined): void {
		const reasoningSchema = this._reasoningSchema();
		const before = this._models.get();
		applyModelState(models => this._models.set(models, undefined), this.id, state, reasoningSchema);
		if (state?.availableModels?.length || before.length === 0) {
			return;
		}
		// Reasoning-only refresh: keep each model's Context Size property.
		this._models.set(before.map(model => {
			const contextProp = model.configSchema?.properties?.[ContextSizeConfigKey];
			const configSchema = mergeGrokModelConfigSchema(
				reasoningSchema,
				contextSizeConfigSchema(contextProp),
			);
			return { ...model, configSchema };
		}), undefined);
	}

	private async _reapplyReasoningEffort(client: IAcpClient, backing: IGrokBuildChatBacking): Promise<void> {
		const current = typeof this._reasoningOption?.currentValue === 'string' ? this._reasoningOption.currentValue : undefined;
		const wanted = backing.reasoningEffort;
		if (wanted && wanted !== current) {
			try {
				await client.request('session/set_config_option', {
					sessionId: backing.sessionId,
					configId: GROK_REASONING_CONFIG_ID,
					value: wanted,
				});
			} catch (err) {
				const formatted = formatAcpError(err);
				this._logService.warn(`[GrokBuild] session/set_config_option failed after load: ${grokLogSummary(formatted.message)}`);
				return;
			}
		} else if (!wanted && current) {
			backing.reasoningEffort = current;
			backing.model = modelWithThinkingLevel(backing.model, current);
			this._emitProviderDataChange(backing.chat, backing);
			return;
		}
		if (wanted) {
			backing.model = modelWithThinkingLevel(backing.model, wanted);
		}
	}

	private _captureSessionSideChannel(params: AcpSessionUpdateParams): void {
		const update = params.update;
		if (!update || typeof update.sessionUpdate !== 'string') {
			return;
		}
		const chat = this._sessionToChat.get(params.sessionId);
		const backing = chat ? this._backings.get(chatKey(chat)) : undefined;
		if (!backing) {
			return;
		}
		if (update.sessionUpdate === 'available_commands_update') {
			const commands = readAvailableCommands(update);
			if (!commands || sameCommands(backing.commands, commands)) {
				return;
			}
			backing.commands = commands;
			this._onDidCustomizationsChange.fire();
			return;
		}
		if (update.sessionUpdate === 'config_option_update') {
			const raw = (update as { configOptions?: unknown }).configOptions;
			const option = Array.isArray(raw) ? readReasoningEffortOption(raw) : undefined;
			if (option) {
				this._rememberReasoningOption(option);
				this._publishModels(undefined);
			}
			return;
		}
		if (update.sessionUpdate === 'current_mode_update') {
			this._onCurrentModeUpdate(backing, (update as { currentModeId?: unknown }).currentModeId);
		}
	}

	/**
	 * After approve/abandon, grok emits `current_mode_update` `default`. Mirror
	 * that onto `appliedModeId` and chat config `interactive` so the next
	 * prompt does not force plan mode back on.
	 */
	private _onCurrentModeUpdate(backing: IGrokBuildChatBacking, currentModeId: unknown): void {
		if (typeof currentModeId !== 'string') {
			return;
		}
		if (currentModeId === GROK_PLAN_MODE_ID) {
			backing.appliedModeId = GROK_PLAN_MODE_ID;
			return;
		}
		if (currentModeId !== GROK_DEFAULT_MODE_ID) {
			return;
		}
		backing.appliedModeId = GROK_DEFAULT_MODE_ID;
		if (!this._sessionsExitingPlanMode.delete(backing.sessionId)) {
			return;
		}
		const owner = backing.ownerRef?.get();
		if (!owner) {
			return;
		}
		this._configurationService.updateChatConfig(
			{ session: owner.toString(), chat: backing.chat.toString() },
			{ [SessionConfigKey.Mode]: 'interactive' },
		);
	}

	private _autoEditOptionId(backing: IGrokBuildChatBacking | undefined, params: AcpRequestPermissionParams): string | undefined {
		if (!backing || readPermissionPreset(this._chatConfig(backing)) !== GROK_PERMISSION_PRESET_ALLOW_EDITS) {
			return undefined;
		}
		const toolCallId = params.toolCall?.toolCallId;
		const entry = toolCallId ? backing.mapState?.toolCalls.get(toolCallId) : undefined;
		const toolMeta = params.toolCall?._meta;
		const xai = toolMeta?.['x.ai/tool'];
		const xaiRecord = xai && typeof xai === 'object' ? xai as { kind?: unknown; name?: unknown } : undefined;
		return allowEditsOnceOptionId(params.options ?? [], {
			kind: typeof xaiRecord?.kind === 'string' ? xaiRecord.kind : params.toolCall?.kind,
			name: typeof xaiRecord?.name === 'string' ? xaiRecord.name : undefined,
			permissionKind: entry?.permissionKind,
		});
	}

	/**
	 * `session/set_mode` returns `{}` for any id. A resolved request is treated
	 * as applied. Plan is required for the next prompt: a failed `set_mode`
	 * throws {@link grokPlanModeFailedError} when `failIfPlanUnapplied` is set.
	 * Other modes are logged and left unchanged.
	 */
	private async _applySessionMode(backing: IGrokBuildChatBacking, modeId: string, failIfPlanUnapplied: boolean): Promise<void> {
		if (backing.appliedModeId === modeId) {
			return;
		}
		const fail = failIfPlanUnapplied && modeId === GROK_PLAN_MODE_ID;
		try {
			await this._ensureSessionAttached(backing);
			if (backing.appliedModeId === modeId) {
				return;
			}
			const client = this._connection?.client;
			if (!client || backing.loadedGeneration !== this._connectionGeneration) {
				if (fail) {
					throw grokPlanModeFailedError();
				}
				return;
			}
			await client.request('session/set_mode', { sessionId: backing.sessionId, modeId });
			backing.appliedModeId = modeId;
		} catch (err) {
			const formatted = formatAcpError(err);
			const alreadyLocalized = formatted.message === grokPlanModeFailedError().message;
			if (!alreadyLocalized) {
				this._logService.warn(`[GrokBuild] session/set_mode ${modeId} failed: ${grokLogSummary(formatted.message)}`);
			}
			if (fail) {
				throw grokPlanModeFailedError();
			}
		}
	}

	/** Chat config is the mode source after `session/load` and `session/resume`. */
	private async _reapplySessionMode(backing: IGrokBuildChatBacking): Promise<void> {
		const modeId = modeIdForSessionMode(this._chatConfig(backing)?.[SessionConfigKey.Mode]);
		if (!modeId) {
			return;
		}
		await this._applySessionMode(backing, modeId, true);
	}

	/**
	 * Create and config changes apply plan without failing the caller. The
	 * prompt retries once the session is on this process, and fails if plan
	 * still did not stick.
	 */
	private async _ensurePlanModeForPrompt(backing: IGrokBuildChatBacking): Promise<void> {
		const modeId = modeIdForSessionMode(this._chatConfig(backing)?.[SessionConfigKey.Mode]);
		if (modeId !== GROK_PLAN_MODE_ID || backing.appliedModeId === GROK_PLAN_MODE_ID) {
			return;
		}
		await this._applySessionMode(backing, modeId, true);
	}

	private _onChatConfigChanged(event: IAgentChatConfigurationChangeEvent): void {
		if (!Object.hasOwn(event.config, SessionConfigKey.Mode)) {
			return;
		}
		const modeId = modeIdForSessionMode(event.config[SessionConfigKey.Mode]);
		if (!modeId) {
			return;
		}
		for (const backing of this._backings.values()) {
			if (backing.chat.toString() !== event.chat) {
				continue;
			}
			const owner = backing.ownerRef?.get().toString();
			if (owner && owner !== event.session) {
				continue;
			}
			void this._applySessionMode(backing, modeId, false);
		}
	}

	private _disposeConnection(): void {
		this._cancelAllPendingPermissions();
		const connection = this._connection;
		this._connection = undefined;
		this._invalidateLoadedSessions();
		if (!connection) {
			return;
		}
		connection.store.dispose();
		this._killChild(connection.child);
		if (this._testClient === connection.client) {
			this._testClient = undefined;
		}
	}

	/** Root setting `chat.agentHost.grokBuildAgent.clientToolsMcp.enabled` (default on). */
	private _isClientToolsMcpEnabled(): boolean {
		try {
			const value = this._configurationService.getRootValue(platformRootSchema, AgentHostGrokBuildClientToolsMcpEnabledConfigKey);
			return value !== false;
		} catch {
			return true;
		}
	}

	private async _mcpServersForBacking(backing: IGrokBuildChatBacking): Promise<readonly IGrokAcpHttpMcpServer[]> {
		const handle = await this._ensureClientMcpServer(backing);
		return handle ? [handle.toAcpMcpServer()] : [];
	}

	private async _ensureClientMcpServer(backing: IGrokBuildChatBacking): Promise<IGrokClientMcpServerHandle | undefined> {
		if (!this._isClientToolsMcpEnabled()) {
			this._disposeClientMcp(backing);
			return undefined;
		}
		if (backing.clientMcpServer) {
			this._seedClientToolsFromHandles(backing);
			backing.clientMcpServer.setTools(backing.clientToolSet.merged());
			return backing.clientMcpServer;
		}
		if (backing.clientMcpServerInFlight) {
			return backing.clientMcpServerInFlight;
		}
		const chat = backing.chat;
		const inFlight = this._startClientMcpForChat(chat).then(handle => {
			// Dispose won the race (or a newer ensure replaced us) — drop the handle.
			if (backing.clientMcpServerInFlight !== inFlight) {
				handle?.dispose();
				return undefined;
			}
			if (this._backings.get(chatKey(chat)) !== backing) {
				handle?.dispose();
				return undefined;
			}
			this._attachClientMcpServer(backing, handle);
			return backing.clientMcpServer;
		}).finally(() => {
			if (backing.clientMcpServerInFlight === inFlight) {
				backing.clientMcpServerInFlight = undefined;
			}
		});
		backing.clientMcpServerInFlight = inFlight;
		return inFlight;
	}

	private async _startClientMcpForChat(chat: URI): Promise<IGrokClientMcpServerHandle | undefined> {
		if (!this._isClientToolsMcpEnabled()) {
			return undefined;
		}
		const initialTools = this._mergedToolsFromHandles(chat);
		try {
			return await startGrokClientToolMcpServer(
				{
					invoke: (toolName, args, toolCallId, signal) => this._invokeClientTool(chat, toolName, args, toolCallId, signal),
				},
				initialTools,
			);
		} catch (err) {
			this._logService.warn(`[GrokBuild] failed to start client-tools MCP server: ${err instanceof Error ? err.message : String(err)}`);
			return undefined;
		}
	}

	private _attachClientMcpServer(backing: IGrokBuildChatBacking, handle: IGrokClientMcpServerHandle | undefined): void {
		if (!handle) {
			return;
		}
		if (backing.clientMcpServer && backing.clientMcpServer !== handle) {
			backing.clientMcpServer.dispose();
		}
		backing.clientMcpServer = handle;
		this._seedClientToolsFromHandles(backing);
		handle.setTools(backing.clientToolSet.merged());
	}

	private _rejectPendingClientToolCalls(backing: IGrokBuildChatBacking): void {
		backing.pendingClientToolCalls.rejectAll(new CancellationError());
		backing.pendingGrokClientToolCalls.length = 0;
		backing.approvedClientCalls.clear();
	}

	private _disposeClientMcp(backing: IGrokBuildChatBacking): void {
		this._rejectPendingClientToolCalls(backing);
		backing.clientMcpServer?.dispose();
		backing.clientMcpServer = undefined;
		backing.clientMcpServerInFlight = undefined;
	}

	private _createMapState(backing: IGrokBuildChatBacking, turnId: string): IGrokBuildMapState {
		return createGrokBuildMapState(turnId, {
			clientMcpAttached: !!backing.clientMcpServer,
		});
	}

	private _syncMapStateClientMcp(backing: IGrokBuildChatBacking): void {
		if (!backing.mapState) {
			return;
		}
		backing.mapState.clientMcpAttached = !!backing.clientMcpServer;
	}

	/**
	 * Track grok ACP `use_tool` / `client__*` cards for MCP tools/call
	 * correlation. Only while our HTTP `client` server is attached.
	 */
	private _noteGrokClientToolCallUpdate(backing: IGrokBuildChatBacking, update: { readonly toolCallId?: string; readonly title?: string; readonly rawInput?: unknown; readonly status?: string | null; readonly _meta?: Record<string, unknown> }): void {
		if (!backing.clientMcpServer) {
			return;
		}
		const toolCallId = update.toolCallId;
		if (!toolCallId) {
			return;
		}
		const target = parseGrokClientToolTarget(update);
		if (!target) {
			return;
		}
		const status = (update.status ?? '').toLowerCase();
		const terminal = status === 'completed' || status === 'failed' || status === 'cancelled';
		const existing = backing.pendingGrokClientToolCalls.find(entry => entry.toolCallId === toolCallId);
		if (!existing && !terminal) {
			backing.pendingGrokClientToolCalls.push({
				toolCallId,
				toolName: target.toolName,
				args: target.args,
				invoked: false,
			});
			return;
		}
		if (terminal) {
			const index = backing.pendingGrokClientToolCalls.findIndex(entry => entry.toolCallId === toolCallId);
			if (index >= 0) {
				backing.pendingGrokClientToolCalls.splice(index, 1);
			}
		}
	}

	private _seedClientToolsFromHandles(backing: IGrokBuildChatBacking): void {
		const handles = this._activeClients.get(chatKey(backing.chat));
		if (!handles) {
			return;
		}
		for (const handle of handles.values()) {
			backing.clientToolSet.set(handle.clientId, handle.tools);
		}
	}

	private _mergedToolsFromHandles(chat: URI): readonly ToolDefinition[] {
		const handles = this._activeClients.get(chatKey(chat));
		if (!handles || handles.size === 0) {
			return [];
		}
		const set = new ActiveClientToolSet();
		for (const handle of handles.values()) {
			set.set(handle.clientId, handle.tools);
		}
		return set.merged();
	}

	/**
	 * MCP tools/call → ask if not already approved with matching args, then
	 * open Start{Client} + Ready{NotNeeded, toolInput} on grok's matched id
	 * (or a fresh fallback id) and park on {@link onClientToolCallComplete}.
	 */
	private async _invokeClientTool(
		chat: URI,
		toolName: string,
		args: Record<string, unknown>,
		mintedToolCallId: string,
		signal?: AbortSignal,
	): Promise<ToolCallResult> {
		const backing = this._backings.get(chatKey(chat));
		if (!backing) {
			throw new Error(localize('grokBuild.clientTool.noChat', "Client tool \"{0}\" has no active Grok Build chat.", toolName));
		}
		const turnId = backing.activeTurnId;
		if (!turnId) {
			throw new Error(localize('grokBuild.clientTool.noTurn', "Client tool \"{0}\" was called without an active turn.", toolName));
		}
		const ownerClientId = backing.clientToolSet.ownerOf(toolName);
		if (!ownerClientId) {
			throw new Error(localize('grokBuild.clientTool.unknown', "Client tool \"{0}\" is not registered for this chat.", toolName));
		}
		if (signal?.aborted) {
			throw new CancellationError();
		}

		const matched = takePendingGrokClientToolCall(
			backing.pendingGrokClientToolCalls,
			toolName,
			args,
			(a, b) => structuralEquals(a, b),
		);
		const toolCallId = matched?.toolCallId ?? mintedToolCallId;
		if (!matched) {
			this._logService.trace('[GrokBuild] client tools/call without matching use_tool card; falling back to separate Client card');
		}

		// Fresh-id fallback is always unapproved. Matched ids are approved only
		// when the stored args are structurally equal to the MCP args (blocks
		// approving A then executing B via FIFO name fallback).
		const approvedArgs = matched ? backing.approvedClientCalls.get(toolCallId) : undefined;
		const alreadyApproved = approvedArgs !== undefined && structuralEquals(approvedArgs, args);
		if (!alreadyApproved) {
			const onAbortDuringAsk = () => this._abandonClientToolApprovalForCall(chat, toolCallId);
			signal?.addEventListener('abort', onAbortDuringAsk, { once: true });
			let outcome: GrokClientToolApprovalOutcome;
			try {
				outcome = await this._requestClientToolApproval(
					chat,
					backing.sessionId,
					toolCallId,
					toolName,
					args,
				);
			} finally {
				signal?.removeEventListener('abort', onAbortDuringAsk);
			}
			if (signal?.aborted) {
				throw new CancellationError();
			}
			if (outcome !== 'allow') {
				return {
					success: false,
					pastTenseMessage: localize('grokBuild.clientTool.declined', "{0} declined", toolName),
					content: [{ type: ToolResultContentType.Text, text: 'User declined' }],
					error: { message: 'User declined' },
				};
			}
		}

		if (signal?.aborted) {
			throw new CancellationError();
		}

		let toolInput: string;
		try {
			toolInput = JSON.stringify(args);
		} catch {
			toolInput = '{}';
		}

		const onAbort = () => {
			backing.pendingClientToolCalls.respond(toolCallId, {
				success: false,
				pastTenseMessage: localize('grokBuild.clientTool.cancelled', "{0} cancelled", toolName),
				content: [],
				error: { message: localize('grokBuild.clientTool.requestClosed', "Client tool request closed"), code: 'cancelled' },
			});
		};
		signal?.addEventListener('abort', onAbort, { once: true });
		try {
			return await backing.pendingClientToolCalls.registerAndFire(toolCallId, () => {
				if (backing.mapState) {
					markGrokClientToolExecutionStarted(backing.mapState, toolCallId, toolName, args);
				}
				// Client ownership must be established at Start — Ready cannot add it.
				this._fireAction(chat, {
					type: ActionType.ChatToolCallStart,
					turnId,
					toolCallId,
					toolName,
					displayName: toolName,
					contributor: { kind: ToolCallContributorKind.Client, clientId: ownerClientId },
				});
				this._fireAction(chat, {
					type: ActionType.ChatToolCallReady,
					turnId,
					toolCallId,
					invocationMessage: localize('grokBuild.clientTool.invoking', "Calling {0}", toolName),
					toolInput,
					confirmed: ToolCallConfirmationReason.NotNeeded,
				});
			});
		} finally {
			signal?.removeEventListener('abort', onAbort);
		}
	}
}
