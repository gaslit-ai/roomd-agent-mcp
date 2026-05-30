// Config schema for the generic tasks feature.
//
// Everything here is PURE CONFIGURATION — protocol shape, timeout policy,
// or presentation. None of it knows what a task runs; that is the bridge's
// concern (the `start` callback wired into `createTasksFeature`). See
// `../feature.ts` for the split.
//
// The two timeouts encode the lifecycle's two bounded phases:
//   - `prepareTimeoutMs` bounds the admission gate. `prepare` blocks the
//     synchronous `tasks/create` response, so this must be tight.
//   - `taskTimeoutMs` bounds the async task body. It is the backstop that
//     makes "every task ends" a hard guarantee — a task that breaches it
//     is force-failed.
import { z } from "zod";

/**
 * Tool annotation hints surfaced on the registered task tool. Mirrors the
 * MCP SDK's `ToolAnnotations`; every field is optional.
 */
export const TasksToolAnnotationsSchema = z.object({
  title: z.string().optional(),
  readOnlyHint: z.boolean().optional(),
  destructiveHint: z.boolean().optional(),
  idempotentHint: z.boolean().optional(),
  openWorldHint: z.boolean().optional(),
});

/**
 * Configuration for one task-augmented MCP tool. A recipe supplies one of
 * these per `createTasksFeature` call.
 */
export const TasksFeatureConfigSchema = z
  .object({
    /** MCP tool name the task is registered under. */
    toolName: z.string().min(1),

    /** Human-readable tool description, surfaced in `tools/list`. */
    description: z.string().min(1).optional(),

    /** Optional tool annotation hints. */
    annotations: TasksToolAnnotationsSchema.optional(),

    /**
     * Capability-exposure gating. `list` is opt-in: per MCP spec
     * §"Security Considerations", a server with no per-caller identity
     * MUST NOT advertise task enumeration. `cancel` is always declared.
     *
     * (There is no `taskSupport` knob: this feature provides no
     * synchronous code path, so the tool is registered task-only —
     * advertising an untested sync lane would be dishonest.)
     */
    expose: z
      .object({
        list: z.boolean().default(false),
      })
      .default({ list: false }),

    /**
     * Admission-gate deadline (ms). The optional `prepare` hook MUST
     * resolve within this window — it blocks the synchronous
     * `tasks/create` response, so keep it tight. On breach, `prepare`'s
     * signal is aborted and `tasks/create` rejects; no task is allocated.
     *
     * If `prepare` does lazy cold-start work (e.g. spawning a backend on
     * first use), the FIRST call can be far slower than steady state —
     * the recipe should size this to the real first-call cost, or
     * pre-warm the backend so `prepare` stays fast.
     */
    prepareTimeoutMs: z.number().int().positive().default(5_000),

    /**
     * Run deadline (ms) for the task body. If the task has not reached a
     * terminal status by this deadline, the feature aborts the bridge and
     * force-fails the task. This is the guarantee that every task ends.
     *
     * It is a HARD CEILING: a legitimately long run (e.g. a slow local
     * model) that exceeds it is force-failed mid-flight, so the recipe
     * MUST size it to the agent's real worst case. Constrained to be <=
     * `defaultTtlMs` so the deadline fires before the store reaps the
     * record.
     */
    taskTimeoutMs: z.number().int().positive().default(300_000),

    /**
     * TTL (ms) requested when allocating a task in the store — how long
     * the result is retained after the task reaches a terminal status.
     * The store MAY clamp it.
     */
    defaultTtlMs: z.number().int().positive().default(600_000),

    /** Poll-interval (ms) hint returned to clients for `tasks/get`. */
    defaultPollIntervalMs: z.number().int().positive().default(1_000),

    /**
     * Namespace prefix applied to every implementer-supplied `_meta` key
     * — on progress notifications and on the create-response. Spec-defined
     * keys (`io.modelcontextprotocol/*`) are never namespaced; the feature
     * owns those. This keeps implementer payloads from colliding with the
     * spec's reserved keys.
     */
    metaNamespace: z.string().min(1).default("task/"),

    /**
     * Message stored under `io.modelcontextprotocol/model-immediate-response`
     * on the create-response, telling the host model it may keep going
     * while the task runs asynchronously. Omit to not emit the key.
     */
    modelImmediateResponseMessage: z.string().min(1).optional(),
  })
  .refine((c) => c.taskTimeoutMs <= c.defaultTtlMs, {
    message:
      "taskTimeoutMs must be <= defaultTtlMs — the run deadline must fire before the store reaps the task record",
    path: ["taskTimeoutMs"],
  });

export type TasksFeatureConfig = z.infer<typeof TasksFeatureConfigSchema>;
