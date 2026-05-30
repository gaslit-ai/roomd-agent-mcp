// Generic tasks feature factory.
//
// This feature is a state machine over the MCP Tasks protocol and nothing
// else. It knows `tasks/create`, `tasks/get`, `tasks/result`,
// `tasks/cancel`, the five task statuses, the terminal-ordering rules, and
// the capability handshake. It does NOT know what a task runs.
//
// "A task is a task; the agent is the agent." The feature provides the
// ability; the implementer does the bridging. See `./handle.ts`.
//
// TWO BOUNDED PHASES
// ------------------
// The lifecycle is two phases, each with its own deadline — so a task can
// never hang and a stranded gate can never happen:
//
//   Phase 1 — the admission GATE (`deps.prepare`, optional).
//     Runs BEFORE the task is allocated, under `config.prepareTimeoutMs`.
//     It resolves eager `_meta` for the create-response — which, for a
//     real backend, can mean a side effect (e.g. opening a session). A
//     throw or timeout rejects `tasks/create` with no task allocated; if
//     allocation itself then fails, the gate's signal is aborted too. So
//     a `prepare` that wires its cleanup to `signal` strands nothing on
//     any failure path. A task exists only once the gate has passed.
//
//   Phase 2 — the task BODY (`deps.start`, mandatory).
//     Runs after the task is allocated; the client already holds its
//     task id and is polling. `start` resolving completes the task,
//     throwing fails it. The handle's run deadline (`taskTimeoutMs`)
//     force-fails it if `start` does neither. Cleanup is bound to the
//     handle settling — which the deadline guarantees — so a task can
//     never leak even if the bridge hangs.
//
// What `attach(ctx)` does:
//   1. Wire the kernel shutdown signal to abort every live task's handle.
//   2. Build a `ToolTaskHandler` (createTask / getTask / getTaskResult)
//      and register it task-only under `config.toolName`.
//   3. Replace the SDK's default `tasks/cancel` handler — which only
//      flips the stored status — with one that also aborts the bridge,
//      drains in-flight progress, and (spec §"Task Cancellation") returns
//      `-32602` when the task already terminated in the race window.
//
// Not in this file, by design: any concrete backend. Wiring opencode (or
// any agent) to `deps.start` is the implementer's job — a separate bridge.
//
// Authorization note: the MCP `TaskStore` API takes an optional
// `sessionId`, but there is no transport-level auth principal in scope
// here — every task is visible to any caller that knows the taskId. For
// multi-tenant deployments, run one server per tenant, or add auth
// middleware that populates `sessionId` and a `TaskStore` that scopes by
// it. `expose.list: false` (the default) keeps tasks unenumerable.
import type {
  CallToolResult,
  CancelTaskResult,
  ServerCapabilities,
  ServerNotification,
  ServerRequest,
  Task,
} from "@modelcontextprotocol/sdk/types.js";
import {
  CancelTaskRequestSchema,
  ErrorCode,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type {
  CreateTaskRequestHandlerExtra,
  TaskRequestHandlerExtra,
  ToolTaskHandler,
} from "@modelcontextprotocol/sdk/experimental/tasks/index.js";
import type { ZodRawShapeCompat } from "@modelcontextprotocol/sdk/server/zod-compat.js";
import type { z } from "zod";
import type { AgentModule, AttachContext } from "../../kernel/module.js";
import { TaskHandleImpl, type TaskStart } from "./handle.js";
import type { TasksFeatureConfig } from "./schemas/task-config.js";

/** Spec-defined `_meta` key the host model watches to know it may keep going. */
const MODEL_IMMEDIATE_RESPONSE_META_KEY =
  "io.modelcontextprotocol/model-immediate-response";

/** Terminal task statuses — mirrors the SDK's `isTerminal`. */
function isTerminal(status: Task["status"]): boolean {
  return (
    status === "completed" || status === "failed" || status === "cancelled"
  );
}

/**
 * Run the `prepare` admission gate under a hard deadline, using the
 * caller-owned `AbortController`. On timeout the controller is aborted and
 * the promise rejects with an MCP `RequestTimeout`; a throw from `prepare`
 * itself propagates the same way. The caller keeps the controller so it
 * can also abort the gate if a later step (task allocation) fails.
 */
async function runPrepareGate(
  prepare: (
    signal: AbortSignal,
  ) => Record<string, unknown> | Promise<Record<string, unknown>>,
  ac: AbortController,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<Record<string, unknown>>((_resolve, reject) => {
    timer = setTimeout(() => {
      ac.abort();
      reject(
        new McpError(
          ErrorCode.RequestTimeout,
          `prepare phase exceeded its ${timeoutMs}ms deadline`,
        ),
      );
    }, timeoutMs);
  });
  try {
    return await Promise.race([Promise.resolve(prepare(ac.signal)), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Build the `capabilities.tasks` subtree this feature contributes, gated
 * by `config.expose`. The kernel deep-merges it with other modules'
 * capabilities. `cancel` is always declared; `list` is opt-in (spec
 * §"Security Considerations").
 */
export function buildTasksFeatureCapabilities(
  config: Pick<TasksFeatureConfig, "expose">,
): Partial<ServerCapabilities> {
  const tasks: NonNullable<ServerCapabilities["tasks"]> = {
    cancel: {},
    requests: { tools: { call: {} } },
  };
  if (config.expose.list) {
    tasks.list = {};
  }
  return { tasks };
}

/** Default capabilities subtree (i.e. `list` omitted). */
export const TasksFeatureCapabilities: Partial<ServerCapabilities> =
  buildTasksFeatureCapabilities({ expose: { list: false } });

/**
 * Dependencies a recipe wires into `createTasksFeature`.
 *
 * `config` and the schemas are static; `start` is the bridge (mandatory)
 * and `prepare` is the optional admission gate. The feature is generic
 * over the Zod raw shape so `start` and `prepare` receive typed args.
 */
export interface TasksFeatureDeps<
  TShape extends z.ZodRawShape = z.ZodRawShape,
> {
  readonly config: TasksFeatureConfig;
  /** Zod raw shape lifted into the MCP tool's `inputSchema`. */
  readonly inputSchema: TShape;
  /**
   * Optional Zod raw shape lifted into the tool's `outputSchema`, so
   * clients see the declared result shape. Only the bridge knows what
   * `start` produces, so it supplies this.
   */
  readonly outputSchema?: z.ZodRawShape;
  /**
   * Optional admission gate. Runs under `config.prepareTimeoutMs` BEFORE
   * the task is allocated; its return lands on `CreateTaskResult._meta`
   * (keys namespaced).
   *
   * It MAY have side effects — e.g. opening a backend session to mint the
   * eager `_meta`. Wire any such cleanup to `signal`: it is aborted on
   * timeout AND if task allocation fails after `prepare` succeeded, so a
   * signal-honoring `prepare` strands nothing. A throw or timeout fails
   * `tasks/create` outright with no task allocated.
   */
  readonly prepare?: (
    args: z.infer<z.ZodObject<TShape>>,
    signal: AbortSignal,
  ) => Record<string, unknown> | Promise<Record<string, unknown>>;
  /**
   * The bridge — the task body. Resolves to a `CallToolResult`
   * (→ completed) or throws (→ failed). The run deadline force-fails it
   * if it does neither.
   */
  readonly start: TaskStart<z.infer<z.ZodObject<TShape>>>;
}

/**
 * Build the tasks feature as an `AgentModule`.
 *
 * The factory returns synchronously; the locator and server are only
 * touched inside `attach(ctx)`.
 */
export function createTasksFeature<TShape extends z.ZodRawShape>(
  deps: TasksFeatureDeps<TShape>,
): AgentModule {
  const { config } = deps;

  // Live tasks, keyed by taskId. Captured by the closures below; lives as
  // long as the module is attached. An entry is removed when its handle
  // settles (guaranteed by the run deadline), or on cancel / detach.
  const handles = new Map<string, TaskHandleImpl>();

  /** Listener on `ctx.shutdown`; removed in `detach()` to avoid a leak. */
  let onShutdown: (() => void) | undefined;
  let shutdownSignal: AbortSignal | undefined;

  return {
    name: "tasks",
    capabilities: buildTasksFeatureCapabilities(config),
    attach(ctx: AttachContext): void {
      // 1. On shutdown, abort every live handle so bridges wind down.
      shutdownSignal = ctx.shutdown;
      onShutdown = () => {
        for (const handle of handles.values()) {
          handle.abort();
        }
      };
      if (ctx.shutdown.aborted) {
        onShutdown();
      } else {
        ctx.shutdown.addEventListener("abort", onShutdown, { once: true });
      }

      // 2. The ToolTaskHandler. Shape fixed by the SDK.
      const handler: ToolTaskHandler<ZodRawShapeCompat> = {
        createTask: async (
          args: unknown,
          extra: CreateTaskRequestHandlerExtra,
        ) => {
          const typedArgs = args as z.infer<z.ZodObject<TShape>>;

          // Phase 1 — the admission gate. Bounded by `prepareTimeoutMs`.
          // The gate's AbortController is caller-owned so allocation
          // failure below can abort it too.
          let eagerMeta: Record<string, unknown> | undefined;
          let prepareAc: AbortController | undefined;
          if (deps.prepare) {
            const prepare = deps.prepare;
            prepareAc = new AbortController();
            eagerMeta = await runPrepareGate(
              (signal) => prepare(typedArgs, signal),
              prepareAc,
              config.prepareTimeoutMs,
            );
          }

          // Allocate the task. If allocation fails after a successful
          // gate, abort the gate's signal so a `prepare` that wired
          // cleanup to it winds down — nothing is left stranded.
          let task: Task;
          try {
            task = await extra.taskStore.createTask({
              ttl: config.defaultTtlMs,
              pollInterval: config.defaultPollIntervalMs,
            });
          } catch (err) {
            prepareAc?.abort();
            throw err;
          }

          // Construct the handle — its run deadline starts here.
          const handle = new TaskHandleImpl({
            taskId: task.taskId,
            taskStore: extra.taskStore,
            transport: ctx.server.server,
            progressToken: extra._meta?.progressToken,
            metaNamespace: config.metaNamespace,
            taskTimeoutMs: config.taskTimeoutMs,
          });
          handles.set(task.taskId, handle);

          // Phase 2 — the task body. `start` resolving completes the
          // task; throwing fails it; the run deadline force-fails it if
          // `start` settles as neither. `complete`/`fail` are no-ops once
          // a terminal decision has been made, so this races the deadline
          // safely.
          void Promise.resolve()
            .then(() => deps.start(typedArgs, handle))
            .then(
              (result) => handle.complete(result),
              (err: unknown) =>
                handle.fail(
                  err instanceof Error ? err : new Error(String(err)),
                ),
            );
          // Cleanup is bound to the handle settling — NOT to `start`.
          // The run deadline guarantees `settled` resolves, so the entry
          // is always reclaimed, even if `start` never settles.
          void handle.settled.then(() => {
            handles.delete(task.taskId);
          });

          // Return the create-response. Eager `_meta` keys are
          // namespaced; the spec key is added raw.
          const meta: Record<string, unknown> = {};
          if (eagerMeta) {
            for (const [key, value] of Object.entries(eagerMeta)) {
              meta[`${config.metaNamespace}${key}`] = value;
            }
          }
          if (config.modelImmediateResponseMessage !== undefined) {
            meta[MODEL_IMMEDIATE_RESPONSE_META_KEY] =
              config.modelImmediateResponseMessage;
          }
          return { task, _meta: meta };
        },
        getTask: async (_args: unknown, extra: TaskRequestHandlerExtra) => {
          return extra.taskStore.getTask(extra.taskId);
        },
        getTaskResult: async (
          _args: unknown,
          extra: TaskRequestHandlerExtra,
        ) => {
          return (await extra.taskStore.getTaskResult(
            extra.taskId,
          )) as CallToolResult;
        },
      };

      // 3. Register the tool, task-only. Schemas are cast across the zod /
      //    zod-compat boundary — the public `deps` types stay clean; only
      //    this SDK hand-off is loose.
      ctx.server.experimental.tasks.registerToolTask(
        config.toolName,
        {
          ...(config.description !== undefined
            ? { description: config.description }
            : {}),
          inputSchema: deps.inputSchema as unknown as ZodRawShapeCompat,
          ...(deps.outputSchema !== undefined
            ? {
                outputSchema:
                  deps.outputSchema as unknown as ZodRawShapeCompat,
              }
            : {}),
          ...(config.annotations !== undefined
            ? { annotations: config.annotations }
            : {}),
          // Task-only: the feature provides no synchronous code path, so
          // it does not advertise one.
          execution: { taskSupport: "required" },
        },
        handler,
      );

      // 4. Override the SDK's default `tasks/cancel` handler.
      ctx.server.server.setRequestHandler(
        CancelTaskRequestSchema,
        async (
          request,
          extra: RequestHandlerExtra<ServerRequest, ServerNotification>,
        ): Promise<CancelTaskResult> => {
          const taskId = request.params.taskId;
          if (!extra.taskStore) {
            throw new McpError(
              ErrorCode.InternalError,
              "tasks/cancel: no taskStore configured on the MCP server.",
            );
          }

          const handle = handles.get(taskId);
          if (handle) {
            // The handle is the authority for a live task. It drains
            // progress, aborts the bridge, and writes `cancelled` — and
            // reports whether it won the terminate race. If it lost (the
            // task completed/failed/timed-out first), spec §"Task
            // Cancellation" mandates -32602 for the now-terminal task.
            const didCancel = await handle.cancel();
            if (!didCancel) {
              const final = await extra.taskStore
                .getTask(taskId)
                .catch(() => null);
              throw new McpError(
                ErrorCode.InvalidParams,
                `Cannot cancel task: already in terminal status '${
                  final?.status ?? "unknown"
                }'`,
              );
            }
          } else {
            // No live handle — consult the store directly.
            const existing = await extra.taskStore
              .getTask(taskId)
              .catch(() => null);
            if (!existing) {
              // Unknown taskId — surface a clean -32602 rather than
              // letting `updateTaskStatus` throw a generic internal
              // error on a task that does not exist.
              throw new McpError(
                ErrorCode.InvalidParams,
                `Cannot cancel task: unknown task '${taskId}'`,
              );
            }
            if (isTerminal(existing.status)) {
              // Spec §"Task Cancellation": a terminal task MUST yield
              // -32602.
              throw new McpError(
                ErrorCode.InvalidParams,
                `Cannot cancel task: already in terminal status '${existing.status}'`,
              );
            }
            await extra.taskStore.updateTaskStatus(
              taskId,
              "cancelled",
              "cancelled by request",
            );
          }
          handles.delete(taskId);

          const finalTask = await extra.taskStore
            .getTask(taskId)
            .catch(() => null);
          return finalTask ? { ...finalTask } : ({} as CancelTaskResult);
        },
      );
    },
    detach(): void {
      // Best-effort: abort every in-flight bridge, drop all references.
      for (const handle of handles.values()) {
        handle.abort();
      }
      handles.clear();
      if (onShutdown && shutdownSignal) {
        shutdownSignal.removeEventListener("abort", onShutdown);
        onShutdown = undefined;
        shutdownSignal = undefined;
      }
    },
  };
}
