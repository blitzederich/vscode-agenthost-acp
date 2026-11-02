/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../base/common/event.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { AgentHostGrokBuildAgentEnabledEnvVar, AgentHostGrokBuildBinaryPathEnvVar, isAgentEnabled } from '../../common/agentService.js';
import { AgentHostGrokBuildEnabledConfigKey, platformRootSchema } from '../../common/agentHostSchema.js';
import { GrokBuildAgent } from './grokBuildAgent.js';
import { grokCliMissingError, probeGrokBinaryAvailability } from './grokBuildLaunchConfig.js';

export interface IGrokBuildRegistrationConfiguration {
	getRootValue(schema: object, key: string): unknown;
	readonly onDidRootConfigChange: Event<void>;
}

export interface IGrokBuildRegistrationProviderService {
	registerProvider(provider: { readonly id: string }): void;
}

export interface IGrokBuildRegistrationInstantiation {
	createInstance(ctor: typeof GrokBuildAgent): { readonly id: string };
}

export interface IGrokBuildRegistrationLog {
	error(message: string, ...args: unknown[]): void;
}

/**
 * One-way register-on-enable for the Grok Build provider. A missing install
 * skips registration. An explicitly configured binary path that does not exist
 * still registers and logs {@link grokCliMissingError} so the hint is not
 * swallowed. Disabling requires an agent host restart.
 */
export function registerGrokBuildProviderIfEnabled(options: {
	readonly agentConfigurationService: IGrokBuildRegistrationConfiguration;
	readonly providerService: IGrokBuildRegistrationProviderService;
	readonly instantiationService: IGrokBuildRegistrationInstantiation;
	readonly disposables: DisposableStore;
	readonly logService?: IGrokBuildRegistrationLog;
	readonly onRegistered?: () => void;
	/** Overrides `os.homedir()` for the `~/.grok` and `~/.local` probes. */
	readonly userHome?: string;
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
		void probeGrokBinaryAvailability(process.env[AgentHostGrokBuildBinaryPathEnvVar], process.env, options.userHome).then(probe => {
			if (grokBuildRegistered) {
				return;
			}
			if (probe === 'not-installed') {
				return;
			}
			if (probe === 'explicit-path-missing') {
				options.logService?.error(grokCliMissingError().message);
			}
			grokBuildRegistered = true;
			options.providerService.registerProvider(options.instantiationService.createInstance(GrokBuildAgent));
			options.onRegistered?.();
		});
	};
	registerGrokBuildIfEnabled();
	options.disposables.add(options.agentConfigurationService.onDidRootConfigChange(registerGrokBuildIfEnabled));
}
