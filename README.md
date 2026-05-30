# roomd-agent-mcp

**An MCP-hosted agent runtime.** Expose an [opencode](https://opencode.ai)-backed
agent over the [Model Context Protocol](https://modelcontextprotocol.io) as
task-augmented tools — a single, self-contained primitive that knows nothing
about who calls it.

This library is deliberately independent of any consumer. Building a solid
MCP-hosted agent is its own concern: the transport, the task lifecycle, the
agent backend, and the wiring between them each have sharp edges that are
easier to get right in isolation than entangled with an orchestrator.

## The three pieces

A composition root wires together three independent layers. Nothing reaches
across a boundary except through an explicitly injected dependency — there is
no service locator.

- **`src/kernel/`** — the MCP server framework: HTTP transport, capability
  aggregation, module attach/detach lifecycle, graceful shutdown. Knows
  nothing about agents or any specific feature.
- **`src/features/`** — one folder per MCP capability (`tasks/`, `resources/`).
  Each exports a factory returning an `AgentModule`. A feature touches the MCP
  wire and receives whatever it needs as an explicit factory dependency.
- **`src/backends/opencode/`** — the opencode agent: `createOpencodeAgent` →
  `spawn` / `prompt` / `subscribe` / session reading. Standalone: imports no
  MCP and no kernel symbols. `src/backends/interfaces/` holds the agnostic
  types a feature codes against without importing a concrete agent.

The composition root — see [`examples/opencode-server/server.ts`](examples/opencode-server/server.ts) —
is the one place that knows all three pieces and the small bridge between them.

## Install

```sh
pnpm install
```

Requires Node `>=22 <26`. To actually run an agent you also need the `opencode`
CLI on PATH and a model provider (e.g. ollama) — see the
[example README](examples/opencode-server/README.md).

## Quickstart

```sh
OPENCODE_MODEL=ollama/qwen3:latest pnpm example
```

This starts the canonical example: an opencode agent exposed over MCP as a
single task-augmented `ask` tool at `http://127.0.0.1:4317/mcp`. The
[example README](examples/opencode-server/README.md) walks through driving it
with curl.

`OPENCODE_MODEL` must name a model registered in your opencode provider config;
an unregistered id fails the task with `ProviderModelNotFoundError` (surfaced in
opencode's own log, not the agent server's).

## Public API

Import from the package root — it re-exports each layer's public boundary
(`createAgentMcpServer`, `createOpencodeAgent`, `createTasksFeature`,
`createResourcesFeature`, the config schemas, and the backend interfaces).
Don't reach into folder internals.

```ts
import {
  createAgentMcpServer,
  createOpencodeAgent,
  createTasksFeature,
} from "@gaslit-ai/roomd-agent-mcp";
```

`createAgentMcpServer` takes a **`createModules` factory** (invoked once per
session — see below) rather than module instances, plus an optional `logger`.

## Independence contract

`src/` imports **only** from:

- `zod`
- `@modelcontextprotocol/sdk` (and its subpath exports)
- `@opencode-ai/sdk` (and its subpath exports)
- node built-ins

It does not import from anywhere outside this package. This boundary is what
makes the runtime portable; keep it intact.

## Sessions, limits, and logging

**Per-session isolation (stateful mode, the default).** Each MCP client gets
its own transport and server, keyed by `mcp-session-id`: a fresh `initialize`
mints a session, later requests route to it by header, and a `DELETE` tears it
down. (A single shared transport can only ever hold one session — the second
client's `initialize` is rejected with "Server already initialized" — so the
kernel keeps one per session.) Because feature modules carry per-session state,
you pass a **`createModules` factory**, not instances; the kernel calls it once
per session. Capture shared backends (an agent) in the factory closure — one
backend, many sessions.

**Bounding sessions.** The MCP transport reclaims a session only on an explicit
`DELETE` — *never* on a client disconnect — so the kernel adds two guards
(transport config):

- `sessionIdleTimeoutMs` (default `300000`) — a background sweeper reclaims
  sessions idle longer than this. Requests in flight keep their session alive.
- `maxSessions` (default `1000`) — a fresh `initialize` past this ceiling is
  rejected with `503`.

**Stateless mode** (`stateful: false`) builds and disposes a transport + server
per request (the SDK forbids reusing a stateless transport across requests).

**Logging.** The kernel and its modules log through an injected `Logger`
(`AgentMcpServerOptions.logger`; default a structured console logger — pass
`noopLogger` to silence, or your own to bridge into pino/OpenTelemetry). Task
bridge failures, idle reaps, and transport errors surface here, so a failed
task is never silent.

**`tasks/get` and `enableJsonResponse`.** Set `enableJsonResponse: true` for
task-augmented servers (the example does): with JSON responses there are no SSE
streams, so `tasks/get` is already spec-compliant and the kernel never flips
response modes per request. With `enableJsonResponse: false` the kernel briefly
forces JSON for `tasks/get`; that flip mutates per-transport state, so it is
only sound when at most one request is in flight on a session at a time (a
concurrency-safe out-of-band path is a tracked follow-up).

## A note on the MCP SDK pin

`@modelcontextprotocol/sdk` is **pinned to an exact version** in
`package.json`, on purpose. The kernel leans on a few surfaces the SDK marks
experimental or keeps private:

- `experimental/tasks/*` (the task store + `registerToolTask`),
- the `server/webStandardStreamableHttp.js` and `server/zod-compat.js`
  subpaths, and
- a private nested field, `transport._webStandardTransport._enableJsonResponse`,
  poked in `src/kernel/transport.ts` to force JSON responses on `tasks/get`
  (only when `enableJsonResponse: false`; see "Sessions, limits, and logging").

`tests/mcp-sdk-surface.test.ts` is a canary for the one surface TypeScript
cannot see (the private field). Typecheck guards the rest. When bumping the
SDK, expect to run both `pnpm typecheck` and `pnpm test` and to re-verify these
surfaces deliberately.

## Develop

```sh
pnpm typecheck   # tsc --noEmit over src, tests, examples
pnpm test        # vitest
pnpm build       # emit dist/ from src/
```

## License

[Apache-2.0](LICENSE)
