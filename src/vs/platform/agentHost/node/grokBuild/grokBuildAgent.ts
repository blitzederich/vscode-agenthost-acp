/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { raceTimeout } from '../../../../base/common/async.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { type IObservable, observableValue } from '../../../../base/common/observable.js';
import { URI } from '../../../../base/common/uri.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { localize } from '../../../../nls.js';
import { ILogService } from '../../../log/common/log.js';
import { IProductService } from '../../../product/common/productService.js';
import { createSchema } from '../../common/agentHostSchema.js';
import {
	AgentChatMigrationResult,
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
import { MessageKind, ResponsePartKind, TurnState } from '../../common/state/sessionState.js';
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
	buildGrokBuildLaunchConfig,
	grokHandshakeTimeoutError,
	grokNotLoggedInError,
	resolveGrokBinary,
	type IGrokBuildLaunchConfig,
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
	ACP_PROTOCOL_VERSION,
	type AcpModelInfo,
	type AcpModelState,
	type AcpRequestPermissionParams,
	type AcpRequestPermissionResult,
	type AcpSessionUpdateParams,
	type AcpUsage,
} from './protocol/acpTypes.js';

const emptySessionSchema = createSchema({});
const HANDSHAKE_TIMEOUT_MS = 30_000;

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
}

