/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { AgentPermissionKind } from '../../../common/agent.js';
import { readUsageInfoMeta } from '../../../common/meta/agentUsageMeta.js';
import { grokBuildTodoListMetaKey } from '../../../common/meta/agentToolCallMeta.js';
import { chatReducer } from '../../../common/state/protocol/reducers.js';
import { ActionType, type ChatAction } from '../../../common/state/sessionActions.js';
import { ChatOriginKind, ResponsePartKind, SessionStatus, ToolResultContentType, type ChatState } from '../../../common/state/sessionState.js';
import { ContextSizeConfigKey } from '../../../common/agentModelConfiguration.js';
import {
	createGrokBuildMapState,
	createGrokContextSizeConfigSchemaProperty,
	GROK_ASK_USER_DISPLAY_NAME,
	GROK_COPILOT_USAGE_INFO_KEY,
	GROK_PRESENT_PLAN_DISPLAY_NAME,
	mapExitPlanContent,
	mapPermissionRequest,
	mapSessionUpdate,
	mapTurnCompleted,
	mapTurnStarted,
	mapUsage,
	markGrokClientToolExecutionStarted,
	readGrokCompactionCurrentTokens,
	readGrokContextWindows,
	readGrokCurrentModelContextWindow,
	readGrokMaxContextWindow,
	readGrokModelChangedContextWindow,
	readGrokTotalTokens,
	selectPermissionOptionId,
	toGrokUsageInfo,
	withGrokContextUsage,
} from '../../../node/grokBuild/grokBuildMapSessionUpdates.js';

function makeChat(): ChatState {
	const now = new Date(Date.now()).toISOString();
	return {
		resource: 'ahp-chat://test',
		title: 'Test',
		status: SessionStatus.Idle,
		modifiedAt: now,
		origin: { kind: ChatOriginKind.User },
		turns: [],
		activeTurn: undefined,
	};
}

