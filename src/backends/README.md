# `backends/`

- **`interfaces/`** — the agnostic contracts a feature codes against without
  importing a concrete agent: `AgentSessionEvents` (subscribe to a live
  session-event stream) and `AgentSessionReader` (list / read sessions).
- **`opencode/`** — the opencode agent. `createOpencodeAgent(config)` returns
  an `OpencodeAgent`: `spawn` a session, `prompt` it, `subscribe` to its
  events, read its sessions, `close` it. It is a thin composition over the
  opencode SDK (`runtime.ts`, `session-events.ts`, `session-reader.ts`) and
  imports no MCP and no kernel symbols — it is usable standalone.

A second agent (e.g. `codex/`) drops in as a sibling folder implementing the
same `interfaces/` contracts. The composition root injects whichever agent a
feature needs; the agent is never registered into a framework.
