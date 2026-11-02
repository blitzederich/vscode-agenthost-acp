/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { generateUuid } from '../../../../base/common/uuid.js';
import type { AcpSessionUpdate } from './protocol/acpTypes.js';

/**
 * One durable turn reconstructed from an ACP `session/load` replay.
 *
 * Live `getMessages` only stores the user prompt plus assistant markdown
 * (thoughts and tool calls are streamed as actions, not kept on the turn
 * record). Replay matches that shape. Turn boundaries follow ACP v1:
 * `user_message_chunk` starts a user message, `agent_message_chunk` appends
 * the reply. **To verify live** — grok 1.0.70's `session/load` body and
 * replay chunking are not in the attached logs.
 */
export interface IGrokReplayedTurn {
	readonly id: string;
	readonly userText: string;
	readonly assistantMarkdown: string;
}

export interface IGrokHistoryReplay {
	readonly sessionId: string;
	title?: string;
	readonly turns: IGrokReplayedTurn[];
	current?: {
		id: string;
		userText: string;
		assistantMarkdown: string;
		userMessageId?: string;
		sawAgent: boolean;
	};
}

export interface IGrokReplayedHistory {
	readonly turns: readonly IGrokReplayedTurn[];
	readonly title?: string;
}

export function createGrokHistoryReplay(sessionId: string): IGrokHistoryReplay {
	return { sessionId, turns: [] };
}

export function applyGrokHistoryUpdate(replay: IGrokHistoryReplay, update: AcpSessionUpdate | undefined): void {
	if (!update || typeof update.sessionUpdate !== 'string') {
		return;
	}
	if (update.sessionUpdate === 'session_info_update') {
		const title = readGrokSessionTitle(update);
		if (title) {
			replay.title = title;
		}
		return;
	}
	if (update.sessionUpdate === 'user_message_chunk') {
		const text = textFromContent((update as { content?: unknown }).content);
		const messageId = messageIdOf(update);
		const current = replay.current;
		const sameUser = !!current && !current.sawAgent && (messageId === undefined || messageId === current.userMessageId);
		if (current && !sameUser) {
			flushGrokHistoryTurn(replay);
		}
		if (!replay.current) {
			replay.current = {
				id: messageId ?? generateUuid(),
				userText: '',
				assistantMarkdown: '',
				userMessageId: messageId,
				sawAgent: false,
			};
		}
		replay.current.userText += text;
		if (messageId) {
			replay.current.userMessageId = messageId;
		}
		return;
	}
	if (update.sessionUpdate === 'agent_message_chunk') {
		const text = textFromContent((update as { content?: unknown }).content);
		if (!replay.current) {
			replay.current = {
				id: messageIdOf(update) ?? generateUuid(),
				userText: '',
				assistantMarkdown: '',
				sawAgent: true,
			};
		}
		replay.current.assistantMarkdown += text;
		replay.current.sawAgent = true;
	}
}

export function finishGrokHistoryReplay(replay: IGrokHistoryReplay): IGrokReplayedHistory {
	flushGrokHistoryTurn(replay);
	return {
		turns: replay.turns,
		title: replay.title,
	};
}

export function readGrokSessionTitle(update: AcpSessionUpdate | undefined): string | undefined {
	if (!update || update.sessionUpdate !== 'session_info_update') {
		return undefined;
	}
	const title = (update as { title?: unknown }).title;
	return typeof title === 'string' && title.trim().length > 0 ? title : undefined;
}

function flushGrokHistoryTurn(replay: IGrokHistoryReplay): void {
	const current = replay.current;
	replay.current = undefined;
	if (!current) {
		return;
	}
	if (current.userText.length === 0 && current.assistantMarkdown.length === 0) {
		return;
	}
	replay.turns.push({
		id: current.id,
		userText: current.userText,
		assistantMarkdown: current.assistantMarkdown,
	});
}

function messageIdOf(update: AcpSessionUpdate): string | undefined {
	const value = (update as { messageId?: unknown }).messageId;
	return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function textFromContent(content: unknown): string {
	if (Array.isArray(content)) {
		return content.map(textFromContent).join('');
	}
	if (!content || typeof content !== 'object') {
		return '';
	}
	const text = (content as { text?: unknown }).text;
	return typeof text === 'string' ? text : '';
}
