// Regression canary for the FRAGILE @modelcontextprotocol/sdk surface this
// primitive depends on.
//
// The kernel reaches for a few SDK surfaces that are experimental, resolved
// only via wildcard subpath exports, or outright private (see
// `src/kernel/transport.ts` and `src/features/tasks/feature.ts`). That is why
// `@modelcontextprotocol/sdk` is pinned to an EXACT version in package.json.
//
// `tsc` already guards every *typed* dependency: if the experimental-tasks
// types, `zod-compat`, the `webStandardStreamableHttp` types, or the
// `experimental.tasks.registerToolTask` call chain disappear, `pnpm typecheck`
// fails. The one thing typecheck CANNOT see is the private nested field
// `transport._webStandardTransport._enableJsonResponse`, which the kernel pokes
// via casts. This file is the runtime canary for that — plus a couple of cheap
// runtime-resolution checks for the value-bearing experimental subpaths.
//
// If a test here fails after an SDK upgrade, the kernel's task transport is
// broken. Do not delete the test — fix the integration (or repin the SDK).
import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { getSdkPrivateState } from "../src/kernel/transport.js";

describe("MCP SDK fragile surface (exact-pin canary)", () => {
  it("resolves the experimental task store with its runtime exports", async () => {
    const mod = await import(
      "@modelcontextprotocol/sdk/experimental/tasks/stores/in-memory.js"
    );
    expect(typeof mod.InMemoryTaskStore).toBe("function");
    expect(typeof mod.InMemoryTaskMessageQueue).toBe("function");
  });

  it("resolves the wildcard-only subpaths the kernel imports types from", async () => {
    // These are imported type-only in source, but must still resolve at
    // runtime under NodeNext — they exist only via the SDK's "./*" wildcard
    // export, not its curated exports map, so a packaging change can drop them.
    await expect(
      import("@modelcontextprotocol/sdk/experimental/tasks/index.js"),
    ).resolves.toBeDefined();
    await expect(
      import("@modelcontextprotocol/sdk/server/zod-compat.js"),
    ).resolves.toBeDefined();
    await expect(
      import("@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"),
    ).resolves.toBeDefined();
  });

  it("exposes experimental.tasks.registerToolTask once a task store is wired", async () => {
    const { McpServer } = await import(
      "@modelcontextprotocol/sdk/server/mcp.js"
    );
    const { InMemoryTaskStore, InMemoryTaskMessageQueue } = await import(
      "@modelcontextprotocol/sdk/experimental/tasks/stores/in-memory.js"
    );
    // Construct with a task store + queue, mirroring the kernel
    // (src/kernel/server.ts).
    const server = new McpServer(
      { name: "sdk-surface-probe", version: "0.0.0" },
      {
        capabilities: {},
        taskStore: new InMemoryTaskStore(),
        taskMessageQueue: new InMemoryTaskMessageQueue(),
      },
    );
    const tasks = (
      server as unknown as {
        experimental?: { tasks?: { registerToolTask?: unknown } };
      }
    ).experimental?.tasks;
    expect(typeof tasks?.registerToolTask).toBe("function");
  });

  it("StreamableHTTPServerTransport still carries the private _webStandardTransport._enableJsonResponse field", async () => {
    const { StreamableHTTPServerTransport } = await import(
      "@modelcontextprotocol/sdk/server/streamableHttp.js"
    );
    // Mirror the kernel's construction (src/kernel/transport.ts:104) and its
    // private-state probe (getSdkPrivateState).
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableJsonResponse: true,
    });
    // Call the REAL production accessor (src/kernel/transport.ts) instead of
    // re-deriving the private path here — this keeps the canary coupled to the
    // code it guards. getSdkPrivateState returns undefined if the SDK's private
    // shape changes, which fails the assertion below.
    const state = getSdkPrivateState(transport);
    expect(
      state,
      "getSdkPrivateState lost _webStandardTransport._enableJsonResponse",
    ).toBeDefined();
    expect(typeof state?._enableJsonResponse).toBe("boolean");
  });
});
