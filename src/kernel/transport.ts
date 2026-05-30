// Streamable HTTP transport factory.
//
// Builds a Node HTTP listener that fronts MCP `StreamableHTTPServerTransport`
// instances. Auth (HTTP Basic), CORS / DNS rebinding protection (via
// `allowedOrigins` and `allowedHosts`), rate limiting, and resumability
// (in-memory `EventStore`) are wired through the transport config.
//
// SESSIONS
// --------
// In STATEFUL mode the kernel keeps ONE `StreamableHTTPServerTransport` (and
// one connected server) PER MCP session, keyed by `mcp-session-id`:
//   - a fresh `initialize` (no session id) mints a new transport + server;
//   - subsequent requests are routed to their session's transport by header;
//   - a DELETE tears the session down. The SDK does NOT signal a bare client
//     disconnect, so idle sessions are reaped on a timer
//     (`sessionIdleTimeoutMs`) and `maxSessions` caps how many accumulate.
// A single shared transport could only ever hold one session — the second
// client's `initialize` is rejected with "Server already initialized" — which
// is why each session gets its own. The server+module wiring is supplied by
// the caller as a `SessionConnector`, invoked once per session.
//
// In STATELESS mode there is no session binding, so each request gets its own
// transport + server, disposed when the request completes (the SDK forbids
// reusing a stateless transport across requests).
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
//     configured default.
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
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { McpTransportConfig } from "./schemas/transport-config.js";
import type { Logger } from "./logger.js";
import {
  createTokenBucketRateLimiter,
  type TokenBucketRateLimiter,
} from "./rate-limiter.js";

/**
 * Handle returned by the transport factory. Owns the Node HTTP listener and
 * every live session's transport+server.
 */
export interface AgentTransportHandle {
  /** Fully resolved URL the server is listening on (with assigned port). */
  readonly url: string;
  /** Tear down all sessions and the HTTP listener. Idempotent. */
  close(): Promise<void>;
}

/**
 * Connects a freshly-created SDK transport to a server instance and returns a
 * disposer. Called once per MCP session in stateful mode (and once at startup
 * in stateless mode). The disposer must abort the session's work, detach its
 * modules, and close its server (which closes the transport).
 */
export type SessionConnector = (
  transport: Transport,
) => Promise<() => Promise<void>>;

/** Shutdown grace period: how long to wait for `httpServer.close()` to
 * settle after `closeAllConnections()`. The keep-alive close happens
 * immediately, but the SDK's per-request promises may still be
 * resolving. */
const SHUTDOWN_GRACE_MS = 5_000;

/**
 * Build a Streamable HTTP transport listening on `config.bindHost`:`config.bindPort`.
 * `connectSession` wires a server + modules onto each session's transport;
 * `logger` receives transport-level diagnostics. Returns once the listener is
 * bound.
 */
