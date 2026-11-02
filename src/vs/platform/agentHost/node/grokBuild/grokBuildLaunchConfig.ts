/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { execFile } from 'child_process';
import { homedir } from 'os';
import { join } from '../../../../base/common/path.js';
import { isWindows } from '../../../../base/common/platform.js';
import { Promises } from '../../../../base/node/pfs.js';
import { findExecutable } from '../../../../base/node/processes.js';
import * as nls from '../../../../nls.js';
import { AgentHostGrokBuildBinaryPathEnvVar } from '../../common/agentService.js';

export { AgentHostGrokBuildBinaryPathEnvVar };

/** Client identity env vars passed to the spawned `grok` process. */
export const GROK_CLIENT_NAME_ENV = 'GROK_CLIENT_NAME';
export const GROK_CLIENT_VERSION_ENV = 'GROK_CLIENT_VERSION';

/**
 * Minimum major.minor.patch we accept. Confirmed against the 1.0.70 wire
 * logs used for fixtures; raise once a newer floor is verified live.
 *
 * TODO(live-grok): confirm `--version` output format on a logged-in install.
 */
export const GROK_BUILD_MIN_VERSION = '1.0.70';

export interface IGrokBuildResolvedBinary {
	readonly path: string;
	readonly version?: string;
}

export interface IGrokBuildLaunchConfig {
	readonly binaryPath: string;
	readonly args: readonly string[];
	readonly env: NodeJS.ProcessEnv;
}

/**
 * Localized error when the Grok CLI cannot be found.
 */
export function grokCliMissingError(): Error {
	return new Error(nls.localize(
		'grokBuild.cliMissing',
		"The Grok CLI was not found. Install it from https://x.ai/cli, or set chat.agentHost.grokBuildAgent.binaryPath to the `grok` binary.",
	));
}

/**
 * Localized error when ACP authentication fails / user is not logged in.
 * Never reads `~/.grok/auth.json`.
 */
export function grokNotLoggedInError(): Error {
	return new Error(nls.localize(
		'grokBuild.notLoggedIn',
		"Grok Build is not signed in. Run `grok auth login` in a terminal, or set the XAI_API_KEY environment variable, then try again.",
	));
}

export function grokVersionTooOldError(version: string): Error {
	return new Error(nls.localize(
		'grokBuild.versionTooOld',
		"Grok CLI version {0} is too old. Please upgrade to {1} or newer (https://x.ai/cli).",
		version,
		GROK_BUILD_MIN_VERSION,
	));
}

/**
 * Resolve the `grok` binary: setting/env → PATH → ~/.grok/bin/grok →
 * ~/.local/bin/grok.
 */
export async function resolveGrokBinaryPath(
	configuredPath: string | undefined,
	env: NodeJS.ProcessEnv = process.env,
	userHome: string = homedir(),
): Promise<string | undefined> {
	const candidates: string[] = [];
	const configured = (configuredPath?.trim() || env[AgentHostGrokBuildBinaryPathEnvVar]?.trim()) || undefined;
	if (configured) {
		candidates.push(configured);
	}

	const fromPath = await findExecutable('grok', undefined, undefined, env).catch(() => undefined);
	if (fromPath) {
		candidates.push(fromPath);
	}

	candidates.push(join(userHome, '.grok', 'bin', isWindows ? 'grok.exe' : 'grok'));
	candidates.push(join(userHome, '.local', 'bin', isWindows ? 'grok.exe' : 'grok'));

	const seen = new Set<string>();
	for (const candidate of candidates) {
		if (!candidate || seen.has(candidate)) {
			continue;
		}
		seen.add(candidate);
		if (await Promises.exists(candidate)) {
			return candidate;
		}
	}
	return undefined;
}

/**
 * Sync existence check used at host registration time (no version spawn).
 */
export async function isGrokBinaryAvailable(
	configuredPath: string | undefined,
	env: NodeJS.ProcessEnv = process.env,
	userHome: string = homedir(),
): Promise<boolean> {
	return (await resolveGrokBinaryPath(configuredPath, env, userHome)) !== undefined;
}

export function parseGrokVersion(output: string): string | undefined {
	const match = output.match(/(\d+\.\d+\.\d+)/);
	return match?.[1];
}

export function isGrokVersionAtLeast(version: string, minimum: string = GROK_BUILD_MIN_VERSION): boolean {
	const a = version.split('.').map(n => parseInt(n, 10));
	const b = minimum.split('.').map(n => parseInt(n, 10));
	for (let i = 0; i < Math.max(a.length, b.length); i++) {
		const av = a[i] ?? 0;
		const bv = b[i] ?? 0;
		if (av > bv) {
			return true;
		}
		if (av < bv) {
			return false;
		}
	}
	return true;
}

export async function readGrokVersion(binaryPath: string): Promise<string | undefined> {
	return new Promise(resolve => {
		execFile(binaryPath, ['--version'], { timeout: 5_000, windowsHide: true }, (err, stdout, stderr) => {
			if (err) {
				resolve(undefined);
				return;
			}
			resolve(parseGrokVersion(`${stdout}\n${stderr}`));
		});
	});
}

export async function resolveGrokBinary(
	configuredPath: string | undefined,
	env: NodeJS.ProcessEnv = process.env,
	userHome: string = homedir(),
): Promise<IGrokBuildResolvedBinary> {
	const path = await resolveGrokBinaryPath(configuredPath, env, userHome);
	if (!path) {
		throw grokCliMissingError();
	}
	const version = await readGrokVersion(path);
	if (version && !isGrokVersionAtLeast(version)) {
		throw grokVersionTooOldError(version);
	}
	return { path, version };
}

/**
 * Build argv + env for the Grok ACP stdio process.
 *
 * TODO(live-grok): verify exact flag names/placement with `grok --help`
 * (`--permission-mode default`, `--no-leader`) on a logged-in install. The
 * interactive permission mode MUST be forced so ACP
 * `session/request_permission` reaches VS Code even when the user's
 * `~/.grok/config.toml` sets always-approve.
 */
export function buildGrokBuildLaunchConfig(
	binaryPath: string,
	inheritedEnv: NodeJS.ProcessEnv,
	clientName: string,
	clientVersion: string,
): IGrokBuildLaunchConfig {
	const env: NodeJS.ProcessEnv = { ...inheritedEnv };
	env[GROK_CLIENT_NAME_ENV] = clientName;
	env[GROK_CLIENT_VERSION_ENV] = clientVersion;
	// Pass through XAI_API_KEY when present; never read ~/.grok/auth.json.
	// Do not touch the user's telemetry settings.

	return {
		binaryPath,
		args: [
			'--no-auto-update',
			'--no-leader',
			// Force interactive permissions for this process.
			'--permission-mode', 'default',
			'agent',
			'stdio',
		],
		env,
	};
}
