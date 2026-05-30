// Resources feature factory.
//
// What this module does, at attach time:
//   1. Uses two injected dependencies:
//        - `reader` (required) — sources `resources/list` and
//          `resources/read` content.
//        - `events` (optional) — sources live event streams for
//          `resources/subscribe`. If absent, the feature degrades to
//          snapshot-only: subscribe still succeeds but no
//          `notifications/resources/updated` ever fires.
//   2. Registers handlers for the five resource-related MCP methods:
//        - `resources/list`            — paginate sessions from the reader,
//                                        emit two URIs per session.
//        - `resources/templates/list`  — return the two URI templates.
//        - `resources/read`            — snapshot → JSON, events → JSON-Lines.
//        - `resources/subscribe`       — track subscription per MCP client
//                                        session; on first subscription for
//                                        a sessionId, subscribe to the
//                                        events service.
//        - `resources/unsubscribe`     — drop subscription; on last
//                                        unsubscribe for a sessionId,
//                                        tear down the events subscription.
//
// Capability declaration:
//   - Contributes `{ resources: { subscribe: true, listChanged: false } }`.
//   - `subscribe: true` enables `resources/subscribe` and the
//     `notifications/resources/updated` notification.
//   - `listChanged: false` is the honest declaration. We do not emit
//     `notifications/resources/list_changed` because there is no
//     session-creation event the resources feature can subscribe to
//     globally — `AgentSessionEvents.subscribe(sessionId, listener)` is
//     per-session, not lifecycle-aware. Listing is on-demand via
//     `resources/list`; clients SHOULD re-list on a cadence if they need
//     fresh data. Resource list changes WILL show up on the next
//     `resources/list` call.
//
// Per-session event log:
//   - When the events service is present and a client subscribes, we open
//     ONE underlying subscription per sessionId (refcounted across both
//     `snapshot` and `events` URIs AND across all MCP client sessions).
//     The listener appends to an in-memory log capped at
//     `config.eventLogMaxEntries`. The log is also the source-of-truth
//     for `resources/read` against the `events` URI.
//
// Coalescing:
//   - Each underlying event schedules a debounced notification per
//     affected URI. The first event in a window starts a timer;
//     subsequent events within the same window reset/extend it. On timer
//     fire, ONE `notifications/resources/updated` is sent per affected
//     URI (snapshot AND events, since both are derived from the same
//     stream), per MCP client session that currently subscribes to that
//     URI.
//
// Per-MCP-client subscription identity:
//   - Subscription state is keyed by `extra.sessionId` (the MCP-transport
//     session id assigned by the streamable-HTTP transport — distinct from
//     the agent's session id). Multi-client deployments correctly route
//     updates to the client that asked for them, and partial unsubscribes
//     by one client never affect the other.
//   - The `sendNotification` callback captured from the subscribe-time
//     `extra` is what we invoke on debounced fires; this is the standard
//     SDK escape hatch for per-session notifications outside the request
//     scope.
//
// Shutdown:
//   - `detach()` synchronously flushes any pending debounced
//     notifications (so we don't drop the last update on shutdown), then
//     clears all pending timers, calls all stored unsubscribes from the
//     events service, and clears all maps.
import type {
  ServerCapabilities,
  ServerNotification,
  ServerRequest,
  ListResourcesRequest,
  ListResourcesResult,
  ListResourceTemplatesRequest,
  ListResourceTemplatesResult,
  ReadResourceRequest,
  ReadResourceResult,
  SubscribeRequest,
  UnsubscribeRequest,
  Resource,
  Result,
} from "@modelcontextprotocol/sdk/types.js";
import {
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ReadResourceRequestSchema,
  SubscribeRequestSchema,
  UnsubscribeRequestSchema,
  McpError,
  ErrorCode,
} from "@modelcontextprotocol/sdk/types.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { AgentModule, AttachContext } from "../../kernel/module.js";
import type {
  AgentSessionEvent,
  AgentSessionEventsUnsubscribe,
  AgentSessionReader,
  AgentSessionEvents,
} from "../../backends/interfaces/index.js";
import type { ResourcesFeatureConfig } from "./schemas/resources-config.js";

