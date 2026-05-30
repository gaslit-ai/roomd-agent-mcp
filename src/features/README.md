# `features/`

One folder per MCP capability. Each exports a factory returning an
`AgentModule` (see `kernel/module.ts`); the composition root attaches them.

Present:

- **`tasks/`** — task-augmented tools over the MCP Tasks protocol.
- **`resources/`** — session snapshots and event logs as MCP resources.

A feature touches the MCP wire. It receives whatever it needs from the
outside world (an agent) as an explicit dependency on its factory — features
are never coupled to a concrete backend.

## A feature may

- Declare a `capabilities` subtree (merged with all other modules).
- Register MCP request / notification handlers.
- Subscribe to the `shutdown` AbortSignal for cleanup.

## A feature must not

- Import from another feature.
- Import from a concrete agent folder — only from `backends/interfaces/`.
