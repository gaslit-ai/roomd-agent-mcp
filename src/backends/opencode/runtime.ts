// Opencode SDK lifecycle wrapper.
//
// Owns:
//   - A lazily-constructed v2 `OpencodeClient`.
//   - An optionally-managed `opencode serve` child process. When config
//     supplies `opencodeBaseUrl`, no child is spawned; otherwise the first
//     `client()` invocation spins up `createOpencodeServer(...)` and reuses
//     its URL for subsequent calls.
//
// This module owns NO MCP knowledge. It is consumed by `./agent.ts`.
import {
  createOpencodeClient,
  type OpencodeClient,
} from "@opencode-ai/sdk/v2";
import { createOpencodeServer } from "@opencode-ai/sdk/v2/server";
import type { OpencodeAgentConfig } from "./schemas/opencode-config.js";

/**
 * Opaque opencode runtime handle. The concrete shape (cached client +
 * optional server handle) is implementation detail; consumers see only
 * the methods.
 *
 * `client()` returns the v2 `OpencodeClient` from `@opencode-ai/sdk/v2`,
 * typed as `unknown` here so the runtime's external interface does not leak
 * SDK generics; `./agent.ts` narrows back to `OpencodeClient` internally.
 */
export interface OpencodeRuntime {
  /** Return the cached v2 OpencodeClient, lazily constructing if needed. */
  client(): Promise<unknown>;
  /** Shut down a managed server (if any) and release resources. */
  close(): Promise<void>;
}

interface ManagedServerHandle {
  readonly url: string;
  close(): void;
}

/**
 * Build an `OpencodeRuntime` from config. Lazy: no SDK call happens until
 * `client()` is invoked the first time.
 */
export function createOpencodeRuntime(
  config: OpencodeAgentConfig,
): OpencodeRuntime {
  let cachedClient: OpencodeClient | undefined;
  // Promise-cache for in-flight initialization. Without this, the `await
  // createOpencodeServer(...)` below yields the event loop before
  // `cachedClient` is set, so N concurrent callers each see `cachedClient`
  // undefined and each spawn their own `opencode serve` child.
  let inFlight: Promise<OpencodeClient> | undefined;
  let managedServer: ManagedServerHandle | undefined;

  return {
    async client(): Promise<unknown> {
      if (cachedClient) return cachedClient;
      if (!inFlight) {
        inFlight = (async (): Promise<OpencodeClient> => {
          if (config.opencodeBaseUrl !== undefined) {
            return createOpencodeClient({ baseUrl: config.opencodeBaseUrl });
          }
          const server = await createOpencodeServer({
            hostname: "127.0.0.1",
            port: 0,
            timeout: 60_000,
          });
          managedServer = server;
          return createOpencodeClient({ baseUrl: server.url });
        })().then(
          (c) => {
            cachedClient = c;
            inFlight = undefined;
            return c;
          },
          (err) => {
            // Init failed — clear so a future call can retry. Re-throw
            // so every currently-awaiting caller sees the error.
            inFlight = undefined;
            throw err;
          },
        );
      }
      return inFlight;
    },
    async close(): Promise<void> {
      inFlight = undefined;
      if (managedServer) {
        try {
          managedServer.close();
        } catch {
          // Best-effort shutdown — the SDK's close() kills the
          // `opencode serve` child via cross-spawn; there's nothing
          // actionable if the child has already exited.
        }
        managedServer = undefined;
      }
      cachedClient = undefined;
    },
  };
}