export async function createStreamableHttpTransport(
  config: McpTransportConfig,
  connectSession: SessionConnector,
  logger: Logger,
): Promise<AgentTransportHandle> {
  // DNS rebinding protection: the SDK only honors `allowedOrigins` /
  // `allowedHosts` when `enableDnsRebindingProtection: true` is also set.
  // Without it, the field is silently ignored — a NO-OP. We flip the flag
  // automatically whenever EITHER allow-list is configured.
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

  // Options shared by every transport instance (the stateless singleton, or
  // one per stateful session). `sessionIdGenerator` and the per-session
  // callbacks are layered on in `createSession`.
  const baseTransportOptions = {
    enableJsonResponse: config.enableJsonResponse,
    ...(config.allowedOrigins !== undefined ? { allowedOrigins: config.allowedOrigins } : {}),
    ...(config.allowedHosts !== undefined ? { allowedHosts: config.allowedHosts } : {}),
    ...(dnsProtectionEnabled ? { enableDnsRebindingProtection: true } : {}),
    ...(eventStore !== undefined ? { eventStore } : {}),
  };

  // Build the rate limiter (optional). When `rateLimit` is undefined the
  // limiter is skipped entirely — every request passes through.
  const rateLimiter: TokenBucketRateLimiter | undefined =
    config.rateLimit !== undefined
      ? createTokenBucketRateLimiter({
          capacity: config.rateLimit.capacity,
          refillPerSecond: config.rateLimit.refillPerSecond,
        })
      : undefined;
  const rateLimitKeyStrategy = config.rateLimit?.keyStrategy ?? "remote-address";

  // ---- session registry (stateful mode) --------------------------------
  // One transport + connected server per session. NOTE: the SDK reclaims a
  // session only on an explicit DELETE — it does NOT fire `onclose` on a mere
  // client disconnect — so a client that initializes and walks away would pin
  // its session forever. The idle reaper and `maxSessions` cap below bound
  // that.
  interface ActiveSession {
    readonly transport: StreamableHTTPServerTransport;
    readonly dispose: () => Promise<void>;
    /** ms timestamp of the last request seen (set at start AND completion);
     *  with `inFlight`, drives idle reaping. */
    lastSeenAt: number;
    /** Requests currently being handled on this session. The reaper never
     *  reclaims a session with work in flight (a long tool call, a held-open
     *  tasks/result stream), even if it exceeds the idle window. */
    inFlight: number;
  }
  const sessions = new Map<string, ActiveSession>();
  // Disposers for sessions whose `initialize` is in flight — connected but not
  // yet registered by `onsessioninitialized`. Tracked so a failed init and
  // kernel shutdown can still reclaim them (otherwise the connected server
  // leaks during the createSession→onsessioninitialized window).
  const pending = new Set<() => Promise<void>>();

  /** Reclaim one session. Idempotent — DELETE (`onsessionclosed`), the
   *  disposer's own `mcpServer.close()` (`onclose`), the idle reaper, and
   *  kernel shutdown all route here; the synchronous map-delete makes repeat
   *  calls no-ops. */
  async function teardownSession(sessionId: string): Promise<void> {
    const session = sessions.get(sessionId);
    if (session === undefined) return;
    sessions.delete(sessionId);
    try {
      await session.dispose();
    } catch (err) {
      logger.error("session dispose failed", { sessionId, err });
    }
    logger.debug("session ended", { sessionId, activeSessions: sessions.size });
  }

  /** Mint a new stateful session: a fresh transport with a connected server.
   *  Runs BEFORE the transport handles the `initialize` it was created for, so
   *  the server is wired when the request is processed. The disposer is parked
   *  in `pending` until `onsessioninitialized` promotes it into `sessions`. */
  async function createSession(): Promise<{
    transport: StreamableHTTPServerTransport;
    dispose: () => Promise<void>;
  }> {
    // `dispose` is reassigned by `connectSession` below; the session-init
    // callback (fired later, during handleRequest) closes over this binding.
    let dispose: () => Promise<void> = async () => {};
    const transport = new StreamableHTTPServerTransport({
      ...baseTransportOptions,
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sessionId: string) => {
        pending.delete(dispose);
        sessions.set(sessionId, {
          transport,
          dispose,
          lastSeenAt: Date.now(),
          inFlight: 0,
        });
        logger.debug("session initialized", {
          sessionId,
          activeSessions: sessions.size,
        });
      },
      onsessionclosed: (sessionId: string) => {
        teardownSession(sessionId).catch(() => {});
      },
    });
    // Fires when our own disposer closes the server (DELETE also routes via
    // `onsessionclosed`). A bare client disconnect does NOT reach here.
    transport.onclose = () => {
      const sessionId = transport.sessionId;
      if (sessionId !== undefined) teardownSession(sessionId).catch(() => {});
    };
    // Upcast to the SDK `Transport` interface; the concrete transport's
    // `onclose` getter type trips `exactOptionalPropertyTypes`.
    dispose = await connectSession(transport as Transport);
    pending.add(dispose);
    return { transport, dispose };
  }

  // ---- idle-session reaper ----------------------------------------------
  // The SDK never reclaims a session on disconnect, so sweep idle sessions
  // ourselves. `.unref()` so the timer never keeps the process alive.
  let reaper: ReturnType<typeof setInterval> | undefined;
  if (config.stateful && config.sessionIdleTimeoutMs > 0) {
    const idleMs = config.sessionIdleTimeoutMs;
    const sweepMs = Math.max(1_000, Math.min(idleMs, 30_000));
    reaper = setInterval(() => {
      const cutoff = Date.now() - idleMs;
      for (const [sessionId, session] of sessions) {
        // Never reap a session with a request in flight — only genuinely idle
        // ones. (Iterating a Map while teardownSession deletes from it is safe
        // in JS: deletion during iteration just skips the removed entry.)
        if (session.inFlight === 0 && session.lastSeenAt <= cutoff) {
          logger.debug("reaping idle session", { sessionId });
          teardownSession(sessionId).catch(() => {});
        }
      }
    }, sweepMs);
    reaper.unref?.();
  }

  // Build the Node HTTP listener. Reject anything outside `publicPath` with
  // 404. Pre-parse JSON for POST bodies, route to the right session's
  // transport, then hand off to the SDK transport.
  const httpServer: Server = createServer(async (req, res) => {
    try {
      // HTTP Basic Auth gate when configured. Runs BEFORE the path gate
      // so unauthenticated probes can't enumerate which paths exist.
      if (config.basicAuthUser !== undefined) {
        if (!checkBasicAuth(req, config.basicAuthUser, config.basicAuthPassword ?? "")) {
          res.statusCode = 401;
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

      // Kernel-side Origin allow-list check (rejects missing-Origin too).
      if (
        config.allowedOrigins !== undefined &&
        config.allowedOrigins.length > 0 &&
        !originAllowed(req, config.allowedOrigins)
      ) {
        writeJsonRpcError(res, 403, -32000, "Origin not allowed");
        return;
      }

      // Rate limiter gate. After auth, before body parsing / SDK delegation.
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

      // Resolve the transport for this request. Stateful routes to (or mints)
      // a per-session transport; stateless gets a fresh ephemeral transport
      // per request (the SDK forbids reusing a stateless transport).
      let transport: StreamableHTTPServerTransport;
      // For a freshly-minted stateful session, kept so a FAILED initialize can
      // be reclaimed in `finally`. For stateless, the per-request disposer.
      let createdSession:
        | { transport: StreamableHTTPServerTransport; dispose: () => Promise<void> }
        | undefined;
      let ephemeralDispose: (() => Promise<void>) | undefined;
      let routedSession: ActiveSession | undefined;

      if (config.stateful) {
        const sessionId = headerValue(req, "mcp-session-id");
        if (sessionId !== undefined) {
          const session = sessions.get(sessionId);
          if (session === undefined) {
            // Unknown or expired session id (spec: 404 Not Found).
            writeJsonRpcError(res, 404, -32001, "Session not found or expired");
            return;
          }
          // Mark in-flight so the reaper won't reclaim a session busy with a
          // long request; refreshed again on completion in `finally`.
          session.lastSeenAt = Date.now();
          session.inFlight += 1;
          routedSession = session;
          transport = session.transport;
        } else if (isInitializeRequest(body)) {
          // Capacity guard (counts in-flight inits) — bounds memory against a
          // flood of sessions that never DELETE.
          if (sessions.size + pending.size >= config.maxSessions) {
            res.setHeader("Retry-After", "1");
            writeJsonRpcError(
              res,
              503,
              -32000,
              "Server at session capacity; retry later",
            );
            return;
          }
          createdSession = await createSession();
          transport = createdSession.transport;
        } else {
          // No session id and not an initialize request (spec: 400).
          writeJsonRpcError(
            res,
            400,
            -32000,
            "No active session: send an initialize request or include mcp-session-id",
          );
          return;
        }
      } else {
        // Stateless: a fresh transport + connected server for THIS request,
        // disposed in `finally`.
        const t = new StreamableHTTPServerTransport({ ...baseTransportOptions });
        ephemeralDispose = await connectSession(t as Transport);
        transport = t;
      }

      // tasks/get JSON-mode override: spec says tasks/get SHOULD NOT upgrade to
      // SSE. Only relevant when SSE is the default (enableJsonResponse=false);
      // when responses are already JSON there is nothing to flip and no SSE
      // stream to disturb, so we skip it. The SDK exposes no per-request flag,
      // so we briefly flip the transport's private `_enableJsonResponse`,
      // restored in finally.
      //
      // CAVEAT: this mutates per-transport state, so it is only sound when at
      // most one request is in flight on the session's transport. Set
      // `enableJsonResponse: true` for task servers to avoid it entirely (see
      // README "tasks/get"). A fully concurrency-safe path would answer
      // tasks/get out-of-band; tracked as a follow-up.
      const pokeJsonMode = !config.enableJsonResponse && isTasksGetBody(body);
      const sdkPrivate = pokeJsonMode ? getSdkPrivateState(transport) : undefined;
      const originalJsonMode = sdkPrivate?._enableJsonResponse;
      if (sdkPrivate !== undefined) {
        sdkPrivate._enableJsonResponse = true;
      }
      try {
        await transport.handleRequest(req, res, body);
      } finally {
        if (sdkPrivate !== undefined && originalJsonMode !== undefined) {
          sdkPrivate._enableJsonResponse = originalJsonMode;
        }
        // Release the in-flight mark and stamp completion time so the reaper's
        // idle window measures from when this request FINISHED, not started.
        if (routedSession !== undefined) {
          routedSession.inFlight -= 1;
          routedSession.lastSeenAt = Date.now();
        }
        // A fresh stateful session whose initialize FAILED (no id assigned,
        // never registered) must be reclaimed — its disposer is still in
        // `pending`, holding a connected server. Guard on the delete result so
        // a concurrent kernel close() cannot dispose the same session twice.
        if (
          createdSession !== undefined &&
          transport.sessionId === undefined &&
          pending.delete(createdSession.dispose)
        ) {
          await createdSession
            .dispose()
            .catch((err) => logger.error("failed-init dispose failed", { err }));
        }
        // Stateless: tear down this request's transport + server.
        if (ephemeralDispose !== undefined) {
          await ephemeralDispose().catch((err) =>
            logger.error("stateless request dispose failed", { err }),
          );
        }
      }
    } catch (err) {
      // Defensive: never leak an unhandled exception out of the request
      // handler. If we haven't sent headers yet, emit a 500.
      if (!res.headersSent) {
        res.statusCode = 500;
        res.end();
      }
      logger.error("request handler error", { err });
    }
  });

  // Track open sockets so shutdown can drop lingering keep-alive connections.
  const openSockets = new Set<Socket>();
  httpServer.on("connection", (socket) => {
    openSockets.add(socket);
    socket.on("close", () => openSockets.delete(socket));
  });

  // Bind. Resolve the ACTUAL port from `httpServer.address()` once listening —
  // important when `bindPort` is 0 (ephemeral).
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
    close: async () => {
      // 1. Stop the idle reaper.
      if (reaper !== undefined) clearInterval(reaper);

      // 2. Tear down every live session CONCURRENTLY (abort tasks, detach
      //    modules, close each session's server + transport). Concurrent so one
      //    slow module can't serialize-block the rest.
      await Promise.allSettled(
        [...sessions.keys()].map((sessionId) => teardownSession(sessionId)),
      );

      // 3. Dispose any sessions still mid-initialize (connected but not yet
      //    registered) so their servers don't leak.
      await Promise.allSettled(
        [...pending].map(async (dispose) => {
          if (!pending.delete(dispose)) return; // lost the race; already handled
          try {
            await dispose();
          } catch (err) {
            logger.error("pending session dispose failed", { err });
          }
        }),
      );

      // 4. Drop keep-alive connections so `httpServer.close()` doesn't hang
      //    waiting on idle sockets.
      const closeAll = (httpServer as Server & { closeAllConnections?: () => void })
        .closeAllConnections;
      if (typeof closeAll === "function") {
        closeAll.call(httpServer);
      }

      // 4. Wait for the listener to fully close, with a grace timeout.
      await new Promise<void>((resolve) => {
        let settled = false;
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          logger.warn("httpServer.close() did not settle within grace period", {
            graceMs: SHUTDOWN_GRACE_MS,
            openSockets: openSockets.size,
          });
          resolve();
        }, SHUTDOWN_GRACE_MS);
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

/** Read a single-valued request header, normalizing the `string[]` case. */
function headerValue(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name];
  if (typeof v === "string" && v.length > 0) return v;
  if (Array.isArray(v) && v.length > 0 && typeof v[0] === "string" && v[0].length > 0) {
    return v[0];
  }
  return undefined;
}

/** Write a JSON-RPC error response with the given HTTP status. */
function writeJsonRpcError(
  res: ServerResponse,
  statusCode: number,
  code: number,
  message: string,
): void {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }));
}

