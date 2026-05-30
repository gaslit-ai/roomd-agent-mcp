// `AgentSessionEvents` — the contract for subscribing to a live
// session-event stream. The opencode agent implements it over opencode's
// `/event` SSE endpoint, multiplexed across per-session listeners; the
// resources feature consumes it to debounce-emit
// `notifications/resources/updated` while a resource subscription is active.
//
// EVENT NORMALIZATION
// -------------------
// Each backend translates its native event vocabulary into the
// `AgentSessionEvent` discriminated union below. Features consume the
// normalized stream — they never inspect backend-specific shapes.
//
// COALESCING is NOT the producer's job. The backend emits one event per
// underlying source event (token-by-token where applicable). Consumers
// that want time-bucketed coalescing do it themselves (e.g. the tasks
// feature batches `text-delta`/`reasoning-delta` into 250ms windows
// before emitting progress notifications). Keeping the producer raw
// preserves visibility for any consumer that wants full fidelity.

/**
 * Normalized token usage carried on `step-finish` events. Subset matching
 * what opencode + most other providers report.
 */
export interface AgentTokensSnapshot {
  readonly input: number;
  readonly output: number;
  readonly reasoning: number;
  readonly total: number;
  readonly cache?: {
    readonly read: number;
    readonly write: number;
  };
}

/**
 * Normalized tool-call state. Backends map their own shape onto this.
 *
 * `status`:
 *   - `pending`   — tool selected, input not yet fully formed
 *   - `running`   — input complete, tool executing
 *   - `completed` — terminal success; `output` populated
 *   - `error`     — terminal failure; `error` populated
 */
export interface AgentToolCallState {
  readonly status: "pending" | "running" | "completed" | "error";
  readonly input?: unknown;
  readonly output?: string;
  readonly error?: string;
  readonly durationMs?: number;
  readonly metadata?: Record<string, unknown>;
}

/**
 * Normalized session event union. New variants extend the union; existing
 * variants MUST NOT change shape without a major-version-style migration.
 *
 * `kind` is a string discriminator — kept human-readable on purpose so
 * the resource event-log NDJSON is debuggable as plain text.
 */
export type AgentSessionEvent =
  | {
      readonly kind: "text-delta";
      readonly messageId: string;
      readonly partId: string;
      readonly delta: string;
    }
  | {
      readonly kind: "reasoning-delta";
      readonly messageId: string;
      readonly partId: string;
      readonly delta: string;
    }
  | {
      readonly kind: "text";
      readonly messageId: string;
      readonly partId: string;
      readonly text: string;
    }
  | {
      readonly kind: "reasoning";
      readonly messageId: string;
      readonly partId: string;
      readonly text: string;
    }
  | {
      readonly kind: "tool-call";
      readonly messageId: string;
      readonly partId: string;
      readonly tool: string;
      readonly callId: string;
      readonly state: AgentToolCallState;
    }
  | {
      readonly kind: "step-start";
      readonly messageId: string;
      readonly partId: string;
    }
  | {
      readonly kind: "step-finish";
      readonly messageId: string;
      readonly partId: string;
      readonly reason: string;
      readonly tokens: AgentTokensSnapshot;
      readonly cost: number;
    }
  | {
      readonly kind: "status";
      readonly status: "busy" | "idle" | "retry";
      readonly retry?: {
        readonly attempt: number;
        readonly message: string;
        readonly next: number;
      };
    }
  | {
      readonly kind: "model-switched";
      readonly model: { providerID: string; modelID: string; variant?: string };
    }
  | {
      readonly kind: "agent-switched";
      readonly agent: string;
    }
  | {
      readonly kind: "error";
      readonly error: {
        readonly name: string;
        readonly message: string;
        readonly data?: unknown;
      };
    }
  | {
      readonly kind: "permission-asked";
      readonly permission: unknown;
    }
  | {
      readonly kind: "session-updated";
      readonly info: unknown;
    };

/** Unsubscribe callback returned by `subscribe`. Idempotent. */
export type AgentSessionEventsUnsubscribe = () => void;

/**
 * Listener callback fired for each normalized event.
 *
 * MUST NOT throw — implementations log and continue if a listener throws,
 * but well-behaved listeners catch their own errors.
 */
export type AgentSessionEventsListener = (event: AgentSessionEvent) => void;

/**
 * Subscribe to a single session's normalized event stream. Multiple
 * features (tasks + resources, typically) can subscribe to the same
 * session concurrently — the backend impl is responsible for
 * multiplexing (one upstream connection, fan-out to all listeners).
 *
 * `subscribe` SHOULD return quickly: heavy lifting like opening an
 * upstream SSE connection happens lazily on first subscription and is
 * cached across subscribers.
 */
export interface AgentSessionEvents {
  subscribe(
    sessionId: string,
    listener: AgentSessionEventsListener,
  ): AgentSessionEventsUnsubscribe;
}
