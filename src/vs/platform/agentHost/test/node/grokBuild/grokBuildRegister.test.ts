/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Emitter } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import type { IInstantiationService } from '../../../../instantiation/common/instantiation.js';
import { AgentHostGrokBuildAgentEnabledEnvVar, AgentHostGrokBuildBinaryPathEnvVar } from '../../../common/agentService.js';
import type { IAgentConfigurationService } from '../../../node/agentConfigurationService.js';
import { grokCliMissingError } from '../../../node/grokBuild/grokBuildLaunchConfig.js';
import type { IAgentHostProviderService } from '../../../node/agentHostProviderService.js';
import { GrokBuildAgent } from '../../../node/grokBuild/grokBuildAgent.js';
import { registerGrokBuildProviderIfEnabled, type IGrokBuildRegistrationConfiguration, type IGrokBuildRegistrationInstantiation, type IGrokBuildRegistrationProviderService } from '../../../node/grokBuild/registerGrokBuildProvider.js';

suite('GrokBuild registration', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('an explicit missing binary path logs the CLI-not-found hint and still registers', async () => {
		const previousEnabled = process.env[AgentHostGrokBuildAgentEnabledEnvVar];
		const previousPath = process.env[AgentHostGrokBuildBinaryPathEnvVar];
		const userHome = mkdtempSync(join(tmpdir(), 'grok-register-home-'));
		process.env[AgentHostGrokBuildAgentEnabledEnvVar] = 'true';
		process.env[AgentHostGrokBuildBinaryPathEnvVar] = join(userHome, 'missing-grok');
		const errors: string[] = [];
		const registered: { readonly id: string }[] = [];
		try {
			registerGrokBuildProviderIfEnabled({
				...registrationDoubles(registered, store.add(new Emitter<void>()).event),
				disposables: store.add(new DisposableStore()),
				logService: { error: (message: string) => errors.push(message) },
				userHome,
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
		const previousHome = process.env.HOME;
		const userHome = mkdtempSync(join(tmpdir(), 'grok-register-home-'));
		const pathDir = mkdtempSync(join(tmpdir(), 'grok-register-path-'));
		process.env[AgentHostGrokBuildAgentEnabledEnvVar] = 'true';
		delete process.env[AgentHostGrokBuildBinaryPathEnvVar];
		process.env.PATH = pathDir;
		process.env.HOME = userHome;
		const errors: string[] = [];
		const registered: { readonly id: string }[] = [];
		try {
			registerGrokBuildProviderIfEnabled({
				...registrationDoubles(registered, store.add(new Emitter<void>()).event),
				disposables: store.add(new DisposableStore()),
				logService: { error: (message: string) => errors.push(message) },
				userHome,
			});
			await new Promise(resolve => setTimeout(resolve, 200));
			assert.deepStrictEqual(registered, []);
			assert.deepStrictEqual(errors, []);
		} finally {
			restoreEnv(AgentHostGrokBuildAgentEnabledEnvVar, previousEnabled);
			restoreEnv(AgentHostGrokBuildBinaryPathEnvVar, previousPath);
			restoreEnv('PATH', previousPathEnv);
			restoreEnv('HOME', previousHome);
		}
	});
});

function registrationDoubles(
	registered: { readonly id: string }[],
	onDidRootConfigChange: IGrokBuildRegistrationConfiguration['onDidRootConfigChange'],
): {
	readonly agentConfigurationService: IGrokBuildRegistrationConfiguration;
	readonly providerService: IGrokBuildRegistrationProviderService;
	readonly instantiationService: IGrokBuildRegistrationInstantiation;
} {
	return {
		agentConfigurationService: {
			getRootValue: () => false,
			onDidRootConfigChange,
		},
		providerService: {
			registerProvider: agent => { registered.push(agent); },
		},
		instantiationService: {
			createInstance: (_ctor: typeof GrokBuildAgent) => ({ id: 'fake-grok-agent' }),
		},
	};
}

/**
 * The host services passed from `agentHostMain` / `agentHostServerMain` must
 * satisfy the registration seams. This is a type check; it is not called.
 */
export function grokBuildRegistrationHostIsAssignable(
	agentConfigurationService: IAgentConfigurationService,
	providerService: IAgentHostProviderService,
	instantiationService: IInstantiationService,
	disposables: DisposableStore,
): void {
	registerGrokBuildProviderIfEnabled({
		agentConfigurationService,
		providerService,
		instantiationService,
		disposables,
	});
}

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
