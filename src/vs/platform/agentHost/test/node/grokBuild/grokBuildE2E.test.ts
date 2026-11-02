/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * CI-safe Grok Build end-to-end.
 *
 * The live `grok --xai-api-base-url` replay is skipped when `grok` is not on
 * PATH. It was not possible to confirm a credential-free replay: upstream
 * docs describe that flag as a model-API override that still expects
 * `grok login` or `XAI_API_KEY`, and this environment has no `grok` binary.
 * The test that always runs spawns a fake ACP process (recorded assistant
 * text) through the real stdio spawn path and a temporary HOME. It does not
 * read or write `~/.grok/auth.json`.
 */

import assert from 'assert';
import { spawn } from 'child_process';
import { createServer, type Server } from 'http';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'fs/promises';
import { tmpdir, homedir } from 'os';
import { join } from '../../../../../base/common/path.js';
import { findExecutable } from '../../../../../base/node/processes.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../log/common/log.js';
import type { IProductService } from '../../../../product/common/productService.js';
import { fixedChatOwnerRef, GROK_BUILD_AGENT_PROVIDER_ID, type IAgentChatContext } from '../../../common/agent.js';
import { ResponsePartKind, type Turn } from '../../../common/state/sessionState.js';
import { GrokBuildAgent } from '../../../node/grokBuild/grokBuildAgent.js';
import { GROK_BUILD_ACP_ARGV } from '../../../node/grokBuild/grokBuildLaunchConfig.js';
import { IAgentConfigurationService } from '../../../node/agentConfigurationService.js';
import { Event } from '../../../../../base/common/event.js';

const FAKE_ACP_AGENT = `#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { writeFileSync } from 'node:fs';

const report = process.env.GROK_E2E_REPORT;
if (report) {
	writeFileSync(report, JSON.stringify({
		home: process.env.HOME ?? null,
		argv: process.argv.slice(2),
	}));
}

const reply = (id, result) => {
	process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n');
};

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', line => {
	const trimmed = line.trim();
	if (!trimmed) {
		return;
	}
	let msg;
	try {
		msg = JSON.parse(trimmed);
	} catch {
		return;
	}
	if (msg.method === 'initialize') {
		reply(msg.id, {
			protocolVersion: 1,
			agentCapabilities: { loadSession: false },
			authMethods: [{ id: 'grok.com' }],
		});
	} else if (msg.method === 'authenticate') {
		reply(msg.id, {});
	} else if (msg.method === 'session/new') {
		reply(msg.id, {
			sessionId: 'e2e-session',
			models: {
				currentModelId: 'replay-model',
				availableModels: [{ modelId: 'replay-model', name: 'Replay' }],
			},
		});
	} else if (msg.method === 'session/prompt') {
		process.stdout.write(JSON.stringify({
			jsonrpc: '2.0',
			method: 'session/update',
			params: {
				sessionId: msg.params.sessionId,
				update: {
					sessionUpdate: 'agent_message_chunk',
					content: { type: 'text', text: 'REPLAY-OK' },
				},
			},
		}) + '\\n');
		reply(msg.id, { stopReason: 'end_turn' });
	} else if (msg.id !== undefined) {
		reply(msg.id, {});
	}
});
rl.on('close', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
`;

class TestProductService {
	readonly _serviceBrand: undefined;
	readonly version = '1.145.0';
	readonly nameShort = 'Code - OSS';
	readonly nameLong = 'Code - OSS';
	readonly applicationName = 'code-oss';
	readonly dataFolderName = '.vscode-oss';
	readonly urlProtocol = 'code-oss';
	readonly quality = 'stable';
	readonly commit = 'test';
	readonly date = undefined;
	readonly vscodeVersion = '1.145.0';
}

function chatContext(chat: URI): IAgentChatContext {
	const owner = URI.from({ scheme: GROK_BUILD_AGENT_PROVIDER_ID, path: '/session' });
	return {
		resource: chat,
		owner: fixedChatOwnerRef(owner),
		sessionSettings: undefined,
		launchWorkingDirectories: undefined,
		workspaceless: false,
	};
}

function markdownOf(turn: Turn): string {
	return turn.responseParts
		.filter(part => part.kind === ResponsePartKind.Markdown)
		.map(part => part.kind === ResponsePartKind.Markdown ? part.content : '')
		.join('');
}

interface IAuthSnapshot {
	readonly path: string;
	readonly exists: boolean;
	readonly mtimeMs?: number;
	readonly size?: number;
}

async function snapshotAuth(home: string | undefined): Promise<IAuthSnapshot | undefined> {
	if (!home) {
		return undefined;
	}
	const path = join(home, '.grok', 'auth.json');
	try {
		const info = await stat(path);
		return { path, exists: true, mtimeMs: info.mtimeMs, size: info.size };
	} catch {
		return { path, exists: false };
	}
}

async function assertAuthUnchanged(before: IAuthSnapshot | undefined): Promise<void> {
	if (!before) {
		return;
	}
	const after = await snapshotAuth(before.path.slice(0, before.path.length - '/.grok/auth.json'.length));
	assert.ok(after);
	assert.strictEqual(after.exists, before.exists);
	assert.strictEqual(after.mtimeMs, before.mtimeMs);
	assert.strictEqual(after.size, before.size);
}

function listen(server: Server): Promise<number> {
	return new Promise((resolve, reject) => {
		server.once('error', reject);
		server.listen(0, '127.0.0.1', () => {
			const address = server.address();
			if (!address || typeof address === 'string') {
				reject(new Error('replay proxy did not bind'));
				return;
			}
			resolve(address.port);
		});
	});
}

