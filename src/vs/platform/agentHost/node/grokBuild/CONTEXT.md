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

The spawned environment is an allowlist (`PATH`, `HOME`, `XAI_API_KEY`,
`GROK_SANDBOX`, user `GROK_*` except the client identity vars the host sets,
plus locale / proxy / CA / temp). It does **not** copy `ELECTRON_RUN_AS_NODE`
or `VSCODE_*`. Codex copies the full host environment; Claude strips those
prefixes but sets `ELECTRON_RUN_AS_NODE=1` because its SDK is Node. Grok is a
native binary, so this allowlist is intentional. Never read `~/.grok/auth.json`.

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
| **2 (persistence)** | `session/load` / `session/resume`, history → `Turn[]`, `session/list` discovery, crash reload, `setWorkingDirectory`, `session/close`, stage 1 leftovers. **Implemented** in this branch. Shapes marked below are still **to verify live**. |
| 3 | Plan, subagents, slash commands, reasoning effort, permission presets. **Deferred** |
| 4 | Hardening, docs, CI-safe e2e replay. **Deferred** |

## IAgent / IAgentChats — MVP vs stub

### `IAgentChats`

| Member | MVP | Notes |
|--------|-----|--------|
| `createChat` | **Implemented** | `session/new` after shared ACP handshake + `authenticate`; optional `session/set_model` |
| `sendMessage` | **Implemented** | `session/prompt`; maps `session/update` → AHP actions; failures throw only |
| `abort` | **Implemented** | `session/cancel` on **existing** connection only (never spawn) |
| `getMessages` | **Implemented** | In-memory `Turn[]`. `session/load` replaces them with replayed history. Does not connect on its own, so a crashed turn stays visible until the next send |
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
| `id` / `getDescriptor` / `agentHostCapabilities` | **Implemented** | Provider id `grokBuild`; label **"Grok Build"**; no logos |
| `models` | **Implemented** | From `session/new` (and initialize `_meta.modelState` seed) |
| `onDidChatProgress` | **Implemented** | Action + `pending_confirmation` signals |
| `onDidMaterializeChat` / `onDidChangeChatData` | **Implemented** | Fired on create / providerData updates |
| `onDidSpawnChat` / `onDidDiscoverChats` | **Implemented** | `startChatDiscovery` lists sessions and emits external chats whose ACP session id is not already in memory |
| `chats` | **Implemented** | See table above |
| `materializeChat` | **Implemented** | Decodes `{ sessionId, model, cwd }` and attaches it with `session/load` or `session/resume` |
| `respondToPermissionRequest` | **Implemented** | Maps approve → `allow_once` / deny → `reject_once` |
| `getOrCreateActiveClient` / `removeActiveClient` | **Implemented** | Minimal in-memory handles |
| `onClientToolCallComplete` | Stub | No-op |
| `respondToUserInputRequest` | Stub | No-op |
| `resolveChatConfig` / `getInheritedChatConfig` / `chatConfigCompletions` | **Implemented** | Empty schema / passthrough |
| `getChatCustomizations` | **Implemented** | Returns host customizations only |
| `getProtectedResources` | **Implemented** | `[]` — CLI owns grok.com auth; never GitHub-gated |
| `authenticate` | **Implemented** | No-op `false` for unknown resources (CLI auth path) |
| `getChatMetadata` | **Implemented** | Live backing, or providerData. `activation: 'restore'` attaches the runtime; a passive read does not |
| `listChatsToMigrate` | **Implemented** | `session/list` pages for known working directories (unfiltered when none are known). `[]` when list is not advertised. `undefined` when the catalog cannot be read |
| `setWorkingDirectory` | **Implemented** | `workspaceConversion: true`. Stores the absolute file URI, persists `cwd`, and `session/load` or `session/resume` at that cwd |
| `shutdown` / `dispose` | **Implemented** | Tears down ACP child |
| All marketplace / canvas / MCP / sandbox / steering / truncate / plugin APIs | Stub | Omitted optional members |
| `refreshModels` / discovery / legacy migration extras | Stub | Omitted or no-op |

## Stage 2 — persistence

