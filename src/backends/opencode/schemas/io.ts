// Opencode agent I/O shapes — the plain-data vocabulary `createOpencodeAgent`
// produces. `SpawnInfo` is what `spawn()` returns; `PromptResult` is what an
// `AgentRun.result` resolves to. No MCP, no task vocabulary.
//
// Fields map to `AssistantMessage` from
//   node_modules/@opencode-ai/sdk/dist/v2/gen/types.gen.d.ts
// (`id` -> messageId, `finish` -> finishReason).
import { z } from "zod";

/**
 * One tool call extracted from a `tool` Part of the assistant message.
 */
export const OpencodeToolCallSchema = z.object({
  tool: z.string().min(1),
  callId: z.string().min(1),
  input: z.unknown(),
  output: z.string().optional(),
  error: z.string().optional(),
  durationMs: z.number().optional(),
  status: z.enum(["pending", "running", "completed", "error"]),
});
export type OpencodeToolCall = z.output<typeof OpencodeToolCallSchema>;

/**
 * The structured result of one `prompt` turn. `text` is the concatenated
 * non-synthetic text parts; `reasoning` the concatenated reasoning parts
 * (omitted when empty); `toolCalls` populated from `tool` parts when present.
 */
export const PromptResultSchema = z.object({
  sessionId: z.string().min(1),
  messageId: z.string().min(1),
  parentMessageId: z.string().min(1),
  agent: z.string().min(1),
  mode: z.string().min(1),
  model: z.object({
    providerID: z.string().min(1),
    modelID: z.string().min(1),
  }),
  workspace: z.object({ cwd: z.string(), root: z.string() }),
  tokens: z.object({
    total: z.number().optional(),
    input: z.number(),
    output: z.number(),
    reasoning: z.number(),
    cache: z.object({ read: z.number(), write: z.number() }),
  }),
  cost: z.number(),
  durationMs: z.number().optional(),
  finishReason: z.string().min(1).optional(),
  text: z.string(),
  reasoning: z.string().optional(),
  toolCalls: z.array(OpencodeToolCallSchema).optional(),
  parts: z.array(z.string()),
});
export type PromptResult = z.output<typeof PromptResultSchema>;

/**
 * What `spawn()` returns — plain eager data about a freshly opened session.
 * `model` / `agent` are present only when pinned in config; before the first
 * prompt the agent cannot know opencode's chosen defaults.
 */
export interface SpawnInfo {
  readonly sessionId: string;
  readonly workspace: { cwd: string; root: string };
  readonly model?: { providerID: string; modelID: string };
  readonly agent?: string;
}
