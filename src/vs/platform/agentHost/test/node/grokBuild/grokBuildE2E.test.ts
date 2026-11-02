/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * CI-safe Grok Build end-to-end.
 *
 * grok 1.0.70 cannot replay a turn through `--xai-api-base-url` without a
 * real login. Without credentials, `initialize` works and
 * `authenticate { methodId: "grok.com" }` hangs; `session/new` then fails
 * with "Authentication required" and grok does not call that URL. A dummy
 * `XAI_API_KEY` makes grok request `GET /models` and `/api-key` there, but
 * authenticate still hangs. This file therefore spawns a fake ACP process
 * through the real stdio path and a temporary HOME. It never stats the real home.
 */

import assert from 'assert';
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { Event } from '../../../../../base/common/event.js';
import { join } from '../../../../../base/common/path.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../log/common/log.js';
import type { IProductService } from '../../../../product/common/productService.js';
import { fixedChatOwnerRef, GROK_BUILD_AGENT_PROVIDER_ID, type AgentSignal, type IAgentChatContext } from '../../../common/agent.js';
import type { ChatInputRequestWithPlanReview } from '../../../common/agentHostPlanReview.js';
import { ActionType } from '../../../common/state/sessionActions.js';
import { ChatInputAnswerState, ChatInputAnswerValueKind, ChatInputResponseKind, ResponsePartKind, type Turn } from '../../../common/state/sessionState.js';
import { SessionConfigKey } from '../../../common/sessionConfigKeys.js';
import { GrokBuildAgent } from '../../../node/grokBuild/grokBuildAgent.js';
import { GROK_BUILD_ACP_ARGV } from '../../../node/grokBuild/grokBuildLaunchConfig.js';
import { IAgentConfigurationService } from '../../../node/agentConfigurationService.js';

