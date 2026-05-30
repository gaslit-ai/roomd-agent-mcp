// Logging seam for the kernel.
//
// The kernel and its modules emit diagnostics through an injected `Logger`
// rather than reaching for `console` directly. This keeps the library quiet
// by default-configurable, lets a host route logs into its own pipeline, and
// — crucially — gives failures a place to surface. A task whose bridge throws
// must not vanish silently; it is logged here.
//
// The default is a structured console logger writing single lines to
// stdout (debug/info) and stderr (warn/error). Pass `noopLogger` to silence,
// or implement `Logger` to bridge into pino/winston/OpenTelemetry/etc.

export type LogLevel = "debug" | "info" | "warn" | "error";

/** Structured logger. `meta` is an arbitrary bag; `Error` values within it
 * are expanded to `{ name, message, stack }` by the default logger. */
export interface Logger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

/** Expand an `Error` into a plain object: `name`/`message`/`stack`, plus any
 * own-enumerable props (e.g. a `code`) and `cause` (recursively). */
function serializeError(err: Error, seen: Set<unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {
    name: err.name,
    message: err.message,
    stack: err.stack,
  };
  for (const key of Object.keys(err)) {
    if (key === "cause") continue;
    out[key] = toSafe((err as unknown as Record<string, unknown>)[key], seen);
  }
  if (err.cause !== undefined) {
    out.cause = toSafe(err.cause, seen);
  }
  return out;
}

/**
 * Recursively convert a value into something JSON-safe. `seen` tracks only the
 * CURRENT ancestor path (added on the way down, removed on the way back up),
 * so a repeated sibling / diamond reference serializes fully and only a true
 * cycle becomes `"[Circular]"`.
 */
function toSafe(value: unknown, seen: Set<unknown>): unknown {
  if (typeof value === "bigint") return value.toString();
  if (typeof value !== "object" || value === null) return value;
  // Cycle guard for ALL object kinds — including Error, whose `cause`/props can
  // point back up the chain — BEFORE recursing, so a cyclic cause can't loop.
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  let result: unknown;
  if (value instanceof Error) {
    result = serializeError(value, seen);
  } else if (typeof (value as { toJSON?: unknown }).toJSON === "function") {
    // Honor `toJSON` (Date, etc.) the way JSON.stringify would, then keep
    // sanitizing its output (which is usually a primitive).
    result = toSafe((value as { toJSON: () => unknown }).toJSON(), seen);
  } else if (Array.isArray(value)) {
    result = value.map((v) => toSafe(v, seen));
  } else {
    const obj: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      obj[k] = toSafe(v, seen);
    }
    result = obj;
  }
  seen.delete(value);
  return result;
}

/** JSON-serialize `meta`, expanding `Error` values and tolerating cycles. May
 * throw if a value has a throwing getter — callers must guard (see `emit`). */
function serializeMeta(meta: Record<string, unknown>): string {
  return JSON.stringify(toSafe(meta, new Set<unknown>()));
}

export interface ConsoleLoggerOptions {
  /** Minimum level to emit. Default `"info"`. */
  readonly level?: LogLevel;
  /** Prefix tag for every line. Default `"agent-mcp"`. */
  readonly name?: string;
}

/**
 * A structured console logger. Lines look like:
 *   `2026-05-30T17:00:00.000Z INFO  [agent-mcp] message {"meta":1}`
 * debug/info go to stdout; warn/error go to stderr.
 */
export function createConsoleLogger(opts?: ConsoleLoggerOptions): Logger {
  const min = LEVEL_ORDER[opts?.level ?? "info"];
  const tag = `[${opts?.name ?? "agent-mcp"}]`;

  const emit =
    (level: LogLevel, write: (line: string) => void) =>
    (message: string, meta?: Record<string, unknown>): void => {
      if (LEVEL_ORDER[level] < min) return;
      const ts = new Date().toISOString();
      const label = level.toUpperCase().padEnd(5);
      let suffix = "";
      if (meta !== undefined && Object.keys(meta).length > 0) {
        try {
          suffix = ` ${serializeMeta(meta)}`;
        } catch (err) {
          // A logger must NEVER throw out of a log call — doing so would mask
          // the very failure being logged (and could strand a floating
          // promise that logs in its catch). Fall back to a marker.
          suffix = ` [meta-serialization-failed: ${
            err instanceof Error ? err.message : String(err)
          }]`;
        }
      }
      write(`${ts} ${label} ${tag} ${message}${suffix}`);
    };

  /* eslint-disable no-console */
  return {
    debug: emit("debug", (l) => console.log(l)),
    info: emit("info", (l) => console.log(l)),
    warn: emit("warn", (l) => console.warn(l)),
    error: emit("error", (l) => console.error(l)),
  };
  /* eslint-enable no-console */
}

/** A logger that discards everything. Useful in tests and embedded hosts. */
export const noopLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};
