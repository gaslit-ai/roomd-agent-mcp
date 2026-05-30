// Streamable HTTP transport configuration — the MCP-side knobs. Pure
// transport concerns: bind, auth, CORS, resumability. Does NOT carry any
// backend or feature config.
//
// SDK references for each field:
//   - `StreamableHTTPServerTransport` Node-HTTP wrapper:
//     node_modules/@modelcontextprotocol/sdk/dist/esm/server/streamableHttp.d.ts
//   - `WebStandardStreamableHTTPServerTransportOptions` (the option fields below):
//     node_modules/@modelcontextprotocol/sdk/dist/esm/server/webStandardStreamableHttp.d.ts:41-95
import { z } from "zod";

/**
 * MCP transport configuration. Consumed by `kernel/transport.ts` to build
 * a `StreamableHTTPServerTransport` and mount it on a Node HTTP listener.
 */
export const McpTransportConfigSchema = z.object({
  /** HTTP host to bind. Default `127.0.0.1` (loopback only). */
  bindHost: z.string().min(1).default("127.0.0.1"),

  /** HTTP port to bind. `0` = ephemeral (assigned by the OS). */
  bindPort: z.number().int().min(0).max(65_535).default(0),

  /** URL path on which the transport handles requests. */
  publicPath: z.string().min(1).default("/mcp"),

  /**
   * Stateful mode generates a per-client session id via `sessionIdGenerator`
   * (see SDK option of same name). Required when the server is exposed to
   * multiple MCP clients that should not see each other's state. Stateless
   * mode disables session tracking.
   *
   * SDK behavior (verbatim from streamableHttp.d.ts:47-56):
   *   "In stateful mode: Session ID is generated and included in response
   *    headers; … Requests with invalid session IDs are rejected with 404
   *    Not Found; Non-initialization requests without a session ID are
   *    rejected with 400 Bad Request; State is maintained in-memory."
   */
  stateful: z.boolean().default(true),

  /**
   * If `true`, the transport returns JSON responses instead of upgrading
   * to SSE for non-task requests. Default `false` (SSE preferred).
   */
  enableJsonResponse: z.boolean().default(false),

  /** Optional HTTP Basic auth user; pairs with `basicAuthPassword`. */
  basicAuthUser: z.string().min(1).optional(),
  basicAuthPassword: z.string().min(1).optional(),

  /**
   * Optional allow-list of `Origin` header values for DNS rebinding
   * protection (Spec §"Security Warning"). When set, the SDK transport
   * is configured with `enableDnsRebindingProtection: true` and the
   * kernel REJECTS requests with a missing or mismatched Origin header
   * (the SDK only checks the mismatched case; the kernel adds the
   * missing-header case in `transport.ts`).
   */
  allowedOrigins: z.array(z.string()).optional(),

  /**
   * Optional allow-list of `Host` header values for DNS rebinding
   * protection. Pairs with `allowedOrigins`. Triggers SDK
   * `enableDnsRebindingProtection` together with `allowedOrigins`.
   */
  allowedHosts: z.array(z.string()).optional(),

  /**
   * Optional filesystem path backing a resumability `EventStore`. When set,
   * the kernel currently instantiates an IN-MEMORY `EventStore` (path is
   * IGNORED). A future file-backed impl will honor the path; the option
   * is preserved so the schema doesn't shift when it lands.
   */
  resumabilityEventStorePath: z.string().min(1).optional(),

  /**
   * Optional rate limiter (Spec §"Security Considerations" lists rate
   * limiting as MUST). When undefined, the kernel installs no limiter.
   * When set, every incoming request consumes one token from a per-key
   * bucket; requests that exhaust the bucket get a 429 response with
   * a `Retry-After` header.
   *
   * Key strategy controls which request attribute identifies the bucket:
   *   - `"authorization"`: the `Authorization` header value (recommended
   *     for token-authed servers).
   *   - `"remote-address"`: the client's TCP remote address (default;
   *     suitable for trusted-network deployments).
   *   - `"global"`: one shared bucket across all callers.
   * If the chosen attribute is missing on a given request, the limiter
   * falls back to the literal string `"global"`.
   */
  rateLimit: z
    .object({
      capacity: z.number().int().positive().default(60),
      refillPerSecond: z.number().positive().default(2),
      keyStrategy: z
        .enum(["authorization", "remote-address", "global"])
        .default("remote-address"),
    })
    .optional(),
});

export type McpTransportConfig = z.output<typeof McpTransportConfigSchema>;
