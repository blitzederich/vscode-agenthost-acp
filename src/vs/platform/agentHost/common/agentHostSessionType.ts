/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { FileAccess, type AppResourcePath } from '../../../base/common/network.js';
import { ThemeIcon } from '../../../base/common/themables.js';
import { localize } from '../../../nls.js';
import { getIconRegistry, registerIcon } from '../../theme/common/iconRegistry.js';
import { GROK_BUILD_AGENT_PROVIDER_ID, type AgentProvider } from './agent.js';

const LOCAL_AGENT_HOST_SESSION_TYPE_PREFIX = 'agent-host-';
const REMOTE_AGENT_HOST_SESSION_TYPE_PREFIX = 'remote-';

/**
 * Dedicated icon-font id for the official Grok logomark (not upstream codicons).
 * Font sources live under `common/media/grokBuild/` — see README there.
 */
const GROK_BUILD_ICON_FONT_ID = 'grok-build';
const GROK_BUILD_ICON_FONT_WOFF: AppResourcePath = 'vs/platform/agentHost/common/media/grokBuild/grok-build.woff';
const GROK_BUILD_ICON_FONT_TTF: AppResourcePath = 'vs/platform/agentHost/common/media/grokBuild/grok-build.ttf';
/** Private-use code point assigned when generating the single-glyph font. */
const GROK_BUILD_ICON_FONT_CHARACTER = '\\E001';

const grokBuildIconFont = getIconRegistry().registerIconFont(GROK_BUILD_ICON_FONT_ID, {
	src: [
		{ location: FileAccess.asBrowserUri(GROK_BUILD_ICON_FONT_WOFF), format: 'woff' },
		{ location: FileAccess.asBrowserUri(GROK_BUILD_ICON_FONT_TTF), format: 'truetype' },
	],
});

/**
 * Shared icon for the Grok Build agent-host harness / session type.
 * Use this wherever the harness itself is represented (session list, picker,
 * harness presentation). Per-model xAI icons stay independent (`chat-model-provider-xai`).
 */
export const GrokBuildAgentHostIcon: ThemeIcon = registerIcon('grok-build', {
	fontCharacter: GROK_BUILD_ICON_FONT_CHARACTER,
	font: { id: GROK_BUILD_ICON_FONT_ID, definition: grokBuildIconFont },
}, localize('grokBuildAgentHostIcon', 'Icon for the Grok Build agent host harness.'));

/** Identifies the Grok Build agent-host provider id exactly (not a substring match). */
export function isGrokBuildAgentHostProvider(provider: string): boolean {
	return provider === GROK_BUILD_AGENT_PROVIDER_ID;
}

/** Identifies the Copilot agent family without changing the host's provider ID or implying runtime capabilities. */
export function isCopilotAgentHostProvider(provider: AgentProvider | undefined): boolean {
	return provider === 'copilotcli' || provider === 'copilot';
}

/** Identifies local and remote Copilot agent-host session types, preserving their existing URI schemes. */
export function isCopilotAgentHostSessionType(sessionType: string): boolean {
	const provider = parseAgentHostHarness(sessionType);
	return provider !== undefined && isCopilotAgentHostProvider(provider)
		&& (!isRemoteAgentHostSessionType(sessionType) || parseRemoteAgentHostSessionTypeAuthority(sessionType, provider) !== undefined);
}

/**
 * Builds the unique per-connection identifier for a remote agent host.
 *
 * This string is used as the resource URI scheme registered via
 * `registerChatSessionContentProvider` and as the language model vendor /
 * `targetChatSessionType` published by `AgentHostLanguageModelProvider`.
 */
export function remoteAgentHostSessionTypeId(connectionAuthority: string, agentProvider: AgentProvider): string {
	return `${remoteAgentHostSessionTypeAuthorityPrefix(connectionAuthority)}${agentProvider}`;
}

/**
 * Builds the authority-specific prefix for remote agent host session types.
 */
export function remoteAgentHostSessionTypeAuthorityPrefix(connectionAuthority: string): string {
	return `${REMOTE_AGENT_HOST_SESSION_TYPE_PREFIX}${connectionAuthority}-`;
}

/**
 * Returns whether the given session type uses the remote agent host scheme.
 */
export function isRemoteAgentHostSessionType(sessionType: string): boolean {
	return sessionType.startsWith(REMOTE_AGENT_HOST_SESSION_TYPE_PREFIX);
}

/**
 * Finds the best matching remote agent host authority from a known candidate set.
 *
 * Remote session types are formatted as `remote-{authority}-{provider}` and
 * authorities may contain `-`, so callers should match against the full set of
 * known authorities instead of splitting the session type.
 */
export function findRemoteAgentHostSessionTypeAuthority(sessionType: string, connectionAuthorities: Iterable<string>): string | undefined {
	if (!isRemoteAgentHostSessionType(sessionType)) {
		return undefined;
	}

	let bestMatch: string | undefined;
	for (const authority of connectionAuthorities) {
		if (isRemoteAgentHostSessionTypeForAuthority(sessionType, authority) && (!bestMatch || authority.length > bestMatch.length)) {
			bestMatch = authority;
		}
	}
	return bestMatch;
}

function isRemoteAgentHostSessionTypeForAuthority(sessionType: string, connectionAuthority: string): boolean {
	return !!connectionAuthority && sessionType.startsWith(remoteAgentHostSessionTypeAuthorityPrefix(connectionAuthority));
}

/**
 * Extracts the harness/provider suffix from a remote agent host session type.
 *
 * Remote session types are formatted as `remote-{authority}-{provider}`. The
 * authority may contain `-`, but provider names do not, so the harness is the
 * final `-`-delimited segment. Returns `undefined` for non-remote session types.
 */
export function parseRemoteAgentHostHarness(sessionType: string): string | undefined {
	if (!isRemoteAgentHostSessionType(sessionType)) {
		return undefined;
	}
	const lastDash = sessionType.lastIndexOf('-');
	const harness = sessionType.slice(lastDash + 1);
	return harness || undefined;
}

/**
 * Extracts the logical harness/provider from a local or remote agent-host session type.
 */
export function parseAgentHostHarness(sessionType: string): string | undefined {
	if (sessionType.startsWith(LOCAL_AGENT_HOST_SESSION_TYPE_PREFIX)) {
		return sessionType.slice(LOCAL_AGENT_HOST_SESSION_TYPE_PREFIX.length) || undefined;
	}
	return parseRemoteAgentHostHarness(sessionType);
}

/**
 * Extracts the connection authority from a remote agent host session type when the provider is known.
 */
export function parseRemoteAgentHostSessionTypeAuthority(sessionType: string, agentProvider: AgentProvider): string | undefined {
	if (!isRemoteAgentHostSessionType(sessionType)) {
		return undefined;
	}

	const providerSuffix = `-${agentProvider}`;
	if (!sessionType.endsWith(providerSuffix)) {
		return undefined;
	}

	const authority = sessionType.slice(REMOTE_AGENT_HOST_SESSION_TYPE_PREFIX.length, sessionType.length - providerSuffix.length);
	return authority || undefined;
}
