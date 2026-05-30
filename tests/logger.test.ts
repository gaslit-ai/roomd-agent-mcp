// Unit guard for the structured console logger's serializer.
//
// The logger is on every error path; it must (a) never throw out of a log call
// (that would mask the failure it is recording), (b) expand Errors usefully,
// (c) tolerate cycles — including cyclic `cause` chains — without overflowing,
// and (d) not corrupt non-cyclic shared references or `toJSON` values.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createConsoleLogger } from "../src/index.js";

const log = createConsoleLogger({ level: "debug", name: "test" });

afterEach(() => {
  vi.restoreAllMocks();
});

/** Capture everything the logger writes during `fn`. */
function capture(fn: () => void): string {
  const lines: string[] = [];
  for (const m of ["log", "warn", "error"] as const) {
    vi.spyOn(console, m).mockImplementation((line: unknown) => {
      lines.push(String(line));
    });
  }
  fn();
  return lines.join("\n");
}

describe("createConsoleLogger serialization", () => {
  it("serializes Date via toJSON, not as {}", () => {
    const out = capture(() => log.info("m", { when: new Date(0) }));
    expect(out).toContain("1970-01-01T00:00:00.000Z");
    expect(out).not.toContain('"when":{}');
  });

  it("serializes a repeated (non-cyclic) sibling reference fully — not [Circular]", () => {
    const shared = { k: "v" };
    const out = capture(() => log.info("m", { a: shared, b: shared }));
    expect(out).not.toContain("[Circular]");
    expect(out.match(/"k":"v"/g)?.length).toBe(2);
  });

  it("marks a true self-cycle as [Circular] without throwing", () => {
    const o: Record<string, unknown> = {};
    o.self = o;
    const out = capture(() => log.error("m", { o }));
    expect(out).toContain("[Circular]");
  });

  it("survives a cyclic Error cause without stack overflow", () => {
    const e = new Error("boom");
    e.cause = e; // self-referential cause
    const out = capture(() => log.error("failed", { err: e }));
    expect(out).toContain("boom");
    expect(out).not.toContain("meta-serialization-failed");
  });

  it("includes an Error's custom own props (e.g. code)", () => {
    const e = Object.assign(new Error("nope"), { code: "E_X" });
    const out = capture(() => log.error("failed", { err: e }));
    expect(out).toContain("nope");
    expect(out).toContain("E_X");
  });

  it("never throws out of a log call when a value has a throwing getter", () => {
    const weird: Record<string, unknown> = {};
    Object.defineProperty(weird, "x", {
      enumerable: true,
      get() {
        throw new Error("getter blew up");
      },
    });
    expect(() => log.error("failed", { weird })).not.toThrow();
    const out = capture(() => log.error("failed", { weird }));
    expect(out).toContain("meta-serialization-failed");
  });

  it("serializes bigint as a string", () => {
    const out = capture(() => log.info("m", { n: 10n }));
    expect(out).toContain('"10"');
  });
});
