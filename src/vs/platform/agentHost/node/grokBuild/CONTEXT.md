<!--
  CONTEXT.md — Grok Build Agent Host provider (Stage 0–2)
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

Ignorable session updates / notifications: `available_commands_update`,
`config_option_update`, `session_info_update`, `tool_call_delta_chunk`,
`response_completed`, `turn_completed`, `session_summary_generated`,
`pending_interaction`, `interaction_resolved`, plus `_x.ai/*` (including
`_x.ai/session/prompt_complete`, `_x.ai/mcp_initialized`).

Live edit permission options (1.0.70): `allow-edits-session` (`allow_always`),
`allow-once` (`allow_once`), `reject-once` (`reject_once`) — no `reject_always`.
Reject ends the prompt with `stopReason: "cancelled"`.

## Stages

| Stage | Scope |
|-------|--------|
| **0** | This design doc + IAgent surface table |
| **1 (MVP)** | ACP client, launch, mapping, create/send/abort/getMessages/materialize, settings, unit tests |
| **2 (persistence)** | `session/load` / `session/resume`, history → `Turn[]`, `session/list` discovery, crash reload, fixed cwd, `session/close`, stage 1 leftovers. **Implemented** and checked against grok 1.0.70. |
| 3 | Plan, subagents, slash commands, reasoning effort, permission presets. **Deferred** |
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
| `changeModel` | **Implemented** | `session/set_model` then update backing |
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
| `materializeChat` | **Implemented** | Decodes `{ sessionId, model, cwd }` and attaches it with `session/load` or `session/resume`. `providerData === undefined` recovers a discovered session (same path as `recoverLegacyChat`) |
| `respondToPermissionRequest` | **Implemented** | Maps approve → `allow_once` / deny → `reject_once` |
| `getOrCreateActiveClient` / `removeActiveClient` | **Implemented** | Minimal in-memory handles |
| `onClientToolCallComplete` | Stub | No-op |
| `respondToUserInputRequest` | Stub | No-op |
| `resolveChatConfig` / `getInheritedChatConfig` / `chatConfigCompletions` | **Implemented** | Empty schema / passthrough |
| `getChatCustomizations` | **Implemented** | Returns host customizations only |
| `getProtectedResources` | **Implemented** | `[]` — CLI owns grok.com auth; never GitHub-gated |
| `authenticate` | **Implemented** | No-op `false` for unknown resources (CLI auth path) |
| `getChatMetadata` | **Implemented** | Live backing, or providerData. `activation: 'restore'` attaches the runtime; a passive read does not |
| `listChatsToMigrate` | **Implemented** | One unfiltered paginated `session/list`. `[]` when list is not advertised. `undefined` when the catalog cannot be read |
| `recoverLegacyChat` | **Implemented** | Session id from the owner URI, cwd and title from the `session/list` cache (or a lookup), then `session/load`. Returns canonical providerData only after load succeeds |
| `setWorkingDirectory` | **Implemented** | Always rejects. grok cannot reload a session at a different cwd (`FS_NOT_FOUND`) |
| `shutdown` / `dispose` | **Implemented** | Tears down ACP child |
| All marketplace / canvas / MCP / sandbox / steering / truncate / plugin APIs | Stub | Omitted optional members |
| `refreshModels` / discovery / legacy migration extras | Stub | Omitted or no-op |

## Stage 2 — persistence

Durable handle is `{ sessionId, model?, cwd? }` in host `providerData`. A session
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

- Result is `{ models, configOptions, _meta }`. History arrives as `session/update` notifications before that result. `session_info_update` is not replayed; `summary` comes from the `session/list` title.
- Replay chunks are whole messages. There is no `messageId`. `update._meta` is `{ modelId, promptIndex }`.
- A `tool_call` between assistant messages joins those messages with `\n\n`. The first streamed `tool_call` has no top-level `kind`; kind is `_meta["x.ai/tool"].kind` (`execute` → shell).
- `cwd` must be the directory the session was created with. A different cwd, on a fresh or already-loaded process, returns `-32603` `Path not found.` with `data.code: "FS_NOT_FOUND"`. The same error is returned for an unknown session id. That load failure is `grokSessionMissingError` ("This Grok session no longer exists on this machine.").
- `workspaceConversion` is false. `setWorkingDirectory` rejects and changes nothing. `sendMessage` ignores a differing cwd: it keeps the session cwd, does not clear `loadedGeneration`, and does not emit providerData. `workingDirectories` and persisted providerData are not updated until a load succeeds.

`session/list` rows are `{ sessionId, cwd, title, updatedAt, _meta }`. Discovered sessions (`providerData === undefined`, including `recoverLegacyChat`) take `sessionId` from the owner session URI, `cwd` from the cached list row or one unfiltered lookup, then `session/load`.

Replay keeps the same `Turn[]` shape as a live turn: user text plus assistant markdown. Turns are matched to local turns by `promptIndex`. A local `TurnState.Error` and its `errorMessage` are kept. A replayed turn that is only a user message is `Cancelled` (or `Error` when a local error matches), never `Complete`. Chunks that share a `messageId` and have no `promptIndex` still concatenate, so older fixtures keep working.

Crash: process exit or handshake failure records active turns as `TurnState.Error` (`errorType: GrokProcessExited`), cancels pending permissions, and includes the last ~2 KB of stderr. The host maps the rejected `sendMessage` to `ChatError`; the provider does not also fire one. The next send respawns and runs `session/load` (or `session/resume`) at the original cwd. `getMessages` does not auto-load, so the failed turn stays visible until that reload merges history.

`session/new` uses `workingDirectories[0].fsPath` or `process.cwd()` when the host sent none. `additionalDirectories` is not sent. `session/set_model` failure during `createChat` is logged and the CLI's `currentModelId` is kept. `changeModel` still throws. Spawn is `this._spawn` (tests inject it); `_connect` has no test-only branch. Handshake failure, transport failure, and process exit share one idempotent teardown.

### Deferred

- `sessionCapabilities.additionalDirectories` (not advertised on 1.0.70).
- `setChatWorkingDirectory` / per-chat worktree isolation. A session cannot move to another cwd.
- Cross-restart dedupe of `session/list` rows against host chats that already store the same `sessionId` in `providerData` (no metadata store). In-process ids are excluded from `onDidDiscoverChats`.
- `session/delete`.
- Reasoning effort, richer auth-error copy, plan / subagents / slash commands (stage 3).

## Open TODOs

1. **Reasoning effort** — wire `session/set_model` (or sibling) effort when product UX needs it; live models advertise `reasoningEfforts` in `_meta`. **Deferred** (stage 3).
2. **Auth error taxonomy** — auth-required is `-32000` + `/authentication required/i` only. `session/load` `FS_NOT_FOUND` (`-32603`) is the localized missing-session error. Other live failures are `-32602 Invalid params` with detail in `error.data` (`unknown model id`, and similar); already surfaced via `formatAcpError`.
