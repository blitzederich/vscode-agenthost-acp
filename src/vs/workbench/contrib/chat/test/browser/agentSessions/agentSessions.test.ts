/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { GrokBuildAgentHostIcon } from '../../../../../../platform/agentHost/common/agentHostSessionType.js';
import { AgentSessionProviders, getAgentSessionProviderIcon } from '../../../browser/agentSessions/agentSessions.js';

suite('Agent session provider presentation', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('uses the Copilot icon for both local and remote Copilot provider IDs', () => {
		assert.deepStrictEqual([
			'agent-host-copilotcli',
			'agent-host-copilot',
			'remote-mission-control-mac-cli-copilotcli',
			'remote-mission-control-mac-cli-copilot',
			'remote-mission-control-mac-cli-other',
		].map(type => getAgentSessionProviderIcon(type).id), [
			'copilot', 'copilot', 'copilot', 'copilot', 'extensions',
		]);
	});

	test('uses the Grok logomark icon for the Grok Build agent-host session type', () => {
		assert.strictEqual(getAgentSessionProviderIcon(AgentSessionProviders.AgentHostGrokBuild).id, GrokBuildAgentHostIcon.id);
		assert.strictEqual(getAgentSessionProviderIcon('agent-host-grokBuild').id, GrokBuildAgentHostIcon.id);
		assert.strictEqual(GrokBuildAgentHostIcon.id, 'grok-build');
	});
});
