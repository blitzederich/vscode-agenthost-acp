/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { ModelSelection } from '../../common/state/sessionState.js';

/**
 * Opaque per-chat backing persisted by the orchestrator and returned on restore.
 *
 * `sessionId` is the ACP session id from `session/new`. Stage 1 keeps history
 * in memory only; Stage 2 will use `session/load` / `session/resume`.
 */
export interface IGrokBuildPersistedChat {
	readonly sessionId: string;
	readonly model?: ModelSelection;
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
			return parsed as IGrokBuildPersistedChat;
		}
	} catch {
		// fall through
	}
	return undefined;
}
