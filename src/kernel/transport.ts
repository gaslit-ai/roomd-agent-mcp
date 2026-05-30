// Streamable HTTP transport factory.
//
// Builds a `StreamableHTTPServerTransport` and mounts it on a Node HTTP
// listener. Auth (HTTP Basic), CORS / DNS rebinding protection (via
// `allowedOrigins` and `allowedHosts`), rate limiting, and resumability
// (in-memory `EventStore`) are wired through the transport config.
//
// Resumability note: when `config.resumabilityEventStorePath` is set the
// kernel instantiates an IN-MEMORY `EventStore`. The path field is
// currently ignored; a file-backed `EventStore` is a future enhancement,
// the schema preserves the field so it doesn't shift when it lands.
//
// Streamable-HTTP-specific Tasks behavior to honor (spec 2025-11-25):
//   - `tasks/get`: SHOULD NOT upgrade to SSE (client wants to poll). The
//     SDK transport selects SSE vs JSON via the transport-wide
//     `enableJsonResponse` flag — there's no per-request override. The
//     kernel pre-parses the request body and, when the method is
//     `tasks/get`, temporarily flips the underlying web-standard
//     transport's `_enableJsonResponse` private field to `true` for the
//     duration of the single `handleRequest` call. The flag is restored
//     in `finally` so subsequent non-tasks/get requests use the
//     configured default. Trade-off: concurrent SSE responses on other
//     streams would temporarily see the flag flipped — acceptable, the
//     kernel's primary use case is task polling and the window is small.
//   - `tasks/result`: MAY hold SSE open for side-channel messages.
//   - Clients MAY disconnect mid-stream; background work must continue.
//   - Notifications may land on any open stream.
import { randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type {
  EventStore,
  EventId,
  StreamId,
} from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import type { McpTransportConfig } from "./schemas/transport-config.js";
import {
  createTokenBucketRateLimiter,
  type TokenBucketRateLimiter,
} from "./rate-limiter.js";

/**
 * Handle returned by the transport factory. Wraps both the SDK transport
 * and the underlying Node HTTP listener so the kernel can shut them down
 * in tandem.
 */
export interface AgentTransportHandle {
  /** Fully resolved URL the server is listening on (with assigned port). */
  readonly url: string;
  /**
   * The opaque SDK transport object. The kernel will pass this to
   * `mcpServer.connect(transport)`. Typed as `unknown` here to avoid
   * leaking SDK types through the kernel's public boundary; the kernel
   * impl will narrow back to the SDK's `Transport` type internally.
   */
  readonly sdkTransport: unknown;
  /** Tear down the HTTP listener and the SDK transport. Idempotent. */
  close(): Promise<void>;
}

/** Shutdown grace period: how long to wait for `httpServer.close()` to
 * settle after `closeAllConnections()`. The keep-alive close happens
 * immediately, but the SDK's per-request promises may still be
 * resolving. */
const SHUTDOWN_GRACE_MS = 5_000;

/**
 * Build a Streamable HTTP transport listening on `config.bindHost`:`config.bindPort`.
 * Returns once the listener is bound; the kernel calls `mcpServer.connect`
 * on the returned `sdkTransport` afterwards.
 */
export async function createStreamableHttpTransport(
  config: McpTransportConfig,
): Promise<AgentTransportHandle> {
  // 1. Build the SDK transport. Use stateful mode (per-client session id)
  //    iff `config.stateful` is true. Optional fields are only included when
  //    set (exactOptionalPropertyTypes friendly).
  //
  // Note: stateless mode is expressed by OMITTING `sessionIdGenerator`
  // entirely — the SDK's option type does not accept `undefined` under
  // `exactOptionalPropertyTypes`. The SDK treats "missing" as stateless,
  // matching the schema's intent.
  //
  // DNS rebinding protection: the SDK only honors `allowedOrigins` /
  // `allowedHosts` when `enableDnsRebindingProtection: true` is also set.
  // Without it, the field is silently ignored — a NO-OP. We flip the flag
  // automatically whenever EITHER allow-list is configured. When neither
  // is configured, protection is left off (matches SDK default; document
  // the spec warning in the schema).
  const dnsProtectionEnabled =
    (config.allowedOrigins !== undefined && config.allowedOrigins.length > 0) ||
    (config.allowedHosts !== undefined && config.allowedHosts.length > 0);

  // In-memory EventStore: when `resumabilityEventStorePath` is set, the
  // kernel installs a memory-backed implementation. The path itself is
  // ignored today (see file header).
  const eventStore: EventStore | undefined =
    config.resumabilityEventStorePath !== undefined
      ? createInMemoryEventStore()
      : undefined;

  const transport = new StreamableHTTPServerTransport({
    ...(config.stateful ? { sessionIdGenerator: () => randomUUID() } : {}),
    enableJsonResponse: config.enableJsonResponse,
    ...(config.allowedOrigins !== undefined ? { allowedOrigins: config.allowedOrigins } : {}),
    ...(config.allowedHosts !== undefined ? { allowedHosts: config.allowedHosts } : {}),
    ...(dnsProtectionEnabled ? { enableDnsRebindingProtection: true } : {}),
    ...(eventStore !== undefined ? { eventStore } : {}),
  });

  // 2. Build the rate limiter (optional). When `rateLimit` is undefined
  //    the limiter is skipped entirely — every request passes through.
  const rateLimiter: TokenBucketRateLimiter | undefined =
    config.rateLimit !== undefined
      ? createTokenBucketRateLimiter({
          capacity: config.rateLimit.capacity,
          refillPerSecond: config.rateLimit.refillPerSecond,
        })
      : undefined;
  const rateLimitKeyStrategy = config.rateLimit?.keyStrategy ?? "remote-address";

  // 3. Build the Node HTTP listener. Reject anything outside `publicPath`
  //    with 404. Pre-parse JSON for POST bodies, then hand off to the SDK
  //    transport.
  const httpServer: Server = createServer(async (req, res) => {
    try {
      // HTTP Basic Auth gate when configured. Runs BEFORE the path gate
      // so unauthenticated probes can't enumerate which paths exist.
      if (config.basicAuthUser !== undefined) {
        if (!checkBasicAuth(req, config.basicAuthUser, config.basicAuthPassword ?? "")) {
          res.statusCode = 401;
          // RFC 7617 §2.1: `charset="UTF-8"` advertises that the server
          // will accept UTF-8-encoded credentials.
          res.setHeader("WWW-Authenticate", 'Basic realm="agent", charset="UTF-8"');
          res.end();
          return;
        }
      }

      // Path gate: only handle requests on the configured public path.
      const url = req.url ?? "";
      const pathname = pathnameOf(url);
      if (pathname !== config.publicPath && !pathname.startsWith(`${config.publicPath}/`)) {
        res.statusCode = 404;
        res.end();
        return;
      }

      // Kernel-side Origin allow-list check. The SDK only rejects when
      // the Origin header is PRESENT and mismatched; it lets missing-Origin
      // requests pass. The spec requires us to reject missing-Origin too
      // when an allow-list is configured.
      if (
        config.allowedOrigins !== undefined &&
        config.allowedOrigins.length > 0 &&
        !originAllowed(req, config.allowedOrigins)
      ) {
        res.statusCode = 403;
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32000, message: "Origin not allowed" },
            id: null,
          }),
        );
        return;
      }

      // Rate limiter gate. Runs after auth (so we don't rate-limit
      // unauthenticated probes alongside genuine clients) but before any
      // body parsing or SDK delegation.
      if (rateLimiter !== undefined) {
        const key = computeRateLimitKey(req, rateLimitKeyStrategy);
        if (!rateLimiter.allow(key)) {
          const retryAfter = rateLimiter.retryAfterSeconds(key);
          res.statusCode = 429;
          res.setHeader("Retry-After", String(retryAfter));
          res.setHeader("Content-Type", "application/json");
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              error: { code: -32000, message: "Too Many Requests" },
              id: null,
            }),
          );
          return;
        }
      }

      // Parse JSON body when POST; the SDK transport accepts a pre-parsed body
      // and uses it instead of re-reading the stream.
      let body: unknown;
      if (req.method === "POST") {
        body = await readJsonBody(req);
      }

      // tasks/get override: force JSON response for poll requests so
      // we don't upgrade them to SSE (spec SHOULD-NOT). The SDK exposes
      // no per-request flag, so we temporarily flip the underlying
      // web-standard transport's private `_enableJsonResponse` field.
      // We restore the original value in `finally`.
      const isTasksGet = isTasksGetBody(body);
      const sdkPrivate = getSdkPrivateState(transport);
      const originalJsonMode = sdkPrivate?._enableJsonResponse;
      if (isTasksGet && sdkPrivate !== undefined) {
        sdkPrivate._enableJsonResponse = true;
      }
      try {
        await transport.handleRequest(req, res, body);
      } finally {
        if (isTasksGet && sdkPrivate !== undefined && originalJsonMode !== undefined) {
          sdkPrivate._enableJsonResponse = originalJsonMode;
        }
      }
    } catch (err) {
      // Defensive: never leak an unhandled exception out of the request
      // handler. If we haven't sent headers yet, emit a 500.
      if (!res.headersSent) {
        res.statusCode = 500;
        res.end();
      }
      // Surface unexpected errors on stderr so they're visible during local
      // dev; the kernel doesn't wire a logger here.
      // eslint-disable-next-line no-console
      console.error("[agent-kernel/transport] request handler error:", err);
    }
  });

  // Track open sockets so shutdown can drop lingering keep-alive
  // connections. Node's `closeAllConnections()` (added in 18.2) does this
  // automatically, but exposing the count via a tracked Set lets the
  // graceful-shutdown path know whether the timeout is necessary.
  const openSockets = new Set<Socket>();
  httpServer.on("connection", (socket) => {
    openSockets.add(socket);
    socket.on("close", () => openSockets.delete(socket));
  });

  // 4. Bind. Resolve the ACTUAL port from `httpServer.address()` once the
  //    socket is listening — important when `bindPort` is 0 (ephemeral).
  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error): void => {
      httpServer.off("error", onError);
      reject(err);
    };
    httpServer.once("error", onError);
    httpServer.listen(config.bindPort, config.bindHost, () => {
      httpServer.off("error", onError);
      resolve();
    });
  });

  const address = httpServer.address();
  const actualPort = isAddressInfo(address) ? address.port : config.bindPort;
  const url = `http://${config.bindHost}:${actualPort}${config.publicPath}`;

  return {
    url,
    sdkTransport: transport,
    close: async () => {
      // Best-effort: close the SDK transport first (so in-flight SSE streams
      // unwind cleanly), then drop lingering keep-alive sockets, then
      // close the listener.
      await transport.close();

      // Drop keep-alive connections so `httpServer.close()` doesn't hang
      // waiting on idle sockets. `closeAllConnections` was added in
      // Node 18.2; the cast is a runtime existence check for older
      // engines.
      const closeAll = (httpServer as Server & { closeAllConnections?: () => void })
        .closeAllConnections;
      if (typeof closeAll === "function") {
        closeAll.call(httpServer);
      }

      // Wait for the listener to fully close. If something keeps it open
      // past `SHUTDOWN_GRACE_MS`, log a warning and resolve anyway so the
      // kernel doesn't hang.
      await new Promise<void>((resolve) => {
        let settled = false;
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          // eslint-disable-next-line no-console
          console.warn(
            `[agent-kernel/transport] httpServer.close() did not settle within ${SHUTDOWN_GRACE_MS}ms; ${openSockets.size} sockets still open`,
          );
          resolve();
        }, SHUTDOWN_GRACE_MS);
        // Don't keep the event loop alive solely for this timer.
        timer.unref?.();
        httpServer.close(() => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve();
        });
      });
    },
  };
}