const FAKE_ACP_AGENT = `#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { writeFileSync } from 'node:fs';

const report = process.env.GROK_E2E_REPORT;
const events = [];
const note = (event) => {
	events.push(event);
	if (report) {
		writeFileSync(report, JSON.stringify({
			home: process.env.HOME ?? null,
			argv: process.argv.slice(2),
			events,
		}));
	}
};
if (report) {
	note({ type: 'boot' });
}

const reply = (id, result) => {
	process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n');
};
const notify = (method, params) => {
	process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\\n');
};

let nextServerId = 1000;
let pendingPromptId = undefined;
let modeId = 'default';
let expectPermissionAfterApprove = false;

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', line => {
	const trimmed = line.trim();
	if (!trimmed) {
		return;
	}
	let msg;
	try {
		msg = JSON.parse(trimmed);
	} catch {
		return;
	}
	if (msg.method === 'initialize') {
		reply(msg.id, {
			protocolVersion: 1,
			agentCapabilities: { loadSession: false },
			authMethods: [{ id: 'grok.com' }],
		});
	} else if (msg.method === 'authenticate') {
		reply(msg.id, {});
	} else if (msg.method === 'session/new') {
		reply(msg.id, {
			sessionId: 'e2e-session',
			models: {
				currentModelId: 'replay-model',
				availableModels: [{ modelId: 'replay-model', name: 'Replay' }],
			},
		});
	} else if (msg.method === 'session/set_mode') {
		modeId = msg.params?.modeId ?? modeId;
		note({ type: 'set_mode', modeId });
		reply(msg.id, {});
		notify('session/update', {
			sessionId: msg.params.sessionId,
			update: { sessionUpdate: 'current_mode_update', currentModeId: modeId },
		});
	} else if (msg.method === 'session/prompt') {
		pendingPromptId = msg.id;
		const text = Array.isArray(msg.params?.prompt)
			? msg.params.prompt.map(block => block?.text ?? '').join('')
			: '';
		if (modeId === 'plan' || /\\bplan\\b/i.test(text)) {
			notify('session/update', {
				sessionId: msg.params.sessionId,
				update: {
					sessionUpdate: 'tool_call',
					toolCallId: 'call-e2e-exit',
					title: 'exit_plan_mode',
					rawInput: {},
					_meta: { 'x.ai/tool': { name: 'exit_plan_mode', kind: 'exit_plan', label: 'Exit Plan Mode', read_only: true } },
				},
			});
			notify('session/update', {
				sessionId: msg.params.sessionId,
				update: {
					sessionUpdate: 'tool_call_update',
					toolCallId: 'call-e2e-exit',
					title: 'Plan: Exit',
					rawInput: { variant: 'ExitPlanMode' },
					_meta: { 'x.ai/tool': { name: 'exit_plan_mode', kind: 'exit_plan', label: 'Exit Plan Mode', read_only: true } },
				},
			});
			const id = nextServerId++;
			note({ type: 'exit_plan_mode_request', id });
			process.stdout.write(JSON.stringify({
				jsonrpc: '2.0',
				id,
				method: '_x.ai/exit_plan_mode',
				params: {
					sessionId: msg.params.sessionId,
					toolCallId: 'call-e2e-exit',
					planContent: '# E2E plan\\n\\n- write REPLAY-OK\\n',
				},
			}) + '\\n');
		} else {
			notify('session/update', {
				sessionId: msg.params.sessionId,
				update: {
					sessionUpdate: 'agent_message_chunk',
					content: { type: 'text', text: 'REPLAY-OK' },
				},
			});
			reply(msg.id, { stopReason: 'end_turn' });
			pendingPromptId = undefined;
		}
	} else if (msg.method === undefined && msg.id !== undefined && Object.prototype.hasOwnProperty.call(msg, 'result')) {
		note({ type: 'client_result', id: msg.id, result: msg.result });
		if (msg.result?.outcome === 'approved') {
			expectPermissionAfterApprove = true;
			modeId = 'default';
			notify('session/update', {
				sessionId: 'e2e-session',
				update: { sessionUpdate: 'current_mode_update', currentModeId: 'default' },
			});
			notify('session/update', {
				sessionId: 'e2e-session',
				update: {
					sessionUpdate: 'tool_call_update',
					toolCallId: 'call-e2e-exit',
					status: 'completed',
					title: 'Plan mode exited',
					content: [{ type: 'content', content: { type: 'text', text: 'Plan file: /tmp/plan.md' } }],
				},
			});
			notify('session/update', {
				sessionId: 'e2e-session',
				update: {
					sessionUpdate: 'tool_call',
					toolCallId: 'call-e2e-edit',
					title: 'Edit hello.txt',
					kind: 'edit',
					rawInput: { file_path: '/tmp/hello.txt', new_string: 'ok' },
					_meta: { 'x.ai/tool': { name: 'search_replace', kind: 'edit', label: 'Edit' } },
				},
			});
			const permId = nextServerId++;
			note({ type: 'permission_request', id: permId });
			process.stdout.write(JSON.stringify({
				jsonrpc: '2.0',
				id: permId,
				method: 'session/request_permission',
				params: {
					sessionId: 'e2e-session',
					toolCall: {
						toolCallId: 'call-e2e-edit',
						kind: 'edit',
						title: 'Edit hello.txt',
						rawInput: { file_path: '/tmp/hello.txt', new_string: 'ok' },
						_meta: { 'x.ai/tool': { name: 'search_replace', kind: 'edit', label: 'Edit' } },
					},
					options: [
						{ optionId: 'allow-once', name: 'Yes', kind: 'allow_once' },
						{ optionId: 'reject-once', name: 'No', kind: 'reject_once' },
					],
				},
			}) + '\\n');
		} else if (msg.result?.outcome?.outcome === 'selected' && expectPermissionAfterApprove && pendingPromptId !== undefined) {
			note({ type: 'permission_result', result: msg.result });
			notify('session/update', {
				sessionId: 'e2e-session',
				update: {
					sessionUpdate: 'agent_message_chunk',
					content: { type: 'text', text: 'REPLAY-OK' },
				},
			});
			reply(pendingPromptId, { stopReason: 'end_turn' });
			pendingPromptId = undefined;
			expectPermissionAfterApprove = false;
		}
	} else if (msg.id !== undefined && msg.method) {
		reply(msg.id, {});
	}
});
rl.on('close', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
`;

