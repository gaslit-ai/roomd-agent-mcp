// The `TaskHandle` — the interaction surface this feature hands to a bridge.
//
// A task is a finite state machine over the MCP Tasks protocol:
//
//     created ─▶ working ⇄ input_required ─▶ { completed | failed | cancelled }
//
// Termination is NOT something the bridge triggers explicitly. The bridge
// is an async function (`start`) — it RETURNS a `CallToolResult`
// (→ completed) or THROWS (→ failed). The feature owns every terminal
// transition; the handle is purely the *non-terminal* interaction
// channel: progress, the `input_required` toggle, and the abort signal.
//
// This is what makes "every task ends" structural rather than a footgun:
//   - There is no "mark done" button to forget — `start` settling IS the
//     terminal signal, and TypeScript enforces that `start` returns a
//     result on every path.
//   - A run deadline (see `TaskHandleInit.taskTimeoutMs`) force-fails any
//     task whose `start` never settles. So even a hung bridge cannot pin
//     a task in `working` forever.
//
// What the handle / feature ENFORCE so the bridge cannot get it wrong:
//   - Guaranteed termination (deadline backstop, above).
//   - Exactly-once termination. The first terminal transition — `start`
//     settling, the deadline, or `cancel` — wins; the rest are no-ops.
//   - No progress after terminal (spec §"Task Progress Notifications").
//     A terminal transition drains all in-flight progress sends BEFORE
//     it writes the terminal result.
//   - `_meta` namespacing — implementer keys are prefixed; the spec's
//     `io.modelcontextprotocol/*` keys are left untouched.
//   - `progressToken` gating — with no token there is nothing to attach
//     progress to, so `progress` is silently dropped.
//
// `TaskHandle` is the whole bridge-facing surface. `TaskHandleImpl` is the
// concrete FSM; the feature constructs one per task and exposes it to the
// bridge only as the narrow `TaskHandle`. The terminal controls
// (`complete`/`fail`/`cancel`) live on the impl, feature-only.
import type {
  CallToolResult,
  ServerNotification,
  Task,
} from "@modelcontextprotocol/sdk/types.js";
import type {
  NotificationOptions,
  RequestTaskStore,
} from "@modelcontextprotocol/sdk/shared/protocol.js";

/**
 * Structured failure. The feature also accepts a plain `Error`, which is
 * narrowed to this shape before being stored.
 */
export interface TaskFailure {
  readonly name: string;
  readonly message: string;
}

/**
 * The interaction surface a bridge's `start` callback receives. It carries
 * no terminal controls: the bridge ends the task by returning from / or
 * throwing out of `start`. The handle is for everything that happens
 * *during* the run.
 */
export interface TaskHandle {
  /** Store-assigned task id. Handy for the bridge's own logging. */
  readonly taskId: string;
  /**
   * Aborts when the task is cancelled (`tasks/cancel`), hits its run
   * deadline, or the kernel shuts down. The bridge watches this to wind
   * down its work.
   */
  readonly signal: AbortSignal;
  /**
   * Emit a progress notification. `meta` keys are namespaced under the
   * configured prefix. No-op once the task is terminal, or if the caller
   * supplied no `progressToken` (nothing to attach progress to).
   */
  progress(message: string, meta?: Record<string, unknown>): void;
  /**
   * Transition the task to `input_required` — it is waiting on input the
   * bridge resolves out-of-band. No-op if terminal or already
   * `input_required`.
   */
  needsInput(message: string): void;
  /** Transition `input_required` back to `working`. No-op otherwise. */
  resume(): void;
}

/**
 * The bridge seam — the one mandatory callback wired into
 * `createTasksFeature`. Invoked once per `tasks/create`, off the request
 * path (the create-response is already on its way back).
 *
 * It MUST resolve to a `CallToolResult` (→ task `completed`) or throw
 * (→ task `failed`). TypeScript enforces that every code path produces a
 * result; the run deadline backstops a promise that never settles. For an
 * event-shaped bridge, `start` returns a promise that resolves when the
 * underlying stream reaches its terminal event.
 */
export type TaskStart<TArgs> = (
  args: TArgs,
  handle: TaskHandle,
) => CallToolResult | Promise<CallToolResult>;

/**
 * Minimal slice of the MCP server the handle needs: the ability to send
 * one notification. Narrowing to this keeps the handle decoupled from the
 * kernel and unit-testable with a trivial fake. The kernel's `Server`
 * satisfies it structurally.
 */
export interface NotificationSink {
  notification(
    notification: ServerNotification,
    options?: NotificationOptions,
  ): Promise<void>;
}