/**
 * Extract just the pathname portion of a request URL. `req.url` is a path
 * like `/mcp?foo=bar`, never a full URL, so we slice at the query.
 */
function pathnameOf(url: string): string {
  const q = url.indexOf("?");
  return q === -1 ? url : url.slice(0, q);
}

/**
 * Validate an HTTP Basic credential against the configured user/password.
 * Returns `false` on missing or malformed `Authorization` header.
 *
 * Timing-safe: uses `crypto.timingSafeEqual` on byte buffers so an attacker
 * cannot probe individual credential bytes via response-time
 * side-channels. `timingSafeEqual` requires equal-length buffers; the
 * implementation short-circuits unequal-length comparisons but still
 * performs a timing-safe equal-length comparison against the expected
 * value to avoid leaking the expected length.
 */
function checkBasicAuth(
  req: IncomingMessage,
  expectedUser: string,
  expectedPassword: string,
): boolean {
  const header = req.headers["authorization"];
  if (typeof header !== "string" || !header.startsWith("Basic ")) {
    return false;
  }
  const encoded = header.slice("Basic ".length).trim();
  let decoded: string;
  try {
    decoded = Buffer.from(encoded, "base64").toString("utf8");
  } catch {
    return false;
  }
  const sep = decoded.indexOf(":");
  if (sep === -1) {
    return false;
  }
  const user = decoded.slice(0, sep);
  const password = decoded.slice(sep + 1);
  return (
    timingSafeStringEqual(user, expectedUser) &&
    timingSafeStringEqual(password, expectedPassword)
  );
}