Durable handle is `{ sessionId, model?, cwd? }` in host `providerData`. A session
id from a dead grok process is never used for `session/prompt` until
`session/load` or `session/resume` succeeds on the current process generation.

| Capability | Behavior |
|------------|----------|
| `agentCapabilities.loadSession === true` | `session/load`. Replay replaces in-memory turns. Preferred whenever both load and resume are advertised (live 1.0.70 advertises both). |
| else `sessionCapabilities.resume` present (`{}` counts; `null` / omitted do not) | `session/resume`. No history replay. |
| neither | Localized `grokCannotRestoreSessionError`. |
| `sessionCapabilities.list` | `session/list`. Optional `cwd` is an exact directory match. `cursor` / `nextCursor` are opaque. Omitted or `null` `nextCursor` ends the list; `''` is a valid cursor. Stop on a repeated cursor or after 20 pages. |
| `sessionCapabilities.close` | `session/close` on `disposeChat` / `releaseChat` when that session is loaded on the current process. `-32002` (unknown session) is success. Does not respawn just to close. |

`session/load` replay keeps the same `Turn[]` shape as a live turn: user text
plus assistant markdown. Thoughts and tool calls are not copied onto the turn.
`user_message_chunk`s that share a `messageId` (or have no id before any
assistant text) concatenate. A new user chunk after assistant text starts the
next turn. `session_info_update.title` becomes `summary`.

Crash: process exit or handshake failure records active turns as
`TurnState.Error` (`errorType: GrokProcessExited`), cancels pending
permissions, and includes the last ~2 KB of stderr. The host maps the rejected
`sendMessage` to `ChatError`; the provider does not also fire one. The next
send respawns and runs `session/load` (or `session/resume`). `getMessages`
does not auto-load, so the failed turn stays visible until that reload
replaces history.

`session/new`, `session/load`, and `session/resume` receive
`cwd` = `workingDirectories[0].fsPath` (or `process.cwd()` when the host sent
none). `additionalDirectories` is not sent. `session/set_model` failure during
`createChat` is logged and the CLI's `currentModelId` is kept. `changeModel`
still throws. Spawn is `this._spawn` (tests inject it); `_connect` has no
test-only branch. Handshake failure, transport failure, and process exit share
one idempotent teardown.

### To verify live (ACP v1 shapes; not in the grok 1.0.70 logs)

- `session/load` response (`{}` vs `models` / `modes` / `configOptions`) and the replay chunk sequence (`user_message_chunk` / `agent_message_chunk` `messageId` grouping, `session_info_update.title`).
- `session/resume` response, and that grok does not replay history for it. We do not call resume when `loadSession` is true.
- `session/list` response: `sessions[]` of `{ sessionId, cwd, title?, updatedAt? }` and `nextCursor` pagination, including the exact-`cwd` filter.
- Whether grok accepts a **changed** `cwd` on `session/load` / `session/resume`. The spec says `cwd` should match the session's cwd. `setWorkingDirectory` still sends the new directory.

### Deferred

- `sessionCapabilities.additionalDirectories` (not advertised on 1.0.70).
- `setChatWorkingDirectory` / per-chat worktree isolation. Session-level host worktree conversion uses `setWorkingDirectory` only.
- Cross-restart dedupe of `session/list` rows against host chats that already store the same `sessionId` in `providerData` (no metadata store). In-process ids are excluded from `onDidDiscoverChats`.
- `session/delete`.
- Reasoning effort, richer auth-error copy, plan / subagents / slash commands (stage 3).

## Open TODOs

1. **Reasoning effort** — wire `session/set_model` (or sibling) effort when product UX needs it; live models advertise `reasoningEfforts` in `_meta`. **Deferred** (stage 3).
2. **Auth error taxonomy** — auth-required is `-32000` + `/authentication required/i` only. Other live failures are `-32602 Invalid params` with detail in `error.data` (`unknown session id`, `unsupported auth method: x`, `unknown model id`); already surfaced via `formatAcpError`. Expand localized mapping if product needs friendlier copy.
3. **Verify stage 2 wire shapes live** — see the list above. Unit tests drive the ACP v1 shapes against the fake server.