/**
 * Capabilities contributed by the resources feature. Merged with other
 * modules' capabilities by the kernel. `subscribe` enables
 * `resources/subscribe` + `notifications/resources/updated`;
 * `listChanged` is `false` because we have no global session-lifecycle
 * event source to drive emissions (see file header).
 */
export const ResourcesFeatureCapabilities: Partial<ServerCapabilities> = {
  resources: {
    subscribe: true,
    listChanged: false,
  },
};

/** Per-resource MIME types. */
const MIME_JSON = "application/json";
/**
 * JSON Lines content type. `application/jsonl` is the community-standard
 * convention (used by ndjson.org, Hugging Face, OpenAI, etc.) but is
 * NOT registered with IANA. The alternative `application/json-seq` is
 * RFC 7464 and requires a leading 0x1E (RS) record separator on each
 * record, which is NOT what we emit — we emit pure `\n`-delimited JSON.
 * The deprecated `application/x-ndjson` prefix has been retired in favor
 * of `application/jsonl`.
 */
const MIME_JSONL = "application/jsonl";

/**
 * JSON-RPC error code for "resource not found". Defined by the MCP spec
 * §"Error Handling" but not present in the SDK's `ErrorCode` enum
 * (which only covers the base JSON-RPC 2.0 codes plus ConnectionClosed,
 * RequestTimeout, and UrlElicitationRequired). Use the numeric literal.
 */
const RESOURCE_NOT_FOUND = -32002;

/**
 * `_meta` namespace prefix for resource/content annotations emitted by
 * this feature. Two keys are emitted:
 *   - `agent.opencode/session-id` — the agent sessionId for the resource.
 *   - `agent.opencode/kind`       — "snapshot" | "events".
 * Plus on `resources/read` content blocks:
 *   - `agent.opencode/last-modified` — ISO 8601 timestamp.
 */
const META_KEY_SESSION_ID = "agent.opencode/session-id";
const META_KEY_KIND = "agent.opencode/kind";
const META_KEY_LAST_MODIFIED = "agent.opencode/last-modified";

/**
 * Type of the `sendNotification` callback exposed on `RequestHandlerExtra`.
 * Cached at subscribe time so debounced notifications (which fire outside
 * any request scope) can still route per-MCP-client-session.
 */
type SendNotification = (notification: ServerNotification) => Promise<void>;

/**
 * Per-MCP-client-session subscription state.
 *
 * Keyed by `extra.sessionId` (the MCP transport session id, distinct
 * from the agent sessionId in the URI). Each entry tracks the URIs
 * the client has currently subscribed to and the cached
 * `sendNotification` callback we use to push updates back to that
 * specific transport.
 */
interface ClientSubscription {
  /** URIs the client is currently subscribed to. */
  uris: Set<string>;
  /**
   * Cached per-transport notification callback. Last subscribe wins
   * if multiple subscribes arrive with different `extra.sendNotification`
   * values for the same MCP session — the SDK guarantees the same
   * transport reuses the same callback for the lifetime of the session,
   * so in practice this is a single stable function.
   */
  sendNotification: SendNotification;
}

/**
 * Dependencies the composition root wires in: the config, the required
 * session reader, and the optional live event stream.
 */
export interface ResourcesFeatureDeps {
  readonly config: ResourcesFeatureConfig;
  /** Snapshot source — `resources/read` and `resources/list` read from it. */
  readonly reader: AgentSessionReader;
  /**
   * Live event stream. Optional: without it, `resources/subscribe` still
   * succeeds but no `notifications/resources/updated` ever fires.
   */
  readonly events?: AgentSessionEvents;
}

/**
 * Build the resources feature as an `AgentModule`.
 */
