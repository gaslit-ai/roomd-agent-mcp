// Tests for `createOpencodeRuntime` lifecycle behavior in
// `src/backends/opencode/runtime.ts`.
//
// The other opencode-backend tests run against `opencodeBaseUrl`, which
// short-circuits the managed-server spawn path. This file exercises the
// spawn path by mocking `createOpencodeServer` so we never actually fork
// `opencode serve`.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface PendingSpawn {
  resolve: (handle: { url: string; close: () => void }) => void;
  reject: (err: Error) => void;
}

const { mockState } = vi.hoisted(() => ({
  mockState: {
    callCount: 0,
    pending: [] as PendingSpawn[],
  },
}));

vi.mock("@opencode-ai/sdk/v2/server", () => ({
  createOpencodeServer: vi.fn(
    () =>
      new Promise<{ url: string; close: () => void }>((resolve, reject) => {
        mockState.callCount++;
        mockState.pending.push({ resolve, reject });
      }),
  ),
}));

import { createOpencodeRuntime } from "../src/backends/opencode/runtime.js";

beforeEach(() => {
  mockState.callCount = 0;
  mockState.pending = [];
});

afterEach(() => {
  // Any unresolved spawn would leak into the next test; resolve defensively.
  for (const p of mockState.pending) {
    p.resolve({ url: "http://cleanup.test", close: (): void => {} });
  }
  mockState.pending = [];
});

describe("createOpencodeRuntime", () => {
  it("coalesces concurrent client() calls into a single spawn", async () => {
    const runtime = createOpencodeRuntime({
      workspacePath: "/tmp",
      sessionTitle: "t",
    });

    const calls = Array.from({ length: 100 }, () => runtime.client());

    // Give all 100 callers a tick to enter `client()` before we let the
    // spawn resolve. Without the in-flight promise cache, each of them
    // would have already called createOpencodeServer by now.
    await new Promise((r) => setImmediate(r));
    expect(mockState.callCount).toBe(1);
    expect(mockState.pending).toHaveLength(1);

    mockState.pending[0]!.resolve({
      url: "http://spawned.test",
      close: (): void => {},
    });
    mockState.pending = [];

    const clients = await Promise.all(calls);

    expect(mockState.callCount).toBe(1);
    for (const c of clients) {
      expect(c).toBe(clients[0]);
    }
  });

  it("does not spawn again once a client is cached", async () => {
    const runtime = createOpencodeRuntime({
      workspacePath: "/tmp",
      sessionTitle: "t",
    });

    const firstCall = runtime.client();
    await new Promise((r) => setImmediate(r));
    mockState.pending[0]!.resolve({
      url: "http://spawned.test",
      close: (): void => {},
    });
    mockState.pending = [];
    const first = await firstCall;

    const second = await runtime.client();
    const third = await runtime.client();

    expect(mockState.callCount).toBe(1);
    expect(second).toBe(first);
    expect(third).toBe(first);
  });

  it("allows a fresh spawn attempt after a failed init", async () => {
    const runtime = createOpencodeRuntime({
      workspacePath: "/tmp",
      sessionTitle: "t",
    });

    const firstAttempt = runtime.client();
    await new Promise((r) => setImmediate(r));
    expect(mockState.callCount).toBe(1);
    mockState.pending[0]!.reject(new Error("boom"));
    mockState.pending = [];
    await expect(firstAttempt).rejects.toThrow("boom");

    const secondAttempt = runtime.client();
    await new Promise((r) => setImmediate(r));
    expect(mockState.callCount).toBe(2);
    mockState.pending[0]!.resolve({
      url: "http://retry.test",
      close: (): void => {},
    });
    mockState.pending = [];
    const client = await secondAttempt;
    expect(client).toBeDefined();
  });
});
