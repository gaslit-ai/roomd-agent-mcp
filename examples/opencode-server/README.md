# Example: an opencode agent over MCP

A minimal, canonical example — an opencode-backed agent exposed over MCP as a
single task-augmented tool, `ask`. All the wiring lives in `server.ts`: it is
the composition root that builds the three library pieces (the agent, the
tasks feature, the MCP server) and the small bridge between them.

## Prerequisites

1. **Node 22+ and pnpm.** From the repo root, run `pnpm install` once.
2. **opencode** — `npm i -g opencode-ai`; the `opencode` CLI must be on PATH.
3. **ollama**, installed and running, with a tool-capable model pulled:
   ```
   ollama pull qwen3
   ```
4. **opencode pointed at that model** — create `~/.config/opencode/opencode.jsonc`:
   ```jsonc
   {
     "$schema": "https://opencode.ai/config.json",
     "provider": {
       "ollama": {
         "npm": "@ai-sdk/openai-compatible",
         "name": "ollama",
         "options": { "baseURL": "http://localhost:11434/v1" },
         "models": { "qwen3:latest": { "name": "qwen3" } }
       }
     }
   }
   ```
   opencode now knows the model as `ollama/qwen3:latest`.

## Run

```
OPENCODE_MODEL=ollama/qwen3:latest pnpm tsx examples/opencode-server/server.ts
```

It prints `example-agent listening at http://127.0.0.1:4317/mcp`.

Environment overrides: `PORT` (default `4317`), `OPENCODE_MODEL` (default
`ollama/gemma4:latest`), `OPENCODE_BASE_URL` (attach to an already-running
`opencode serve` instead of spawning one).

## Call it

Point any MCP host at `http://127.0.0.1:4317/mcp` — or drive it with curl.
`ask` is task-augmented: `tools/call` returns a `taskId` right away, and
`tasks/result` blocks until the agent finishes. The transport is stateful, so
carry the `mcp-session-id` from step 1 through every later request.

```sh
URL=http://127.0.0.1:4317/mcp

# 1. initialize — the response headers include `mcp-session-id`
curl -sS -D - -X POST "$URL" \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}'

SID=...   # paste the mcp-session-id value from step 1

# 2. finish the handshake
curl -sS -X POST "$URL" \
  -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -H "mcp-session-id: $SID" \
  -d '{"jsonrpc":"2.0","method":"notifications/initialized"}'

# 3. call the tool — returns { task: { taskId, ... } }
curl -sS -X POST "$URL" \
  -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -H "mcp-session-id: $SID" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"ask","arguments":{"message":"hello"},"task":{}}}'

# 4. block for the result — paste the taskId from step 3
curl -sS -X POST "$URL" \
  -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -H "mcp-session-id: $SID" \
  -d '{"jsonrpc":"2.0","id":3,"method":"tasks/result","params":{"taskId":"..."}}'
```

The first call is slow — `opencode serve` and the model load cold; later
calls are quick.

## Context window

The agent runs in whatever context window ollama loads the model with
(ollama's default is ~32K). This is **not** an agent-config knob — opencode
does not forward a context size to ollama. To change it, set it ollama-side:
`OLLAMA_CONTEXT_LENGTH` (ollama-server environment) or a Modelfile
`PARAMETER num_ctx`.
