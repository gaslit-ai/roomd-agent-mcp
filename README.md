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

## Independence contract

`src/` imports **only** from:

- `zod`
- `@modelcontextprotocol/sdk` (and its subpath exports)
- `@opencode-ai/sdk` (and its subpath exports)
- node built-ins

It does not import from anywhere outside this package. This boundary is what
makes the runtime portable; keep it intact.

## A note on the MCP SDK pin

`@modelcontextprotocol/sdk` is **pinned to an exact version** in
`package.json`, on purpose. The kernel leans on a few surfaces the SDK marks
experimental or keeps private:

- `experimental/tasks/*` (the task store + `registerToolTask`),
- the `server/webStandardStreamableHttp.js` and `server/zod-compat.js`
  subpaths, and
- a private nested field, `transport._webStandardTransport._enableJsonResponse`,
  poked in `src/kernel/transport.ts` to force JSON responses on `tasks/get`.

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
