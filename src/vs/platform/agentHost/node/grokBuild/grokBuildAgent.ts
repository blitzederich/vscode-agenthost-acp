/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { raceTimeout } from '../../../../base/common/async.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { type IObservable, observableValue } from '../../../../base/common/observable.js';
import { extUri } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { localize } from '../../../../nls.js';
import { ILogService } from '../../../log/common/log.js';
import { IProductService } from '../../../product/common/productService.js';
import { deriveLegacyDefaultChat } from '../../common/agentHostLegacyDefaultChat.js';
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
import { AgentHostGrokBuildBinaryPathEnvVar } from '../../common/agentService.js';
import { SessionConfigKey } from '../../common/sessionConfigKeys.js';
import type { ConfigSchema } from '../../common/state/protocol/common/state.js';
import { IAgentConfigurationService, type IAgentChatConfigurationChangeEvent } from '../agentConfigurationService.js';
import { createErrorResponsePart, MessageKind, ResponsePartKind, TurnState, type ChatInputAnswer, type ChatInputResponseKind, type ClientPluginCustomization, type Customization, type ModelSelection, type ToolCallResult, type Turn, type UsageInfo } from '../../common/state/sessionState.js';
import type { ProtectedResourceMetadata, ToolDefinition } from '../../common/state/protocol/state.js';
import type { ResolveSessionConfigResult, SessionConfigCompletionsResult } from '../../common/state/protocol/commands.js';
import type { SessionAction, ChatAction } from '../../common/state/sessionActions.js';
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
	grokHandshakeTimeoutError,
	grokNotLoggedInError,
	GrokSessionMissingError,
	grokProcessExitedError,
	grokSessionMissingError,
	grokUnreadableVersionWarning,
	grokWorkingDirectoryRejectedError,
	resolveGrokBinary,
	withStderrTail,
	type IGrokBuildLaunchConfig,
	type IGrokBuildResolvedBinary,
} from './grokBuildLaunchConfig.js';
import {
	createGrokBuildMapState,
	mapPermissionRequest,
	mapSessionUpdate,
	mapTurnCompleted,
	mapTurnStarted,
	mapUsage,
	selectPermissionOptionId,
	type IGrokBuildMapState,
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
	grokAlwaysApproveRejectedError,
	grokBuildSessionSchema,
	grokPlanModeFailedError,
	GROK_PERMISSION_PRESET_ALLOW_EDITS,
	GROK_PLAN_MODE_ID,
	GROK_REASONING_CONFIG_ID,
	isAlwaysApprovePrompt,
	modeIdForSessionMode,
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
	type AcpConfigOption,
	type AcpModelState,
	type AcpRequestPermissionParams,
	type AcpRequestPermissionResult,
	type AcpSessionInfo,
	type AcpSessionListParams,
	type AcpSessionListResult,
	type AcpSessionUpdateParams,
	type AcpUsage,
	ACP_PROTOCOL_VERSION,
} from './protocol/acpTypes.js';

const HANDSHAKE_TIMEOUT_MS = 30_000;
const GROK_SESSION_LIST_MAX_PAGES = 20;

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
}

