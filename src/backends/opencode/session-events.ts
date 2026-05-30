// Opencode implementation of `AgentSessionEvents`. Multiplexes the
// opencode SSE bus (`client.event.subscribe()`) across multiple per-
// session listeners.
//
// Design:
//   - One upstream SSE handle for the whole backend, opened lazily on
//     first `subscribe()` call. Closed when the last subscription is
//     removed.
//   - `Map<sessionId, Set<listener>>` for fan-out. Errors thrown by
//     individual listeners are caught and logged to stderr; never
//     propagated upstream.
//   - Events are translated from the opencode bus union into the
//     normalized `AgentSessionEvent` discriminated union. Bus events
//     that don't map cleanly (legacy `session.next.*` parallels of the
//     `message.part.*` events, server keep-alives, idle pulses) are
//     dropped.
//
// Reference: `Event` from
//   node_modules/@opencode-ai/sdk/dist/v2/gen/types.gen.d.ts.
import type { OpencodeClient } from "@opencode-ai/sdk/v2";
import type {
  Event,
  Part,
  SessionStatus,
  ToolState,
} from "@opencode-ai/sdk/v2";
import type {
  AgentSessionEvent,
  AgentSessionEvents,
  AgentSessionEventsListener,
  AgentSessionEventsUnsubscribe,
  AgentToolCallState,
} from "../interfaces/index.js";
import type { OpencodeRuntime } from "./runtime.js";

