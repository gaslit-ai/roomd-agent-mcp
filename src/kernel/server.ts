// MCP server bootstrap.
//
// The kernel composes two independent inputs — transport and modules — into
// one running server. It owns:
//   - Per-session construction of the `McpServer` with merged capabilities.
//   - Module attachment: each module's `attach({ server, shutdown, logger })`
//     runs in declared order.
//   - Transport binding, with one connected server PER MCP session in
//     stateful mode (see `transport.ts`).
//   - Graceful shutdown: signal `shutdown`, run `module.detach?()` in reverse
//     order, then close the server (and transport).
//
// The kernel does NOT know about tasks, tools, opencode, or any specific
// feature. Adding a new feature never edits this file. An agent is not a
// kernel concern — a module receives whatever it needs as an explicit
// constructor dependency, wired by the composition root.
//
// WHY A MODULE FACTORY: feature modules carry per-instance state (a tasks
// module owns its live-handle map and shutdown wiring). Stateful mode attaches
// a fresh module set per session, so each session is isolated; sharing one
// instance across sessions would cross-wire their state. Backend dependencies
// (an agent) are captured by the factory closure and shared — only the
// MCP-side plumbing is per-session.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  InMemoryTaskStore,
  InMemoryTaskMessageQueue,
} from "@modelcontextprotocol/sdk/experimental/tasks/stores/in-memory.js";
import type { ServerCapabilities } from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { McpTransportConfig } from "./schemas/transport-config.js";
import type { AgentModule } from "./module.js";
import {
  createStreamableHttpTransport,
  type AgentTransportHandle,
} from "./transport.js";
import { createConsoleLogger, type Logger } from "./logger.js";

/**
 * The single argument to `createAgentMcpServer`. A composition root builds
 * this and the kernel runs it.
 */
export interface AgentMcpServerOptions {
  /** `{ name, version }` advertised in the MCP init handshake. */
  readonly info: { name: string; version: string };
  /**
   * Optional human-readable instructions surfaced in the MCP init handshake
   * (Spec §Initialization). Pass-through to the SDK's `instructions` field.
   */
  readonly instructions?: string;
  /** Transport configuration (bind, auth, CORS, resumability). */
  readonly transport: McpTransportConfig;
  /**
   * Factory producing a FRESH set of feature modules. Called once per MCP
   * session in stateful mode (once total in stateless mode), so each session
   * gets isolated module state. Modules are attached in the returned order and
   * detached in reverse on session/kernel shutdown. Capture shared backend
   * dependencies (an agent) in the factory closure.
   */
  readonly createModules: () => ReadonlyArray<AgentModule>;
  /**
   * Logger for kernel and module diagnostics. Defaults to a structured
   * console logger tagged with `info.name`. Pass `noopLogger` to silence.
   */
  readonly logger?: Logger;
}

/**
 * Handle returned to the composition root. Owns the full server lifecycle.
 */
export interface AgentMcpServerHandle {
  readonly url: string;
  close(): Promise<void>;
}

/**
 * The kernel's only public function. Binds the transport and, for each MCP
 * session, builds the server, attaches fresh modules, and connects. Returns
 * once listening.
 */
export async function createAgentMcpServer(
  opts: AgentMcpServerOptions,
): Promise<AgentMcpServerHandle> {
  const logger = opts.logger ?? createConsoleLogger({ name: opts.info.name });

  // Build and connect a server for ONE session's transport, returning a
  // disposer. Invoked by the transport layer per session (stateful) or once
  // at startup (stateless).
  const connectSession = async (
    transport: Transport,
  ): Promise<() => Promise<void>> => {
    const modules = opts.createModules();

    // Merge capabilities. `tools: {}` is always present so a recipe with zero
    // feature modules still gets a tools-capable server.
    const capabilities: ServerCapabilities = deepMergeCapabilities(
      { tools: {} },
      ...modules.map((m) => m.capabilities ?? {}),
    );

    // Each session gets its own TaskStore + TaskMessageQueue — task state is
    // isolated per session.
    const taskStore = new InMemoryTaskStore();
    const taskMessageQueue = new InMemoryTaskMessageQueue();
    const mcpServer = new McpServer(opts.info, {
      capabilities,
      taskStore,
      taskMessageQueue,
      ...(opts.instructions !== undefined
        ? { instructions: opts.instructions }
        : {}),
    });

    // Per-session shutdown signal: fired when this session ends (client
    // DELETE, idle reap) or the whole kernel stops.
    const ac = new AbortController();
    const attached: AgentModule[] = [];
    try {
      // Attach BEFORE connect: the SDK's `registerCapabilities` (called
      // transitively by `registerTool` / `registerToolTask`) throws once a
      // transport is connected. Modules register at attach time.
      for (const module of modules) {
        await module.attach({ server: mcpServer, shutdown: ac.signal, logger });
        attached.push(module);
      }
    } catch (err) {
      ac.abort();
      await detachReverse(attached, logger);
      throw err;
    }

    try {
      await mcpServer.connect(transport);
    } catch (err) {
      ac.abort();
      await detachReverse(attached, logger);
      throw err;
    }

    // Idempotent: teardown can be reached more than one way (DELETE, the idle
    // reaper, a failed init, kernel close). Running detach/close twice is not
    // contractually safe for modules, so guard here as well as at call sites.
    let disposed = false;
    return async () => {
      if (disposed) return;
      disposed = true;
      ac.abort();
      await detachReverse(attached, logger);
      try {
        await mcpServer.close();
      } catch (err) {
        logger.error("session server close failed", { err });
      }
    };
  };

  const transport: AgentTransportHandle = await createStreamableHttpTransport(
    opts.transport,
    connectSession,
    logger,
  );
  logger.info("agent MCP server listening", {
    url: transport.url,
    stateful: opts.transport.stateful,
  });

  return {
    url: transport.url,
    close: async () => {
      logger.info("agent MCP server shutting down");
      await transport.close();
    },
  };
}

/**
 * Detach every module in reverse-attachment order. Errors are logged
 * per-module so one misbehaving detach doesn't strand the others.
 */
async function detachReverse(
  modules: ReadonlyArray<AgentModule>,
  logger: Logger,
): Promise<void> {
  for (const module of [...modules].reverse()) {
    if (!module.detach) continue;
    try {
      await module.detach();
    } catch (err) {
      logger.error("module detach failed", { module: module.name, err });
    }
  }
}

/**
 * Deep-merge an arbitrary number of `Partial<ServerCapabilities>` objects
 * into a single `ServerCapabilities`. Each subtree's leaves are plain `{}`
 * indicating "supported", so a recursive merge of plain objects is
 * sufficient. Arrays are not part of the capability shape.
 */
function deepMergeCapabilities(
  ...sources: Array<Partial<ServerCapabilities>>
): ServerCapabilities {
  const out: Record<string, unknown> = {};
  for (const src of sources) {
    mergeInto(out, src as Record<string, unknown>);
  }
  return out as ServerCapabilities;
}

function mergeInto(
  target: Record<string, unknown>,
  src: Record<string, unknown>,
): void {
  for (const [key, value] of Object.entries(src)) {
    if (isPlainObject(value)) {
      const existing = target[key];
      const next = isPlainObject(existing) ? { ...existing } : {};
      mergeInto(next, value);
      target[key] = next;
    } else {
      target[key] = value;
    }
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
