// Opencode agent — public boundary.
//
// `createOpencodeAgent(config)` builds the standalone opencode agent. This
// module imports no MCP and no kernel symbols; a composition root wires the
// agent into features directly.
export {
  createOpencodeAgent,
  type OpencodeAgent,
  type AgentRun,
} from "./agent.js";

export {
  OpencodeAgentConfigSchema,
  type OpencodeAgentConfig,
} from "./schemas/opencode-config.js";

export {
  OpencodeToolCallSchema,
  type OpencodeToolCall,
  PromptResultSchema,
  type PromptResult,
  type SpawnInfo,
} from "./schemas/io.js";

// Lower-level building blocks, for advanced composition.
export { createOpencodeRuntime, type OpencodeRuntime } from "./runtime.js";
export { createOpencodeSessionEvents } from "./session-events.js";
export { createOpencodeSessionReader } from "./session-reader.js";