/**
 * Constant-time string equality check.
 *
 * Strategy: if lengths differ, compare against a normalized buffer of
 * equal length anyway and then return `false`. This avoids the timing
 * side-channel that a naive `a.length !== b.length && return false` would
 * leak (an attacker would observe a faster code path when lengths
 * mismatch).
 */
function timingSafeStringEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, "utf8");
  const bBuf = Buffer.from(b, "utf8");
  if (aBuf.length !== bBuf.length) {
    // Burn cycles on an equal-length comparison so the duration of this
    // branch matches the success-path duration. The result is discarded.
    const padded = Buffer.alloc(bBuf.length);
    timingSafeEqual(padded, bBuf);
    return false;
  }
  return timingSafeEqual(aBuf, bBuf);
}

/**
 * Read the full request body and parse as JSON. Returns `undefined` when the
 * body is empty so the SDK transport can treat it as a non-JSON request.
 * Throws on malformed JSON.
 */
async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer));
  }
  if (chunks.length === 0) {
    return undefined;
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (raw.length === 0) {
    return undefined;
  }
  return JSON.parse(raw);
}

function isAddressInfo(value: unknown): value is AddressInfo {
  return typeof value === "object" && value !== null && "port" in (value as Record<string, unknown>);
}

/**
 * Determine whether a request's Origin header is allowed. Treats missing
 * Origin as DISALLOWED when an allow-list is configured — the SDK's
 * native check only rejects mismatched present Origins, but the spec
 * intent is stricter.
 */
