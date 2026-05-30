# CLAUDE.md

Guidance for Claude Code working in this repository.

## What this is

`@gaslit-ai/roomd-agent-mcp` — a standalone **MCP-hosted agent runtime**. It
exposes an [opencode](https://opencode.ai)-backed agent over the Model Context
Protocol as task-augmented tools. It is a self-contained primitive: it knows
nothing about any consumer, and consumers depend on it, never the reverse.

## Commands

```sh
pnpm install        # Node >=22 <26, pnpm 10
pnpm typecheck      # tsc --noEmit over src, tests, examples
pnpm test           # vitest run
pnpm test:watch     # vitest (watch)
pnpm build          # tsc -p tsconfig.build.json -> dist/ (emitted from src/ only)
pnpm example        # tsx examples/opencode-server/server.ts (needs opencode CLI + a model)
```

Before declaring any change done, run `pnpm typecheck && pnpm test`. If you
touch the build surface, also `pnpm build`.

## Architecture

Three independent layers, wired by a composition root. Dependencies point one
way; nothing reaches across a boundary except through an injected dependency
(there is no service locator).

- `src/kernel/` — the MCP server framework: HTTP transport, capability
  aggregation, module attach/detach lifecycle, graceful shutdown. **Knows
  nothing about agents or any specific feature.**
- `src/features/` — one folder per MCP capability (`tasks/`, `resources/`).
  Each exports a factory returning an `AgentModule`. A feature touches the MCP
  wire and receives what it needs as an explicit factory dependency.
- `src/backends/` — `interfaces/` holds the agnostic agent contracts
  (`AgentSessionReader`, `AgentSessionEvents`); `opencode/` is the one concrete
  backend (`createOpencodeAgent`: spawn / prompt / subscribe / read).
  **The backend imports no MCP and no kernel symbols.** A new backend slots in
  by implementing `backends/interfaces`.
- `src/index.ts` — the public barrel. Import from the package root; do not reach
  into folder internals. The example (`examples/opencode-server/server.ts`) is
  the canonical composition root.

## Invariants — do not break these

1. **Independence contract.** Code under `src/` imports ONLY from: `zod`,
   `@modelcontextprotocol/sdk` (+ subpaths), `@opencode-ai/sdk` (+ subpaths),
   and `node:` builtins. No other external dependency, and nothing from outside
   the package. This boundary is the whole point of the repo — keep it intact.
2. **Layer direction.** kernel ⇍ features ⇍ backends. The kernel must not learn
   about a feature; a backend must not learn about MCP. Wire concrete pieces
   together only in a composition root (the example), never via globals.
3. **`@modelcontextprotocol/sdk` is pinned EXACTLY** (`1.29.0`) — see below.

## The MCP SDK: fragile surface (read before bumping)

The kernel deliberately leans on SDK surfaces that are experimental, resolved
only via wildcard subpath exports, or private:

- `experimental/tasks/*` — the task store + `experimental.tasks.registerToolTask`
  (`src/features/tasks/feature.ts`, `src/kernel/server.ts`).
- `server/webStandardStreamableHttp.js` and `server/zod-compat.js` — imported
  for types; resolve only via the SDK's `"./*"` wildcard, not its curated
  exports map.
- A **private nested field**, `transport._webStandardTransport._enableJsonResponse`,
  read via `getSdkPrivateState` and poked in `src/kernel/transport.ts` to force
  JSON responses on `tasks/get` (the SDK exposes no per-request flag).

`tsc` guards every *typed* surface above. The one thing it cannot see is that
private field — so `tests/mcp-sdk-surface.test.ts` is the runtime canary,
calling the real `getSdkPrivateState` so the test tracks production's accessor.
**When bumping the SDK: run `pnpm typecheck && pnpm test`, and if the canary
fails, the task transport is broken — fix the integration or repin; do not
delete the canary.**

## Testing conventions

- vitest with `globals: true` and `restoreMocks: true` (`vitest.config.ts`);
  tests live in `tests/**/*.test.ts`.
- The opencode backend has two test modes: pass `opencodeBaseUrl` to attach to a
  running server (short-circuits the spawn path), or mock
  `@opencode-ai/sdk/v2/server`'s `createOpencodeServer` to exercise the managed
  spawn path without forking a real `opencode serve` (see
  `tests/agents-opencode-runtime.test.ts`).

## Conventions & gotchas

- TypeScript is strict with `noUncheckedIndexedAccess` and
  `exactOptionalPropertyTypes`; module resolution is `NodeNext`, so **relative
  imports use `.js` extensions** even though sources are `.ts`.
- opencode model IDs are `providerID/modelID` (e.g. `ollama/qwen3:latest`); the
  backend splits on the first `/`.
- The model's context window is an opencode/ollama-server setting, not an
  agent-config knob — the runtime does not forward it.
- The transport supports `stateful` sessions (carry `mcp-session-id`) and
  `enableJsonResponse`; tools are task-augmented (a `tools/call` returns a
  `taskId`, the caller blocks on `tasks/result`).
