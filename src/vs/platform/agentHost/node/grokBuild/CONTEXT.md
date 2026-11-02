<!--
  CONTEXT.md — Grok Build Agent Host provider (Stage 0–3)
  Living note — keep in sync with code after each significant change.
-->

# Grok Build provider (Agent Host)

Fork-only provider that drives [Grok Build](https://x.ai/cli) through the
Agent Client Protocol (ACP) over stdio. Template: Codex
(`node/codex/codexAgent.ts`, `codexAppServerClient.ts`). No runtime ACP SDK
dependency — types live in `protocol/acpTypes.ts`.

> **Not affiliated with or endorsed by Microsoft or xAI.** Grok / Grok Build
> are trademarks of their owners. This adapter never bundles the `grok` binary
> and never reads `~/.grok/auth.json`.

## Architecture

```
Agents window / Chat view
  <-> AHP
  <-> Agent Host
  <-> GrokBuildAgent (IAgent)
  <-> spawned `grok … agent stdio` (ACP v1, NDJSON JSON-RPC 2.0)
```

Binary resolution (first hit wins): setting
`chat.agentHost.grokBuildAgent.binaryPath` → `PATH` → `~/.grok/bin/grok` →
`~/.local/bin/grok`. When the setting/env path is set but missing, fail
(`grokCliMissingError`) — do **not** fall back to PATH. Registration requires
`chat.agentHost.grokBuildAgent.enabled` (default `false`, experimental). A
missing install skips registration. An explicitly configured path that does
not exist still registers and logs `grokCliMissingError()` so the hint is not
swallowed. `grok --version` output such as
`grok 1.0.70 (f50904eaee6c) [stable]` is readable; output with no semver warns
and the CLI is still started. A parsed version older than 1.0.70 throws.

The spawned environment is the host environment with a denylist. Grok's shell
tool inherits it, so `SSH_AUTH_SOCK`, `NODE_EXTRA_CA_CERTS`, `KUBECONFIG`,
`XAI_API_KEY`, and user `GROK_*` are kept. Dropped keys are `VSCODE_*`,
`ELECTRON_*` (never set `ELECTRON_RUN_AS_NODE`), and `NODE_OPTIONS`. The host
overwrites `GROK_CLIENT_NAME` and `GROK_CLIENT_VERSION`. Never read
`~/.grok/auth.json`.

Verified launch argv (grok **1.0.70**):

```
['--no-auto-update', '--permission-mode', 'default', 'agent', '--no-leader', 'stdio']
```

- `--permission-mode` is **top-level only** (`default|acceptEdits|auto|dontAsk|bypassPermissions|plan`). After `agent`/`stdio` it exits 2.
- `--no-leader` is valid **only after** `agent`. Top-level `--no-leader` exits 1 ("applies to the interactive Grok UI").
- Never pass `--always-approve` / `bypassPermissions` / `dontAsk`.

Handshake: `initialize` → `authenticate { methodId: "grok.com" }` →
`session/new`. On 1.0.70, `session/new` without authenticate also succeeded
(cached token), but we still authenticate so the host owns the auth path.
Connection is published only after handshake succeeds so concurrent
`createChat` callers share `_connectionInFlight`.

Models: from `session/new`; `session/set_model { sessionId, modelId }` on
create (when `options.model` is set) and `changeModel`. Success
`_meta.model.Ok`; unknown id → `-32602` / data `"unknown model id"`.

Usage field is `cachedReadTokens` (not `cachedTokens`).

Session updates that do not become chat actions: `available_commands_update`
(slash skills, below), `config_option_update`, `session_info_update`,
`tool_call_delta_chunk`, `response_completed`, `turn_completed`,
`session_summary_generated`, `pending_interaction`, `interaction_resolved`,
plus `_x.ai/*` (including `_x.ai/session/prompt_complete`,
`_x.ai/mcp_initialized`, and hook events such as `subagent_stop`).
`plan` updates and `todo_write` tool calls become `manage_todo_list` tool
calls. A turn renders only the first of those two sources.

Live edit permission options (1.0.70): `allow-edits-session` (`allow_always`,
"allow all edits during this session"), `allow-once` (`allow_once`),
`reject-once` (`reject_once`). Shell prompts offer `always-allow` /
`allow-once` / `reject-once` / `reject-always` and never
`allow-edits-session`. Selecting `allow-edits-session` suppresses every later
edit prompt in that grok process, so this adapter answers `allow-once`.
Reject ends the prompt with `stopReason: "cancelled"`.

## Stages

| Stage | Scope |
|-------|--------|
| **0** | This design doc + IAgent surface table |
| **1 (MVP)** | ACP client, launch, mapping, create/send/abort/getMessages/materialize, settings, unit tests |
| **2 (persistence)** | `session/load` / `session/resume`, history → `Turn[]`, `session/list` discovery, crash reload, fixed cwd, `session/close`, stage 1 leftovers. **Implemented** and checked against grok 1.0.70. |
| **3 (UX)** | Reasoning effort, slash commands, plan updates, plan mode, subagent tool calls, per-chat edit preset, prompt-error `promptIndex`. **Implemented** and checked against grok 1.0.70. There is no non-agent-host Grok Build, so the editor has no `preferAgentHost` setting (Claude's precedent, not Codex's). |
| 4 | Hardening, docs, CI-safe e2e replay. **Deferred** |

## IAgent / IAgentChats — MVP vs stub

### `IAgentChats`

| Member | MVP | Notes |
|--------|-----|--------|
| `createChat` | **Implemented** | `session/new` after shared ACP handshake + `authenticate`; optional `session/set_model` |
| `sendMessage` | **Implemented** | `session/prompt`; maps `session/update` → AHP actions; failures throw only |
| `abort` | **Implemented** | `session/cancel` on **existing** connection only (never spawn) |
| `getMessages` | **Implemented** | In-memory `Turn[]`. `session/load` merges replayed history by `promptIndex` and keeps a local error. Does not connect on its own, so a crashed turn stays visible until the next send |
| `disposeChat` | **Implemented** | Drops backing. `session/close` when `sessionCapabilities.close` was advertised and this session is loaded on the current process |
| `releaseChat` | **Implemented** | Same as dispose, including `session/close` |
| `changeModel` | **Implemented** | `session/set_model`, then `session/set_config_option` when `model.config.thinkingLevel` changes |
| `getModel` | **Implemented** | From backing |
| `changeAgent` | Stub | No-op (no custom agents in MVP) |
| `prepareTurn` / `prepareChat` / `warmChat` | Stub | Omitted |
| `resumeTurn` | Stub | Omitted |
| `canReleaseChat` | Stub | Omitted (defaults to releasable) |

### `IAgent`

| Member | MVP | Notes |
|--------|-----|--------|
| `id` / `getDescriptor` / `agentHostCapabilities` | **Implemented** | Provider id `grokBuild`; label **"Grok Build"**; `workspaceConversion: false`; no logos |
| `models` | **Implemented** | From `session/new` (and initialize `_meta.modelState` seed) |
| `onDidChatProgress` | **Implemented** | Action + `pending_confirmation` signals |
| `onDidMaterializeChat` / `onDidChangeChatData` | **Implemented** | Fired on create / providerData updates |
| `onDidSpawnChat` / `onDidDiscoverChats` | **Implemented** | `startChatDiscovery` lists sessions and emits external chats whose ACP session id is not already in memory |
| `chats` | **Implemented** | See table above |
| `materializeChat` | **Implemented** | Decodes `{ sessionId, model, cwd, reasoningEffort }` and attaches it with `session/load` or `session/resume`. `providerData === undefined` recovers a discovered session (same path as `recoverLegacyChat`) |
| `respondToPermissionRequest` | **Implemented** | Maps approve → `allow_once` / deny → `reject_once`. Preset `allowEdits` answers `allow-once` for edit prompts that offer `allow-edits-session`, before this method runs. It never selects `allow-edits-session` |
| `getOrCreateActiveClient` / `removeActiveClient` | **Implemented** | Minimal in-memory handles |
| `onClientToolCallComplete` | Stub | No-op |
| `respondToUserInputRequest` | Stub | No-op |
| `resolveChatConfig` / `getInheritedChatConfig` / `chatConfigCompletions` | **Implemented** | Schema is mode (`interactive` \| `plan`) plus `grokPermissionPreset` (`ask` default, `allowEdits`). Completions stay empty |
| `getChatCustomizations` | **Implemented** | Host customizations plus a read-only Grok Build skill directory from `available_commands_update` |
| `getProtectedResources` | **Implemented** | `[]` — CLI owns grok.com auth; never GitHub-gated |
| `authenticate` | **Implemented** | No-op `false` for unknown resources (CLI auth path) |
| `getChatMetadata` | **Implemented** | Live backing, or providerData. `activation: 'restore'` attaches the runtime; a passive read does not |
| `listChatsToMigrate` | **Implemented** | One unfiltered paginated `session/list`. `[]` when list is not advertised. `undefined` when the catalog cannot be read |
| `recoverLegacyChat` | **Implemented** | Connects first (capabilities are empty before the handshake), then session id from the owner URI, cwd and title from `session/list`, then `session/load`. Provider data includes `models.currentModelId` from that load |
| `setWorkingDirectory` | **Implemented** | Always rejects. grok cannot reload a session at a different cwd (`FS_NOT_FOUND`) |
| `shutdown` / `dispose` | **Implemented** | Tears down ACP child |
| All marketplace / canvas / MCP / sandbox / steering / truncate / plugin APIs | Stub | Omitted optional members |
| `refreshModels` / discovery / legacy migration extras | Stub | Omitted or no-op |

## Stage 2 — persistence

Durable handle is `{ sessionId, model?, cwd?, reasoningEffort? }` in host `providerData`. A session
id from a dead grok process is never used for `session/prompt` until
`session/load` or `session/resume` succeeds on the current process generation.

| Capability | Behavior |
|------------|----------|
| `agentCapabilities.loadSession === true` | `session/load` at the session's original cwd. Preferred whenever both load and resume are advertised (live 1.0.70 advertises both). |
| else `sessionCapabilities.resume` present (`{}` counts; `null` / omitted do not) | `session/resume`. No history replay. Result is `{ models, configOptions, _meta }`. |
| neither | Localized `grokCannotRestoreSessionError`. |
| `sessionCapabilities.list` | One unfiltered paginated `session/list`. Live page size is 30. `nextCursor` is opaque and absent on the last page. A garbage cursor restarts at page 1; a repeated cursor stops the walk. `cwd` on the wire is an exact match and this provider does not send it. |
| `sessionCapabilities.close` | `session/close` on `disposeChat` / `releaseChat` when that session is loaded on the current process. Success `_meta["x.ai/closeOutcome"]` is `"closed"` or `"notResident"`. Does not respawn just to close. |

Live `session/load` (grok 1.0.70):

- Result is `{ models, configOptions, _meta }`. History arrives as `session/update` notifications before that result. `session_info_update` is not replayed; `summary` comes from the `session/list` title. A restore looks that title up when it is not already cached. A prompt index is stored only after grok accepts the prompt (`promptIndex` on an update, a permission request, or the prompt result).
- Replay chunks are whole messages. There is no `messageId`. `update._meta` is `{ modelId, promptIndex }`.
- A `tool_call` between assistant messages joins those messages with `\n\n`. The first streamed `tool_call` has no top-level `kind`; kind is `_meta["x.ai/tool"].kind` (`execute` → shell).
- `cwd` must be the directory the session was created with. A different cwd, on a fresh or already-loaded process, returns `-32603` `Path not found.` with `data.code: "FS_NOT_FOUND"`. The same error is returned for an unknown session id. That load failure is `grokSessionMissingError` ("This Grok session no longer exists on this machine.").
- `workspaceConversion` is false. `setWorkingDirectory` rejects and changes nothing. `sendMessage` ignores a differing cwd: it keeps the session cwd, does not clear `loadedGeneration`, and does not emit providerData. `workingDirectories` and persisted providerData are not updated until a load succeeds.

`session/list` rows are `{ sessionId, cwd, title, updatedAt, _meta }`. Discovered sessions (`providerData === undefined`, including `recoverLegacyChat`) take `sessionId` from the owner session URI, `cwd` from the cached list row or one unfiltered lookup, then `session/load`.

Replay keeps the same `Turn[]` shape as a live turn: user text plus assistant markdown. Turns are matched to local turns by `promptIndex`. A local `TurnState.Error` and its `errorMessage` are kept. A replayed turn that is only a user message is `Cancelled` (or `Error` when a local error matches), never `Complete`. Chunks that share a `messageId` and have no `promptIndex` still concatenate, so older fixtures keep working.

Crash: process exit or handshake failure records active turns as `TurnState.Error` (`errorType: GrokProcessExited`), cancels pending permissions, and includes the last ~2 KB of stderr. The host maps the rejected `sendMessage` to `ChatError`; the provider does not also fire one. The next send respawns and runs `session/load` (or `session/resume`) at the original cwd. `getMessages` does not auto-load, so the failed turn stays visible until that reload merges history.

`session/new` uses `workingDirectories[0].fsPath` or `process.cwd()` when the host sent none. `additionalDirectories` is not sent. `session/set_model` failure during `createChat` is logged and the CLI's `currentModelId` is kept. `changeModel` still throws. Spawn is `this._spawn` (tests inject it); `_connect` has no test-only branch. Handshake failure, transport failure, and process exit share one idempotent teardown.

A `session/prompt` JSON-RPC error while the grok process is still alive records `TurnState.Error` with no `promptIndex`. The next `session/load` adopts grok's index when the user text matches. A `promptIndex` match also requires the user text to match, so a bad index cannot attach that error to a different turn. Process exit still records the error (and may keep an index the permission path already stored) through the same merge.

## Stage 3 — UX

Launch argv is unchanged: `--permission-mode` stays `default`. Presets and plan mode are applied on the live session. Nothing reads `~/.grok/auth.json`. The authenticate result is not logged.

| Item | Behavior |
|------|----------|
| Reasoning effort | `configOptions` entry `reasoning_effort` (category `thought_level`) becomes the model `thinkingLevel` schema. Live values are `xhigh`, `high`, `medium`, and `low`. The default is `high`. It persists across `session/load` and `session/set_model`. `changeModel` / create apply it with `session/set_config_option { sessionId, configId: "reasoning_effort", value }`. The value is stored on provider data. After `session/load` or `session/resume`, it is sent again only when grok's `currentValue` differs. |
| Slash commands | `available_commands_update` entries are `{ name, description, input: null \| { hint }, _meta? }`. A non-array is ignored. They become a read-only skill directory. A prompt is a slash command only when its first token starts with `/` (the name is the part before any `:`, compared case-insensitively). It is forwarded only when that name is in the latest advertised list and is not denied (`always-approve`, `yolo`, `auto`, `plugins`, `plugin`, `reload-plugins`, `feedback`, `statusline`, `hooks-trust`, `hooks-add`, `settings`). Live grok 1.0.70 honours `/yolo` as an unadvertised alias of `/always-approve`. Before grok has sent its command list, every slash-prefixed prompt is rejected. A slash command on a later line is plain text and is forwarded. |
| Plan | Live turns send both a `todo_write` tool call (`rawInput { todos: [{ id, content, status }], merge }`, `_meta["x.ai/tool"].kind` `"plan"`) and ACP `plan` updates (`entries: [{ content, priority, status }]`). The first source that yields todos owns the turn; the other is dropped, so the widget is not updated three times. Each snapshot is one completed `manage_todo_list` call (`pending` → `not-started`, `in_progress` → `in-progress`, `completed` → `completed`) stamped with `_meta["grokBuild.todoList"]: true`. The chat todo widget reads that marker, not the tool name alone. |
| Plan mode | Session config `mode` is `interactive` (default) or `plan`, the same picker Codex uses. `session/new` does not include `modes`. `plan` calls `session/set_mode { modeId: "plan" }`. `interactive` calls `{ modeId: "default" }`. The request returns `{}` for any id; plan also emits `current_mode_update { currentModeId: "plan" }`. Neither relaunches the CLI. `appliedModeId` is cleared whenever the loaded connection generation changes, and mode is applied again after every successful `session/load` or `session/resume`. If the chat is in plan mode and `session/set_mode` fails, the prompt fails. |
| Subagents | A tool call whose `_meta["x.ai/tool"].kind` is `subagent` or `task`, or whose name is `spawn_subagent`, is rendered as tool name `task` with `_meta.toolKind: "subagent"`. Live `spawn_subagent` is `{ name: "spawn_subagent", kind: "task" }` with `rawInput { description, prompt }` (and `background`). No child chat is created. `subagent_stop` hook notifications are ignored. Shell and exec are never tagged as subagents. |
| Permission preset | Chat config `grokPermissionPreset`. Default `ask` ("Ask Every Time") answers nothing. `allowEdits` ("Allow Edits This Session") selects `allow-once` only when the prompt is an edit and the options include `allow-edits-session`. Shell prompts are never auto-answered. Switching the preset back to `ask` surfaces the next edit prompt. `bypassPermissions`, `dontAsk`, `auto`, and `--always-approve` are never passed to the CLI. |

### Deferred

- `sessionCapabilities.additionalDirectories` (not advertised on 1.0.70).
- `setChatWorkingDirectory` / per-chat worktree isolation. A session cannot move to another cwd.
- Cross-restart dedupe of `session/list` rows against host chats that already store the same `sessionId` in `providerData` (no metadata store). In-process ids are excluded from `onDidDiscoverChats`.
- `session/delete`.
- Child subagent chats. Captured traffic has no child session id to attach.
- Relaunching to change permission mode or plan mode. The argv stays `default`.
- Plan-mode turns end `cancelled`. grok's `exit_plan_mode` tool reports that plan approval could not be completed because the client disconnected ("Plan approval could not be completed because the client disconnected. Plan mode remains active; the approval will reappear on reconnect."). The prompt result is `stopReason: "cancelled"` with `cancellationCategory: "PermissionCancelled"`. A client capability is missing. Left as-is until that capability exists.

## Open TODOs

1. **Auth error taxonomy** — auth-required is `-32000` + `/authentication required/i` only. `session/load` `FS_NOT_FOUND` (`-32603`) is the localized missing-session error. Other live failures are `-32602 Invalid params` with detail in `error.data` (`unknown model id`, and similar); already surfaced via `formatAcpError`.
