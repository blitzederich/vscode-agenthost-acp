/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Emitter } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { AgentHostGrokBuildAgentEnabledEnvVar, AgentHostGrokBuildBinaryPathEnvVar } from '../../../common/agentService.js';
import { grokCliMissingError } from '../../../node/grokBuild/grokBuildLaunchConfig.js';
import { registerGrokBuildProviderIfEnabled } from '../../../node/grokBuild/registerGrokBuildProvider.js';

suite('GrokBuild registration', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('an explicit missing binary path logs the CLI-not-found hint and still registers', async () => {
		const previousEnabled = process.env[AgentHostGrokBuildAgentEnabledEnvVar];
		const previousPath = process.env[AgentHostGrokBuildBinaryPathEnvVar];
		process.env[AgentHostGrokBuildAgentEnabledEnvVar] = 'true';
		process.env[AgentHostGrokBuildBinaryPathEnvVar] = '/no/such/grok';
		const errors: string[] = [];
		const registered: unknown[] = [];
		try {
			registerGrokBuildProviderIfEnabled({
				agentConfigurationService: {
					getRootValue: () => false,
					onDidRootConfigChange: store.add(new Emitter<void>()).event,
				} as any,
				providerService: {
					registerProvider: (agent: unknown) => { registered.push(agent); },
				} as any,
				instantiationService: {
					createInstance: () => ({ id: 'fake-grok-agent' }),
				} as any,
				disposables: store.add(new DisposableStore()),
				logService: { error: (message: string) => errors.push(message) },
			});
			await waitFor(() => registered.length === 1);
			assert.strictEqual(registered.length, 1);
			assert.deepStrictEqual(errors, [grokCliMissingError().message]);
		} finally {
			restoreEnv(AgentHostGrokBuildAgentEnabledEnvVar, previousEnabled);
			restoreEnv(AgentHostGrokBuildBinaryPathEnvVar, previousPath);
		}
	});

	test('a missing install skips registration and does not log the CLI-not-found hint', async () => {
		const previousEnabled = process.env[AgentHostGrokBuildAgentEnabledEnvVar];
		const previousPath = process.env[AgentHostGrokBuildBinaryPathEnvVar];
		const previousPathEnv = process.env.PATH;
		process.env[AgentHostGrokBuildAgentEnabledEnvVar] = 'true';
		delete process.env[AgentHostGrokBuildBinaryPathEnvVar];
		process.env.PATH = '/no/such/bin';
		const errors: string[] = [];
		const registered: unknown[] = [];
		try {
			registerGrokBuildProviderIfEnabled({
				agentConfigurationService: {
					getRootValue: () => false,
					onDidRootConfigChange: store.add(new Emitter<void>()).event,
				} as any,
				providerService: {
					registerProvider: (agent: unknown) => { registered.push(agent); },
				} as any,
				instantiationService: {
					createInstance: () => ({ id: 'fake-grok-agent' }),
				} as any,
				disposables: store.add(new DisposableStore()),
				logService: { error: (message: string) => errors.push(message) },
			});
			await new Promise(resolve => setTimeout(resolve, 200));
			assert.deepStrictEqual(registered, []);
			assert.deepStrictEqual(errors, []);
		} finally {
			restoreEnv(AgentHostGrokBuildAgentEnabledEnvVar, previousEnabled);
			restoreEnv(AgentHostGrokBuildBinaryPathEnvVar, previousPath);
			restoreEnv('PATH', previousPathEnv);
		}
	});
});

function restoreEnv(key: string, value: string | undefined): void {
	if (value === undefined) {
		delete process.env[key];
	} else {
		process.env[key] = value;
	}
}

async function waitFor(predicate: () => boolean): Promise<void> {
	const start = Date.now();
	while (!predicate()) {
		if (Date.now() - start > 2_000) {
			throw new Error('timed out waiting for Grok Build registration');
		}
		await new Promise(resolve => setTimeout(resolve, 10));
	}
}
