// Resources-feature configuration. Pure MCP-Resources-utility knobs; no
// backend concerns. Consumed by `createResourcesFeature(config)` to compute
// resource URIs, debounce coalescing, and per-session event-log bounds.
//
// Spec: https://modelcontextprotocol.io/specification/2025-11-25/server/resources
import { z } from "zod";

/**
 * Syntactic check for an RFC 3986 URI prefix.
 *
 * Matches `<scheme>://<authority?>(/<path>)?` with no trailing slash required.
 * The scheme follows RFC 3986 (alpha followed by alpha/digit/`+-.`); the
 * authority is the non-empty span after `://` up to the first `/`, `?`, or
 * `#` (empty authority is also allowed for prefixes like `file:///x`); the
 * optional path is one or more `/segment` pieces.
 *
 * This is intentionally lenient — we validate prefix shape, not the full set
 * of RFC 3986 productions. The goal is to reject obvious nonsense (no
 * scheme, embedded query/fragment, etc.) so misconfiguration fails loud at
 * load time rather than producing surprising URIs at runtime.
 */
const URI_PREFIX_REGEX =
  /^[a-zA-Z][a-zA-Z0-9+\-.]*:\/\/[^/?#]*(\/[^?#]*)?$/;

/**
 * Per-feature configuration for the resources feature.
 *
 * Knobs:
 *   - `urlPrefix`             — URI prefix for session resources. Each
 *                               session contributes two resources:
 *                                 `${urlPrefix}/${encodeURIComponent(sessionId)}/snapshot`
 *                                 `${urlPrefix}/${encodeURIComponent(sessionId)}/events`
 *                               Must be a syntactically valid RFC 3986 URI
 *                               prefix of the form
 *                               `<scheme>://<authority?>(/<path>)?` with no
 *                               query (`?`) or fragment (`#`).
 *   - `eventLogMaxEntries`    — cap on the in-memory event log per
 *                               subscribed session. Once exceeded, the
 *                               oldest entry is dropped (FIFO). The cap
 *                               keeps the `events` resource readable as a
 *                               single payload without unbounded growth.
 *   - `updateDebounceMs`      — coalescing window for
 *                               `notifications/resources/updated`. Multiple
 *                               events arriving within this window emit one
 *                               notification per affected URI. Set to 0 to
 *                               disable coalescing (a notification per
 *                               event); higher values batch more.
 *   - `listLimit`             — default page size passed to
 *                               `AgentSessionReader.listSessions({ limit })`
 *                               when handling `resources/list`.
 *                               Implementations may cap further.
 */
export const ResourcesFeatureConfigSchema = z.object({
  urlPrefix: z
    .string()
    .min(1)
    .default("agent://session")
    .refine((s) => URI_PREFIX_REGEX.test(s), {
      message:
        "urlPrefix must be a valid RFC 3986 URI prefix of the form <scheme>://<authority?>(/<path>)? with no query or fragment",
    }),
  eventLogMaxEntries: z.number().int().positive().default(1000),
  updateDebounceMs: z.number().int().nonnegative().default(250),
  listLimit: z.number().int().positive().default(100),
});

export type ResourcesFeatureConfig = z.output<typeof ResourcesFeatureConfigSchema>;
