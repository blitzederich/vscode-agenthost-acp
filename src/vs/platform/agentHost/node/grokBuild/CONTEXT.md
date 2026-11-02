<!--
  CONTEXT.md — Grok Build Agent Host provider (Stage 0/1 design)
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
`chat.agentHost.grokBuildAgent.enabled` (default `false`, experimental) **and**
a resolvable binary.

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
| 2 | Persistence (`session/load` / resume), history → `Turn[]`, discovery |
| 3 | Plan, subagents, slash commands, reasoning effort, permission presets |
| 4 | Hardening, docs, CI-safe e2e replay |

## IAgent / IAgentChats — MVP vs stub

### `IAgentChats`

| Member | MVP | Notes |
|--------|-----|--------|
| `createChat` | **Implemented** | `session/new` after shared ACP handshake + `authenticate`; optional `session/set_model` |
| `sendMessage` | **Implemented** | `session/prompt`; maps `session/update` → AHP actions; failures throw only |
| `abort` | **Implemented** | `session/cancel` on **existing** connection only (never spawn) |
| `getMessages` | **Implemented** | In-memory `Turn[]` for the live process only |
| `disposeChat` | **Implemented** | Drops backing; `session/close` when connection already up |
| `releaseChat` | **Implemented** | Same as dispose for MVP (no durable resume yet) |
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
| `onDidSpawnChat` / `onDidDiscoverChats` | **Implemented** | Emitters present; discovery empty in MVP |
| `chats` | **Implemented** | See table above |
| `materializeChat` | **Implemented** | Restores opaque `{ sessionId, model }` into memory; live ACP resume is Stage 2 |
| `respondToPermissionRequest` | **Implemented** | Maps approve → `allow_once` / deny → `reject_once` |
| `getOrCreateActiveClient` / `removeActiveClient` | **Implemented** | Minimal in-memory handles |
| `onClientToolCallComplete` | Stub | No-op |
| `respondToUserInputRequest` | Stub | No-op |
| `resolveChatConfig` / `getInheritedChatConfig` / `chatConfigCompletions` | **Implemented** | Empty schema / passthrough |
| `getChatCustomizations` | **Implemented** | Returns host customizations only |
| `getProtectedResources` | **Implemented** | `[]` — CLI owns grok.com auth; never GitHub-gated |
| `authenticate` | **Implemented** | No-op `false` for unknown resources (CLI auth path) |
| `getChatMetadata` | **Implemented** | Minimal metadata from in-memory backing |
| `listChatsToMigrate` | **Implemented** | `[]` |
| `setWorkingDirectory` | Stub | Throws unsupported |
| `shutdown` / `dispose` | **Implemented** | Tears down ACP child |
| All marketplace / canvas / MCP / sandbox / steering / truncate / plugin APIs | Stub | Omitted optional members |
| `refreshModels` / discovery / legacy migration extras | Stub | Omitted or no-op |

## Open TODOs

1. **Reasoning effort** — wire `session/set_model` (or sibling) effort when product UX needs it; live models advertise `reasoningEfforts` in `_meta`.
2. **Auth error taxonomy** — auth-required is `-32000` + `/authentication required/i` only. Other live failures are `-32602 Invalid params` with detail in `error.data` (`unknown session id`, `unsupported auth method: x`, `unknown model id`); already surfaced via `formatAcpError`. Expand localized mapping if product needs friendlier copy.
3. **Stage 2 persistence** — `session/load` / resume / discovery once durable reload is productized.
