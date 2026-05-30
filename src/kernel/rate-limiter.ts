// Token-bucket rate limiter for MCP transport requests.
//
// The MCP spec (§"Security Considerations") lists rate limiting as a MUST.
// This module provides a simple in-memory token-bucket implementation keyed
// by an opaque caller-chosen string (typically the `Authorization` header or
// remote address). One bucket per key; buckets are created lazily on first
// `allow()` call and remain in the map for the lifetime of the process.
//
// Behavior:
//   - Each bucket has `capacity` tokens and refills at `refillPerSecond`.
//   - `allow(key)` removes one token and returns true if a token was
//     available; false otherwise.
//   - Bucket state is computed lazily on each `allow()` call — no
//     background refill timer. Tokens are recomputed against `capacity`,
//     `refillPerSecond`, and the elapsed time since the last touch.
//   - Token counts are floats (not integers); this avoids the rounding
//     starvation that integer-only buckets exhibit when refill < 1/sec.
//
// Design notes:
//   - In-memory only. No distributed coordination. Per-process bucket map.
//   - No bucket eviction. For a long-lived server with unbounded distinct
//     keys (e.g. per-IP from a public WAN), this is a memory leak. The
//     kernel callers should bound the key space (per-token / per-session).
//   - Not async-locked. JS single-threaded execution guarantees `allow()`
//     is atomic relative to other `allow()` calls.

/**
 * Options for `createTokenBucketRateLimiter`.
 */
export interface TokenBucketRateLimiterOptions {
  /** Bucket capacity (max burst). Must be a positive integer. */
  readonly capacity: number;
  /**
   * Refill rate, in tokens per second. May be fractional (e.g. 0.5 = one
   * token every two seconds).
   */
  readonly refillPerSecond: number;
}

/**
 * A token-bucket rate limiter. Construct one per "namespace" (e.g. one for
 * tool invocations, one for task creation) when distinct quotas are
 * needed.
 */
export interface TokenBucketRateLimiter {
  /**
   * Attempt to consume one token from the bucket associated with `key`.
   * Returns `true` if a token was available (request allowed) and `false`
   * if the bucket was empty (request should be rejected).
   */
  allow(key: string): boolean;
  /**
   * Compute the suggested `Retry-After` seconds value for a key whose
   * last `allow()` returned `false`. The result is the time until the
   * next token refills, rounded up to the next whole second (so a client
   * polling at 1s granularity sees a non-zero value).
   */
  retryAfterSeconds(key: string): number;
}

interface BucketState {
  tokens: number;
  /** `performance.now()` timestamp of the last touch, in milliseconds. */
  lastTouchMs: number;
}

/**
 * Create a new token-bucket rate limiter.
 *
 * @param opts.capacity - Bucket size; the maximum burst the limiter
 *   tolerates. Each bucket starts FULL (i.e. the first `capacity` calls
 *   on a fresh key all succeed).
 * @param opts.refillPerSecond - Steady-state refill rate, in tokens
 *   per second.
 */
export function createTokenBucketRateLimiter(
  opts: TokenBucketRateLimiterOptions,
): TokenBucketRateLimiter {
  const { capacity, refillPerSecond } = opts;
  if (!Number.isInteger(capacity) || capacity <= 0) {
    throw new Error(
      `createTokenBucketRateLimiter: capacity must be a positive integer (got ${capacity})`,
    );
  }
  if (!Number.isFinite(refillPerSecond) || refillPerSecond <= 0) {
    throw new Error(
      `createTokenBucketRateLimiter: refillPerSecond must be a positive finite number (got ${refillPerSecond})`,
    );
  }

  const buckets = new Map<string, BucketState>();

  function refill(state: BucketState, nowMs: number): void {
    const elapsedSeconds = (nowMs - state.lastTouchMs) / 1000;
    if (elapsedSeconds > 0) {
      state.tokens = Math.min(capacity, state.tokens + elapsedSeconds * refillPerSecond);
      state.lastTouchMs = nowMs;
    }
  }

  function ensureBucket(key: string, nowMs: number): BucketState {
    let state = buckets.get(key);
    if (state === undefined) {
      state = { tokens: capacity, lastTouchMs: nowMs };
      buckets.set(key, state);
    }
    return state;
  }

  return {
    allow(key: string): boolean {
      const nowMs = performance.now();
      const state = ensureBucket(key, nowMs);
      refill(state, nowMs);
      if (state.tokens >= 1) {
        state.tokens -= 1;
        return true;
      }
      return false;
    },
    retryAfterSeconds(key: string): number {
      const state = buckets.get(key);
      if (state === undefined) {
        // No prior call — full bucket, no wait needed.
        return 0;
      }
      // After a denied call, `state.tokens` is < 1; compute how long until
      // it ticks back up to 1.
      const deficit = 1 - state.tokens;
      if (deficit <= 0) {
        return 0;
      }
      const seconds = deficit / refillPerSecond;
      return Math.max(1, Math.ceil(seconds));
    },
  };
}
