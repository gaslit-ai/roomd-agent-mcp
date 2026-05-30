// examples/opencode-server/server.ts
//
// Canonical example — an opencode-backed agent exposed over MCP as a single
// task-augmented tool.
//
// This file is the COMPOSITION ROOT: the one place that knows all three
// independent library pieces and wires them together.
//
//   agent   — `createOpencodeAgent`  : runs opencode; knows nothing of MCP.
//   tasks   — `createTasksFeature`   : a task-augmented MCP tool; knows
//                                      nothing of opencode.
//   kernel  — `createAgentMcpServer` : the MCP server + HTTP transport.
//
// The "bridge" between the agent and the task is the `start` callback below.
// It is small and deterministic on purpose: a task is a task, an agent is an
// agent, and `start` is the glue.
//
// Usage:   pnpm tsx examples/opencode-server/server.ts
//
// Env overrides:
//   PORT               HTTP port (default 4317)
//   OPENCODE_MODEL     providerID/modelID (default ollama/gemma4:latest)
//   OPENCODE_BASE_URL  attach to a running `opencode serve` instead of spawning
import { z } from "zod";
import {
  createAgentMcpServer,
  createOpencodeAgent,
  createTasksFeature,
  McpTransportConfigSchema,
  OpencodeAgentConfigSchema,
  PromptResultSchema,
  TasksFeatureConfigSchema,
} from "../../src/index.js";

// The agent's entire instruction set. Whatever it is asked, it replies "OK".
const SYSTEM_PROMPT =
  'You are a test agent. Reply with exactly the word "OK" — nothing else: ' +
  "no punctuation, no explanation, no tool calls.";

// 1. THE AGENT — standalone; no MCP, no kernel, no tasks.
const agent = createOpencodeAgent(
  OpencodeAgentConfigSchema.parse({
    model: process.env.OPENCODE_MODEL ?? "ollama/gemma4:latest",
    // The model's context window is an ollama-server setting, not an
    // agent-config knob — opencode does not forward it. See this example's
    // README ("Context window"); it defaults to ollama's ~32K.
    systemPrompt: SYSTEM_PROMPT,
    workspacePath: process.cwd(),
    sessionTitle: "example-agent",
    ...(process.env.OPENCODE_BASE_URL
      ? { opencodeBaseUrl: process.env.OPENCODE_BASE_URL }
      : {}),
  }),
);

// 2. THE TASKS FEATURE — generic; no opencode. `start` is the bridge: it
//    drives one task to a terminal state by running the agent. Returning a
//    CallToolResult completes the task; throwing fails it.
const tasks = createTasksFeature({
  config: TasksFeatureConfigSchema.parse({
    toolName: "ask",
    description:
      "Send a message to the agent. Returns immediately with a taskId; " +
      "block on tasks/result for the reply.",
    modelImmediateResponseMessage:
      "The agent is running — retrieve its reply with tasks/result.",
    annotations: { readOnlyHint: true, openWorldHint: false },
  }),

  // The MCP tool's input.
  inputSchema: {
    message: z.string().min(1).describe("Message to send to the agent."),
    sessionId: z
      .string()
      .min(1)
      .optional()
      .describe("Continue a prior session; omit to start a new one."),
  },

  // The MCP tool's structured output — the agent's result.
  outputSchema: PromptResultSchema.shape,

  // THE BRIDGE.
  start: async (args, handle) => {
    // Open a fresh session, or continue the one the caller named.
    const sessionId = args.sessionId ?? (await agent.spawn()).sessionId;

    // Forward the agent's live events as task progress notifications.
    const unsubscribe = agent.subscribe(sessionId, (event) => {
      handle.progress(event.kind, { event });
    });

    try {
      const run = agent.prompt(sessionId, args.message);
      // A cancelled task (or a breached deadline) aborts the agent run.
      if (handle.signal.aborted) {
        run.abort();
      } else {
        handle.signal.addEventListener("abort", () => run.abort(), {
          once: true,
        });
      }
      const result = await run.result;
      return {
        content: [{ type: "text", text: result.text }],
        structuredContent: result,
        isError: false,
      };
    } finally {
      unsubscribe();
    }
  },
});

// 3. THE MCP SERVER — attaches the feature, binds the HTTP transport.
const server = await createAgentMcpServer({
  info: { name: "example-agent", version: "0.1.0" },
  instructions:
    "Call the `ask` tool with a message. It runs asynchronously: the call " +
    "returns a taskId; block on tasks/result for the reply.",
  transport: McpTransportConfigSchema.parse({
    bindHost: "127.0.0.1",
    bindPort: Number(process.env.PORT ?? 4317),
    publicPath: "/mcp",
    stateful: true,
    enableJsonResponse: true,
  }),
  modules: [tasks],
});

console.log(`example-agent listening at ${server.url}`);

// The composition root owns BOTH lifecycles — the kernel does not know about
// the agent, so it cannot close it for us.
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.once(sig, () => {
    console.log(`\nreceived ${sig}, shutting down…`);
    void Promise.allSettled([server.close(), agent.close()]).finally(() =>
      process.exit(0),
    );
  });
}
