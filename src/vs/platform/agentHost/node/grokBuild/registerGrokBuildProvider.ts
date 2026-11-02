/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { IInstantiationService } from '../../../instantiation/common/instantiation.js';
import { AgentHostGrokBuildAgentEnabledEnvVar, AgentHostGrokBuildBinaryPathEnvVar, isAgentEnabled } from '../../common/agentService.js';
import { AgentHostGrokBuildEnabledConfigKey, platformRootSchema } from '../../common/agentHostSchema.js';
import type { IAgentConfigurationService } from '../agentConfigurationService.js';
import type { IAgentHostProviderService } from '../agentHostProviderService.js';
import { GrokBuildAgent } from './grokBuildAgent.js';
import { isGrokBinaryAvailable } from './grokBuildLaunchConfig.js';

/**
 * One-way register-on-enable for the Grok Build provider. Requires a resolvable
 * `grok` binary. Disabling requires an agent host restart.
 */
export function registerGrokBuildProviderIfEnabled(options: {
	readonly agentConfigurationService: IAgentConfigurationService;
	readonly providerService: IAgentHostProviderService;
	readonly instantiationService: IInstantiationService;
	readonly disposables: DisposableStore;
	readonly onRegistered?: () => void;
}): void {
	let grokBuildRegistered = false;
	const registerGrokBuildIfEnabled = () => {
		if (grokBuildRegistered) {
			return;
		}
		const enabledByEnv = isAgentEnabled(process.env[AgentHostGrokBuildAgentEnabledEnvVar], false);
		const enabledByRootConfig = options.agentConfigurationService.getRootValue(platformRootSchema, AgentHostGrokBuildEnabledConfigKey) === true;
		if (!(enabledByEnv || enabledByRootConfig)) {
			return;
		}
		void isGrokBinaryAvailable(process.env[AgentHostGrokBuildBinaryPathEnvVar]).then(available => {
			if (grokBuildRegistered || !available) {
				return;
			}
			grokBuildRegistered = true;
			options.providerService.registerProvider(options.instantiationService.createInstance(GrokBuildAgent));
			options.onRegistered?.();
		});
	};
	registerGrokBuildIfEnabled();
	options.disposables.add(options.agentConfigurationService.onDidRootConfigChange(registerGrokBuildIfEnabled));
}