function originAllowed(req: IncomingMessage, allowedOrigins: readonly string[]): boolean {
  const origin = req.headers["origin"];
  if (typeof origin !== "string" || origin.length === 0) {
    // Missing Origin under a configured allow-list is disallowed.
    return false;
  }
  return allowedOrigins.includes(origin);
}

/**
 * Compute the rate-limit bucket key for an incoming request.
 *
 * Strategy semantics:
 *   - `"authorization"`: the raw `Authorization` header value.
 *   - `"remote-address"`: `req.socket.remoteAddress`.
 *   - `"global"`: the literal `"global"`.
 * When the chosen attribute is missing, falls back to `"global"` so the
 * limiter still applies (just without per-caller separation).
 */
function computeRateLimitKey(
  req: IncomingMessage,
  strategy: "authorization" | "remote-address" | "global",
): string {
  if (strategy === "global") {
    return "global";
  }
  if (strategy === "authorization") {
    const auth = req.headers["authorization"];
    if (typeof auth === "string" && auth.length > 0) {
      return `auth:${auth}`;
    }
    return "global";
  }
  // remote-address
  const addr = req.socket.remoteAddress;
  if (typeof addr === "string" && addr.length > 0) {
    return `addr:${addr}`;
  }
  return "global";
}

/**
 * Detect whether a parsed JSON-RPC body is a `tasks/get` request. Accepts
 * both single objects and batched arrays (returns `true` if ANY of the
 * batched messages is `tasks/get` — conservative; one tasks/get message
 * in a batch is enough to suppress SSE).
 */
