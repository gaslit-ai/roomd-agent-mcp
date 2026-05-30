// Opencode implementation of `AgentSessionReader`. Thin wrapper over
// `client.session.list({…})`, `client.session.get(...)`, and
// `client.session.messages(...)`. Loose `unknown` types per the contract.
//
// SCOPING: opencode's session storage (`~/.local/share/opencode/opencode.db`)
// is shared across the user's entire opencode installation. `session.list`
// returns every session that has ever existed there — prior CLI runs, the
// TUI, other MCP servers, etc. To keep the `resources` feature from
// advertising unrelated history, this reader optionally filters against
// a `Set<string>` of session ids the caller considers "ours."
// `createOpencodeAgent` writes that set from `spawn` / `prompt` and shares it
// with this reader. Without the set, the reader is unscoped (advanced use).
import type { OpencodeClient } from "@opencode-ai/sdk/v2";
import type {
  AgentSessionListPage,
  AgentSessionReader,
  AgentSessionSnapshot,
  AgentSessionSummary,
} from "../interfaces/index.js";
import type { OpencodeRuntime } from "./runtime.js";

interface SessionLite {
  id: string;
  title?: string;
  time: { created: number; updated: number };
}

/**
 * Build an opencode-backed `AgentSessionReader`. Lazy: the underlying
 * SDK client is constructed on first call via `runtime.client()`.
 *
 * Pass a `Set<string>` of known session ids to filter results to sessions
 * this server has actually touched. Without one, every session in
 * opencode's database is returned.
 */
export function createOpencodeSessionReader(
  runtime: OpencodeRuntime,
  knownSessions?: Set<string>,
): AgentSessionReader {
  return {
    async listSessions(opts): Promise<AgentSessionListPage> {
      const client = (await runtime.client()) as OpencodeClient;
      const cursorRaw = opts?.cursor;
      let start: number | undefined;
      if (cursorRaw !== undefined) {
        const parsed = Number.parseInt(cursorRaw, 10);
        // Invalid cursors throw rather than silently degrading to "first
        // page", which would mask client bugs and let stale cursors return
        // surprising data. A consumer that surfaces this over MCP maps the
        // thrown error to an invalid-params response.
        if (!Number.isFinite(parsed)) {
          throw new Error(`invalid cursor: ${cursorRaw}`);
        }
        start = parsed;
      }
      const limit = opts?.limit;
      const result = await client.session.list(
        {
          ...(start !== undefined ? { start } : {}),
          ...(limit !== undefined ? { limit } : {}),
        },
        { throwOnError: true },
      );
      const rows = (result.data ?? []) as SessionLite[];
      const filteredRows = knownSessions
        ? rows.filter((row) => knownSessions.has(row.id))
        : rows;
      const sessions: AgentSessionSummary[] = filteredRows.map((row) => ({
        id: row.id,
        ...(row.title !== undefined && row.title.length > 0
          ? { title: row.title }
          : {}),
        createdAt: row.time.created,
        updatedAt: row.time.updated,
      }));
      // Pagination: opencode's SDK exposes `start`+`limit` as query params
      // and doesn't echo a cursor. When the page is full, hand back a
      // synthetic offset-based cursor so callers can keep walking. We base
      // it on the unfiltered `rows.length` (the page opencode actually
      // returned), not `filteredRows.length` — otherwise scoping via
      // `knownSessions` would terminate pagination early.
      const nextCursor =
        rows.length === limit
          ? String((start ?? 0) + rows.length)
          : undefined;
      return {
        sessions,
        ...(nextCursor !== undefined ? { nextCursor } : {}),
      };
    },
    async readSession(sessionId: string): Promise<AgentSessionSnapshot> {
      // Gate reads to the tracked set so a caller that knows / guesses an
      // unknown id can't pull arbitrary session contents from opencode's
      // shared database. Throwing `NotFoundError` matches the contract;
      // the resources feature translates that to an MCP error.
      if (knownSessions && !knownSessions.has(sessionId)) {
        throw new Error(`session not found: ${sessionId}`);
      }
      const client = (await runtime.client()) as OpencodeClient;
      const [info, messages] = await Promise.all([
        client.session.get({ sessionID: sessionId }, { throwOnError: true }),
        client.session.messages(
          { sessionID: sessionId },
          { throwOnError: true },
        ),
      ]);
      return {
        id: sessionId,
        info: info.data,
        messages: (messages.data ?? []) as ReadonlyArray<unknown>,
      };
    },
  };
}