interface IPendingPermission {
	readonly chat: URI;
	readonly turnId: string;
	readonly options: AcpRequestPermissionParams['options'];
	resolve(result: AcpServerRequestHandlerResult<AcpRequestPermissionResult>): void;
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

function toAgentModelInfo(model: { modelId: string; name?: string }, provider: AgentProvider, schema: ConfigSchema | undefined): IAgentModelInfo {
	return {
		provider,
		id: model.modelId,
		name: model.name ?? model.modelId,
		supportsVision: false,
		...(schema ? { configSchema: schema } : {}),
	};
}

function toUsageInfo(usage: AcpUsage | undefined): UsageInfo | undefined {
	if (!usage) {
		return undefined;
	}
	const info: UsageInfo = {
		inputTokens: typeof usage.inputTokens === 'number' ? usage.inputTokens : undefined,
		outputTokens: typeof usage.outputTokens === 'number' ? usage.outputTokens : undefined,
		cacheReadTokens: typeof usage.cachedReadTokens === 'number' ? usage.cachedReadTokens : undefined,
	};
	if (info.inputTokens === undefined && info.outputTokens === undefined && info.cacheReadTokens === undefined) {
		return undefined;
	}
	return info;
}

function applyModelState(
	setModels: (models: readonly IAgentModelInfo[]) => void,
	provider: AgentProvider,
	state: AcpModelState | undefined,
	schema: ConfigSchema | undefined,
): void {
	const available = state?.availableModels;
	if (!available?.length) {
		return;
	}
	setModels(available.map(m => toAgentModelInfo(m, provider, schema)));
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

function turnRecordToTurn(record: IGrokBuildTurnRecord): Turn {
	const responseParts = [];
	if (record.assistantMarkdown) {
		responseParts.push({ kind: ResponsePartKind.Markdown as const, id: generateUuid(), content: record.assistantMarkdown });
	}
	if (record.errorMessage) {
		responseParts.push(createErrorResponsePart({ errorType: 'GrokProcessExited', message: record.errorMessage }));
	}
	return {
		id: record.id,
		message: { text: record.userText, origin: { kind: MessageKind.User } },
		responseParts,
		usage: record.usage,
		state: record.state,
	};
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
	private readonly _activeClients = new Map<string, Map<string, IActiveClient>>();
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
	private _discoveryPromise: Promise<void> | undefined;
	private _testClient: IAcpClient | undefined;
	private _reasoningOption: AcpConfigOption | undefined;
	private _spawn: GrokBuildTestSpawn = spawnGrokBuildProcess;
	private _resolveBinary: (configuredPath: string | undefined) => Promise<IGrokBuildResolvedBinary> = configuredPath => resolveGrokBinary(configuredPath);
	private _binaryResolverOverridden = false;

	private readonly _onDidCustomizationsChange = this._register(new Emitter<void>());
	readonly onDidCustomizationsChange: Event<void> = this._onDidCustomizationsChange.event;

	constructor(
		@ILogService private readonly _logService: ILogService,
		@IProductService private readonly _productService: IProductService,
		@IAgentConfigurationService private readonly _configurationService: IAgentConfigurationService,
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
			return Promise.resolve(backing?.turns.map(turnRecordToTurn) ?? []);
		},
		changeModel: (chat, model, _context) => this._changeModel(chat, model),
		getModel: (chat, _context) => this._backings.get(chatKey(chat))?.model,
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
		let tools: readonly ToolDefinition[] = [];
		let customizations: readonly ClientPluginCustomization[] = [];
		active = {
			clientId: client.clientId,
			displayName: client.displayName,
			get tools() { return tools; },
			set tools(value: readonly ToolDefinition[]) { tools = value; },
			get customizations() { return customizations; },
			set customizations(value: readonly ClientPluginCustomization[]) { customizations = value; },
		};
		perChat.set(client.clientId, active);
		return active;
	}

	removeActiveClient(chat: URI, _context: URI | IAgentChatContext, clientId: string): void {
		this._activeClients.get(chatKey(chat))?.delete(clientId);
	}

	onClientToolCallComplete(_chat: URI, _toolCallId: string, _result: ToolCallResult, _context?: IAgentChatContext): void {
		// Client tools are not wired through Grok ACP yet.
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

	respondToUserInputRequest(_requestId: string, _response: ChatInputResponseKind, _answers?: Record<string, ChatInputAnswer>): void {
		// No ask_user bridge.
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
				const now = Date.now();
				return {
					chat,
					startTime: now,
					modifiedTime: now,
					model: decoded.model,
					workingDirectories: decoded.cwd ? [URI.file(decoded.cwd)] : undefined,
				};
			}
		}
		if (!backing) {
			return undefined;
		}
		if (options?.activation === 'restore') {
			await this._ensureSessionAttached(backing);
		}
		return {
			chat,
			startTime: backing.startTime,
			modifiedTime: backing.modifiedTime,
			summary: backing.summary,
			model: backing.model,
			workingDirectories: backing.workingDirectories,
		};
	}

	async listChatsToMigrate(): Promise<AgentChatMigrationResult> {
		try {
			const sessions = await this._discoverSessions();
			return sessions.map(session => this._toListedChat(session));
		} catch (err) {
			this._logService.warn(`[GrokBuild] session/list failed: ${err instanceof Error ? err.message : String(err)}`);
			return undefined;
		}
	}

	startChatDiscovery(): Promise<void> {
		if (!this._discoveryPromise) {
			this._discoveryPromise = this._emitDiscoveredChats().catch(err => {
				this._logService.warn(`[GrokBuild] chat discovery failed: ${err instanceof Error ? err.message : String(err)}`);
			});
		}
		return this._discoveryPromise;
	}

	async shutdown(): Promise<void> {
		this._disposeConnection();
	}

	override dispose(): void {
		this._disposeConnection();
		this._backings.clear();
		this._sessionToChat.clear();
		this._pendingPermissions.clear();
		this._activeClients.clear();
		super.dispose();
	}