class TestProductService {
	readonly _serviceBrand: undefined;
	readonly version = '1.145.0';
	readonly nameShort = 'Code - OSS';
	readonly nameLong = 'Code - OSS';
	readonly applicationName = 'code-oss';
	readonly dataFolderName = '.vscode-oss';
	readonly urlProtocol = 'code-oss';
	readonly quality = 'stable';
	readonly commit = 'test';
	readonly date = undefined;
	readonly vscodeVersion = '1.145.0';
}

function chatContext(chat: URI): IAgentChatContext {
	const owner = URI.from({ scheme: GROK_BUILD_AGENT_PROVIDER_ID, path: '/session' });
	return {
		resource: chat,
		owner: fixedChatOwnerRef(owner),
		sessionSettings: undefined,
		launchWorkingDirectories: undefined,
		workspaceless: false,
	};
}

function markdownOf(turn: Turn): string {
	return turn.responseParts
		.filter(part => part.kind === ResponsePartKind.Markdown)
		.map(part => part.kind === ResponsePartKind.Markdown ? part.content : '')
		.join('');
}

suite('Grok Build e2e', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	async function withFakeGrokHome<T>(options: {
		readonly getChatConfigValues?: () => Record<string, unknown> | undefined;
	}, run: (args: {
		readonly agent: GrokBuildAgent;
		readonly home: string;
		readonly root: string;
		readonly reportPath: string;
	}) => Promise<T>): Promise<T> {
		const root = await mkdtemp(join(tmpdir(), 'grok-build-e2e-'));
		const home = join(root, 'home');
		const reportPath = join(root, 'report.json');
		const binaryPath = join(root, 'fake-grok.mjs');
		await writeFile(binaryPath, FAKE_ACP_AGENT, { mode: 0o755 });
		await chmod(binaryPath, 0o755);
		const previousHome = process.env.HOME;
		const previousProfile = process.env.USERPROFILE;
		const previousKey = process.env.XAI_API_KEY;
		const previousReport = process.env.GROK_E2E_REPORT;
		process.env.HOME = home;
		process.env.USERPROFILE = home;
		process.env.GROK_E2E_REPORT = reportPath;
		delete process.env.XAI_API_KEY;
		const configurationService = {
			onDidChatConfigChange: Event.None,
			getChatConfigValues: options.getChatConfigValues ?? (() => undefined),
			updateChatConfig: () => undefined,
		} as unknown as IAgentConfigurationService;
		const agent = store.add(new GrokBuildAgent(new NullLogService(), new TestProductService() as unknown as IProductService, configurationService));
		agent.bindTestBinaryResolver(async () => ({ path: binaryPath, version: '1.0.70' }));
		try {
			return await run({ agent, home, root, reportPath });
		} finally {
			agent.dispose();
			if (previousHome === undefined) {
				delete process.env.HOME;
			} else {
				process.env.HOME = previousHome;
			}
			if (previousProfile === undefined) {
				delete process.env.USERPROFILE;
			} else {
				process.env.USERPROFILE = previousProfile;
			}
			if (previousKey === undefined) {
				delete process.env.XAI_API_KEY;
			} else {
				process.env.XAI_API_KEY = previousKey;
			}
			if (previousReport === undefined) {
				delete process.env.GROK_E2E_REPORT;
			} else {
				process.env.GROK_E2E_REPORT = previousReport;
			}
			await rm(root, { recursive: true, force: true });
		}
	}

	test('fake ACP process replays a recorded turn without credentials or the real grok home', async () => {
		await withFakeGrokHome({}, async ({ agent, home, root, reportPath }) => {
			const chat = URI.from({ scheme: GROK_BUILD_AGENT_PROVIDER_ID, path: '/chat/e2e' });
			const context = chatContext(chat);
			const created = await agent.chats.createChat(chat, context, { workingDirectories: [URI.file(root)] });
			assert.ok(created?.providerData);
			await agent.chats.sendMessage(chat, 'replay please', [URI.file(root)], undefined, 'turn-e2e', undefined, context);
			const messages = await agent.chats.getMessages(chat, context);
			assert.strictEqual(messages.length, 1);
			assert.strictEqual(markdownOf(messages[0]), 'REPLAY-OK');

			const report = JSON.parse(await readFile(reportPath, 'utf8')) as { home: string; argv: string[] };
			assert.strictEqual(report.home, home);
			assert.ok(report.argv.includes('--permission-mode'));
			assert.strictEqual(report.argv[report.argv.indexOf('--permission-mode') + 1], 'default');
			assert.ok(!report.argv.includes('--always-approve'));
			assert.deepStrictEqual(report.argv, [...GROK_BUILD_ACP_ARGV]);
			await assert.rejects(stat(join(home, '.grok', 'auth.json')));
		});
	});

	test('plan mode exit_plan_mode approve then permission still reaches the UI', async () => {
		await withFakeGrokHome({
			getChatConfigValues: () => ({ [SessionConfigKey.Mode]: 'plan' }),
		}, async ({ agent, root, reportPath }) => {
			const chat = URI.from({ scheme: GROK_BUILD_AGENT_PROVIDER_ID, path: '/chat/e2e-plan' });
			const context = chatContext(chat);
			const signals: AgentSignal[] = [];
			store.add(agent.onDidChatProgress(signal => signals.push(signal)));

			const created = await agent.chats.createChat(chat, context, {
				workingDirectories: [URI.file(root)],
				config: { [SessionConfigKey.Mode]: 'plan' },
			});
			assert.ok(created?.providerData);

			const send = agent.chats.sendMessage(chat, 'please plan', [URI.file(root)], undefined, 'turn-e2e-plan', undefined, context);
			const review = await new Promise<ChatInputRequestWithPlanReview>((resolve, reject) => {
				const timer = setTimeout(() => reject(new Error('timeout waiting for plan review')), 5_000);
				const check = () => {
					const found = signals.map(signal => signal.kind === 'action' && signal.action.type === ActionType.ChatInputRequested
						? signal.action.request as ChatInputRequestWithPlanReview
						: undefined).find(request => request?.planReview);
					if (found) {
						clearTimeout(timer);
						resolve(found);
					}
				};
				store.add(agent.onDidChatProgress(() => check()));
				check();
			});
			assert.match(review.planReview!.content, /E2E plan/);
			agent.respondToUserInputRequest(review.id, ChatInputResponseKind.Accept, {
				[review.planReview!.answerQuestionId]: {
					state: ChatInputAnswerState.Submitted,
					value: { kind: ChatInputAnswerValueKind.Selected, value: 'approve' },
				},
			});

			const pending = await new Promise<Extract<AgentSignal, { kind: 'pending_confirmation' }>>((resolve, reject) => {
				const timer = setTimeout(() => reject(new Error('timeout waiting for permission')), 5_000);
				const check = () => {
					const found = signals.find(signal => signal.kind === 'pending_confirmation');
					if (found && found.kind === 'pending_confirmation') {
						clearTimeout(timer);
						resolve(found);
					}
				};
				store.add(agent.onDidChatProgress(() => check()));
				check();
			});
			agent.respondToPermissionRequest(pending.state.toolCallId, true);

			await send;
			const messages = await agent.chats.getMessages(chat, context);
			assert.strictEqual(markdownOf(messages[0]), 'REPLAY-OK');

			const report = JSON.parse(await readFile(reportPath, 'utf8')) as {
				argv: string[];
				events: Array<{ type: string; result?: { outcome?: unknown } }>;
			};
			assert.deepStrictEqual(report.argv, [...GROK_BUILD_ACP_ARGV]);
			assert.ok(report.events.some(event => event.type === 'client_result' && event.result?.outcome === 'approved'));
			assert.ok(report.events.some(event => event.type === 'permission_request'));
		});
	});
});
