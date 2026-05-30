// Opencode agent configuration. Maps 1:1 onto knobs in `Session2.create`
// and `Session2.prompt` from `@opencode-ai/sdk/v2`. No MCP-side concerns
// live in this schema.
//
// SDK arg-map references (each knob below maps to one body/query field):
//   - Session2.create body: `node_modules/@opencode-ai/sdk/dist/v2/gen/sdk.gen.js:917-935`
//     (parentID, title, agent, model: { id, providerID, variant? }, permission, workspaceID)
//   - Session2.prompt body: `node_modules/@opencode-ai/sdk/dist/v2/gen/sdk.gen.js:2068-2088`
//     (messageID, model: { providerID, modelID }, agent, noReply, tools,
//     format, system, variant, parts)
import { z } from "zod";

/**
 * Opencode agent configuration. Consumed by `createOpencodeAgent(config)`
 * to construct the opencode agent (runtime + events + session reader).
 */
export const OpencodeAgentConfigSchema = z.object({
  /**
   * Model id in `providerID/modelID` form, e.g. `ollama/qwen3.6:27b`.
   * Split on the first `/` (some model ids contain additional `/`s, e.g.
   * `lmstudio/google/gemma-3n-e4b`) and passed as `{ providerID, modelID }`
   * to `Session2.prompt`.
   */
  model: z.string().min(1).optional(),

  /**
   * Provider-specific reasoning effort. Anthropic exposes `high|max`;
   * OpenAI exposes `low|medium|high|xhigh`; Ollama-via-OpenAI-compat
   * generally ignores this. Maps to `variant` body field.
   */
  variant: z.string().min(1).optional(),

  /**
   * Opencode-side agent name (`build`, `plan`, `scout`, `explore`, or a
   * user-defined agent declared in `~/.config/opencode/opencode.jsonc`).
   * Maps to `agent` body field. When omitted, opencode picks its default
   * agent ("build").
   */
  agent: z.string().min(1).optional(),

  /**
   * Per-message tool toggles. Maps to `tools: Record<string, boolean>`
   * body field. Example: `{ bash: false, edit: false }` to forbid tool
   * use on every invocation.
   */
  tools: z.record(z.string(), z.boolean()).optional(),

  /**
   * Resolved system prompt text. Loaded from disk by the recipe (when a
   * user-supplied env var points at a file), not by this schema. This
   * schema accepts the resolved string.
   */
  systemPrompt: z.string().min(1).optional(),

  /** Workspace path passed as the `directory` query parameter. */
  workspacePath: z.string().min(1),

  /**
   * If set, attach to an existing `opencode serve` instance via
   * `createOpencodeClient({ baseUrl })`. When unset, the backend lazily
   * spawns its own server via `createOpencode()`.
   */
  opencodeBaseUrl: z.string().url().optional(),

  /**
   * Title to set on auto-created opencode sessions. Defaults to a static
   * string; recipes typically pass the agent name.
   */
  sessionTitle: z.string().min(1).default("agent-mcp-server"),

  /**
   * Optional retry count for opencode's StructuredOutput tool. Only
   * meaningful when `format` is set (which this backend currently does
   * not — see `io.ts` for the input/output shape, which doesn't
   * declare `format`). Reserved for future shape variants that opt into
   * structured-output enforcement.
   */
  retryCount: z.number().int().min(0).optional(),
});

export type OpencodeAgentConfig = z.output<typeof OpencodeAgentConfigSchema>;
