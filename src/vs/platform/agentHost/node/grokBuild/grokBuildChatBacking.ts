/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { ModelSelection } from '../../common/state/sessionState.js';

/**
 * Opaque per-chat backing persisted by the orchestrator and returned on restore.
 *
 * `sessionId` is the ACP session id from `session/new`. `cwd` is the absolute
 * working directory (host worktree or folder) last given to `session/new`,
 * `session/load`, or `session/resume`. History itself is not stored here —
 * `session/load` replays it into `Turn[]`.
 */
export interface IGrokBuildPersistedChat {
	readonly sessionId: string;
	readonly model?: ModelSelection;
	readonly cwd?: string;
	/**
	 * Last reasoning effort applied with `session/set_config_option`, or the
	 * value grok reported when the user has not chosen one. Re-applied after
	 * `session/load` when grok's `currentValue` differs.
	 */
	readonly reasoningEffort?: string;
	/**
	 * Last non-zero context-window gauge (`_meta.totalTokens` / compaction).
	 * Seeded on restore when the session/load replay under-reports tokens.
	 */
	readonly contextTokens?: number;
}

export function encodeGrokBuildChat(chat: IGrokBuildPersistedChat): string {
	return JSON.stringify(chat);
}

export function decodeGrokBuildChat(data: string | undefined): IGrokBuildPersistedChat | undefined {
	if (data === undefined) {
		return undefined;
	}
	try {
		const parsed = JSON.parse(data);
		if (parsed && typeof parsed.sessionId === 'string') {
			const cwd = typeof parsed.cwd === 'string' && parsed.cwd.length > 0 ? parsed.cwd : undefined;
			const fromModel = parsed.model?.config?.thinkingLevel;
			const reasoningEffort = typeof parsed.reasoningEffort === 'string' && parsed.reasoningEffort.length > 0
				? parsed.reasoningEffort
				: typeof fromModel === 'string' && fromModel.length > 0 ? fromModel : undefined;
			const contextTokens = typeof parsed.contextTokens === 'number'
				&& Number.isFinite(parsed.contextTokens)
				&& parsed.contextTokens > 0
				? parsed.contextTokens
				: undefined;
			return {
				sessionId: parsed.sessionId,
				model: parsed.model,
				cwd,
				reasoningEffort,
				contextTokens,
			};
		}
	} catch {
		// fall through
	}
	return undefined;
}
