// MCP server bootstrap.
//
// The kernel composes two independent inputs — transport and modules — into
// one running server. It owns:
//   - Construction of the `McpServer` with merged capabilities.
//   - Module attachment: each module's `attach({ server, shutdown })` runs in
//     declared order.
//   - Transport binding (`mcpServer.connect(transport)`).
//   - Graceful shutdown: signal `shutdown`, run `module.detach?()` in reverse
//     order, then `transport.close()`.
//
// The kernel does NOT know about tasks, tools, opencode, or any specific
// feature. Adding a new feature never edits this file. An agent is not a
// kernel concern — a module receives whatever it needs as an explicit
// constructor dependency, wired by the composition root.
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

/**
 * The single argument to `createAgentMcpServer`. A composition root builds
 * this and the kernel runs it.
 */
export interface AgentMcpServerOptions {
  /** `{ name, version }` advertised in the MCP init handshake. */
  readonly info: { name: string; version: string };
  /**
   * Optional human-readable instructions surfaced in the MCP init handshake
   * (Spec §Initialization). Clients render this string in their server-info
   * UI; it should describe how to use the server's tools/resources.
   * Pass-through to the SDK's `instructions` field.
   */
  readonly instructions?: string;
  /** Transport configuration (bind, auth, CORS, resumability). */
  readonly transport: McpTransportConfig;
  /**
   * Modules to attach (features). Attached in the declared order; detached
   * in reverse order on shutdown.
   */
  readonly modules: ReadonlyArray<AgentModule>;
}

/**
 * Handle returned to the composition root. Owns the full server lifecycle.
 */
export interface AgentMcpServerHandle {
  readonly url: string;
  close(): Promise<void>;
}

/**
 * The kernel's only public function. Builds the MCP server, attaches the
 * modules, binds the transport, returns when listening.
 */
export async function createAgentMcpServer(
  opts: AgentMcpServerOptions,
): Promise<AgentMcpServerHandle> {
  // 1. Merge capabilities. `tools: {}` is always present so a recipe with
  //    zero feature modules still gets a tools-capable server.
  const capabilities: ServerCapabilities = deepMergeCapabilities(
    { tools: {} },
    ...opts.modules.map((m) => m.capabilities ?? {}),
  );

  // 2. Construct the SDK server. Install BOTH a `TaskStore` (where task
  //    metadata and results live) and a `TaskMessageQueue` (the side-channel
  //    that `tasks/result` drains).
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

  // 3. Attach modules in declared order. Each gets the shared server and a
  //    shutdown signal scoped to this kernel instance.
  //
  //    Attachment runs BEFORE transport connect because the SDK's
  //    `Server.registerCapabilities` (called transitively by
  //    `McpServer.registerTool` / `experimental.tasks.registerToolTask`)
  //    throws once a transport is connected. Modules register capabilities at
  //    attach time, so they must run first.
  const ac = new AbortController();
  const attached: AgentModule[] = [];
  try {
    for (const module of opts.modules) {
      await module.attach({ server: mcpServer, shutdown: ac.signal });
      attached.push(module);
    }
  } catch (err) {
    // Best-effort rollback: detach what we attached so a half-built kernel
    // never returns to the caller.
    ac.abort();
    await detachReverse(attached);
    throw err;
  }

  // 4. Bring up the transport and connect the server to it.
  let transport: AgentTransportHandle;
  try {
    transport = await createStreamableHttpTransport(opts.transport);
  } catch (err) {
    ac.abort();
    await detachReverse(attached);
    throw err;
  }

  try {
    await mcpServer.connect(transport.sdkTransport as Transport);
  } catch (err) {
    ac.abort();
    await detachReverse(attached);
    await transport.close();
    throw err;
  }

  return {
    url: transport.url,
    close: async () => {
      ac.abort();
      await detachReverse(opts.modules);
      await transport.close();
    },
  };
}

/**
 * Detach every module in reverse-attachment order. Errors are swallowed
 * per-module so one misbehaving detach doesn't strand the others.
 */
async function detachReverse(
  modules: ReadonlyArray<AgentModule>,
): Promise<void> {
  for (const module of [...modules].reverse()) {
    if (!module.detach) continue;
    try {
      await module.detach();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(
        `[agent-kernel] module detach failed (${module.name}):`,
        err,
      );
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
