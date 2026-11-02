/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { raceTimeout } from '../../../../base/common/async.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../base/common/network.js';
import { type IObservable, observableValue } from '../../../../base/common/observable.js';
import { isAbsolute } from '../../../../base/common/path.js';
import { extUri } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { localize } from '../../../../nls.js';
import { ILogService } from '../../../log/common/log.js';
import { IProductService } from '../../../product/common/productService.js';
import { createSchema } from '../../common/agentHostSchema.js';
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
	AgentSignal,
	resolveAgentChatContext,
} from '../../common/agent.js';
import { AgentHostGrokBuildBinaryPathEnvVar } from '../../common/agentService.js';
import type { ChatInputAnswer, ChatInputResponseKind, ClientPluginCustomization, Customization, ModelSelection, ToolCallResult, Turn, UsageInfo } from '../../common/state/sessionState.js';
import { createErrorResponsePart, MessageKind, ResponsePartKind, TurnState } from '../../common/state/sessionState.js';
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
	grokProcessExitedError,
	grokUnreadableVersionWarning,
	grokWorkingDirectoryBusyError,
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
} from './grokBuildSessionReplay.js';
import {
	type AcpAgentCapabilities,
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

const emptySessionSchema = createSchema({});
const HANDSHAKE_TIMEOUT_MS = 30_000;
const GROK_SESSION_LIST_MAX_PAGES = 20;
/** ACP v1: `session/close` of an unknown session is success. */
const ACP_UNKNOWN_SESSION = -32002;

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
	/** Connection generation that created or loaded this session. Undefined means it must be restored. */
	loadedGeneration?: number;
	activeTurnId?: string;
	mapState?: IGrokBuildMapState;
	turnAssistantMarkdown?: string;
	turnUserText?: string;
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

function toAgentModelInfo(model: { modelId: string; name?: string }, provider: AgentProvider): IAgentModelInfo {
	return {
		provider,
		id: model.modelId,
		name: model.name ?? model.modelId,
		supportsVision: false,
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
): void {
	const available = state?.availableModels;
	if (!available?.length) {
		return;
	}
	setModels(available.map(m => toAgentModelInfo(m, provider)));
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
	/** Session folder changes go through {@link setWorkingDirectory} (host worktree path as ACP `cwd`). */
	readonly agentHostCapabilities = { workspaceConversion: true } as const;

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
	private _discoveryPromise: Promise<void> | undefined;
	private _testClient: IAcpClient | undefined;
	private _spawn: GrokBuildTestSpawn = spawnGrokBuildProcess;
	private _resolveBinary: (configuredPath: string | undefined) => Promise<IGrokBuildResolvedBinary> = configuredPath => resolveGrokBinary(configuredPath);
	private _binaryResolverOverridden = false;

	constructor(
		@ILogService private readonly _logService: ILogService,
		@IProductService private readonly _productService: IProductService,
	) {
		super();
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
		const decoded = decodeGrokBuildChat(providerData);
		if (!decoded) {
			return;
		}
		const workingDirectories = decoded.cwd ? [URI.file(decoded.cwd)] : undefined;
		const backing = this._storeBacking(chat, decoded, workingDirectories);
		await this._ensureSessionAttached(backing);
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
		const backing = this._requireBacking(chat);
		if (workingDirectory.scheme !== Schemas.file || !!workingDirectory.query || !!workingDirectory.fragment || !isAbsolute(workingDirectory.fsPath)) {
			throw grokWorkingDirectoryRejectedError();
		}
		if (backing.activeTurnId) {
			throw grokWorkingDirectoryBusyError();
		}
		const current = backing.workingDirectories?.[0];
		if (current && extUri.isEqual(current, workingDirectory)) {
			return;
		}
		backing.workingDirectories = [workingDirectory];
		backing.modifiedTime = Date.now();
		backing.loadedGeneration = undefined;
		this._emitProviderDataChange(chat, backing);
		await this._ensureSessionAttached(backing);
	}

	resolveChatConfig(params: IAgentResolveChatConfigParams): Promise<ResolveSessionConfigResult> {
		return Promise.resolve({
			schema: emptySessionSchema.toProtocol(),
			values: params.config ?? {},
		});
	}

	getInheritedChatConfig(_config: Readonly<Record<string, unknown>>): Record<string, unknown> | undefined {
		return undefined;
	}

	chatConfigCompletions(_params: IAgentChatConfigCompletionsParams): Promise<SessionConfigCompletionsResult> {
		return Promise.resolve({ items: [] });
	}

	async getChatCustomizations(_chat: URI, _context: URI | IAgentChatContext, hostCustomizations?: readonly Customization[]): Promise<readonly Customization[]> {
		return hostCustomizations ?? [];
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
		if (!backing && providerData) {
			const decoded = decodeGrokBuildChat(providerData);
			if (!decoded) {
				return undefined;
			}
			if (options?.activation === 'restore') {
				backing = this._storeBacking(chat, decoded, decoded.cwd ? [URI.file(decoded.cwd)] : undefined);
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
			model: persisted.model ?? (sameSession ? existing?.model : undefined),
			summary: sameSession ? existing?.summary : undefined,
			startTime: sameSession && existing ? existing.startTime : now,
			modifiedTime: now,
			workingDirectories: directories,
			turns: sameSession && existing ? existing.turns : [],
			loadedGeneration: sameSession ? existing?.loadedGeneration : undefined,
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

		applyModelState(models => this._models.set(models, undefined), this.id, sessionNew.models);

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

		const backing = this._storeBacking(chat, { sessionId: sessionNew.sessionId, model }, workingDirectories);
		backing.loadedGeneration = this._connectionGeneration;
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
		const workingDirectories = this._resolveWorkingDirectories(workingDirectoriesOrDirectory);
		if (workingDirectories && workingDirectories.length > 0) {
			const next = workingDirectories[0];
			const previous = backing.workingDirectories?.[0];
			const changed = !previous || !extUri.isEqual(previous, next);
			backing.workingDirectories = workingDirectories;
			if (changed) {
				backing.loadedGeneration = undefined;
				this._emitProviderDataChange(chat, backing);
			}
		}
		await this._ensureSessionAttached(backing);
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
			const usage = toUsageInfo(result._meta?.usage);
			for (const action of mapUsage(turn, result._meta?.usage)) {
				this._fireAction(chat, action);
			}
			for (const action of mapTurnCompleted(turn, result.stopReason)) {
				this._fireAction(chat, action);
			}
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
			rethrowAcpFailure(err);
		} finally {
			backing.activeTurnId = undefined;
			backing.mapState = undefined;
			backing.turnAssistantMarkdown = undefined;
			backing.turnUserText = undefined;
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
		backing.model = model;
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
			await client.request('session/close', { sessionId: backing.sessionId });
		} catch (err) {
			if (err instanceof AcpJsonRpcResponseError && err.code === ACP_UNKNOWN_SESSION) {
				return;
			}
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
		backing.turns.push({ id: turnId, userText, assistantMarkdown, state, usage, errorMessage });
		backing.modifiedTime = Date.now();
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
		}
	}

	private _invalidateLoadedSessions(): void {
		for (const backing of this._backings.values()) {
			backing.loadedGeneration = undefined;
		}
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
		const cwd = backing.workingDirectories?.[0]?.fsPath ?? process.cwd();
		if (!backing.workingDirectories?.length) {
			backing.workingDirectories = [URI.file(cwd)];
		}
		if (this._capabilities.loadSession) {
			const replay = createGrokHistoryReplay(backing.sessionId);
			this._historyReplays.set(backing.sessionId, replay);
			try {
				const result = await client.request('session/load', {
					sessionId: backing.sessionId,
					cwd,
					mcpServers: [],
				});
				applyModelState(models => this._models.set(models, undefined), this.id, result.models);
				const history = finishGrokHistoryReplay(replay);
				backing.turns = history.turns.map(turn => ({
					id: turn.id,
					userText: turn.userText,
					assistantMarkdown: turn.assistantMarkdown,
					state: TurnState.Complete,
				}));
				if (history.title) {
					backing.summary = history.title;
				}
				backing.modifiedTime = Date.now();
			} catch (err) {
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
				applyModelState(models => this._models.set(models, undefined), this.id, result.models);
			} catch (err) {
				rethrowAcpFailure(err);
			}
		} else {
			throw grokCannotRestoreSessionError();
		}
		backing.loadedGeneration = this._connectionGeneration;
	}

	private async _discoverSessions(): Promise<readonly AcpSessionInfo[]> {
		await this._ensureConnection();
		if (!this._capabilities.list) {
			return [];
		}
		const cwds = new Set<string>();
		for (const backing of this._backings.values()) {
			const cwd = backing.workingDirectories?.[0]?.fsPath;
			if (cwd) {
				cwds.add(cwd);
			}
		}
		if (cwds.size === 0) {
			return this._listSessionPages(undefined);
		}
		const merged = new Map<string, AcpSessionInfo>();
		for (const cwd of cwds) {
			for (const session of await this._listSessionPages(cwd)) {
				merged.set(session.sessionId, session);
			}
		}
		return [...merged.values()];
	}

	private async _listSessionPages(cwd: string | undefined): Promise<readonly AcpSessionInfo[]> {
		const client = this._connection?.client;
		if (!client || !this._capabilities.list) {
			return [];
		}
		const sessions: AcpSessionInfo[] = [];
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
				sessions.push(...result.sessions);
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
			applyModelState(models => this._models.set(models, undefined), this.id, init._meta?.modelState);

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
		const turnId = backing?.activeTurnId ?? generateUuid();
		const mapped = mapPermissionRequest(chat, turnId, params, backing?.mapState);
		if (!mapped) {
			return Promise.resolve({
				error: { code: AcpJsonRpcErrorCode.InvalidParams, message: 'Permission request missing tool call id' },
			});
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
