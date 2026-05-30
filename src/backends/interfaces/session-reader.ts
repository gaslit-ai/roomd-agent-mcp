// `AgentSessionReader` — backend service contract for reading current
// session state.
//
// Consumed by:
//   - `features/resources/` — `resources/read agent://session/{id}/snapshot`
//     calls into `readSession(sessionId)` and serializes the snapshot as
//     JSON resource content.
//
// Implemented by backends that expose persistent sessions
// (for opencode: via `client.session.get` + `client.session.messages`).
// Backends without session persistence can omit this service; the
// resources feature degrades — `snapshot` resources won't be registered.

/**
 * Lightweight session-list entry. Enough to advertise via
 * `resources/list` without fetching messages.
 */
export interface AgentSessionSummary {
  readonly id: string;
  readonly title?: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/**
 * Full snapshot of a session. Shape is intentionally loose
 * (`info: unknown`, `messages: unknown[]`) so backends preserve their
 * native vocabulary; the resources feature serializes whatever shape the
 * backend returns directly to JSON.
 *
 * Backends are encouraged to include opaque-but-stable identifiers
 * (`id`, `messageId`, `partId`) so resource consumers can correlate
 * snapshots with event-log entries from `AgentSessionEvents`.
 */
export interface AgentSessionSnapshot {
  readonly id: string;
  readonly info: unknown;
  readonly messages: ReadonlyArray<unknown>;
}

/**
 * Cursor-paginated session listing.
 */
export interface AgentSessionListPage {
  readonly sessions: ReadonlyArray<AgentSessionSummary>;
  readonly nextCursor?: string;
}

/**
 * Read-side service contract. Implementations do NOT have to be
 * snapshot-consistent across multiple reads — they reflect whatever the
 * backend currently has.
 */
export interface AgentSessionReader {
  /**
   * Enumerate sessions visible to this server. Cursor-paginated;
   * implementations may cap `limit` regardless of the caller's request.
   */
  listSessions(opts?: {
    readonly limit?: number;
    readonly cursor?: string;
  }): Promise<AgentSessionListPage>;

  /**
   * Read one session's full snapshot. Throws if the session does not
   * exist. Callers in the resources feature catch and translate to
   * resources/read errors.
   */
  readSession(sessionId: string): Promise<AgentSessionSnapshot>;
}
