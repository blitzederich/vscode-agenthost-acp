/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { AgentPermissionKind } from '../../../common/agent.js';
import { chatReducer } from '../../../common/state/protocol/reducers.js';
import { ActionType, type ChatAction } from '../../../common/state/sessionActions.js';
import { ChatOriginKind, ResponsePartKind, SessionStatus, type ChatState } from '../../../common/state/sessionState.js';
import {
	createGrokBuildMapState,
	mapPermissionRequest,
	mapSessionUpdate,
	mapTurnCompleted,
	mapTurnStarted,
	mapUsage,
	selectPermissionOptionId,
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
});
