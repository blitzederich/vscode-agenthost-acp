/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { AgentPermissionKind } from '../../../common/agent.js';
import { ActionType } from '../../../common/state/sessionActions.js';
import {
	createGrokBuildMapState,
	mapPermissionRequest,
	mapSessionUpdate,
	mapTurnCompleted,
	mapTurnStarted,
	mapUsage,
	selectPermissionOptionId,
} from '../../../node/grokBuild/grokBuildMapSessionUpdates.js';

suite('GrokBuild mapSessionUpdates', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('maps turn started, thought, message, usage, and complete', () => {
		const state = createGrokBuildMapState('turn-1');
		const started = mapTurnStarted('turn-1', 'hello');
		assert.strictEqual(started[0].type, ActionType.ChatTurnStarted);

		const thought = mapSessionUpdate(state, {
			sessionId: 's',
			update: {
				sessionUpdate: 'agent_thought_chunk',
				content: { type: 'text', text: 'thinking' },
			},
		});
		assert.strictEqual(thought[0].type, ActionType.ChatReasoning);

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

		const usage = mapUsage('turn-1', { inputTokens: 10, outputTokens: 5 });
		assert.strictEqual(usage[0].type, ActionType.ChatUsage);

		const complete = mapTurnCompleted('turn-1', 'end_turn');
		assert.strictEqual(complete[0].type, ActionType.ChatTurnComplete);

		const cancelled = mapTurnCompleted('turn-1', 'cancelled');
		assert.strictEqual(cancelled[0].type, ActionType.ChatTurnCancelled);
	});

	test('maps edit tool_call and completed update with diff (wire2 shapes)', () => {
		const state = createGrokBuildMapState('turn-1');
		const start = mapSessionUpdate(state, {
			sessionId: 's',
			update: {
				sessionUpdate: 'tool_call',
				toolCallId: 'call-93ba0c9f-14b6-432c-a460-56750fe64cdd-0',
				title: 'search_replace',
				rawInput: { file_path: '/tmp/grok-acp-probe/hello.txt', old_string: '', new_string: 'hi\n' },
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
		assert.ok(start.some(a => a.type === ActionType.ChatToolCallReady));
		const entry = state.toolCalls.get('call-93ba0c9f-14b6-432c-a460-56750fe64cdd-0');
		assert.strictEqual(entry?.toolName, 'file_edit');
		assert.strictEqual(entry?.permissionKind, AgentPermissionKind.Write);

		const update = mapSessionUpdate(state, {
			sessionId: 's',
			update: {
				sessionUpdate: 'tool_call_update',
				toolCallId: 'call-93ba0c9f-14b6-432c-a460-56750fe64cdd-0',
				kind: 'edit',
				title: 'Edit `/tmp/grok-acp-probe/hello.txt`',
				content: [{ type: 'diff', path: '/tmp/grok-acp-probe/hello.txt', oldText: '', newText: 'hi\n' }],
				locations: [{ path: '/tmp/grok-acp-probe/hello.txt' }],
				rawInput: { file_path: '/tmp/grok-acp-probe/hello.txt', old_string: '', new_string: 'hi\n' },
			},
		});
		assert.ok(update.some(a => a.type === ActionType.ChatToolCallContentChanged));

		const done = mapSessionUpdate(state, {
			sessionId: 's',
			update: {
				sessionUpdate: 'tool_call_update',
				toolCallId: 'call-93ba0c9f-14b6-432c-a460-56750fe64cdd-0',
				status: 'completed',
				content: [{ type: 'diff', path: '/tmp/grok-acp-probe/hello.txt', oldText: '', newText: 'hi\n' }],
				rawOutput: { type: 'SearchReplace' },
			},
		});
		assert.ok(done.some(a => a.type === ActionType.ChatToolCallComplete));
	});

	test('ignores unknown x.ai session updates and notifications kinds', () => {
		const state = createGrokBuildMapState('turn-1');
		for (const kind of [
			'available_commands_update',
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

	test('permission request maps to pending_confirmation and option selection', () => {
		const state = createGrokBuildMapState('turn-1');
		mapSessionUpdate(state, {
			sessionId: 's',
			update: {
				sessionUpdate: 'tool_call',
				toolCallId: 'call-1',
				title: 'search_replace',
				rawInput: { file_path: '/tmp/hello.txt' },
				_meta: { 'x.ai/tool': { name: 'search_replace', kind: 'edit', label: 'Edit' } },
			},
		});

		const options = [
			{ optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
			{ optionId: 'allow-always', name: 'Allow always', kind: 'allow_always' },
			{ optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
		] as const;

		const mapped = mapPermissionRequest(
			URI.parse('grokBuild://chat/1'),
			'turn-1',
			{
				sessionId: 's',
				toolCall: { toolCallId: 'call-1', title: 'Edit file' },
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