export function createResourcesFeature(deps: ResourcesFeatureDeps): AgentModule {
  const { config } = deps;
  const prefix = stripTrailingSlash(config.urlPrefix);

  // Per-feature instance state. Captured by the handler closures below;
  // lives as long as the module is attached.
  //
  // - `eventLogs`     : per-agent-session FIFO buffer of normalized events.
  //                     Source for `resources/read` against the events URI.
  // - `unsubscribers` : one-per-agent-session; populated on first subscriber
  //                     across ALL client sessions, cleared on last
  //                     unsubscribe across all client sessions (or detach).
  // - `agentSubscriberCount`: per-agent-session refcount summing
  //                     subscriptions across all MCP client sessions.
  //                     Determines when the upstream events subscription
  //                     should open and tear down.
  // - `debounceTimers`: per-URI debounce timer + the cleanup/fire fn it
  //                     was started with. Cleared on fire (or detach).
  //                     We store the fire callback alongside the timer so
  //                     detach() can flush pending updates synchronously.
  // - `clientSubscriptions`: per-MCP-client-session subscription state.
  //                     Keyed by `extra.sessionId`; tracks per-client URIs
  //                     and the cached `sendNotification` callback.
  // - `agentLastModified` : per-agent-session ISO timestamp of the last
  //                     time an event was observed. Surfaced on read
  //                     content-block `_meta`. Falls back to "now" if no
  //                     event has been recorded yet.
  const eventLogs = new Map<string, AgentSessionEvent[]>();
  const unsubscribers = new Map<string, AgentSessionEventsUnsubscribe>();
  const agentSubscriberCount = new Map<string, number>();
  const debounceTimers = new Map<
    string,
    { timer: NodeJS.Timeout; fire: () => void }
  >();
  const clientSubscriptions = new Map<string, ClientSubscription>();
  const agentLastModified = new Map<string, string>();

  return {
    name: "resources",
    capabilities: ResourcesFeatureCapabilities,
    attach(ctx: AttachContext): void {
      // 1. Dependencies are injected by the composition root — the reader is
      //    required, events is optional.
      const reader: AgentSessionReader = deps.reader;
      const events: AgentSessionEvents | undefined = deps.events;

      const server = ctx.server.server;

      // 2a. resources/list
      server.setRequestHandler(
        ListResourcesRequestSchema,
        async (request: ListResourcesRequest): Promise<ListResourcesResult> => {
          const cursor = request.params?.cursor;
          const page = await reader.listSessions({
            limit: config.listLimit,
            ...(cursor !== undefined ? { cursor } : {}),
          });

          const resources: Resource[] = [];
          for (const session of page.sessions) {
            const baseTitle = session.title ?? session.id;
            const lastModifiedIso = new Date(session.updatedAt).toISOString();
            const encodedId = encodeURIComponent(session.id);
            resources.push({
              uri: snapshotUri(prefix, encodedId),
              name: `${session.id}.snapshot`,
              title: `${baseTitle} (snapshot)`,
              mimeType: MIME_JSON,
              annotations: { lastModified: lastModifiedIso },
              _meta: {
                [META_KEY_SESSION_ID]: session.id,
                [META_KEY_KIND]: "snapshot",
              },
            });
            resources.push({
              uri: eventsUri(prefix, encodedId),
              name: `${session.id}.events`,
              title: `${baseTitle} (events)`,
              mimeType: MIME_JSONL,
              annotations: { lastModified: lastModifiedIso },
              _meta: {
                [META_KEY_SESSION_ID]: session.id,
                [META_KEY_KIND]: "events",
              },
            });
          }

          const result: ListResourcesResult = {
            resources,
            ...(page.nextCursor !== undefined ? { nextCursor: page.nextCursor } : {}),
          };
          return result;
        },
      );

      // 2b. resources/templates/list
      server.setRequestHandler(
        ListResourceTemplatesRequestSchema,
        async (
          _request: ListResourceTemplatesRequest,
        ): Promise<ListResourceTemplatesResult> => {
          return {
            resourceTemplates: [
              {
                uriTemplate: `${prefix}/{sessionId}/snapshot`,
                name: "session-snapshot",
                title: "Agent session snapshot",
                description:
                  "Full JSON snapshot of an agent session: info + messages.",
                mimeType: MIME_JSON,
              },
              {
                uriTemplate: `${prefix}/{sessionId}/events`,
                name: "session-events",
                title: "Agent session event log",
                description:
                  "JSON-Lines event log captured for an agent session.",
                mimeType: MIME_JSONL,
              },
            ],
          };
        },
      );

      // 2c. resources/read
      server.setRequestHandler(
        ReadResourceRequestSchema,
        async (request: ReadResourceRequest): Promise<ReadResourceResult> => {
          const uri = request.params.uri;
          const parsed = parseSessionResourceUri(uri, prefix);
          if (!parsed) {
            throw new McpError(
              RESOURCE_NOT_FOUND,
              "resource not found",
              { uri },
            );
          }

          const sessionId = parsed.sessionId;
          const lastModified =
            agentLastModified.get(sessionId) ?? new Date().toISOString();
          const contentMeta = {
            [META_KEY_SESSION_ID]: sessionId,
            [META_KEY_KIND]: parsed.kind,
            [META_KEY_LAST_MODIFIED]: lastModified,
          } satisfies Record<string, unknown>;

          if (parsed.kind === "snapshot") {
            let snapshot;
            try {
              snapshot = await reader.readSession(sessionId);
            } catch {
              throw new McpError(
                RESOURCE_NOT_FOUND,
                "resource not found",
                { uri },
              );
            }
            return {
              contents: [
                {
                  uri,
                  mimeType: MIME_JSON,
                  text: JSON.stringify(snapshot),
                  _meta: contentMeta,
                },
              ],
            };
          }

          // events: always return a single text block, even if empty.
          // An empty array would be misinterpreted as "resource missing";
          // returning a zero-length text content block is the honest
          // "resource exists, currently empty" signal.
          const log = eventLogs.get(sessionId) ?? [];
          const jsonl = log.map((e) => JSON.stringify(e)).join("\n");
          return {
            contents: [
              {
                uri,
                mimeType: MIME_JSONL,
                text: jsonl,
                _meta: contentMeta,
              },
            ],
          };
        },
      );

      // 2d. resources/subscribe
      server.setRequestHandler(
        SubscribeRequestSchema,
        async (
          request: SubscribeRequest,
          extra: RequestHandlerExtra<ServerRequest, ServerNotification>,
        ): Promise<Result> => {
          const uri = request.params.uri;
          const parsed = parseSessionResourceUri(uri, prefix);
          if (!parsed) {
            throw new McpError(
              ErrorCode.InvalidParams,
              `Unknown resource URI: ${uri}`,
            );
          }

          // Default to "" for transports that don't assign a session id
          // (stdio, or streamable HTTP in stateless mode). All clients
          // collapse onto the same bucket, which matches the previous
          // single-bucket behavior — multi-tenant deployments use the
          // stateful streamable HTTP transport, which DOES set sessionId.
          const clientSessionId = extra.sessionId ?? "";
          const existing = clientSubscriptions.get(clientSessionId);
          if (existing) {
            // Re-subscribe to the same URI is a no-op; subscribing to a
            // new URI extends the set. Refresh the cached
            // `sendNotification` from the latest call to be safe.
            existing.sendNotification = extra.sendNotification;
            if (!existing.uris.has(uri)) {
              existing.uris.add(uri);
              incrementAgentRefcount(parsed.sessionId);
            }
          } else {
            clientSubscriptions.set(clientSessionId, {
              uris: new Set([uri]),
              sendNotification: extra.sendNotification,
            });
            incrementAgentRefcount(parsed.sessionId);
          }

          return {};
        },
      );

      // 2e. resources/unsubscribe
      server.setRequestHandler(
        UnsubscribeRequestSchema,
        async (
          request: UnsubscribeRequest,
          extra: RequestHandlerExtra<ServerRequest, ServerNotification>,
        ): Promise<Result> => {
          const uri = request.params.uri;
          const parsed = parseSessionResourceUri(uri, prefix);
          if (!parsed) {
            throw new McpError(
              ErrorCode.InvalidParams,
              `Unknown resource URI: ${uri}`,
            );
          }

          const clientSessionId = extra.sessionId ?? "";
          const sub = clientSubscriptions.get(clientSessionId);
          if (!sub) {
            // Not subscribed: idempotent no-op.
            return {};
          }
          if (!sub.uris.delete(uri)) {
            // URI wasn't in this client's set: idempotent no-op.
            return {};
          }
          if (sub.uris.size === 0) {
            clientSubscriptions.delete(clientSessionId);
          }
          decrementAgentRefcount(parsed.sessionId);

          return {};
        },
      );

      /**
       * Open the upstream events subscription on first subscriber for
       * `agentSessionId` across ALL client sessions. Increments the
       * refcount on each call.
       */
      function incrementAgentRefcount(agentSessionId: string): void {
        const prev = agentSubscriberCount.get(agentSessionId) ?? 0;
        agentSubscriberCount.set(agentSessionId, prev + 1);
        if (prev === 0 && events && !unsubscribers.has(agentSessionId)) {
          // Initialize the log eagerly so subsequent `resources/read`
          // calls see an empty array rather than undefined.
          if (!eventLogs.has(agentSessionId)) {
            eventLogs.set(agentSessionId, []);
          }
          const unsub = events.subscribe(agentSessionId, (event) => {
            // Append, then evict from the front until within bounds.
            const log = eventLogs.get(agentSessionId) ?? [];
            log.push(event);
            while (log.length > config.eventLogMaxEntries) {
              log.shift();
            }
            eventLogs.set(agentSessionId, log);
            agentLastModified.set(agentSessionId, new Date().toISOString());

            // Schedule (or reset) one debounced timer per affected URI.
            // Both URIs are affected by every event for this session.
            const encodedId = encodeURIComponent(agentSessionId);
            const snapUri = snapshotUri(prefix, encodedId);
            const evtUri = eventsUri(prefix, encodedId);
            scheduleNotification(snapUri);
            scheduleNotification(evtUri);
          });
          unsubscribers.set(agentSessionId, unsub);
        }
      }

      /**
       * Decrement the refcount and tear down the upstream subscription if
       * we hit zero. The event log is preserved so re-subscribing doesn't
       * lose history.
       */
      function decrementAgentRefcount(agentSessionId: string): void {
        const prev = agentSubscriberCount.get(agentSessionId) ?? 0;
        if (prev <= 1) {
          agentSubscriberCount.delete(agentSessionId);
          const unsub = unsubscribers.get(agentSessionId);
          if (unsub) {
            try {
              unsub();
            } catch {
              // Idempotent; swallow.
            }
            unsubscribers.delete(agentSessionId);
          }
        } else {
          agentSubscriberCount.set(agentSessionId, prev - 1);
        }
      }

      /**
       * Schedule (or reset) a debounced `notifications/resources/updated`
       * for a single URI. The latest event in a window wins. Captures
       * `config.updateDebounceMs` and `server` (for fallback broadcast)
       * from the enclosing scope.
       *
       * On fire we look up every MCP client session currently subscribed
       * to this URI and call its cached `sendNotification` callback
       * directly. The SDK has no built-in per-session notification
       * routing for async (post-request) emissions, so caching the
       * `extra.sendNotification` at subscribe time is the standard
       * workaround.
       */
      function scheduleNotification(uri: string): void {
        const existing = debounceTimers.get(uri);
        if (existing) {
          clearTimeout(existing.timer);
        }
        const fire = (): void => {
          debounceTimers.delete(uri);
          for (const sub of clientSubscriptions.values()) {
            if (!sub.uris.has(uri)) continue;
            // Fire-and-forget; the SDK queues the message. Errors are
            // swallowed because there's no caller waiting on it — and
            // the protocol contract for notifications is one-way.
            sub
              .sendNotification({
                method: "notifications/resources/updated",
                params: { uri },
              })
              .catch(() => {
                // Transport may be closed mid-flight (e.g. on shutdown).
                // Silently drop.
              });
          }
        };
        const timer = setTimeout(fire, config.updateDebounceMs);
        debounceTimers.set(uri, { timer, fire });
      }
    },
    async detach(): Promise<void> {
      // Flush any pending debounced notifications synchronously before
      // tearing down — otherwise the last update in a coalesce window
      // would be silently dropped. We snapshot the values first because
      // `fire()` mutates `debounceTimers` via its `.delete(uri)` call.
      const pending = Array.from(debounceTimers.values());
      for (const { timer, fire } of pending) {
        clearTimeout(timer);
        try {
          fire();
        } catch {
          // Notifications are best-effort; never block shutdown.
        }
      }
      debounceTimers.clear();
      for (const unsub of unsubscribers.values()) {
        try {
          unsub();
        } catch {
          // Idempotent; swallow.
        }
      }
      unsubscribers.clear();
      eventLogs.clear();
      agentSubscriberCount.clear();
      clientSubscriptions.clear();
      agentLastModified.clear();
    },
  };
}

