<!--
  CONTEXT.md — Grok Build Agent Host provider (Stage 0–4)
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
`IAgentModelInfo.maxContextWindow` is the model default from
`_meta.totalContextTokens` (typically 256000) — never a per-session
`_meta.contextWindow` on a model entry. When `_meta.contextWindows` lists
more than one size (e.g. `[256000, 500000]`), the model picker gets a
Codex-style `contextSize` schema from
`createContextSizeConfigSchemaPropertyFromLimits(totalContextTokens, max(windows))`,
merged with reasoning effort. Selecting a size always calls
`session/set_model` with `_meta.contextWindow` set to that offered size
(including the default 256000): omitting `_meta` preserves grok's current
window (`resolve_switch_window` → Preserve). Unsupported sizes are ignored.
Per-chat `contextWindowOverride` / `model.config.contextSize` narrow
`copilot.usageInfo.tokenLimit` and the picker. After a switch,
`_x.ai/session_notification` `model_changed` `context_window_selection`
(including during load history replay) and the current model entry's
`_meta.contextWindow` on `session/load` / `session/resume` update that
chat's override, `contextSize`, and usage `tokenLimit`. Live result
`_meta` does not carry `contextWindow` (keys include `sessionId`,
`x.ai/sessionConfig`, …).

Usage: top-level prompt `_meta.inputTokens` / `outputTokens` /
`cachedReadTokens` are the **last model call** (ChatUsage fields). Nested
`_meta.usage` is the **turn sum** and is stored as
`UsageInfo._meta.turnTokenTotals` (Codex shape). Field name is
`cachedReadTokens` (not `cachedTokens`). Older grok that only sends `usage`
falls back to those values for ChatUsage.