suite('GrokBuild mapSessionUpdates', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('maps turn started, thought (with Reasoning part seed), message, usage, and complete', () => {
		const state = createGrokBuildMapState('turn-1');
		let chat = chatReducer(makeChat(), mapTurnStarted('turn-1', 'hello')[0] as ChatAction);

		const thought = mapSessionUpdate(state, {
			sessionId: 's',
			update: {
				sessionUpdate: 'agent_thought_chunk',
				content: { type: 'text', text: 'thinking' },
			},
		});
		assert.strictEqual(thought[0].type, ActionType.ChatResponsePart);
		assert.strictEqual((thought[0] as { part: { kind: string } }).part.kind, ResponsePartKind.Reasoning);
		assert.strictEqual(thought[1].type, ActionType.ChatReasoning);

		for (const action of thought) {
			chat = chatReducer(chat, action as ChatAction);
		}
		const reasoning = chat.activeTurn?.responseParts.find(p => p.kind === ResponsePartKind.Reasoning);
		assert.ok(reasoning);
		assert.strictEqual((reasoning as { content: string }).content, 'thinking');

		const first = mapSessionUpdate(state, {
			sessionId: 's',
			update: {
				sessionUpdate: 'agent_message_chunk',
				content: { type: 'text', text: 'Hi' },
			},
		});
		assert.strictEqual(first[0].type, ActionType.ChatResponsePart);

		const delta = mapSessionUpdate(state, {
			sessionId: 's',
			update: {
				sessionUpdate: 'agent_message_chunk',
				content: { type: 'text', text: ' there' },
			},
		});
		assert.strictEqual(delta[0].type, ActionType.ChatDelta);

		const usage = mapUsage('turn-1', { inputTokens: 10, outputTokens: 5, cachedReadTokens: 3 });
		assert.strictEqual(usage[0].type, ActionType.ChatUsage);
		assert.strictEqual((usage[0] as { usage: { cacheReadTokens?: number } }).usage.cacheReadTokens, 3);

		const complete = mapTurnCompleted('turn-1', 'end_turn');
		assert.strictEqual(complete[0].type, ActionType.ChatTurnComplete);

		const cancelled = mapTurnCompleted('turn-1', 'cancelled');
		assert.strictEqual(cancelled[0].type, ActionType.ChatTurnCancelled);
	});

	test('first tool_call classifies shell from x.ai/tool when top-level kind is absent', () => {
		const state = createGrokBuildMapState('turn-1');
		const actions = mapSessionUpdate(state, {
			sessionId: 's',
			update: {
				sessionUpdate: 'tool_call',
				toolCallId: 'call-live-0',
				title: 'run_terminal_command',
				rawInput: { command: 'env' },
				_meta: {
					'x.ai/tool': {
						version: 1,
						name: 'run_terminal_command',
						kind: 'execute',
						namespace: 'grok_build',
						label: 'Run Command',
						read_only: false,
					},
				},
			},
		});
		const start = actions.find(action => action.type === ActionType.ChatToolCallStart);
		assert.ok(start);
		assert.strictEqual(start.type, ActionType.ChatToolCallStart);
		if (start.type === ActionType.ChatToolCallStart) {
			assert.strictEqual(start.toolName, 'shell');
		}
	});

	test('maps edit tool_call and resets markdownPartId for post-tool text', () => {
		const state = createGrokBuildMapState('turn-1');
		mapSessionUpdate(state, {
			sessionId: 's',
			update: {
				sessionUpdate: 'agent_message_chunk',
				content: { type: 'text', text: 'before' },
			},
		});
		assert.ok(state.markdownPartId);
		const firstPartId = state.markdownPartId;

		const start = mapSessionUpdate(state, {
			sessionId: 's',
			update: {
				sessionUpdate: 'tool_call',
				toolCallId: 'call-93ba0c9f-14b6-432c-a460-56750fe64cdd-0',
				title: 'search_replace',
				kind: 'edit',
				rawInput: {
					variant: 'SearchReplace',
					file_path: '/tmp/grok-acp-probe/hello.txt',
					old_string: '',
					new_string: 'hi\n',
					replace_all: false,
				},
				_meta: {
					'x.ai/tool': {
						name: 'search_replace',
						kind: 'edit',
						namespace: 'grok_build',
						label: 'Edit',
						read_only: false,
					},
				},
			},
		});
		assert.ok(start.some(a => a.type === ActionType.ChatToolCallStart));
		assert.strictEqual(state.markdownPartId, undefined);

		const after = mapSessionUpdate(state, {
			sessionId: 's',
			update: {
				sessionUpdate: 'agent_message_chunk',
				content: { type: 'text', text: 'after' },
			},
		});
		assert.strictEqual(after[0].type, ActionType.ChatResponsePart);
		assert.notStrictEqual(state.markdownPartId, firstPartId);
	});

	test('ignores unknown x.ai session updates and notifications kinds', () => {
		const state = createGrokBuildMapState('turn-1');
		for (const kind of [
			'available_commands_update',
			'config_option_update',
			'tool_call_delta_chunk',
			'response_completed',
			'turn_completed',
			'session_info_update',
			'session_summary_generated',
			'pending_interaction',
			'interaction_resolved',
			'future_unknown_kind',
		]) {
			const actions = mapSessionUpdate(state, {
				sessionId: 's',
				update: { sessionUpdate: kind },
			});
			assert.deepStrictEqual(actions, [], kind);
		}
	});

	test('permission request maps live option ids', () => {
		const state = createGrokBuildMapState('turn-1');
		mapSessionUpdate(state, {
			sessionId: 's',
			update: {
				sessionUpdate: 'tool_call',
				toolCallId: 'call-1',
				title: 'Edit `/tmp/hello.txt`',
				kind: 'edit',
				rawInput: {
					variant: 'SearchReplace',
					file_path: '/tmp/hello.txt',
					old_string: 'original',
					new_string: 'changed',
					replace_all: false,
				},
				_meta: { 'x.ai/tool': { name: 'search_replace', kind: 'edit', label: 'Edit' } },
			},
		});

		const options = [
			{ optionId: 'allow-edits-session', name: 'Yes, allow all edits during this session', kind: 'allow_always' },
			{ optionId: 'allow-once', name: 'Yes', kind: 'allow_once' },
			{ optionId: 'reject-once', name: 'No, and tell Grok what to do differently', kind: 'reject_once' },
		] as const;

		const mapped = mapPermissionRequest(
			URI.parse('grokBuild://chat/1'),
			'turn-1',
			{
				sessionId: 's',
				toolCall: {
					toolCallId: 'call-1',
					kind: 'edit',
					title: 'Edit `/tmp/hello.txt`',
					rawInput: {
						variant: 'SearchReplace',
						file_path: '/tmp/hello.txt',
						old_string: 'original',
						new_string: 'changed',
						replace_all: false,
					},
				},
				options,
			},
			state,
		);
		assert.ok(mapped);
		assert.strictEqual(mapped!.signal.kind, 'pending_confirmation');
		assert.strictEqual(mapped!.signal.permissionKind, AgentPermissionKind.Write);
		assert.strictEqual(mapped!.toolCallId, 'call-1');
		assert.strictEqual(selectPermissionOptionId(options, true), 'allow-once');
		assert.strictEqual(selectPermissionOptionId(options, false), 'reject-once');
	});

	test('todo_write owns the turn when a plan update follows it', () => {
		const state = createGrokBuildMapState('turn-1');
		const tool = mapSessionUpdate(state, {
			sessionId: 's',
			update: {
				sessionUpdate: 'tool_call',
				toolCallId: 'todo-1',
				status: 'completed',
				title: 'todo_write',
				rawInput: {
					todos: [{ id: 'tokenize', content: 'tokenize', status: 'in_progress' }],
					merge: false,
				},
				_meta: { 'x.ai/tool': { name: 'todo_write', kind: 'plan', label: 'Plan' } },
			},
		});
		const plan = mapSessionUpdate(state, {
			sessionId: 's',
			update: {
				sessionUpdate: 'plan',
				entries: [
					{ content: 'tokenize', priority: 'medium', status: 'in_progress' },
					{ content: 'ship', priority: 'low', status: 'pending' },
				],
			},
		});
		assert.deepStrictEqual(plan, []);
		const starts = tool.filter(action => action.type === ActionType.ChatToolCallStart);
		assert.strictEqual(starts.length, 1);
		const start = starts[0];
		if (start.type !== ActionType.ChatToolCallStart) {
			assert.fail('missing todo tool call');
		}
		assert.strictEqual(start.toolName, 'manage_todo_list');
		assert.strictEqual(start._meta?.[grokBuildTodoListMetaKey], true);
		const ready = tool.find(action => action.type === ActionType.ChatToolCallReady);
		if (!ready || ready.type !== ActionType.ChatToolCallReady) {
			assert.fail('missing todo tool input');
		}
		assert.deepStrictEqual(JSON.parse(String(ready.toolInput)), {
			todoList: [{ id: 'tokenize', title: 'tokenize', status: 'in-progress' }],
		});
		assert.strictEqual(ready._meta?.[grokBuildTodoListMetaKey], true);
	});

	test('plan updates still render when todo_write has not arrived', () => {
		const state = createGrokBuildMapState('turn-1');
		const first = mapSessionUpdate(state, {
			sessionId: 's',
			update: {
				sessionUpdate: 'plan',
				entries: [{ content: 'tokenize', priority: 'medium', status: 'in_progress' }],
			},
		});
		const second = mapSessionUpdate(state, {
			sessionId: 's',
			update: {
				sessionUpdate: 'plan',
				entries: [{ content: 'tokenize', priority: 'medium', status: 'completed' }],
			},
		});
		const laterTool = mapSessionUpdate(state, {
			sessionId: 's',
			update: {
				sessionUpdate: 'tool_call',
				toolCallId: 'todo-2',
				status: 'completed',
				rawInput: { todos: [{ id: 'tokenize', content: 'tokenize', status: 'completed' }], merge: true },
				_meta: { 'x.ai/tool': { name: 'todo_write', kind: 'plan' } },
			},
		});
		assert.deepStrictEqual(laterTool, []);
		const ids = [first, second].map(actions => {
			const start = actions.find(action => action.type === ActionType.ChatToolCallStart);
			assert.ok(start && start.type === ActionType.ChatToolCallStart);
			assert.strictEqual(start.toolName, 'manage_todo_list');
			assert.strictEqual(start._meta?.[grokBuildTodoListMetaKey], true);
			return start.toolCallId;
		});
		assert.notStrictEqual(ids[0], ids[1]);
	});

	test('spawn_subagent kind task renders as a subagent task call', () => {
		const state = createGrokBuildMapState('turn-1');
		const actions = mapSessionUpdate(state, {
			sessionId: 's',
			update: {
				sessionUpdate: 'tool_call',
				toolCallId: 'sub-1',
				status: 'completed',
				title: 'Subagent',
				rawInput: { description: 'List current directory', prompt: 'List the files in this directory.', background: false },
				_meta: { 'x.ai/tool': { name: 'spawn_subagent', kind: 'task', label: 'Subagent' } },
			},
		});
		const start = actions.find(action => action.type === ActionType.ChatToolCallStart);
		assert.ok(start && start.type === ActionType.ChatToolCallStart);
		assert.strictEqual(start.toolName, 'task');
		assert.strictEqual(start._meta?.toolKind, 'subagent');
		assert.strictEqual(start._meta?.subagentDescription, 'List current directory');
	});

	test('exit_plan tool cards use Present plan and hide placeholder input', () => {
		const state = createGrokBuildMapState('turn-1');
		const start = mapSessionUpdate(state, {
			sessionId: 's',
			update: {
				sessionUpdate: 'tool_call',
				toolCallId: 'call-exit',
				title: 'exit_plan_mode',
				rawInput: {},
				_meta: { 'x.ai/tool': { name: 'exit_plan_mode', kind: 'exit_plan', label: 'Exit Plan Mode', read_only: true } },
			},
		});
		const startAction = start.find(action => action.type === ActionType.ChatToolCallStart);
		assert.ok(startAction && startAction.type === ActionType.ChatToolCallStart);
		assert.strictEqual(startAction.displayName, GROK_PRESENT_PLAN_DISPLAY_NAME);
		const ready = start.find(action => action.type === ActionType.ChatToolCallReady);
		assert.ok(ready && ready.type === ActionType.ChatToolCallReady);
		assert.strictEqual(ready.toolInput, '');
		assert.ok(!start.some(action => action.type === ActionType.ChatToolCallDelta && (action as { content?: string }).content === '{}'));

		const update = mapSessionUpdate(state, {
			sessionId: 's',
			update: {
				sessionUpdate: 'tool_call_update',
				toolCallId: 'call-exit',
				title: 'Plan: Exit',
				rawInput: { variant: 'ExitPlanMode' },
				_meta: { 'x.ai/tool': { name: 'exit_plan_mode', kind: 'exit_plan', label: 'Exit Plan Mode', read_only: true } },
			},
		});
		assert.ok(!update.some(action => {
			if (action.type !== ActionType.ChatToolCallDelta) {
				return false;
			}
			const content = action.content ?? '';
			return content.includes('ExitPlanMode') || content === '{}';
		}));

		const planActions = mapExitPlanContent(state, 'call-exit', '# Ship it');
		assert.ok(planActions.some(action => action.type === ActionType.ChatToolCallContentChanged));
		assert.ok(!planActions.some(action => action.type === ActionType.ChatToolCallDelta), 'plan should render once via content, not also as tool input delta');
		const content = planActions.find(action => action.type === ActionType.ChatToolCallContentChanged);
		assert.ok(content && content.type === ActionType.ChatToolCallContentChanged);
		assert.deepStrictEqual(content.content, [{ type: ToolResultContentType.Text, text: '# Ship it' }]);
	});

	test('nested text content blocks become tool result and failure text', () => {
		const state = createGrokBuildMapState('turn-1');
		mapSessionUpdate(state, {
			sessionId: 's',
			update: {
				sessionUpdate: 'tool_call',
				toolCallId: 'call-fail',
				title: 'search_replace',
				kind: 'edit',
				rawInput: { file_path: '/tmp/a.txt' },
				_meta: { 'x.ai/tool': { name: 'search_replace', kind: 'edit', label: 'Edit' } },
			},
		});
		const failed = mapSessionUpdate(state, {
			sessionId: 's',
			update: {
				sessionUpdate: 'tool_call_update',
				toolCallId: 'call-fail',
				status: 'failed',
				content: [{ type: 'content', content: { type: 'text', text: 'User rejected the execution for tool `search_replace`' } }],
			},
		});
		const complete = failed.find(action => action.type === ActionType.ChatToolCallComplete);
		assert.ok(complete && complete.type === ActionType.ChatToolCallComplete);
		assert.strictEqual(complete.result.success, false);
		assert.strictEqual(complete.result.error?.message, 'User rejected the execution for tool `search_replace`');
		assert.ok(complete.result.content?.some(block => block.type === ToolResultContentType.Text && block.text.includes('User rejected')));
	});

	test('normal tools prefer rawOutput over ACP content text', () => {
		const state = createGrokBuildMapState('turn-1');
		mapSessionUpdate(state, {
			sessionId: 's',
			update: {
				sessionUpdate: 'tool_call',
				toolCallId: 'call-grep',
				title: 'grep',
				rawInput: { pattern: 'foo' },
				_meta: { 'x.ai/tool': { name: 'grep', kind: 'search', label: 'Grep' } },
			},
		});
		const completed = mapSessionUpdate(state, {
			sessionId: 's',
			update: {
				sessionUpdate: 'tool_call_update',
				toolCallId: 'call-grep',
				status: 'completed',
				content: [{ type: 'content', content: { type: 'text', text: 'found 40 matches' } }],
				rawOutput: 'src/a.ts:1:foo\nsrc/b.ts:2:foo\n',
			},
		});
		const complete = completed.find(action => action.type === ActionType.ChatToolCallComplete);
		assert.ok(complete && complete.type === ActionType.ChatToolCallComplete);
		assert.strictEqual(complete.result.success, true);
		assert.ok(complete.result.content?.some(block => block.type === ToolResultContentType.Text && block.text === 'src/a.ts:1:foo\nsrc/b.ts:2:foo\n'));
		assert.ok(!complete.result.content?.some(block => block.type === ToolResultContentType.Text && block.text === 'found 40 matches'));
	});

	test('ask_user tool cards keep Ask User label and prefer content / UserAnswered.message', () => {
		const state = createGrokBuildMapState('turn-1');
		const start = mapSessionUpdate(state, {
			sessionId: 's',
			update: {
				sessionUpdate: 'tool_call',
				toolCallId: 'call-ask',
				title: 'ask_user_question',
				rawInput: { questions: [{ question: 'Q?', options: [{ label: 'A', description: 'a' }], multiSelect: null }] },
				_meta: { 'x.ai/tool': { name: 'ask_user_question', kind: 'ask_user', label: 'Ask User', read_only: true } },
			},
		});
		const startAction = start.find(action => action.type === ActionType.ChatToolCallStart);
		assert.ok(startAction && startAction.type === ActionType.ChatToolCallStart);
		assert.strictEqual(startAction.displayName, GROK_ASK_USER_DISPLAY_NAME);
		assert.strictEqual(startAction.toolName, 'ask_user_question');

		const titleOnly = mapSessionUpdate(state, {
			sessionId: 's',
			update: {
				sessionUpdate: 'tool_call_update',
				toolCallId: 'call-ask',
				kind: 'other',
				title: 'Ask: Q?',
				rawInput: { variant: 'AskUserQuestion', questions: [{ question: 'Q?', options: [{ label: 'A', description: 'a' }], multiSelect: null }] },
			},
		});
		assert.ok(!titleOnly.some(action => action.type === ActionType.ChatToolCallComplete));
		assert.strictEqual(state.toolCalls.get('call-ask')?.displayName, GROK_ASK_USER_DISPLAY_NAME);

		const declined = 'User declined to answer the questions. Continue with the task using your best judgment, or ask different questions.';
		const withContent = mapSessionUpdate(state, {
			sessionId: 's',
			update: {
				sessionUpdate: 'tool_call_update',
				toolCallId: 'call-ask',
				status: 'completed',
				content: [{ type: 'content', content: { type: 'text', text: declined } }],
				rawOutput: { type: 'AskUserQuestion', UserAnswered: { message: declined } },
			},
		});
		const complete = withContent.find(action => action.type === ActionType.ChatToolCallComplete);
		assert.ok(complete && complete.type === ActionType.ChatToolCallComplete);
		assert.strictEqual(complete.result.success, true);
		assert.strictEqual(complete.result.pastTenseMessage, GROK_ASK_USER_DISPLAY_NAME);
		assert.ok(complete.result.content?.some(block => block.type === ToolResultContentType.Text && block.text === declined));
		assert.ok(!complete.result.content?.some(block => block.type === ToolResultContentType.Text && block.text.includes('"type":"AskUserQuestion"')));

		const state2 = createGrokBuildMapState('turn-2');
		mapSessionUpdate(state2, {
			sessionId: 's',
			update: {
				sessionUpdate: 'tool_call',
				toolCallId: 'call-ask-2',
				title: 'ask_user_question',
				_meta: { 'x.ai/tool': { name: 'ask_user_question', kind: 'ask_user', label: 'Ask User', read_only: true } },
			},
		});
		const messageOnly = 'User has answered your questions: "Q?"="A" … You can now continue with the user\'s answers in mind.';
		const rawOnly = mapSessionUpdate(state2, {
			sessionId: 's',
			update: {
				sessionUpdate: 'tool_call_update',
				toolCallId: 'call-ask-2',
				status: 'completed',
				rawOutput: { type: 'AskUserQuestion', UserAnswered: { message: messageOnly } },
			},
		});
		const complete2 = rawOnly.find(action => action.type === ActionType.ChatToolCallComplete);
		assert.ok(complete2 && complete2.type === ActionType.ChatToolCallComplete);
		assert.strictEqual(complete2.result.pastTenseMessage, GROK_ASK_USER_DISPLAY_NAME);
		assert.ok(complete2.result.content?.some(block => block.type === ToolResultContentType.Text && block.text === messageOnly));
		assert.ok(!JSON.stringify(complete2.result.content).includes('"type":"AskUserQuestion"'));
	});

	test('five-call turn: last-call inputTokens 31897, turn totals 131894', () => {
		const meta = {
			inputTokens: 31897,
			outputTokens: 50,
			cachedReadTokens: 29056,
			totalTokens: 31954,
			usage: {
				inputTokens: 131894,
				outputTokens: 331,
				cachedReadTokens: 100000,
				totalTokens: 132225,
				modelCalls: 5,
			},
		};
		const info = toGrokUsageInfo(meta, 'grok-4.7');
		assert.strictEqual(info?.inputTokens, 31897);
		assert.strictEqual(info?.outputTokens, 50);
		assert.strictEqual(info?.cacheReadTokens, 29056);
		assert.deepStrictEqual(readUsageInfoMeta(info).turnTokenTotals, [{
			model: 'grok-4.7',
			inputTokens: 131894,
			cachedTokens: 100000,
			outputTokens: 331,
		}]);

		const actions = mapUsage('turn-2', meta, 'grok-4.7');
		assert.strictEqual(actions.length, 1);
		assert.strictEqual(actions[0].type, ActionType.ChatUsage);
		if (actions[0].type === ActionType.ChatUsage) {
			assert.strictEqual(actions[0].usage.inputTokens, 31897);
			assert.strictEqual(readUsageInfoMeta(actions[0].usage).turnTokenTotals?.[0]?.inputTokens, 131894);
		}
	});

	test('older grok usage-only meta falls back to usage fields', () => {
		const info = toGrokUsageInfo({ usage: { inputTokens: 20167, outputTokens: 31, cachedReadTokens: 2176 } }, 'grok-4.7');
		assert.strictEqual(info?.inputTokens, 20167);
		assert.strictEqual(info?.outputTokens, 31);
		assert.strictEqual(info?.cacheReadTokens, 2176);
		assert.deepStrictEqual(readUsageInfoMeta(info).turnTokenTotals, [{
			model: 'grok-4.7',
			inputTokens: 20167,
			cachedTokens: 2176,
			outputTokens: 31,
		}]);
	});

	test('maxContextWindow from totalContextTokens only (ignores session contextWindow)', () => {
		assert.strictEqual(readGrokMaxContextWindow({ totalContextTokens: 256000 }), 256000);
		assert.strictEqual(readGrokMaxContextWindow({ totalContextTokens: 256000, contextWindow: 500000 }), 256000);
		assert.strictEqual(readGrokMaxContextWindow({ contextWindow: 500000 }), undefined);
		assert.strictEqual(readGrokMaxContextWindow({ totalContextTokens: 0 }), undefined);
		assert.strictEqual(readGrokMaxContextWindow({ contextWindow: -1 }), undefined);
		assert.strictEqual(readGrokMaxContextWindow(undefined), undefined);
	});

	test('current model entry _meta.contextWindow is the restored selection', () => {
		assert.strictEqual(readGrokCurrentModelContextWindow({
			currentModelId: 'grok-4.7',
			availableModels: [
				{ modelId: 'other', _meta: { contextWindow: 256000 } },
				{ modelId: 'grok-4.7', _meta: { totalContextTokens: 256000, contextWindows: [256000, 500000], contextWindow: 500000 } },
			],
		}), 500000);
		assert.strictEqual(readGrokCurrentModelContextWindow({
			currentModelId: 'grok-4.7',
			availableModels: [{ modelId: 'grok-4.7', _meta: { totalContextTokens: 256000, contextWindows: [256000, 500000] } }],
		}), undefined);
		assert.strictEqual(readGrokCurrentModelContextWindow(undefined), undefined);
	});

	test('contextSize schema only when contextWindows offers more than one size', () => {
		assert.deepStrictEqual(readGrokContextWindows({ contextWindows: [256000, 500000] }), [256000, 500000]);
		const multi = createGrokContextSizeConfigSchemaProperty({ totalContextTokens: 256000, contextWindows: [256000, 500000] });
		assert.ok(multi);
		assert.deepStrictEqual(multi.enum, [256000, 500000]);
		assert.strictEqual(multi.default, 256000);
		assert.strictEqual(createGrokContextSizeConfigSchemaProperty({ totalContextTokens: 256000, contextWindows: [256000] }), undefined);
		assert.strictEqual(createGrokContextSizeConfigSchemaProperty({ totalContextTokens: 256000 }), undefined);
		assert.strictEqual(ContextSizeConfigKey, 'contextSize');
	});

	test('totalTokens 0 is ignored; compaction sessionUpdate shapes lower context', () => {
		assert.strictEqual(readGrokTotalTokens({ totalTokens: 31954 }), 31954);
		assert.strictEqual(readGrokTotalTokens({ totalTokens: 0 }), undefined);
		assert.strictEqual(readGrokCompactionCurrentTokens({
			sessionId: 's',
			update: { sessionUpdate: 'auto_compact_completed', tokens_after: 14345 },
		}), 14345);
		assert.strictEqual(readGrokCompactionCurrentTokens({
			sessionId: 's',
			update: { sessionUpdate: 'auto_compact_completed', tokens_before: 32001, tokens_after: 14345 },
		}), 14345);
		assert.strictEqual(readGrokCompactionCurrentTokens({
			sessionId: 's',
			update: {
				sessionUpdate: 'auto_compact_started',
				tokens_used: 28000,
				context_window: 256000,
				percentage: 85,
			},
		}), 28000);
		assert.strictEqual(readGrokCompactionCurrentTokens({
			sessionId: 's',
			notification: { type: 'auto_compact_completed', tokens_after: 14345 },
		}), undefined);
	});

	test('model_changed context_window_selection sets or clears the override', () => {
		assert.deepStrictEqual(readGrokModelChangedContextWindow({
			sessionId: 's',
			update: { sessionUpdate: 'model_changed', model_id: 'grok-4.7', context_window_selection: 500000 },
		}), { selection: 500000 });
		assert.deepStrictEqual(readGrokModelChangedContextWindow({
			sessionId: 's',
			update: { sessionUpdate: 'model_changed', model_id: 'grok-4.7' },
		}), { selection: undefined });
		assert.strictEqual(readGrokModelChangedContextWindow({
			sessionId: 's',
			update: { sessionUpdate: 'auto_compact_started', tokens_used: 1, context_window: 256000 },
		}), undefined);
	});

	test('withGrokContextUsage merges without dropping other keys', () => {
		const merged = withGrokContextUsage({ keep: true, other: 1 }, {
			currentTokens: 21866,
			tokenLimit: 256000,
			messagesLength: 5,
		});
		assert.strictEqual(merged.keep, true);
		assert.strictEqual(merged.other, 1);
		assert.deepStrictEqual(merged[GROK_COPILOT_USAGE_INFO_KEY], {
			currentTokens: 21866,
			tokenLimit: 256000,
			messagesLength: 5,
		});
	});

	test('tracks live use_tool client__ without emitting a card until pre-MCP failure', () => {
		const state = createGrokBuildMapState('turn-client', { clientMcpAttached: true });
		const start = mapSessionUpdate(state, {
			sessionId: 's',
			update: {
				sessionUpdate: 'tool_call',
				toolCallId: 'grok-client-1',
				title: 'use_tool',
				kind: 'other',
				status: 'pending',
				rawInput: { tool_name: 'client__workspace_echo', tool_input: { msg: 'hi' } },
				_meta: { 'x.ai/tool': { name: 'use_tool', namespace: 'grok_build' } },
			},
		});
		assert.deepStrictEqual(start, []);
		assert.strictEqual(state.toolCalls.get('grok-client-1')?.toolName, 'workspace_echo');
		assert.strictEqual(state.toolCalls.get('grok-client-1')?.started, false);

		const titled = mapSessionUpdate(state, {
			sessionId: 's',
			update: {
				sessionUpdate: 'tool_call_update',
				toolCallId: 'grok-client-1',
				title: 'client__workspace_echo',
				kind: 'other',
				status: 'in_progress',
			},
		});
		assert.deepStrictEqual(titled, []);

		const failed = mapSessionUpdate(state, {
			sessionId: 's',
			update: {
				sessionUpdate: 'tool_call_update',
				toolCallId: 'grok-client-1',
				title: 'client__workspace_echo',
				status: 'failed',
				rawOutput: { error: 'boom before mcp' },
			},
		});
		assert.strictEqual(failed.length, 3);
		assert.strictEqual(failed[0]!.type, ActionType.ChatToolCallStart);
		assert.strictEqual((failed[0] as { toolName: string }).toolName, 'workspace_echo');
		assert.strictEqual((failed[0] as { contributor?: unknown }).contributor, undefined);
		assert.strictEqual(failed[1]!.type, ActionType.ChatToolCallReady);
		assert.strictEqual((failed[1] as { confirmed?: string }).confirmed, 'not-needed');
		assert.strictEqual(failed[2]!.type, ActionType.ChatToolCallComplete);
		assert.strictEqual((failed[2] as { result: { success: boolean } }).result.success, false);
	});

	test('ignores grok terminal updates after Client execution started', () => {
		const state = createGrokBuildMapState('turn-client-done', { clientMcpAttached: true });
		mapSessionUpdate(state, {
			sessionId: 's',
			update: {
				sessionUpdate: 'tool_call',
				toolCallId: 'grok-client-2',
				title: 'use_tool',
				status: 'pending',
				rawInput: { tool_name: 'client__workspace_echo', tool_input: { msg: 'hi' } },
				_meta: { 'x.ai/tool': { name: 'use_tool', namespace: 'grok_build' } },
			},
		});
		markGrokClientToolExecutionStarted(state, 'grok-client-2', 'workspace_echo', { msg: 'hi' });
		const done = mapSessionUpdate(state, {
			sessionId: 's',
			update: {
				sessionUpdate: 'tool_call_update',
				toolCallId: 'grok-client-2',
				title: 'client__workspace_echo',
				status: 'completed',
				rawOutput: { type: 'MCP', output: 'ok' },
			},
		});
		assert.deepStrictEqual(done, []);
	});

	test('leaves use_tool client__ untouched when our client MCP server is off', () => {
		const state = createGrokBuildMapState('turn-user-client', { clientMcpAttached: false });
		const start = mapSessionUpdate(state, {
			sessionId: 's',
			update: {
				sessionUpdate: 'tool_call',
				toolCallId: 'user-mcp-1',
				title: 'use_tool',
				status: 'pending',
				rawInput: { tool_name: 'client__workspace_echo', tool_input: { msg: 'hi' } },
				_meta: { 'x.ai/tool': { name: 'use_tool', namespace: 'grok_build' } },
			},
		});
		assert.ok(start.some(a => a.type === ActionType.ChatToolCallStart));
		const startAction = start.find(a => a.type === ActionType.ChatToolCallStart) as {
			toolName: string;
			displayName: string;
			contributor?: unknown;
		};
		assert.strictEqual(startAction.toolName, 'use_tool');
		assert.strictEqual(startAction.displayName, 'use_tool');
		assert.strictEqual(startAction.contributor, undefined);
		assert.ok(start.some(a => a.type === ActionType.ChatToolCallReady));
	});
});
