/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { generateUuid } from '../../../../base/common/uuid.js';
import type { AcpSessionUpdate } from './protocol/acpTypes.js';

/**
 * One durable turn reconstructed from an ACP `session/load` replay.
 *
 * grok 1.0.70 replays each user and assistant message as one chunk with no
 * `messageId`. Turn identity is `update._meta.promptIndex`. A `tool_call`
 * between two assistant messages joins those messages with a blank line.
 * Thoughts and tool calls are not stored on the turn.
 */
export interface IGrokReplayedTurn {
	readonly id: string;
	readonly userText: string;
	readonly assistantMarkdown: string;
	/** `user_message_chunk._meta.promptIndex` when grok sent one. */
	readonly promptIndex?: number;
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
		promptIndex?: number;
		sawAgent: boolean;
		pendingAssistantSeparator: boolean;
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
	if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') {
		if (replay.current && replay.current.assistantMarkdown.length > 0) {
			replay.current.pendingAssistantSeparator = true;
		}
		return;
	}
	if (update.sessionUpdate === 'user_message_chunk') {
		const text = textFromContent((update as { content?: unknown }).content);
		const messageId = messageIdOf(update);
		const promptIndex = promptIndexOf(update);
		const current = replay.current;
		if (promptIndex !== undefined) {
			if (!current || current.promptIndex !== promptIndex) {
				flushGrokHistoryTurn(replay);
				replay.current = newReplayTurn(messageId, promptIndex);
			}
			replay.current!.userText += text;
			if (messageId) {
				replay.current!.userMessageId = messageId;
			}
			return;
		}
		const sameUser = !!current && !current.sawAgent && (messageId === undefined || messageId === current.userMessageId);
		if (current && !sameUser) {
			flushGrokHistoryTurn(replay);
		}
		if (!replay.current) {
			replay.current = newReplayTurn(messageId, undefined);
		}
		replay.current.userText += text;
		if (messageId) {
			replay.current.userMessageId = messageId;
		}
		return;
	}
	if (update.sessionUpdate === 'agent_message_chunk') {
		const text = textFromContent((update as { content?: unknown }).content);
		const promptIndex = promptIndexOf(update);
		const current = replay.current;
		if (!current || (promptIndex !== undefined && current.promptIndex !== promptIndex)) {
			if (current) {
				flushGrokHistoryTurn(replay);
			}
			replay.current = newReplayTurn(messageIdOf(update), promptIndex);
		}
		const turn = replay.current!;
		if (turn.pendingAssistantSeparator && turn.assistantMarkdown.length > 0 && text.length > 0) {
			turn.assistantMarkdown += '\n\n';
		}
		turn.pendingAssistantSeparator = false;
		turn.assistantMarkdown += text;
		turn.sawAgent = true;
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

function newReplayTurn(messageId: string | undefined, promptIndex: number | undefined): NonNullable<IGrokHistoryReplay['current']> {
	return {
		id: messageId ?? generateUuid(),
		userText: '',
		assistantMarkdown: '',
		userMessageId: messageId,
		promptIndex,
		sawAgent: false,
		pendingAssistantSeparator: false,
	};
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
		promptIndex: current.promptIndex,
	});
}

function promptIndexOf(update: AcpSessionUpdate): number | undefined {
	const value = update._meta?.promptIndex;
	return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
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