/** Normalize an opencode ToolState into the framework's tool-call state. */
function normalizeToolState(state: ToolState): AgentToolCallState {
  const status = state.status;
  const metadata =
    "metadata" in state && state.metadata
      ? (state.metadata as Record<string, unknown>)
      : undefined;
  let durationMs: number | undefined;
  if (
    (status === "completed" || status === "error") &&
    "time" in state &&
    state.time &&
    typeof state.time.end === "number" &&
    typeof state.time.start === "number"
  ) {
    durationMs = state.time.end - state.time.start;
  }
  const out: AgentToolCallState = {
    status,
    ...("input" in state ? { input: state.input } : {}),
    ...(status === "completed"
      ? {
          output: (state as Extract<ToolState, { status: "completed" }>).output,
        }
      : {}),
    ...(status === "error"
      ? { error: (state as Extract<ToolState, { status: "error" }>).error }
      : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(metadata ? { metadata } : {}),
  };
  return out;
}

/**
 * Translate a single opencode bus event to a normalized
 * `AgentSessionEvent` plus the `sessionId` it should be delivered to.
 * Returns `undefined` for events that should be dropped (server
 * keepalives, duplicate `session.next.*` deltas already covered by
 * `message.part.*`, etc.).
 */
function translateEvent(
  event: Event,
): { sessionId: string; agentEvent: AgentSessionEvent } | undefined {
  switch (event.type) {
    case "message.part.delta": {
      const props = event.properties;
      if (props.field === "text") {
        return {
          sessionId: props.sessionID,
          agentEvent: {
            kind: "text-delta",
            messageId: props.messageID,
            partId: props.partID,
            delta: props.delta,
          },
        };
      }
      if (props.field === "reasoning") {
        return {
          sessionId: props.sessionID,
          agentEvent: {
            kind: "reasoning-delta",
            messageId: props.messageID,
            partId: props.partID,
            delta: props.delta,
          },
        };
      }
      return undefined;
    }
    case "message.part.updated": {
      const props = event.properties;
      const part = props.part as Part;
      const sessionId = props.sessionID;
      switch (part.type) {
        case "text": {
          if (!part.time || typeof part.time.end !== "number") return undefined;
          return {
            sessionId,
            agentEvent: {
              kind: "text",
              messageId: part.messageID,
              partId: part.id,
              text: part.text,
            },
          };
        }
        case "reasoning": {
          if (typeof part.time.end !== "number") return undefined;
          return {
            sessionId,
            agentEvent: {
              kind: "reasoning",
              messageId: part.messageID,
              partId: part.id,
              text: part.text,
            },
          };
        }
        case "tool": {
          return {
            sessionId,
            agentEvent: {
              kind: "tool-call",
              messageId: part.messageID,
              partId: part.id,
              tool: part.tool,
              callId: part.callID,
              state: normalizeToolState(part.state),
            },
          };
        }
        case "step-start": {
          return {
            sessionId,
            agentEvent: {
              kind: "step-start",
              messageId: part.messageID,
              partId: part.id,
            },
          };
        }
        case "step-finish": {
          return {
            sessionId,
            agentEvent: {
              kind: "step-finish",
              messageId: part.messageID,
              partId: part.id,
              reason: part.reason,
              tokens: {
                input: part.tokens.input,
                output: part.tokens.output,
                reasoning: part.tokens.reasoning,
                total:
                  part.tokens.total ??
                  part.tokens.input +
                    part.tokens.output +
                    part.tokens.reasoning,
                cache: {
                  read: part.tokens.cache.read,
                  write: part.tokens.cache.write,
                },
              },
              cost: part.cost,
            },
          };
        }
        default:
          return undefined;
      }
    }
    case "session.status": {
      const props = event.properties;
      const status = props.status as SessionStatus;
      if (status.type === "busy") {
        return {
          sessionId: props.sessionID,
          agentEvent: { kind: "status", status: "busy" },
        };
      }
      if (status.type === "idle") {
        return {
          sessionId: props.sessionID,
          agentEvent: { kind: "status", status: "idle" },
        };
      }
      // retry
      return {
        sessionId: props.sessionID,
        agentEvent: {
          kind: "status",
          status: "retry",
          retry: {
            attempt: status.attempt,
            message: status.message,
            next: status.next,
          },
        },
      };
    }
    case "session.next.model.switched": {
      const props = event.properties;
      return {
        sessionId: props.sessionID,
        agentEvent: {
          kind: "model-switched",
          model: {
            providerID: props.model.providerID,
            modelID: props.model.id,
            ...(props.model.variant !== undefined
              ? { variant: props.model.variant }
              : {}),
          },
        },
      };
    }
    case "session.next.agent.switched": {
      const props = event.properties;
      return {
        sessionId: props.sessionID,
        agentEvent: {
          kind: "agent-switched",
          agent: props.agent,
        },
      };
    }
    case "session.error": {
      const props = event.properties;
      const sessionId = props.sessionID;
      if (sessionId === undefined) return undefined;
      const err = props.error;
      const name = err ? (err as { name?: string }).name ?? "UnknownError" : "UnknownError";
      const message = err
        ? ((err as { data?: { message?: string } }).data?.message ??
          (err as { message?: string }).message ??
          name)
        : name;
      const data = err ? (err as { data?: unknown }).data : undefined;
      return {
        sessionId,
        agentEvent: {
          kind: "error",
          error: {
            name,
            message,
            ...(data !== undefined ? { data } : {}),
          },
        },
      };
    }
    case "permission.asked": {
      const props = event.properties as { sessionID?: string };
      const sessionId = props.sessionID;
      if (sessionId === undefined) return undefined;
      return {
        sessionId,
        agentEvent: { kind: "permission-asked", permission: props },
      };
    }
    case "session.updated": {
      const props = event.properties;
      return {
        sessionId: props.sessionID,
        agentEvent: { kind: "session-updated", info: props.info },
      };
    }
    default:
      // Drop everything else (server.connected, session.diff, session.idle,
      // message.updated, session.next.* duplicate streams, etc.).
      return undefined;
  }
}

/**
 * Internal multiplexer state plus close hook. Returned shape extends the
 * public `AgentSessionEvents` interface with `close()` so the backend
 * registration can tear the upstream stream down on shutdown.
 */
export interface OpencodeSessionEventsHandle
  extends AgentSessionEvents {
  close(): Promise<void>;
}

/**
 * Construct an opencode-flavored `AgentSessionEvents`. Lazy: no SSE
 * connection happens until `subscribe()` is called.
 */
export function createOpencodeSessionEvents(
  runtime: OpencodeRuntime,
): OpencodeSessionEventsHandle {
  const perSession = new Map<string, Set<AgentSessionEventsListener>>();
  let totalListeners = 0;
  let upstreamCloser: (() => void) | undefined;
  let upstreamStarting:
    | Promise<{ stream: AsyncGenerator<Event, void, unknown> }>
    | undefined;
  let closed = false;

  async function ensureUpstream(): Promise<void> {
    if (upstreamCloser || closed) return;
    if (upstreamStarting) {
      await upstreamStarting;
      return;
    }
    upstreamStarting = (async () => {
      const client = (await runtime.client()) as OpencodeClient;
      const result = await client.event.subscribe();
      return result as unknown as {
        stream: AsyncGenerator<Event, void, unknown>;
      };
    })();
    let handle: { stream: AsyncGenerator<Event, void, unknown> };
    try {
      handle = await upstreamStarting;
    } catch (err) {
      upstreamStarting = undefined;
      throw err;
    }
    upstreamStarting = undefined;
    let cancelled = false;
    upstreamCloser = () => {
      cancelled = true;
      // Best-effort cancellation of the upstream generator. The SDK
      // generator handles AbortSignal internally if passed; without one,
      // calling `return()` is the supported way to wind it down.
      void handle.stream.return?.(undefined).catch(() => {});
    };
    // Forwarder loop runs in the background.
    void (async () => {
      try {
        for await (const event of handle.stream) {
          if (cancelled) break;
          const translated = translateEvent(event);
          if (!translated) continue;
          const listeners = perSession.get(translated.sessionId);
          if (!listeners) continue;
          for (const listener of listeners) {
            try {
              listener(translated.agentEvent);
            } catch (err) {
              // eslint-disable-next-line no-console
              console.error(
                "[opencode-session-events] listener threw:",
                err,
              );
            }
          }
        }
      } catch (err) {
        if (!cancelled) {
          // eslint-disable-next-line no-console
          console.error("[opencode-session-events] upstream loop:", err);
        }
      } finally {
        upstreamCloser = undefined;
      }
    })();
  }

  return {
    subscribe(
      sessionId: string,
      listener: AgentSessionEventsListener,
    ): AgentSessionEventsUnsubscribe {
      if (closed) {
        return () => {};
      }
      let listeners = perSession.get(sessionId);
      if (!listeners) {
        listeners = new Set();
        perSession.set(sessionId, listeners);
      }
      listeners.add(listener);
      totalListeners++;
      // Lazy-start the upstream stream; if it fails we still return a
      // valid unsubscribe so callers don't leak refs.
      void ensureUpstream().catch((err) => {
        // eslint-disable-next-line no-console
        console.error("[opencode-session-events] upstream init failed:", err);
      });
      let unsubscribed = false;
      return () => {
        if (unsubscribed) return;
        unsubscribed = true;
        const set = perSession.get(sessionId);
        if (!set) return;
        if (set.delete(listener)) {
          totalListeners--;
        }
        if (set.size === 0) {
          perSession.delete(sessionId);
        }
        if (totalListeners === 0 && upstreamCloser) {
          upstreamCloser();
          upstreamCloser = undefined;
        }
      };
    },
    async close(): Promise<void> {
      closed = true;
      perSession.clear();
      totalListeners = 0;
      if (upstreamCloser) {
        upstreamCloser();
        upstreamCloser = undefined;
      }
    },
  };
}
