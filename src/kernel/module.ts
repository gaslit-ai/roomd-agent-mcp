// The single composition primitive of the framework: an `AgentModule`. Every
// MCP feature (tools, tasks, resources, prompts, sampling, elicitation,
// roots, progress, logging, completions) implements this interface. The
// kernel takes a list of modules and attaches them to an `McpServer`.
//
// A module declares two things:
//   1. The MCP capabilities it advertises (merged with other modules'
//      capabilities at init time and surfaced via the `capabilities`
//      argument to `new McpServer({...}, { capabilities })`).
//   2. An `attach` lifecycle hook that registers handlers/notifications on
//      the server.
//
// Modules do not know about each other directly. Whatever a module needs
// from the outside world (an agent) is handed to its factory as an explicit
// dependency by the composition root. This keeps each module independently
// testable and lets new modules drop in without touching existing ones.
import type { ServerCapabilities } from "@modelcontextprotocol/sdk/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Logger } from "./logger.js";

/**
 * Context handed to every module's `attach()` invocation: the server handle
 * (where capabilities and request handlers live), a shutdown signal, and the
 * kernel logger.
 *
 * In stateful mode the kernel attaches a fresh set of modules per MCP session,
 * so `server` and `shutdown` are scoped to ONE session: `shutdown` fires when
 * that session ends (client DELETE, idle reap) or the whole kernel stops.
 */
export interface AttachContext {
  readonly server: McpServer;
  /**
   * Abort signal fired when this session (or the whole kernel) is shutting
   * down. Modules that own long-lived resources (background workers, SSE
   * subscriptions, …) should listen on this and unwind cleanly.
   */
  readonly shutdown: AbortSignal;
  /** Kernel logger — modules should log through this, not `console`. */
  readonly logger: Logger;
}

/**
 * The composition primitive, implemented by every MCP feature (each
 * `features/<name>/feature.ts`).
 *
 * A module touches the MCP wire. Whatever it needs from the outside world
 * (an agent) is injected into its factory by the composition root — modules
 * are never coupled to a concrete backend.
 */
export interface AgentModule {
  /** Stable identifier, used in logs. */
  readonly name: string;
  /**
   * Capability subtree this module contributes to the init handshake. The
   * kernel deep-merges every module's `capabilities` into one
   * `ServerCapabilities` object passed to the SDK's `McpServer` constructor.
   * Reference: `node_modules/@modelcontextprotocol/sdk/dist/esm/types.d.ts`
   * `ServerCapabilitiesSchema`.
   */
  readonly capabilities?: Partial<ServerCapabilities>;
  /** Wire handlers onto the server. */
  attach(ctx: AttachContext): void | Promise<void>;
  /** Optional teardown hook, called on graceful shutdown before the server closes. */
  detach?(): void | Promise<void>;
}
