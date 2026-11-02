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
		'grokBuild.workingDirectoryNotLocal',
		"Grok Build can only use a local absolute folder as the working directory.",
	));
}

export function grokWorkingDirectoryBusyError(): Error {
	return new Error(nls.localize(
		'grokBuild.workingDirectoryBusy',
		"Cannot change the Grok Build working directory while a turn is in progress.",
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
 * Build argv + env for the Grok ACP stdio process.
 *
 * Interactive `--permission-mode default` is forced so ACP
 * `session/request_permission` reaches VS Code even when the user's
 * `~/.grok/config.toml` sets always-approve. Never pass
 * `--always-approve` / `bypassPermissions` / `dontAsk`.
 */
/**
 * Environment grok actually needs. Codex copies the full host environment
 * (it has no strip policy). Claude strips `VSCODE_*` / `ELECTRON_*` but sets
 * `ELECTRON_RUN_AS_NODE=1` because its SDK is Node. Grok is a native binary,
 * so the host passes this allowlist only and never sets `ELECTRON_RUN_AS_NODE`.
 * `GROK_*` values the user already set are kept (telemetry stays in the user's
 * config; we do not invent overrides) except the client identity vars, which
 * the host owns. `XAI_API_KEY` is the documented auth fallback. Never read
 * `~/.grok/auth.json`.
 */
const GROK_SUBPROCESS_ENV_KEYS = [
	'PATH',
	'HOME',
	'USERPROFILE',
	'HOMEDRIVE',
	'HOMEPATH',
	'USER',
	'USERNAME',
	'LOGNAME',
	'SHELL',
	'COMSPEC',
	'PATHEXT',
	'SystemRoot',
	'SYSTEMROOT',
	'WINDIR',
	'TMPDIR',
	'TMP',
	'TEMP',
	'LANG',
	'LC_ALL',
	'LC_CTYPE',
	'LC_MESSAGES',
	'XAI_API_KEY',
	'GROK_SANDBOX',
	'XDG_CONFIG_HOME',
	'XDG_DATA_HOME',
	'XDG_CACHE_HOME',
	'HTTP_PROXY',
	'HTTPS_PROXY',
	'NO_PROXY',
	'ALL_PROXY',
	'http_proxy',
	'https_proxy',
	'no_proxy',
	'all_proxy',
	'SSL_CERT_FILE',
	'SSL_CERT_DIR',
	'CURL_CA_BUNDLE',
	'REQUESTS_CA_BUNDLE',
] as const;

export function buildGrokSubprocessEnv(
	inheritedEnv: NodeJS.ProcessEnv,
	clientName: string,
	clientVersion: string,
): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const key of GROK_SUBPROCESS_ENV_KEYS) {
		const value = inheritedEnv[key];
		if (typeof value === 'string') {
			env[key] = value;
		}
	}
	for (const key of Object.keys(inheritedEnv)) {
		if (!key.startsWith('GROK_') || key === GROK_CLIENT_NAME_ENV || key === GROK_CLIENT_VERSION_ENV) {
			continue;
		}
		const value = inheritedEnv[key];
		if (typeof value === 'string') {
			env[key] = value;
		}
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
