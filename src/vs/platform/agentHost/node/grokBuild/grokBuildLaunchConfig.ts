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
 * Minimum major.minor.patch we accept. Verified against
 * `grok --version` → `grok 1.0.70 (f50904eaee6c)`.
 */
export const GROK_BUILD_MIN_VERSION = '1.0.70';

/**
 * Exact argv for ACP stdio, verified against grok 1.0.70:
 * top-level `--permission-mode` (not after `agent`/`stdio`), and
 * `--no-leader` only after `agent`.
 */
export const GROK_BUILD_ACP_ARGV = [
	'--no-auto-update',
	'--permission-mode', 'default',
	'agent',
	'--no-leader',
	'stdio',
] as const;

export interface IGrokBuildResolvedBinary {
	readonly path: string;
	readonly version?: string;
	/** `grok --version` produced no semver. A parseable version is readable even when the process exits non-zero. */
	readonly versionUnreadable?: boolean;
	readonly versionOutput?: string;
}

export interface IGrokVersionRead {
	readonly version?: string;
	readonly output?: string;
	readonly unreadable: boolean;
}

export type GrokBinaryProbe = 'found' | 'not-installed' | 'explicit-path-missing';

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

export function grokHandshakeTimeoutError(phase: 'initialize' | 'authenticate'): Error {
	return new Error(nls.localize(
		'grokBuild.handshakeTimeout',
		"Timed out waiting for the Grok CLI to respond to {0}. Check that `grok` is installed and responsive.",
		phase,
	));
}

export function grokProcessExitedError(code: number | null, signal: NodeJS.Signals | null, stderrTail: string): Error {
	const base = nls.localize(
		'grokBuild.processExited',
		"The Grok CLI exited unexpectedly (code {0}, signal {1}).",
		code === null ? 'null' : String(code),
		signal ?? 'none',
	);
	return new Error(withStderrTail(base, stderrTail));
}

export function grokCannotRestoreSessionError(): Error {
	return new Error(nls.localize(
		'grokBuild.cannotRestore',
		"This Grok CLI cannot restore a previous session. It does not advertise session/load or session/resume.",
	));
}

export function grokWorkingDirectoryRejectedError(): Error {
	return new Error(nls.localize(
		'grokBuild.workingDirectoryFixed',
		"Grok Build cannot change the working directory of an existing session. The session can only be reloaded in the folder where it was created.",
	));
}

export function grokSessionMissingError(): Error {
	return new Error(nls.localize(
		'grokBuild.sessionMissing',
		"This Grok session no longer exists on this machine.",
	));
}

/** Last ~2 KB of grok stderr included in handshake and process-exit errors. */
export const GROK_STDERR_TAIL_MAX = 2048;

export function appendStderrTail(previous: string, chunk: string, max: number = GROK_STDERR_TAIL_MAX): string {
	const next = previous + chunk;
	return next.length <= max ? next : next.slice(next.length - max);
}

export function withStderrTail(message: string, stderrTail: string): string {
	const tail = stderrTail.trim();
	if (!tail) {
		return message;
	}
	const clipped = tail.length > GROK_STDERR_TAIL_MAX ? tail.slice(tail.length - GROK_STDERR_TAIL_MAX) : tail;
	return `${message}\n${clipped}`;
}

export function grokUnreadableVersionWarning(output: string | undefined): string {
	const shown = (output ?? '').trim().replace(/\s+/g, ' ').slice(0, 500);
	return nls.localize(
		'grokBuild.versionUnreadable',
		"Could not read the Grok CLI version from `grok --version`. The CLI will still be started. Output: {0}",
		shown || nls.localize('grokBuild.versionUnreadableEmpty', "(no output)"),
	);
}

/**
 * Resolve the `grok` binary: setting/env → PATH → ~/.grok/bin/grok →
 * ~/.local/bin/grok.
 *
 * When an explicit configured path is set but missing, returns `undefined`
 * without falling back to PATH (callers throw {@link grokCliMissingError}).
 */