Context bar (`chat.contextUsage.enabled`): every `session/update` and the
prompt result carry `_meta.totalTokens` (grok's live context estimate; the
same number its TUI uses). Non-zero values, plus compaction notifications
from `_x.ai/session_notification` / replay `_x.ai/session/update` whose
`update.sessionUpdate` is `auto_compact_completed` (`tokens_after`) or
`auto_compact_started` (`tokens_used`), publish session
`_meta['copilot.usageInfo'] = { currentTokens, tokenLimit, messagesLength }`
merged with existing keys (looked up by `owner.toString()`). `totalTokens: 0`
(transient after `/compact`) is ignored. `tokenLimit` is the chat's
`contextWindowOverride`, else `model.config.contextSize`, else the model's
published `maxContextWindow` (unchanged by another chat's selection).
Restored turns set `message.model` from the pinned `backing.model` or else
`models.currentModelId` (`cliCurrentModelId`, not written into providerData).
`providerData.contextTokens` persists the last gauge across restarts when
the load replay under-reports. On restore, usage is returned on
`getChatMetadata()._meta['copilot.usageInfo']` (session state does not exist
yet, so `SessionMetaChanged` is not dispatched). During load replay, a
single-call `_x.ai/session/update` `turn_completed` (`modelCalls === 1`)
sets the gauge to `inputTokens + outputTokens`, preferred over under-reported
`agent_message_chunk` `_meta.totalTokens`.

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
| **4 (hardening)** | Timeouts, spawn and exit errors, log redaction, slash-command carry-overs, AGENTS.md, CI-safe e2e. **Implemented.** On grok 1.0.70, without credentials, `initialize` works, `authenticate { methodId: "grok.com" }` hangs for more than 20 seconds, `session/new` fails with "Authentication required", and grok makes 0 requests to `--xai-api-base-url`. With a dummy `XAI_API_KEY`, grok calls `GET /models` and `/api-key` on that URL, but `authMethods` is still only `grok.com`, `authenticate` still hangs, and `session/new` still fails. A credential-free replay is not possible. The CI-safe e2e is a fake ACP process. |

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
| `changeModel` | **Implemented** | `session/set_model` (`_meta.contextWindow` whenever the model offers multiple windows and the effective size is one of them, including the default), then `session/set_config_option` when `model.config.thinkingLevel` changes |
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
| `getOrCreateActiveClient` / `removeActiveClient` | **Implemented** | Writes into `ActiveClientToolSet`; refreshes the client-tools HTTP MCP `tools/list` snapshot |
| `onClientToolCallComplete` | **Implemented** | Resolves a parked HTTP MCP `tools/call` for the workbench client-tools server |
| `respondToUserInputRequest` | **Implemented** | Resolves parked `_x.ai/exit_plan_mode` plan reviews (approve / revise+feedback / abandon) and `_x.ai/ask_user_question` prompts (accepted answers / skip_interview / cancelled) |
| `resolveChatConfig` / `getInheritedChatConfig` / `chatConfigCompletions` | **Implemented** | Schema is mode (`interactive` \| `plan`) plus `grokPermissionPreset` (`ask` default, `allowEdits`). Completions stay empty |
| `getChatCustomizations` | **Implemented** | Host customizations plus a read-only Grok Build skill directory from `available_commands_update` |
| `getProtectedResources` | **Implemented** | `[]` — CLI owns grok.com auth; never GitHub-gated |
| `authenticate` | **Implemented** | No-op `false` for unknown resources (CLI auth path) |
| `getChatMetadata` | **Implemented** | Live backing, or providerData. `activation: 'restore'` attaches the runtime (including discovered/CLI sessions with no providerData, via `session/list` + `session/load`); a passive read does not. A missing session on restore is `AHP_SESSION_NOT_FOUND` with `grokSessionMissingError` (not a silent miss). |
| `listChatsToMigrate` | **Implemented** | One unfiltered paginated `session/list`. `[]` when list is not advertised. `undefined` when the catalog cannot be read |
| `recoverLegacyChat` | **Implemented** | Connects first (capabilities are empty before the handshake), then session id from the owner URI, cwd and title from `session/list`, then `session/load`. `models.currentModelId` is kept as in-memory `cliCurrentModelId` (not pinned into providerData.model) |
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

Crash: process exit or handshake failure records active turns as `TurnState.Error` (`errorType: GrokProcessExited`), cancels pending permissions, and includes the last ~2 KB of stderr after `redactGrokAuthenticateText`. The host maps the rejected `sendMessage` to `ChatError`; the provider does not also fire one. The default-level log line is only the first line of that error (`grokLogSummary`), so the tail is not an error-log line. The next send respawns and runs `session/load` (or `session/resume`) at the original cwd. `getMessages` does not auto-load, so the failed turn stays visible until that reload merges history.

`session/new` uses `workingDirectories[0].fsPath` or `process.cwd()` when the host sent none. `additionalDirectories` is not sent. `session/set_model` failure during `createChat` is logged and the CLI's `currentModelId` is kept. `changeModel` still throws. Spawn is `this._spawn` (tests inject it); `_connect` has no test-only branch. Handshake failure, transport failure, and process exit share one idempotent teardown.

A `session/prompt` JSON-RPC error while the grok process is still alive records `TurnState.Error` with no `promptIndex`. The next `session/load` adopts grok's index when the user text matches. A `promptIndex` match also requires the user text to match, so a bad index cannot attach that error to a different turn. Process exit still records the error (and may keep an index the permission path already stored) through the same merge.

## Stage 3 — UX

Launch argv is unchanged: `--permission-mode` stays `default`. Presets and plan mode are applied on the live session. Nothing reads `~/.grok/auth.json`. The authenticate result is not logged.

| Item | Behavior |
|------|----------|
| Reasoning effort | `configOptions` entry `reasoning_effort` (category `thought_level`) becomes the model `thinkingLevel` schema. Live values are `xhigh`, `high`, `medium`, and `low`. The default is `high`. It persists across `session/load` and `session/set_model`. `changeModel` / create apply it with `session/set_config_option { sessionId, configId: "reasoning_effort", value }`. The value is stored on provider data. After `session/load` or `session/resume`, it is sent again only when grok's `currentValue` differs. |
| Context size | Model `_meta.contextWindows` with more than one entry adds `contextSize` to the model config schema (alongside reasoning effort). `changeModel` / create always send `session/set_model` `_meta.contextWindow` when the effective size is an offered multi-window value (including the default 256000); omitting `_meta` preserves grok's current window. Per-chat override / `contextSize` drive usage `tokenLimit` and the picker without mutating the shared model list. The current model entry's `_meta.contextWindow` on `session/load` / `session/resume`, and `model_changed.context_window_selection` (including during load replay, before the load result), restore that chat's selection. |
| Slash commands | `available_commands_update` entries are `{ name, description, input: null \| { hint }, _meta? }`. A non-array is ignored. They become a read-only skill directory. A prompt is a slash command only when its first token starts with `/`. A token that contains a second `/` (`/Users/x/a.ts explain`) is a path and is rejected ("A message must not start with a path."). The deny-list is the part before the first `:`, compared case-insensitively, so `/yolo:on` and `/always-approve:on` stay rejected and are hidden from the skill directory (`always-approve`, `yolo`, `auto`, `plugins`, `plugin`, `reload-plugins`, `feedback`, `statusline`, `hooks-trust`, `hooks-add`, `settings`). Otherwise the full token up to the first whitespace, without the leading `/`, must exactly match an advertised command, case-insensitively. `/bundled:imagine` is that full name; splitting on `:` would leave `bundled` and reject a command grok advertises. grok 1.0.70 sends `available_commands_update` only after the first prompt, so a slash command as the first message of a new chat is rejected ("Slash commands become available after the first message."). Denied names still use the deny message before that list arrives. An empty advertised list is authoritative. A slash command on a later line is plain text and is forwarded. Live grok 1.0.70 honours `/yolo` as an unadvertised alias of `/always-approve`. |
| Plan | Live turns send both a `todo_write` tool call (`rawInput { todos: [{ id, content, status }], merge }`, `_meta["x.ai/tool"].kind` `"plan"`) and ACP `plan` updates (`entries: [{ content, priority, status }]`). The first source that yields todos owns the turn; the other is dropped, so the widget is not updated three times. Each snapshot is one completed `manage_todo_list` call (`pending` → `not-started`, `in_progress` → `in-progress`, `completed` → `completed`) stamped with `_meta["grokBuild.todoList"]: true`. The chat todo widget reads that marker, not the tool name alone. |
| Plan mode | Session config `mode` is `interactive` (default) or `plan`, the same picker Codex uses. `session/new` does not include `modes`. `plan` calls `session/set_mode { modeId: "plan" }`. `interactive` calls `{ modeId: "default" }`. The request returns `{}` for any id; plan also emits `current_mode_update { currentModeId: "plan" }`. Neither relaunches the CLI. `appliedModeId` is cleared whenever the loaded connection generation changes, and mode is applied again after every successful `session/load` or `session/resume`. If the chat is in plan mode and `session/set_mode` fails, the prompt fails. Leaving plan mode uses grok's agent→client `_x.ai/exit_plan_mode` request (`sessionId`, `toolCallId`, `planContent`), not `session/request_permission`. The host shows the Copilot plan-review UI (approve "Implement plan" / abandon / feedback; never autopilot). Reply `{ outcome: "approved" }` or `"abandoned"` or `"revise"` (+ optional `feedback`). Unknown session / no active turn / decline / skip / cancel → `revise` (never default to approved). Approve/abandon then wait for `current_mode_update` `default`, set `appliedModeId` to `default`, and write chat config `mode` to `interactive` so the next prompt does not force plan back on. Cancel/teardown resolves pending reviews as `revise`, dismisses the review UI, and locally marks the `exit_plan_mode` tool card cancelled (grok sends no update for it). Tool cards with `_meta["x.ai/tool"].kind` `exit_plan` use a "Present plan" title, hide `{}` / `{ variant: "ExitPlanMode" }` input, and surface plan markdown plus ACP `{ type: "content", content: { type: "text" } }` result text (including as the failure message instead of a generic "Tool call failed"). |
| Ask user | grok's agent→client `_x.ai/ask_user_question` (`sessionId`, `toolCallId`, `questions[{question, options[{label, description}], multiSelect}]`, `mode`). Surfaced as `ChatInputRequested` with purpose `askUser`: each question is single- or multi-select (`multiSelect === true`) with free-text allowed, plus a skip-interview control. Reply `{ outcome: "accepted", answers }` keyed by exact question text (`string` or `string[]`), `{ outcome: "skip_interview" }` (skip control or empty accept), or `{ outcome: "cancelled" }` (decline / dismiss). Unknown session / no active turn → `cancelled`. Malformed params → `-32602`. Cancel/teardown resolves pending asks as `cancelled`, dismisses the input UI, and locally marks the tool card cancelled (grok sends no update). A terminal `tool_call_update` for the ask card (timeout) or turn `finally` drops the pending UI **without** an ACP reply. Tool cards keep the localized "Ask User" label and prefer content text / `rawOutput.UserAnswered.message` over raw JSON. `chat_about_this` is not emitted. |
| Subagents | A tool call whose `_meta["x.ai/tool"].kind` is `subagent` or `task`, or whose name is `spawn_subagent`, is rendered as tool name `task` with `_meta.toolKind: "subagent"`. Live `spawn_subagent` is `{ name: "spawn_subagent", kind: "task" }` with `rawInput { description, prompt }` (and `background`). No child chat is created. `subagent_stop` hook notifications are ignored. Shell and exec are never tagged as subagents. |
| Permission preset | Chat config `grokPermissionPreset`. Default `ask` ("Ask Every Time") answers nothing. `allowEdits` ("Allow Edits This Session") selects `allow-once` only when the prompt is an edit and the options include `allow-edits-session`. Shell prompts are never auto-answered. Switching the preset back to `ask` surfaces the next edit prompt. `bypassPermissions`, `dontAsk`, `auto`, and `--always-approve` are never passed to the CLI. |

## Stage 4 — hardening

| Item | Behavior |
|------|----------|
| Version check | `grok --version` is bounded at 5 seconds (`readGrokVersion`). Unreadable output warns and the CLI is still started. A parsed version older than 1.0.70 throws localized `grokVersionTooOldError` before spawn. |
| Handshake timeout | `initialize` and `authenticate` are bounded at 30 seconds (`HANDSHAKE_TIMEOUT_MS`). The wait is a local `withTimeout` that handles both fulfillment and rejection, so the timer winning does not leave the abandoned request's rejection unhandled. `session/prompt` is not timed out: a model turn has no fixed budget. Other control RPCs (`session/new`, `session/load`, `session/resume`, and the rest) are not timed out either. Cancelling one of them on the shared connection would need a per-id cancel this client does not have. |
| Missing binary | Resolution failure throws localized `grokCliMissingError` and does not spawn. An explicit configured path that is missing does not fall back to `PATH`. |
| Spawn failure | A child or stdin `error` of `ENOENT` or `ENOTDIR` becomes `grokCliMissingError`. `EACCES` or `EPERM` becomes localized `grokCliNotExecutableError`. Any other code keeps the original error. |
| Exit mid-turn | Exit 127 with no signal uses the missing-CLI message plus the redacted stderr tail. Exit 126 uses the not-executable message plus that tail. Any other exit, including a signal, uses `grokProcessExitedError` (code, signal, redacted tail of about 2 KB). The in-flight RPC is rejected with that same error, including when the process dies during `initialize`. Active turns become `TurnState.Error`. The next send respawns and restores at the original cwd. |
| Logging | The default log level is Info. Info, warn, and error must not contain an authenticate result (email, team, tier, team id, team name, subscription tier), a skill name, or an MCP server name. `redactGrokAuthenticateText` replaces a flat JSON object that carries those fields with `[redacted-authenticate]`, then leftover fields, then email addresses with `[redacted-email]`. ACP parse failures log the fixed string `parse error on ACP line` at error and the line only at trace, after redaction. Unrecognized messages log `unrecognized ACP message` at warn and the payload at trace. A response whose id is not a number (such as `skills-reload`) is logged at trace. Stderr is stored and traced only after redaction. Warn and error lines that include an error message use `grokLogSummary` (the first line, redacted), so a stderr tail does not land at the default level. The thrown error still includes the redacted tail, which may name a skill; it must not contain an email, team, or tier. The authenticate result is never logged at any level. |
| E2E | `test/node/grokBuild/grokBuildE2E.test.ts`. It writes a fake ACP process, points `HOME` and `USERPROFILE` at a temp directory, unsets `XAI_API_KEY`, and spawns that process through the real stdio path (`bindTestBinaryResolver` only; spawn is not replaced). It expects the recorded assistant text `REPLAY-OK`, argv equal to `GROK_BUILD_ACP_ARGV` (`--permission-mode` then `default`, never `--always-approve`), and no `auth.json` under the temp home. It does not stat the real home. On grok 1.0.70 a credential-free replay is not possible: without credentials, `initialize` works, `authenticate { methodId: "grok.com" }` hangs for more than 20 seconds, `session/new` fails with "Authentication required", and grok makes 0 requests to `--xai-api-base-url`. With a dummy `XAI_API_KEY`, grok calls `GET /models` and `/api-key` on that URL, but `authMethods` is still only `grok.com`, `authenticate` still hangs, and `session/new` still fails. The CI-safe e2e is this fake ACP process. Run it with the grokBuild unit tests (mocha, `HOME` set to an empty temp directory, `XAI_API_KEY` unset). |

## Client tools MCP (workbench language / vscode.lm tools)

When `chat.agentHost.grokBuildAgent.clientToolsMcp.enabled` is true (default),
each chat starts a **127.0.0.1** HTTP MCP server named `client` with a random
bearer token and passes it in `mcpServers` for `session/new`, `session/load`,
and `session/resume` as
`{ type: 'http', name: 'client', url, headers: [{ name: 'Authorization', value: 'Bearer …' }] }`.
Missing/invalid tokens return 401. GET probes return 405; `server/discover`
returns JSON-RPC `-32601` (both OK for grok 1.0.70).

Tools come from the session's `ActiveClientToolSet` (workbench
`ILanguageModelToolsService` / enabled tool sets via
`agentHostActiveClientService`), not from custom LSP wrappers. Grok surfaces
them as `client__<tool>` through search_tool/use_tool. Live 1.0.70 first emits
ACP `tool_call` with title/`x.ai` name `use_tool` and
`rawInput.tool_name: 'client__<tool>'`, then `session/request_permission`
(no auto-approve), then MCP `tools/call`. The host keeps grok's toolCallId as
the single card (display name strips `client__`, Client contributor),
correlates MCP FIFO by tool name + args, parks on `pendingClientToolCalls`,
and settles when `onClientToolCallComplete` runs. Without our `client` MCP
server attached, a user's own server named `client` is left alone.

