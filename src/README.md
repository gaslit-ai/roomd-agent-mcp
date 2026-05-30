# Source layout — agent-over-MCP

A self-contained library for exposing an agent over MCP. Three independent
pieces, wired together by a composition root:

- **`kernel/`** — the MCP server framework: transport, capability
  aggregation, module attachment, graceful shutdown. Knows nothing about
  agents or any specific feature.
- **`features/`** — one folder per MCP capability (`tasks/`, `resources/`).
  Each exports a factory returning an `AgentModule`. A feature touches the
  MCP wire and receives whatever it needs as an explicit factory dependency.
- **`backends/opencode/`** — the opencode agent: `createOpencodeAgent` →
  `spawn` / `prompt` / `subscribe` / session reading. Standalone: imports no
  MCP and no kernel symbols. `backends/interfaces/` holds the agnostic types
  a feature codes against without importing a concrete agent.

A composition root (an `examples/` server) constructs the agent and the
features and wires them — that wiring is the only place that knows all the
pieces. There is no service locator: dependencies are injected directly.

## Independence contract

This package imports only from `zod`, `@modelcontextprotocol/sdk` (and subpath
exports), `@opencode-ai/sdk` (and subpath exports), and node built-ins. No file
under `src/` imports from outside the package.