export async function resolveGrokBinaryPath(
	configuredPath: string | undefined,
	env: NodeJS.ProcessEnv = process.env,
	userHome: string = homedir(),
): Promise<string | undefined> {
	const configured = (configuredPath?.trim() || env[AgentHostGrokBuildBinaryPathEnvVar]?.trim()) || undefined;
	if (configured) {
		if (await Promises.exists(configured)) {
			return configured;
		}
		// Explicit path must not silently fall back to PATH / well-known locations.
		return undefined;
	}

	const candidates: string[] = [];
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
 * Async existence check used at host registration time (no version spawn).
 */
export async function isGrokBinaryAvailable(
	configuredPath: string | undefined,
	env: NodeJS.ProcessEnv = process.env,
	userHome: string = homedir(),
): Promise<boolean> {
	return (await probeGrokBinaryAvailability(configuredPath, env, userHome)) === 'found';
}

/**
 * Distinguish "nothing installed" from "the user configured a path that is
 * missing". An explicit missing path must not be treated as "provider
 * unavailable" — callers surface {@link grokCliMissingError} and still register.
 */
export async function probeGrokBinaryAvailability(
	configuredPath: string | undefined,
	env: NodeJS.ProcessEnv = process.env,
	userHome: string = homedir(),
): Promise<GrokBinaryProbe> {
	const configured = (configuredPath?.trim() || env[AgentHostGrokBuildBinaryPathEnvVar]?.trim()) || undefined;
	if (configured) {
		return await Promises.exists(configured) ? 'found' : 'explicit-path-missing';
	}
	const searchEnv: NodeJS.ProcessEnv = { ...env };
	delete searchEnv[AgentHostGrokBuildBinaryPathEnvVar];
	const found = await resolveGrokBinaryPath(undefined, searchEnv, userHome);
	return found ? 'found' : 'not-installed';
}

/**
 * Parse `grok --version` output such as `grok 1.0.70 (f50904eaee6c)`.
 */
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

/**
 * A parseable semver wins even when the process exits non-zero. Otherwise the
 * banner is unreadable (live `grok --version` is
 * `grok 1.0.70 (f50904eaee6c) [stable]`).
 */
export function interpretGrokVersion(stdout: string, stderr: string): IGrokVersionRead {
	const output = `${stdout ?? ''}\n${stderr ?? ''}`.trim();
	const version = parseGrokVersion(output);
	if (version) {
		return { version, output, unreadable: false };
	}
	return { output, unreadable: true };
}

export async function readGrokVersion(binaryPath: string): Promise<IGrokVersionRead> {
	return new Promise(resolve => {
		execFile(binaryPath, ['--version'], { timeout: 5_000, windowsHide: true }, (_err, stdout, stderr) => {
			resolve(interpretGrokVersion(stdout ?? '', stderr ?? ''));
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
	const read = await readGrokVersion(path);
	if (read.version && !isGrokVersionAtLeast(read.version)) {
		throw grokVersionTooOldError(read.version);
	}
	return {
		path,
		version: read.version,
		versionUnreadable: read.unreadable ? true : undefined,
		versionOutput: read.output,
	};
}

/**
 * Environment passed to `grok`. The shell tool inherits this process, so the
 * host copies the parent environment and drops only the keys that retarget
 * the CLI or leak the editor: `VSCODE_*`, `ELECTRON_*`, and `NODE_OPTIONS`.
 * `ELECTRON_RUN_AS_NODE` is never set. The host owns `GROK_CLIENT_NAME` and
 * `GROK_CLIENT_VERSION`. User values such as `SSH_AUTH_SOCK`,
 * `NODE_EXTRA_CA_CERTS`, `KUBECONFIG`, `XAI_API_KEY`, and other `GROK_*`
 * keys are kept. Never read `~/.grok/auth.json`.
 *
 * Argv stays interactive `--permission-mode default` so ACP
 * `session/request_permission` reaches VS Code even when the user's
 * `~/.grok/config.toml` sets always-approve. Never pass
 * `--always-approve` / `bypassPermissions` / `dontAsk`.
 */
export function buildGrokSubprocessEnv(
	inheritedEnv: NodeJS.ProcessEnv,
	clientName: string,
	clientVersion: string,
): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(inheritedEnv)) {
		if (typeof value !== 'string') {
			continue;
		}
		if (key.startsWith('VSCODE_') || key.startsWith('ELECTRON_') || key === 'NODE_OPTIONS') {
			continue;
		}
		if (key === GROK_CLIENT_NAME_ENV || key === GROK_CLIENT_VERSION_ENV) {
			continue;
		}
		env[key] = value;
	}
	env[GROK_CLIENT_NAME_ENV] = clientName;
	env[GROK_CLIENT_VERSION_ENV] = clientVersion;
	return env;
}

export function buildGrokBuildLaunchConfig(
	binaryPath: string,
	inheritedEnv: NodeJS.ProcessEnv,
	clientName: string,
	clientVersion: string,
): IGrokBuildLaunchConfig {
	return {
		binaryPath,
		args: [...GROK_BUILD_ACP_ARGV],
		env: buildGrokSubprocessEnv(inheritedEnv, clientName, clientVersion),
	};
}