function isTasksGetBody(body: unknown): boolean {
  if (body === null || typeof body !== "object") {
    return false;
  }
  if (Array.isArray(body)) {
    return body.some(isTasksGetBody);
  }
  return (body as { method?: unknown }).method === "tasks/get";
}

/**
 * Best-effort accessor for the SDK transport's private state. The SDK
 * doesn't expose per-request response-mode overrides; we reach into the
 * `_webStandardTransport._enableJsonResponse` private field on
 * `StreamableHTTPServerTransport`. Returns `undefined` if the shape ever
 * changes — callers should fall back to the configured default (no-op).
 */
export function getSdkPrivateState(
  transport: StreamableHTTPServerTransport,
): { _enableJsonResponse: boolean } | undefined {
  const outer = transport as unknown as { _webStandardTransport?: unknown };
  const inner = outer._webStandardTransport;
  if (
    typeof inner === "object" &&
    inner !== null &&
    "_enableJsonResponse" in inner &&
    typeof (inner as { _enableJsonResponse: unknown })._enableJsonResponse === "boolean"
  ) {
    return inner as { _enableJsonResponse: boolean };
  }
  return undefined;
}

/**
 * In-memory `EventStore` for SSE resumability. Stores up to a (per-stream)
 * sliding window of events keyed by an incrementing event id. Used when
 * `config.resumabilityEventStorePath` is set; the path itself is ignored
 * today (a future file-backed impl will honor it).
 */
function createInMemoryEventStore(): EventStore {
  let counter = 0;
  // streamId -> ordered list of (eventId, message)
  const byStream = new Map<StreamId, Array<{ eventId: EventId; message: JSONRPCMessage }>>();
  // eventId -> streamId reverse index
  const eventToStream = new Map<EventId, StreamId>();
  const MAX_EVENTS_PER_STREAM = 1_000;

  return {
    async storeEvent(streamId, message) {
      counter += 1;
      const eventId = String(counter);
      let entries = byStream.get(streamId);
      if (entries === undefined) {
        entries = [];
        byStream.set(streamId, entries);
      }
      entries.push({ eventId, message });
      eventToStream.set(eventId, streamId);
      // Bound memory: drop the oldest entries past the sliding window.
      while (entries.length > MAX_EVENTS_PER_STREAM) {
        const oldest = entries.shift();
        if (oldest !== undefined) {
          eventToStream.delete(oldest.eventId);
        }
      }
      return eventId;
    },
    async getStreamIdForEventId(eventId) {
      return eventToStream.get(eventId);
    },
    async replayEventsAfter(lastEventId, { send }) {
      const streamId = eventToStream.get(lastEventId);
      if (streamId === undefined) {
        // Unknown event id — return a synthetic stream id so the SDK can
        // proceed; nothing to replay.
        return `unknown:${lastEventId}`;
      }
      const entries = byStream.get(streamId) ?? [];
      const idx = entries.findIndex((e) => e.eventId === lastEventId);
      if (idx === -1) {
        return streamId;
      }
      for (const entry of entries.slice(idx + 1)) {
        await send(entry.eventId, entry.message);
      }
      return streamId;
    },
  };
}

// Re-export for tests that want to assert the response type of the
// listener's writes. Internal type alias — not part of the public API.
export type _InternalServerResponse = ServerResponse;