/**
 * Validate an HTTP Basic credential against the configured user/password.
 * Returns `false` on missing or malformed `Authorization` header.
 *
 * Timing-safe: uses `crypto.timingSafeEqual` on byte buffers so an attacker
 * cannot probe individual credential bytes via response-time side-channels.
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
 * leak (an attacker would observe a faster code path when lengths mismatch).
 */
function timingSafeStringEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, "utf8");
  const bBuf = Buffer.from(b, "utf8");
  if (aBuf.length !== bBuf.length) {
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
 * Origin as DISALLOWED when an allow-list is configured — the SDK's native
 * check only rejects mismatched present Origins, but the spec intent is
 * stricter.
 */
function originAllowed(req: IncomingMessage, allowedOrigins: readonly string[]): boolean {
  const origin = req.headers["origin"];
  if (typeof origin !== "string" || origin.length === 0) {
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
 * When the chosen attribute is missing, falls back to `"global"`.
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
  const addr = req.socket.remoteAddress;
  if (typeof addr === "string" && addr.length > 0) {
    return `addr:${addr}`;
  }
  return "global";
}

/**
 * Detect whether a parsed JSON-RPC body is a `tasks/get` request. Accepts
 * both single objects and batched arrays (returns `true` if ANY of the
 * batched messages is `tasks/get`).
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
 * Best-effort accessor for the SDK transport's private state. The SDK doesn't
 * expose per-request response-mode overrides; we reach into the
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
  const byStream = new Map<StreamId, Array<{ eventId: EventId; message: JSONRPCMessage }>>();
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
