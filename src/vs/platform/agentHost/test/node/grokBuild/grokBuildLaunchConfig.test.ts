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
	GROK_BUILD_ACP_ARGV,
	GROK_BUILD_MIN_VERSION,
	grokCliMissingError,
	isGrokVersionAtLeast,
	parseGrokVersion,
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