	private _storeBacking(chat: URI, persisted: IGrokBuildPersistedChat, workingDirectories: readonly URI[] | undefined): IGrokBuildChatBacking {
		const now = Date.now();
		const existing = this._backings.get(chatKey(chat));
		const sameSession = existing?.sessionId === persisted.sessionId;
		const directories = workingDirectories
			?? (sameSession ? existing?.workingDirectories : undefined)
			?? (persisted.cwd ? [URI.file(persisted.cwd)] : undefined);
		const backing: IGrokBuildChatBacking = {
			chat,
			sessionId: persisted.sessionId,
			model: modelWithThinkingLevel(persisted.model ?? (sameSession ? existing?.model : undefined), persisted.reasoningEffort ?? (sameSession ? existing?.reasoningEffort : undefined)),
			summary: sameSession ? existing?.summary : undefined,
			startTime: sameSession && existing ? existing.startTime : now,
			modifiedTime: now,
			workingDirectories: directories,
			turns: sameSession && existing ? existing.turns : [],
			loadedGeneration: sameSession ? existing?.loadedGeneration : undefined,
			reasoningEffort: persisted.reasoningEffort ?? (sameSession ? existing?.reasoningEffort : undefined),
			commands: sameSession ? existing?.commands : undefined,
			ownerRef: sameSession ? existing?.ownerRef : undefined,
			appliedModeId: sameSession ? existing?.appliedModeId : undefined,
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
		});
	}

	private _emitProviderDataChange(chat: URI, backing: IGrokBuildChatBacking): void {
		const providerData = this._persistProviderData(backing);
		this._onDidChangeChatData.fire({ chat, providerData });
	}

	private _toListedChat(session: AcpSessionInfo): IAgentListedChat {
		const sessionUri = AgentSession.uri(this.id, session.sessionId);
		const chat = URI.parse(deriveLegacyDefaultChat(sessionUri));
		const parsed = session.updatedAt ? Date.parse(session.updatedAt) : Number.NaN;
		const modifiedTime = Number.isFinite(parsed) ? parsed : Date.now();
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

	private async _createChat(chat: URI, context: URI | IAgentChatContext, options?: IAgentCreateChatOptions): Promise<IAgentCreateChatResult | void> {
		resolveAgentChatContext(context, chat);
		const client = await this._ensureConnection();
		const requestedDirectories = options?.workingDirectories;
		const cwd = requestedDirectories?.[0]?.fsPath ?? process.cwd();
		const workingDirectories = requestedDirectories && requestedDirectories.length > 0 ? requestedDirectories : [URI.file(cwd)];

		let sessionNew;
		try {
			sessionNew = await client.request('session/new', { cwd, mcpServers: [] });
		} catch (err) {
			rethrowAcpFailure(err);
		}

		this._rememberReasoningOption(readReasoningEffortOption(sessionNew.configOptions));
		this._publishModels(sessionNew.models);

		let model = options?.model;
		if (options?.model?.id) {
			try {
				await client.request('session/set_model', {
					sessionId: sessionNew.sessionId,
					modelId: options.model.id,
				});
			} catch (err) {
				const formatted = formatAcpError(err);
				this._logService.warn(`[GrokBuild] session/set_model failed; keeping the CLI default model: ${formatted.message}`);
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
				this._logService.warn(`[GrokBuild] session/set_config_option failed; keeping grok's reasoning effort: ${formatted.message}`);
				reasoningEffort = this._reasoningOption?.currentValue;
			}
		}

		const backing = this._storeBacking(chat, { sessionId: sessionNew.sessionId, model: modelWithThinkingLevel(model, reasoningEffort), reasoningEffort }, workingDirectories);
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
		if (isAlwaysApprovePrompt(prompt)) {
			throw grokAlwaysApproveRejectedError();
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
		backing.mapState = createGrokBuildMapState(turn);
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
			const usage = toUsageInfo(promptMeta?.usage);
			for (const action of mapUsage(turn, promptMeta?.usage)) {
				this._fireAction(chat, action);
			}
			for (const action of mapTurnCompleted(turn, result.stopReason)) {
				this._fireAction(chat, action);
			}
			// The prompt result means grok recorded the turn. Number it only then,
			// unless an update already carried grok's own promptIndex.
			this._notePromptAccepted(backing, promptMeta);
			this._finalizeTurn(backing, turn, result.stopReason === 'cancelled' ? TurnState.Cancelled : TurnState.Complete, usage);
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
		try {
			await client.request('session/set_model', {
				sessionId: backing.sessionId,
				modelId: model.id,
			});
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
		backing.modifiedTime = Date.now();
		this._emitProviderDataChange(chat, backing);
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
		await this._closeSessionIfAdvertised(backing);
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
		backing.modifiedTime = Date.now();
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

	private _cancelPendingPermissionsForChat(chat: URI): void {
		for (const [toolCallId, pending] of this._pendingPermissions) {
			if (!URI.isUri(pending.chat) || pending.chat.toString() !== chat.toString()) {
				continue;
			}
			pending.resolve({ result: { outcome: { outcome: 'cancelled' } } });
			this._pendingPermissions.delete(toolCallId);
		}
	}

	private _cancelAllPendingPermissions(): void {
		for (const [toolCallId, pending] of this._pendingPermissions) {
			pending.resolve({ result: { outcome: { outcome: 'cancelled' } } });
			this._pendingPermissions.delete(toolCallId);
		}
	}

	private _failActiveTurns(error: Error): void {
		for (const backing of this._backings.values()) {
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
		if (this._capabilities.loadSession) {
			const replay = createGrokHistoryReplay(backing.sessionId);
			this._historyReplays.set(backing.sessionId, replay);
			try {
				const result = await client.request('session/load', {
					sessionId: backing.sessionId,
					cwd,
					mcpServers: [],
				});
				this._rememberReasoningOption(readReasoningEffortOption(result.configOptions));
				this._publishModels(result.models);
				const modelId = result.models?.currentModelId;
				if (typeof modelId === 'string' && modelId.length > 0 && !backing.model) {
					backing.model = { id: modelId };
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
				backing.modifiedTime = Date.now();
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
				const result = await client.request('session/resume', {
					sessionId: backing.sessionId,
					cwd,
					mcpServers: [],
				});
				this._rememberReasoningOption(readReasoningEffortOption(result.configOptions));
				this._publishModels(result.models);
				await this._reapplyReasoningEffort(client, backing);
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
		this._backings.delete(key);
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
			if (level === 'error') {
				this._logService.error(`[GrokBuild ACP] ${message}`);
			} else {
				this._logService.trace(`[GrokBuild ACP] ${message}`);
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
			this._teardownFailedConnection(client, store, child, grokProcessExitedError(e.code, e.signal, this._stderrTail));
		}));
		store.add(client.onTransportError(err => {
			failConnection(err);
		}));

		if (child) {
			child.on('error', (err: Error) => {
				failConnection(err);
			});
			child.stdin.on('error', (err: Error) => {
				failConnection(err);
			});
		}

		let capabilities = noGrokCapabilities;
		try {
			const init = await raceTimeout(
				client.request('initialize', {
					protocolVersion: ACP_PROTOCOL_VERSION,
					clientCapabilities: {
						fs: { readTextFile: false, writeTextFile: false },
						terminal: false,
					},
					clientInfo: { name: clientName, version: clientVersion },
				}),
				HANDSHAKE_TIMEOUT_MS,
			);
			if (init === undefined) {
				throw grokHandshakeTimeoutError('initialize');
			}
			capabilities = readGrokCapabilities(init.agentCapabilities);
			const initMeta = init._meta;
			this._publishModels(initMeta?.modelState);

			// Do not log the authenticate result — `_meta` includes email / team / tier.
			const auth = await raceTimeout(
				client.request('authenticate', { methodId: 'grok.com' }),
				HANDSHAKE_TIMEOUT_MS,
			);
			if (auth === undefined) {
				throw grokHandshakeTimeoutError('authenticate');
			}
		} catch (err) {
			const error = isGrokAuthError(err)
				? new Error(withStderrTail(grokNotLoggedInError().message, this._stderrTail))
				: this._enrichError(err);
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
			this._stderrTail = appendStderrTail(this._stderrTail, text);
			const line = text.trimEnd();
			if (line.length > 0) {
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
		this._logService.error(`[GrokBuild] ${error.message}`);
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
		store.add(client.onRequest('session/request_permission', params => {
			return this._handlePermissionRequest(params as AcpRequestPermissionParams);
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
			backing.modifiedTime = Date.now();
		}
		if (!backing.activeTurnId || !backing.mapState) {
			return;
		}
		this._notePromptAccepted(backing, params.update?._meta);
		const chunkText = textFromSessionUpdate(params);
		if (chunkText !== undefined && backing.turnAssistantMarkdown !== undefined) {
			backing.turnAssistantMarkdown += chunkText;
		}
		const actions = mapSessionUpdate(backing.mapState, params);
		for (const action of actions) {
			this._fireAction(chat, action);
		}
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
		const schema = this._reasoningSchema();
		const before = this._models.get();
		applyModelState(models => this._models.set(models, undefined), this.id, state, schema);
		if (state?.availableModels?.length || before.length === 0 || !schema) {
			return;
		}
		this._models.set(before.map(model => ({ ...model, configSchema: schema })), undefined);
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
				this._logService.warn(`[GrokBuild] session/set_config_option failed after load: ${formatted.message}`);
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
		}
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
				this._logService.warn(`[GrokBuild] session/set_mode ${modeId} failed: ${formatted.message}`);
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
}