suite('Grok Build e2e', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('fake ACP process replays a recorded turn without credentials or the real grok home', async () => {
		const root = await mkdtemp(join(tmpdir(), 'grok-build-e2e-'));
		const home = join(root, 'home');
		const reportPath = join(root, 'report.json');
		const binaryPath = join(root, 'fake-grok.mjs');
		await writeFile(binaryPath, FAKE_ACP_AGENT, { mode: 0o755 });
		await chmod(binaryPath, 0o755);
		const previousHome = process.env.HOME;
		const previousProfile = process.env.USERPROFILE;
		const previousKey = process.env.XAI_API_KEY;
		const previousReport = process.env.GROK_E2E_REPORT;
		const userHome = homedir();
		const authBefore = await snapshotAuth(userHome);
		const envHomeBefore = previousHome && previousHome !== userHome ? await snapshotAuth(previousHome) : undefined;
		process.env.HOME = home;
		process.env.USERPROFILE = home;
		process.env.GROK_E2E_REPORT = reportPath;
		delete process.env.XAI_API_KEY;
		const configurationService = {
			onDidChatConfigChange: Event.None,
			getChatConfigValues: () => undefined,
		} as unknown as IAgentConfigurationService;
		const agent = store.add(new GrokBuildAgent(new NullLogService(), new TestProductService() as unknown as IProductService, configurationService));
		agent.bindTestBinaryResolver(async () => ({ path: binaryPath, version: '1.0.70' }));
		try {
			const chat = URI.from({ scheme: GROK_BUILD_AGENT_PROVIDER_ID, path: '/chat/e2e' });
			const context = chatContext(chat);
			const created = await agent.chats.createChat(chat, context, { workingDirectories: [URI.file(root)] });
			assert.ok(created?.providerData);
			await agent.chats.sendMessage(chat, 'replay please', [URI.file(root)], undefined, 'turn-e2e', undefined, context);
			const messages = await agent.chats.getMessages(chat, context);
			assert.strictEqual(messages.length, 1);
			assert.strictEqual(markdownOf(messages[0]), 'REPLAY-OK');

			const report = JSON.parse(await readFile(reportPath, 'utf8')) as { home: string; argv: string[] };
			assert.strictEqual(report.home, home);
			assert.ok(report.argv.includes('--permission-mode'));
			assert.strictEqual(report.argv[report.argv.indexOf('--permission-mode') + 1], 'default');
			assert.ok(!report.argv.includes('--always-approve'));
			assert.deepStrictEqual(report.argv, [...GROK_BUILD_ACP_ARGV]);
			await assert.rejects(stat(join(home, '.grok', 'auth.json')));
			await assertAuthUnchanged(authBefore);
			await assertAuthUnchanged(envHomeBefore);
		} finally {
			agent.dispose();
			if (previousHome === undefined) {
				delete process.env.HOME;
			} else {
				process.env.HOME = previousHome;
			}
			if (previousProfile === undefined) {
				delete process.env.USERPROFILE;
			} else {
				process.env.USERPROFILE = previousProfile;
			}
			if (previousKey === undefined) {
				delete process.env.XAI_API_KEY;
			} else {
				process.env.XAI_API_KEY = previousKey;
			}
			if (previousReport === undefined) {
				delete process.env.GROK_E2E_REPORT;
			} else {
				process.env.GROK_E2E_REPORT = previousReport;
			}
			await rm(root, { recursive: true, force: true });
		}
	});

	test('live grok replay proxy skips when grok is not on PATH', async function () {
		this.timeout(20_000);
		const grokPath = await findExecutable('grok');
		if (!grokPath) {
			this.skip();
		}

		const root = await mkdtemp(join(tmpdir(), 'grok-build-replay-'));
		const home = join(root, 'home');
		await mkdir(home, { recursive: true });
		const userHome = homedir();
		const authBefore = await snapshotAuth(userHome);
		const server = createServer((_request, response) => {
			response.writeHead(401, { 'content-type': 'application/json' });
			response.end(JSON.stringify({ error: 'unauthorized' }));
		});
		const port = await listen(server);
		const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home };
		delete env.XAI_API_KEY;
		const child = spawn(grokPath!, [
			'--no-auto-update',
			'--permission-mode', 'default',
			'agent',
			'--xai-api-base-url', `http://127.0.0.1:${port}`,
			'--no-leader',
			'stdio',
		], {
			cwd: root,
			env,
			stdio: ['pipe', 'pipe', 'pipe'],
		});
		// Drain the pipes so a chatty CLI cannot block. Do not assert on
		// stdout: this environment has no grok binary, and upstream docs say
		// --xai-api-base-url still expects login or XAI_API_KEY.
		child.stdout?.resume();
		child.stderr?.resume();
		const exited = new Promise<number | null>(resolve => {
			child.once('exit', code => resolve(code));
		});
		try {
			child.stdin?.write(JSON.stringify({
				jsonrpc: '2.0',
				id: 1,
				method: 'initialize',
				params: { protocolVersion: 1, clientInfo: { name: 'e2e', version: '0' } },
			}) + '\n');
			await Promise.race([
				exited,
				new Promise<undefined>(resolve => setTimeout(() => resolve(undefined), 6_000)),
			]);
			await assertAuthUnchanged(authBefore);
		} finally {
			child.kill('SIGKILL');
			await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 1_000))]);
			await new Promise<void>(resolve => server.close(() => resolve()));
			await rm(root, { recursive: true, force: true });
		}
	});
});