interface IGrokBuildChatBacking {
	readonly chat: URI;
	sessionId: string;
	model?: ModelSelection;
	readonly startTime: number;
	modifiedTime: number;
	workingDirectories?: readonly URI[];
	turns: IGrokBuildTurnRecord[];
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

function chatKey(chat: URI): string {
	return chat.toString();
}

function isGrokAuthError(error: unknown): boolean {
	if (!(error instanceof AcpJsonRpcResponseError)) {
		return false;
	}
	return error.code === -32000 && /authentication required/i.test(error.message);
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

function toAgentModelInfo(model: AcpModelInfo, provider: AgentProvider): IAgentModelInfo {
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
	const responseParts = record.assistantMarkdown
		? [{ kind: ResponsePartKind.Markdown as const, id: generateUuid(), content: record.assistantMarkdown }]
		: [];
	return {
		id: record.id,
		message: { text: record.userText, origin: { kind: MessageKind.User } },
		responseParts,
		usage: record.usage,
		state: record.state,
	};
}

export class GrokBuildAgent extends Disposable implements IAgent {
	readonly id: AgentProvider = GROK_BUILD_AGENT_PROVIDER_ID;
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

	private _connection: IConnection | undefined;
	private _connectionInFlight: Promise<IAcpClient> | undefined;
	private _testClient: IAcpClient | undefined;
	private _testSpawn: GrokBuildTestSpawn | undefined;

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
	 */
	bindTestClient(client: IAcpClient): void {
		this._disposeConnection();
		this._testClient = client;
		const store = new DisposableStore();
		store.add(client);
		this._connection = { client, child: undefined, store };
		this._wireClient(client, store);
	}

	/**
	 * @internal Test seam: replace `spawn(grok …)` with a fake transport so
	 * handshake order (`initialize` → `authenticate` → `session/new`) and the
	 * publish-after-handshake race can be asserted.
	 */
	bindTestSpawn(spawnFn: GrokBuildTestSpawn): void {
		this._testSpawn = spawnFn;
	}

	readonly chats: IAgentChats = {
		createChat: (chat, context, options) => this._createChat(chat, context, options),
		disposeChat: (chat, _context) => this._disposeChat(chat, true),
		releaseChat: (chat, _context) => this._disposeChat(chat, false),
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
		// Stage 2 TODO: call `session/load` or resume when Grok exposes durable reload.
		this._storeBacking(chat, decoded, undefined);
		const encoded = encodeGrokBuildChat(decoded);
		this._onDidMaterializeChat.fire({ chat, result: { providerData: encoded }, workingDirectories: undefined, project: undefined });
		return { providerData: encoded };
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
		// MVP: client tools are not wired through Grok ACP yet.
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
		// MVP: no ask_user bridge.
	}

	async setWorkingDirectory(_chat: URI, _context: URI | IAgentChatContext, _workingDirectory: URI): Promise<void> {
		throw new Error(localize('grokBuild.unsupportedWorkingDirectory', "Grok Build does not support changing the working directory after a chat is created."));
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

	async getChatMetadata(chat: URI, _context: URI | IAgentChatContext, providerData?: string, _options?: IAgentChatMetadataOptions): Promise<IAgentChatMetadata | undefined> {
		const backing = this._backings.get(chatKey(chat)) ?? (providerData ? this._backingFromProviderData(chat, providerData) : undefined);
		if (!backing) {
			return undefined;
		}
		return {
			chat,
			startTime: backing.startTime,
			modifiedTime: backing.modifiedTime,
			model: backing.model,
			workingDirectories: backing.workingDirectories,
		};
	}

	listChatsToMigrate(): Promise<AgentChatMigrationResult> {
		return Promise.resolve([]);
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

	private _backingFromProviderData(chat: URI, providerData: string): IGrokBuildChatBacking | undefined {
		const decoded = decodeGrokBuildChat(providerData);
		if (!decoded) {
			return undefined;
		}
		return {
			chat,
			sessionId: decoded.sessionId,
			model: decoded.model,
			startTime: Date.now(),
			modifiedTime: Date.now(),
			turns: [],
		};
	}

	private _storeBacking(chat: URI, persisted: IGrokBuildPersistedChat, workingDirectories: readonly URI[] | undefined): IGrokBuildChatBacking {
		const now = Date.now();
		const backing: IGrokBuildChatBacking = {
			chat,
			sessionId: persisted.sessionId,
			model: persisted.model,
			startTime: now,
			modifiedTime: now,
			workingDirectories,
			turns: [],
		};
		this._backings.set(chatKey(chat), backing);
		this._sessionToChat.set(persisted.sessionId, chat);
		return backing;
	}

	private _persistProviderData(backing: IGrokBuildChatBacking): string {
		return encodeGrokBuildChat({ sessionId: backing.sessionId, model: backing.model });
	}

	private _emitProviderDataChange(chat: URI, backing: IGrokBuildChatBacking): void {
		const providerData = this._persistProviderData(backing);
		this._onDidChangeChatData.fire({ chat, providerData });
	}

	private async _createChat(chat: URI, context: URI | IAgentChatContext, options?: IAgentCreateChatOptions): Promise<IAgentCreateChatResult | void> {
		resolveAgentChatContext(context, chat);
		const client = await this._ensureConnection();
		const workingDirectories = options?.workingDirectories;
		const cwd = workingDirectories?.[0]?.fsPath ?? process.cwd();

		let sessionNew;
		try {
			sessionNew = await client.request('session/new', { cwd, mcpServers: [] });
		} catch (err) {
			rethrowAcpFailure(err);
		}

		applyModelState(models => this._models.set(models, undefined), this.id, sessionNew.models);

		if (options?.model?.id) {
			try {
				await client.request('session/set_model', {
					sessionId: sessionNew.sessionId,
					modelId: options.model.id,
				});
			} catch (err) {
				rethrowAcpFailure(err);
			}
		}

		const persisted: IGrokBuildPersistedChat = {
			sessionId: sessionNew.sessionId,
			model: options?.model,
		};
		const backing = this._storeBacking(chat, persisted, workingDirectories);
		const providerData = this._persistProviderData(backing);
		const result: IAgentCreateChatResult = {
			providerData,
			project: options?.project,
			resolvedWorkingDirectory: workingDirectories?.[0],
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
		const client = await this._ensureConnection();
		const turn = turnId ?? generateUuid();
		const workingDirectories = this._resolveWorkingDirectories(workingDirectoriesOrDirectory);
		if (workingDirectories) {
			backing.workingDirectories = workingDirectories;
		}

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
			// agentSideEffects maps a rejected sendMessage; do not also fire ChatError.
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
		if (!client) {
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
		const client = await this._ensureConnection();
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

	private async _disposeChat(chat: URI, closeSession: boolean): Promise<void> {
		const key = chatKey(chat);
		const backing = this._backings.get(key);
		if (!backing) {
			return;
		}
		this._cancelPendingPermissionsForChat(chat);
		if (closeSession) {
			const client = this._connection?.client;
			if (client) {
				try {
					await client.request('session/close', { sessionId: backing.sessionId });
				} catch (err) {
					this._logService.trace(`[GrokBuild] session/close failed: ${err instanceof Error ? err.message : String(err)}`);
				}
			}
		}
		this._sessionToChat.delete(backing.sessionId);
		this._backings.delete(key);
		this._activeClients.delete(key);
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

	private _finalizeTurn(backing: IGrokBuildChatBacking, turnId: string, state: TurnState, usage: Turn['usage']): void {
		const userText = backing.turnUserText ?? '';
		const assistantMarkdown = backing.turnAssistantMarkdown ?? '';
		backing.turns.push({ id: turnId, userText, assistantMarkdown, state, usage });
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

	private async _ensureConnection(): Promise<IAcpClient> {
		if (this._testClient && this._connection?.client === this._testClient) {
			return this._testClient;
		}
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
		const resolved = this._testSpawn
			? { path: configuredPath?.trim() || 'grok', version: undefined as string | undefined }
			: await resolveGrokBinary(configuredPath);
		const clientName = this._productService.nameShort || 'Code - OSS';
		const clientVersion = this._productService.version || '0.0.0';
		const launch = buildGrokBuildLaunchConfig(resolved.path, process.env, clientName, clientVersion);

		this._logService.info(`[GrokBuild] spawning ACP from ${launch.binaryPath}`);

		let child: ChildProcessWithoutNullStreams | undefined;
		let transport: IAcpTransport;
		let onSpawnDispose: (() => void) | undefined;

		if (this._testSpawn) {
			const spawned = this._testSpawn(launch);
			transport = spawned.transport;
			child = spawned.child;
			onSpawnDispose = spawned.onDispose;
		} else {
			child = spawn(launch.binaryPath, [...launch.args], {
				stdio: ['pipe', 'pipe', 'pipe'],
				env: launch.env,
			});
			child.stderr.setEncoding('utf8');
			child.stderr.on('data', chunk => {
				this._logService.trace(`[GrokBuild stderr] ${String(chunk).trimEnd()}`);
			});
			transport = transportFromChildProcess(child);
		}

		const client = new AcpClient(transport, (level, message) => {
			if (level === 'error') {
				this._logService.error(`[GrokBuild ACP] ${message}`);
			} else {
				this._logService.trace(`[GrokBuild ACP] ${message}`);
			}
		});

		const store = new DisposableStore();
		store.add(client);
		if (onSpawnDispose) {
			store.add(toDisposable(onSpawnDispose));
		}
		this._wireClient(client, store);

		const failConnection = (err: Error) => {
			this._logService.error(`[GrokBuild] process/transport error: ${err.message}`);
			client.rejectAllPending(err);
			this._cancelAllPendingPermissions();
			if (this._connection?.client === client || !this._connection) {
				// During handshake `_connection` is still unset; dispose the local store.
				if (this._connection?.client === client) {
					this._disposeConnection();
				} else {
					store.dispose();
					if (child && child.exitCode === null && child.signalCode === null) {
						try {
							child.kill('SIGTERM');
						} catch {
							// already dead
						}
					}
				}
			}
		};

		store.add(client.onExit(e => {
			this._logService.warn(`[GrokBuild] ACP exited code=${e.code} signal=${e.signal}`);
			this._cancelAllPendingPermissions();
			if (this._connection?.client === client) {
				this._disposeConnection();
			}
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
			store.dispose();
			if (child && child.exitCode === null && child.signalCode === null) {
				try {
					child.kill('SIGTERM');
				} catch {
					// already dead
				}
			}
			rethrowAcpFailure(err);
		}

		// Publish only after a successful handshake so concurrent createChat
		// callers await `_connectionInFlight` instead of an un-handshaked client.
		this._connection = { client, child, store };
		return client;
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
		const chat = this._sessionToChat.get(params.sessionId);
		if (!chat) {
			return;
		}
		const backing = this._backings.get(chatKey(chat));
		if (!backing?.activeTurnId || !backing.mapState) {
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

	private _disposeConnection(): void {
		const connection = this._connection;
		this._connection = undefined;
		if (!connection) {
			return;
		}
		connection.store.dispose();
		if (connection.child && connection.child.exitCode === null && connection.child.signalCode === null) {
			try {
				connection.child.kill('SIGTERM');
			} catch {
				// already dead
			}
		}
		if (this._testClient === connection.client) {
			this._testClient = undefined;
		}
	}
}
