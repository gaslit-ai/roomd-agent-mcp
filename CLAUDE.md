# CLAUDE.md

Guidance for Claude Code working in this repository.

## What this is

`@gaslit-ai/roomd-agent-mcp` — a standalone **MCP-hosted agent runtime**. It
exposes an [opencode](https://opencode.ai)-backed agent over the Model Context
Protocol as task-augmented tools. It is a self-contained primitive: it knows
nothing about any consumer, and consumers depend on it, never the reverse.

## Rules: 
- empirical, not theoretical testing. This requires a mode switch, during testing the perspective is informational, not "how can I make this work" but "how does this work" ALWAYS
  - You test as a user, with real world examples. 
  - A script is not how a user tests. 
  - Writing tests, running tests, are superfluous.
  - A good logging system and examples show more than tests.
  -