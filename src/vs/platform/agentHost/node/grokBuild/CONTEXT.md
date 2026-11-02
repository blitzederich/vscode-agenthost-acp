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
`~/.local/bin/grok`. Registration requires
`chat.agentHost.grokBuildAgent.enabled` (default `false`, experimental) **and**
a resolvable binary.

Launch always forces an interactive permission mode so
`session/request_permission` reaches VS Code even when the user's
`~/.grok/config.toml` sets `permission_mode = "always-approve"`. Never default
to auto-approve / yolo.

Verified against grok **1.0.70** (2026-11-02 wire logs): must call
`authenticate { methodId: "grok.com" }` before `session/new`; models come from
the `session/new` result; tolerate unknown `sessionUpdate` kinds and
`_x.ai/*` notifications.

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
| `createChat` | **Implemented** | `session/new` after shared ACP handshake + `authenticate` |
| `sendMessage` | **Implemented** | `session/prompt`; maps `session/update` → AHP actions |
| `abort` | **Implemented** | `session/cancel` notification; pending permissions → cancelled |
| `getMessages` | **Implemented** | In-memory `Turn[]` for the live process only |
| `disposeChat` | **Implemented** | Drops backing; `session/close` when advertised |
| `releaseChat` | **Implemented** | Same as dispose for MVP (no durable resume yet) |
| `changeModel` | **Implemented** | Stores selection for next prompt; `session/set_model` TODO if confirmed live |
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
| `respondToPermissionRequest` | **Implemented** | Maps approve → `allow_once` / deny → `reject_once` (or `reject`) |
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

## Open TODOs (need live grok login)

1. **Exact CLI flags** — `--permission-mode default` and `--no-leader` placement vs `grok --help` (binary absent in this agent VM).
2. **`session/set_model` / reasoning effort** — confirm method names against a logged-in CLI before wiring the model picker beyond stored selection.
3. **Permission option ids** — wire2 was captured under always-approve (no `session/request_permission`); fixtures use ACP v1 shapes (`allow_once` / `allow_always` / `reject_once` / `reject_always`). Confirm Grok's optionId strings live.
4. **Minimum supported version** — version gate string once `--version` format is confirmed on 1.0.70+.
5. **Auth error taxonomy** — map additional CLI error codes beyond `-32000 Authentication required` when seen live.
