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
			return {
				sessionId: parsed.sessionId,
				model: parsed.model,
				cwd,
			};
		}
	} catch {
		// fall through
	}
	return undefined;
}