Mid-session tool-set changes update the live `tools/list` snapshot
(`listChanged: true`). grok 1.0.70 does not advertise
`x.ai/session/update_mcp_servers`, so a server that was omitted at session
start (setting off, or start failure) is only added on the next
`session/load` / `session/resume`. The HTTP server is disposed with the chat
and with agent shutdown.

### Deferred

- `sessionCapabilities.additionalDirectories` (not advertised on 1.0.70).
- `setChatWorkingDirectory` / per-chat worktree isolation. A session cannot move to another cwd.
- Cross-restart dedupe of `session/list` rows against host chats that already store the same `sessionId` in `providerData` (no metadata store). In-process ids are excluded from `onDidDiscoverChats`.
- `session/delete`.
- Child subagent chats. Captured traffic has no child session id to attach.
- Relaunching to change permission mode or plan mode. The argv stays `default`.
- Pushing `notifications/tools/list_changed` to connected streamable-HTTP
  clients (plain JSON POST responses only today; grok re-lists via search_tool).

## Open TODOs

1. **Auth error taxonomy** — auth-required is `-32000` + `/authentication required/i` only. `session/load` `FS_NOT_FOUND` (`-32603`) is the localized missing-session error. Other live failures are `-32602 Invalid params` with detail in `error.data` (`unknown model id`, and similar); already surfaced via `formatAcpError`.