/** Drop one trailing slash if present, idempotent for prefixes that don't. */
function stripTrailingSlash(s: string): string {
  return s.endsWith("/") ? s.slice(0, -1) : s;
}

/**
 * Construct the snapshot URI for a session under a given prefix. The
 * caller is responsible for URL-encoding the sessionId.
 */
function snapshotUri(prefix: string, encodedSessionId: string): string {
  return `${prefix}/${encodedSessionId}/snapshot`;
}

/**
 * Construct the events URI for a session under a given prefix. The
 * caller is responsible for URL-encoding the sessionId.
 */
function eventsUri(prefix: string, encodedSessionId: string): string {
  return `${prefix}/${encodedSessionId}/events`;
}

/**
 * Parse a session-resource URI into its `(sessionId, kind)` parts.
 *
 * Matches strictly `${prefix}/${encodedSessionId}/${snapshot|events}`.
 * The encoded sessionId is URL-decoded back to its raw form before
 * being returned. Returns `undefined` for anything else (caller turns
 * this into an MCP error).
 *
 * Exported via the public boundary for unit-testability of the parser.
 */
export function parseSessionResourceUri(
  uri: string,
  prefix: string,
): { sessionId: string; kind: "snapshot" | "events" } | undefined {
  const stripped = stripTrailingSlash(prefix);
  const lead = `${stripped}/`;
  if (!uri.startsWith(lead)) return undefined;

  const tail = uri.slice(lead.length);
  // Split into [encodedSessionId, kind] — refuse anything with extra
  // segments or empty parts.
  const slash = tail.lastIndexOf("/");
  if (slash <= 0) return undefined;
  const encodedSessionId = tail.slice(0, slash);
  const kind = tail.slice(slash + 1);
  if (encodedSessionId.length === 0) return undefined;
  // Reject extra slashes within the encoded sessionId segment — a `/`
  // in the actual sessionId MUST have been encoded to `%2F`. A raw
  // slash here means an extra path component, which we don't recognize.
  if (encodedSessionId.includes("/")) return undefined;
  if (kind !== "snapshot" && kind !== "events") return undefined;
  let sessionId: string;
  try {
    sessionId = decodeURIComponent(encodedSessionId);
  } catch {
    // Malformed percent-encoding.
    return undefined;
  }
  if (sessionId.length === 0) return undefined;
  return { sessionId, kind };
}