/** Construction inputs for a `TaskHandleImpl` — wired by the feature. */
export interface TaskHandleInit {
  readonly taskId: string;
  readonly taskStore: RequestTaskStore;
  readonly transport: NotificationSink;
  readonly progressToken: string | number | undefined;
  readonly metaNamespace: string;
  /**
   * Run deadline (ms). When it elapses with the task still non-terminal,
   * the handle aborts the bridge's signal and force-fails the task.
   */
  readonly taskTimeoutMs: number;
}

/**
 * Concrete `TaskHandle`. One per task. Implements the FSM and owns every
 * piece of protocol plumbing the bridge never sees: the abort controller,
 * the run-deadline timer, the progress counter, the drain-before-terminal
 * ordering, the task-store writes, and the status notifications.
 *
 * Beyond `TaskHandle` it exposes terminal controls (`complete` / `fail` /
 * `cancel`), `done`, `settled`, and `abort` — all feature-only. The bridge
 * only ever holds it typed as the narrow `TaskHandle`.
 */
export class TaskHandleImpl implements TaskHandle {
  readonly taskId: string;

  readonly #ac = new AbortController();
  readonly #taskStore: RequestTaskStore;
  readonly #transport: NotificationSink;
  readonly #progressToken: string | number | undefined;
  readonly #metaNamespace: string;

  /** Non-terminal sub-state. Terminal state is tracked by `#terminating`. */
  #phase: "working" | "input_required" = "working";
  /**
   * Set synchronously by the first terminal transition (`complete`/
   * `fail`/`cancel`/deadline) BEFORE the async drain runs. Gates every
   * other method so nothing slips in after a terminal decision is made.
   */
  #terminating = false;
  #progressCounter = 0;
  /** In-flight notification sends, awaited by the drain. */
  readonly #pending = new Set<Promise<void>>();

  readonly #settled: Promise<void>;
  #resolveSettled!: () => void;

  /** Run-deadline timer. Cleared on the first terminal transition. */
  #deadline: ReturnType<typeof setTimeout> | undefined;

