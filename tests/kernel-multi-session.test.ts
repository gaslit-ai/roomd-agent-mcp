// Integration guard for stateful multi-session support + session lifecycle.
//
// Before per-session transports, a single shared StreamableHTTPServerTransport
// in stateful mode bound to the FIRST client's session and rejected every
// later `initialize` with "Server already initialized" — so a second client
// (or any stateless tool making a fresh connection) could never connect.
//
// These tests stand up a real kernel over an ephemeral port and drive it with
// `fetch` exactly as separate MCP clients would: independent sessions, routing
// by `mcp-session-id`, DELETE reclamation, the max-session cap, the idle
// reaper, and stateless-per-request — none of which any unit test exercises.
import { afterEach, describe, expect, it } from "vitest";
import {
  createAgentMcpServer,
  McpTransportConfigSchema,
  noopLogger,
  type AgentMcpServerHandle,
} from "../src/index.js";

let handle: AgentMcpServerHandle | undefined;

afterEach(async () => {
  await handle?.close();
  handle = undefined;
});

const JSON_HEADERS = {
  "content-type": "application/json",
  accept: "application/json, text/event-stream",
};

async function startServer(
  overrides: Record<string, unknown> = {},
): Promise<string> {
  handle = await createAgentMcpServer({
    info: { name: "multi-session-test", version: "0.0.0" },
    transport: McpTransportConfigSchema.parse({
      bindHost: "127.0.0.1",
      bindPort: 0, // ephemeral
      publicPath: "/mcp",
      stateful: true,
      enableJsonResponse: true,
      ...overrides,
    }),
    // No feature modules needed — the wedge/lifecycle logic is in the
    // transport/session layer, which exists regardless of features.
    createModules: () => [],
    logger: noopLogger,
  });
  return handle.url;
}

const INITIALIZE = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "vitest", version: "0" },
  },
};

async function initialize(
  url: string,
): Promise<{ status: number; sessionId: string | null }> {
  const res = await fetch(url, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify(INITIALIZE),
  });
  await res.text();
  return { status: res.status, sessionId: res.headers.get("mcp-session-id") };
}

async function postWithSession(
  url: string,
  sessionId: string,
  body: unknown,
): Promise<number> {
  const res = await fetch(url, {
    method: "POST",
    headers: { ...JSON_HEADERS, "mcp-session-id": sessionId },
    body: JSON.stringify(body),
  });
  await res.text();
  return res.status;
}

const TOOLS_LIST = { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} };
const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

describe("stateful kernel — multiple sessions", () => {
  it("gives each fresh client its own session (no 'Server already initialized')", async () => {
    const url = await startServer();
    const a = await initialize(url);
    const b = await initialize(url);

    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.sessionId).toBeTruthy();
    expect(b.sessionId).toBeTruthy();
    expect(a.sessionId).not.toBe(b.sessionId);
  });

  it("routes by mcp-session-id and rejects unknown sessions with 404", async () => {
    const url = await startServer();
    const { sessionId } = await initialize(url);
    expect(sessionId).toBeTruthy();

    const initialized = await postWithSession(url, sessionId as string, {
      jsonrpc: "2.0",
      method: "notifications/initialized",
    });
    expect(initialized).toBe(202);

    expect(await postWithSession(url, sessionId as string, TOOLS_LIST)).toBe(200);
    expect(await postWithSession(url, "does-not-exist", TOOLS_LIST)).toBe(404);
  });

  it("rejects a non-initialize request that carries no session id with 400", async () => {
    const url = await startServer();
    const res = await fetch(url, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify(TOOLS_LIST),
    });
    await res.text();
    expect(res.status).toBe(400);
  });

  it("reclaims a session on DELETE — the id no longer routes", async () => {
    const url = await startServer();
    const { sessionId } = await initialize(url);
    expect(sessionId).toBeTruthy();

    const del = await fetch(url, {
      method: "DELETE",
      headers: { ...JSON_HEADERS, "mcp-session-id": sessionId as string },
    });
    await del.text();

    // After teardown the id is gone — a subsequent request 404s.
    expect(await postWithSession(url, sessionId as string, TOOLS_LIST)).toBe(404);
  });

  it("rejects new sessions past maxSessions with 503", async () => {
    const url = await startServer({ maxSessions: 1 });
    const a = await initialize(url);
    expect(a.status).toBe(200);

    // Second fresh initialize is over capacity.
    const b = await initialize(url);
    expect(b.status).toBe(503);

    // The first session still works.
    expect(await postWithSession(url, a.sessionId as string, TOOLS_LIST)).toBe(200);
  });

  it("reaps idle sessions (the SDK never signals a disconnect)", async () => {
    const url = await startServer({ sessionIdleTimeoutMs: 150 });
    const { sessionId } = await initialize(url);
    expect(sessionId).toBeTruthy();
    expect(await postWithSession(url, sessionId as string, TOOLS_LIST)).toBe(200);

    // Sweep runs ~every 1s; idle window is 150ms. Wait past one sweep.
    await sleep(1300);

    // The idle session has been reclaimed → unknown id → 404.
    expect(await postWithSession(url, sessionId as string, TOOLS_LIST)).toBe(404);
  }, 6000);
});

describe("stateless kernel", () => {
  it("survives a second request (fresh transport per request)", async () => {
    const url = await startServer({ stateful: false });
    // Before the per-request fix the SDK threw 'Stateless transport cannot be
    // reused' on the 2nd request (200/500). Now each request is independent.
    const a = await initialize(url);
    const b = await initialize(url);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
  });
});
