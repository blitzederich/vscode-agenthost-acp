/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from '../../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	buildGrokBuildLaunchConfig,
	buildGrokSubprocessEnv,
	GROK_BUILD_ACP_ARGV,
	GROK_BUILD_MIN_VERSION,
	GROK_CLIENT_NAME_ENV,
	GROK_CLIENT_VERSION_ENV,
	grokCliMissingError,
	interpretGrokVersion,
	isGrokVersionAtLeast,
	parseGrokVersion,
	probeGrokBinaryAvailability,
	resolveGrokBinary,
	resolveGrokBinaryPath,
} from '../../../node/grokBuild/grokBuildLaunchConfig.js';

suite('GrokBuild launch config', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('ACP argv order forces interactive permissions and places --no-leader after agent', () => {
		const launch = buildGrokBuildLaunchConfig('/bin/grok', {}, 'Code - OSS', '1.0.0');
		assert.deepStrictEqual([...launch.args], [...GROK_BUILD_ACP_ARGV]);
		assert.deepStrictEqual([...launch.args], [
			'--no-auto-update',
			'--permission-mode', 'default',
			'agent',
			'--no-leader',
			'stdio',
		]);
		const joined = launch.args.join(' ');
		assert.ok(!joined.includes('always-approve'));
		assert.ok(!joined.includes('bypassPermissions'));
		assert.ok(!joined.includes('dontAsk'));
		assert.strictEqual(launch.args.indexOf('--permission-mode'), 1);
		assert.ok(launch.args.indexOf('agent') < launch.args.indexOf('--no-leader'));
		assert.ok(launch.args.indexOf('--no-leader') < launch.args.indexOf('stdio'));
	});

	test('parseGrokVersion reads `grok 1.0.70 (f50904eaee6c)`', () => {
		assert.strictEqual(parseGrokVersion('grok 1.0.70 (f50904eaee6c) [stable]\n'), '1.0.70');
		assert.strictEqual(parseGrokVersion('no version here'), undefined);
	});

	test('isGrokVersionAtLeast compares semver components', () => {
		assert.strictEqual(isGrokVersionAtLeast('1.0.70', GROK_BUILD_MIN_VERSION), true);
		assert.strictEqual(isGrokVersionAtLeast('1.0.69', GROK_BUILD_MIN_VERSION), false);
		assert.strictEqual(isGrokVersionAtLeast('1.1.0', GROK_BUILD_MIN_VERSION), true);
		assert.strictEqual(isGrokVersionAtLeast('2.0.0', '1.0.70'), true);
	});

	test('resolveGrokBinaryPath does not fall back when configured path is missing', async () => {
		const missing = join(tmpdir(), `grok-missing-${Date.now()}-${Math.random().toString(16).slice(2)}`);
		const resolved = await resolveGrokBinaryPath(missing, { PATH: '' }, tmpdir());
		assert.strictEqual(resolved, undefined);
		assert.strictEqual(grokCliMissingError().message.length > 0, true);
	});

	test('subprocess env is an allowlist and never sets ELECTRON_RUN_AS_NODE', () => {
		const env = buildGrokSubprocessEnv({
			PATH: '/usr/bin',
			HOME: '/home/tester',
			USER: 'tester',
			XAI_API_KEY: 'test-key',
			GROK_SANDBOX: '1',
			GROK_FOO: 'kept',
			GROK_CLIENT_NAME: 'inherited-name',
			GROK_CLIENT_VERSION: 'inherited-version',
			ELECTRON_RUN_AS_NODE: '1',
			VSCODE_FOO: 'secret',
			NODE_OPTIONS: '--inspect',
			SECRET: 'nope',
		}, 'Code - OSS', '1.145.0');
		assert.strictEqual(env.PATH, '/usr/bin');
		assert.strictEqual(env.HOME, '/home/tester');
		assert.strictEqual(env.XAI_API_KEY, 'test-key');
		assert.strictEqual(env.GROK_SANDBOX, '1');
		assert.strictEqual(env.GROK_FOO, 'kept');
		assert.strictEqual(env[GROK_CLIENT_NAME_ENV], 'Code - OSS');
		assert.strictEqual(env[GROK_CLIENT_VERSION_ENV], '1.145.0');
		assert.ok(!('ELECTRON_RUN_AS_NODE' in env));
		assert.ok(!('VSCODE_FOO' in env));
		assert.ok(!('NODE_OPTIONS' in env));
		assert.ok(!('SECRET' in env));
		const launch = buildGrokBuildLaunchConfig('/bin/grok', { ELECTRON_RUN_AS_NODE: '1', VSCODE_AGENT_HOST: '1' }, 'Code - OSS', '1.145.0');
		assert.deepStrictEqual([...launch.args], [...GROK_BUILD_ACP_ARGV]);
		assert.ok(!('ELECTRON_RUN_AS_NODE' in launch.env));
		assert.ok(!Object.keys(launch.env).some(key => key.startsWith('VSCODE_')));
	});

	test('interpretGrokVersion reads the live banner and flags unreadable output', () => {
		const live = interpretGrokVersion('grok 1.0.70 (f50904eaee6c) [stable]\n', '');
		assert.strictEqual(live.unreadable, false);
		assert.strictEqual(live.version, '1.0.70');
		const weirdExit = interpretGrokVersion('', 'grok 1.0.70 (f50904eaee6c) [stable]');
		assert.strictEqual(weirdExit.unreadable, false);
		assert.strictEqual(weirdExit.version, '1.0.70');
		const garbage = interpretGrokVersion('nope', '');
		assert.strictEqual(garbage.unreadable, true);
		assert.strictEqual(garbage.version, undefined);
	});

	test('resolveGrokBinary rejects an old version, keeps an unreadable banner, and misses an explicit path', async () => {
		const dir = await fs.mkdtemp(join(tmpdir(), 'grok-ver-'));
		const oldBinary = join(dir, 'old-grok');
		const garbageBinary = join(dir, 'garbage-grok');
		const liveBinary = join(dir, 'live-grok');
		await fs.writeFile(oldBinary, '#!/bin/sh\nprintf "grok 0.0.1 (abc)\\n"\n', { mode: 0o755 });
		await fs.writeFile(garbageBinary, '#!/bin/sh\nprintf "nope\\n"\nexit 1\n', { mode: 0o755 });
		await fs.writeFile(liveBinary, '#!/bin/sh\nprintf "grok 1.0.70 (f50904eaee6c) [stable]\\n"\nexit 1\n', { mode: 0o755 });
		const missing = join(dir, 'missing-grok');
		try {
			await assert.rejects(resolveGrokBinary(oldBinary, { PATH: '' }, dir), /too old/);
			const unreadable = await resolveGrokBinary(garbageBinary, { PATH: '' }, dir);
			assert.strictEqual(unreadable.path, garbageBinary);
			assert.strictEqual(unreadable.versionUnreadable, true);
			const live = await resolveGrokBinary(liveBinary, { PATH: '' }, dir);
			assert.strictEqual(live.version, '1.0.70');
			assert.strictEqual(live.versionUnreadable, undefined);
			await assert.rejects(resolveGrokBinary(missing, { PATH: '' }, dir), (err: unknown) => {
				assert.ok(err instanceof Error);
				assert.strictEqual(err.message, grokCliMissingError().message);
				return true;
			});
			assert.strictEqual(await probeGrokBinaryAvailability(missing, { PATH: '' }, dir), 'explicit-path-missing');
			assert.strictEqual(await probeGrokBinaryAvailability(liveBinary, { PATH: '' }, dir), 'found');
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	test('resolveGrokBinaryPath returns configured path when it exists', async () => {
		const dir = await fs.mkdtemp(join(tmpdir(), 'grok-bin-'));
		const binary = join(dir, 'grok');
		await fs.writeFile(binary, '#!/bin/sh\necho ok\n', { mode: 0o755 });
		try {
			const resolved = await resolveGrokBinaryPath(binary, { PATH: '' }, tmpdir());
			assert.strictEqual(resolved, binary);
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
});