  constructor(init: TaskHandleInit) {
    this.taskId = init.taskId;
    this.#taskStore = init.taskStore;
    this.#transport = init.transport;
    this.#progressToken = init.progressToken;
    this.#metaNamespace = init.metaNamespace;
    this.#settled = new Promise<void>((resolve) => {
      this.#resolveSettled = resolve;
    });
    // The run deadline — the backstop that guarantees every task ends.
    // On breach: abort the bridge, then force-fail. `.unref()` so the
    // timer never keeps the process alive on its own.
    const deadline = setTimeout(() => {
      this.#deadline = undefined;
      this.#ac.abort();
      this.fail({
        name: "TaskTimeout",
        message: `task exceeded its ${init.taskTimeoutMs}ms run deadline`,
      });
    }, init.taskTimeoutMs);
    deadline.unref();
    this.#deadline = deadline;
  }

  get signal(): AbortSignal {
    return this.#ac.signal;
  }

  /** True once a terminal decision has been made (possibly still flushing). */
  get done(): boolean {
    return this.#terminating;
  }

  /**
   * Resolves once the task has reached a terminal status AND its result
   * (or terminal status) has been written to the store. The feature
   * binds task cleanup to this — and the run deadline guarantees it
   * always resolves, so a task can never leak.
   */
  get settled(): Promise<void> {
    return this.#settled;
  }

  // ---- public TaskHandle surface -------------------------------------

  progress(message: string, meta?: Record<string, unknown>): void {
    if (this.#terminating) return;
    if (this.#progressToken === undefined) return;
    this.#progressCounter += 1;
    const namespaced = this.#namespace(meta);
    const sent = this.#transport
      .notification(
        {
          method: "notifications/progress",
          params: {
            progressToken: this.#progressToken,
            progress: this.#progressCounter,
            message,
            ...(namespaced ? { _meta: namespaced } : {}),
          },
        },
        { relatedTask: { taskId: this.taskId } },
      )
      .catch((err: unknown) => {
        // Transport may have closed; progress is best-effort.
        this.#logError("progress notification failed", err);
      });
    this.#track(sent);
  }

  needsInput(message: string): void {
    if (this.#terminating) return;
    if (this.#phase === "input_required") return;
    this.#phase = "input_required";
    this.#track(this.#transition("input_required", message));
  }

  resume(): void {
    if (this.#terminating) return;
    if (this.#phase !== "input_required") return;
    this.#phase = "working";
    this.#track(this.#transition("working", "resumed"));
  }

  // ---- terminal controls (feature-only) ------------------------------

  /** Terminal success. No-op if the task already terminated. */
  complete(result: CallToolResult): void {
    if (this.#terminating) return;
    this.#terminating = true;
    this.#clearDeadline();
    void this.#settle("completed", result);
  }

  /** Terminal failure. No-op if the task already terminated. */
  fail(error: Error | TaskFailure): void {
    if (this.#terminating) return;
    this.#terminating = true;
    this.#clearDeadline();
    const failure: TaskFailure =
      error instanceof Error
        ? { name: error.name, message: error.message }
        : error;
    void this.#settle("failed", {
      content: [{ type: "text", text: failure.message }],
      structuredContent: { error: failure },
      isError: true,
    });
  }

  /**
   * Drive the task to `cancelled`: abort the signal so the bridge winds
   * down, drain in-flight progress, write the terminal status.
   *
   * Returns `true` if this call performed the cancellation, `false` if
   * the task had already terminated (or was mid-termination) by another
   * path — `start` settling or the deadline. The `tasks/cancel` handler
   * turns `false` into the spec-mandated `-32602`: the first terminal
   * decision always wins, and cancelling a terminal task is an error.
   */
  async cancel(): Promise<boolean> {
    if (this.#terminating) {
      await this.#settled;
      return false;
    }
    this.#terminating = true;
    this.#clearDeadline();
    this.#ac.abort();
    await this.#drain();
    try {
      await this.#taskStore.updateTaskStatus(
        this.taskId,
        "cancelled",
        "cancelled by request",
      );
      await this.#emitStatus();
    } catch (err) {
      this.#logError("cancel write failed", err);
    }
    this.#resolveSettled();
    return true;
  }

  /**
   * Shutdown path. Aborts the signal so a bridge that honors it winds
   * down, then force-fails the task so the handle settles
   * deterministically — even a bridge that ignores its signal cannot be
   * left immortal. This makes `detach()` safe as a mid-life operation,
   * not only at process exit. No-op (beyond the signal abort) if the task
   * already terminated.
   */
  abort(): void {
    this.#ac.abort();
    this.fail({
      name: "ServerShutdown",
      message: "server shut down before the task completed",
    });
  }

  // ---- internals -----------------------------------------------------

  /**
   * Shared terminal path for `complete`/`fail`. Drains in-flight progress
   * FIRST (spec §"Task Progress Notifications": no progress after
   * terminal), THEN writes the result and emits the terminal status.
   */
  async #settle(
    status: "completed" | "failed",
    result: CallToolResult,
  ): Promise<void> {
    await this.#drain();
    try {
      await this.#taskStore.storeTaskResult(this.taskId, status, result);
      await this.#emitStatus();
    } catch (err) {
      this.#logError("result write failed", err);
    }
    this.#resolveSettled();
  }

  /**
   * Await every in-flight notification send. Loops in case draining one
   * batch enqueued another (a tracked status transition can).
   */
  async #drain(): Promise<void> {
    while (this.#pending.size > 0) {
      await Promise.allSettled([...this.#pending]);
    }
  }

  /** `updateTaskStatus` + status notification, as one awaitable unit. */
  async #transition(status: Task["status"], message: string): Promise<void> {
    try {
      await this.#taskStore.updateTaskStatus(this.taskId, status, message);
      await this.#emitStatus();
    } catch (err) {
      this.#logError("status transition failed", err);
    }
  }

  /** Emit `notifications/tasks/status` with the current stored task. */
  async #emitStatus(): Promise<void> {
    let task: Task;
    try {
      task = await this.#taskStore.getTask(this.taskId);
    } catch {
      // Task already cleaned up — nothing to announce.
      return;
    }
    try {
      await this.#transport.notification({
        method: "notifications/tasks/status",
        params: task,
      });
    } catch (err) {
      this.#logError("status notification failed", err);
    }
  }

  #clearDeadline(): void {
    if (this.#deadline !== undefined) {
      clearTimeout(this.#deadline);
      this.#deadline = undefined;
    }
  }

  #track(promise: Promise<void>): void {
    this.#pending.add(promise);
    void promise.finally(() => {
      this.#pending.delete(promise);
    });
  }

  #namespace(
    meta: Record<string, unknown> | undefined,
  ): Record<string, unknown> | undefined {
    if (!meta) return undefined;
    const entries = Object.entries(meta);
    if (entries.length === 0) return undefined;
    const out: Record<string, unknown> = {};
    for (const [key, value] of entries) {
      out[`${this.#metaNamespace}${key}`] = value;
    }
    return out;
  }

  #logError(context: string, err: unknown): void {
    // eslint-disable-next-line no-console
    console.error(`[tasks] ${context}:`, err);
  }
}
