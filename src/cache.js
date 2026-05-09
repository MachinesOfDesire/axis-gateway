/**
 * Small TTL-aware LRU cache. Per-entry expiry; oldest entry evicted
 * when the map hits `max`. Synchronous API; storage is an in-process Map,
 * suitable for a single Worker isolate or a single Node process.
 *
 * Designed for the gateway's hot paths (verifyAIT, resolveAgent,
 * verifyDelegationChain). Each of those has a natural TTL:
 *   - verifyAIT: min(remaining AIT TTL, configured max)
 *   - resolveAgent: configured TTL (default 30s)
 *   - delegation chain: min(shortest expires_at in chain, configured max)
 *
 * If you care about strong freshness (e.g. immediate revocation visibility),
 * configure short TTLs or disable caching in the gateway config.
 */

export class TtlCache {
  /**
   * @param {object} opts
   * @param {number} opts.max         Maximum entries before LRU eviction.
   * @param {() => number} [opts.now] Clock function for tests.
   */
  constructor({ max = 500, now = () => Date.now() } = {}) {
    if (max < 1) throw new Error("TtlCache: max must be >= 1");
    this.max = max;
    this.now = now;
    this._map = new Map();
  }

  /**
   * Returns the cached value or undefined if missing or expired.
   * A hit refreshes the entry's LRU position; an expired entry is deleted.
   */
  get(key) {
    const entry = this._map.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this._map.delete(key);
      return undefined;
    }
    // Refresh LRU order by re-inserting.
    this._map.delete(key);
    this._map.set(key, entry);
    return entry.value;
  }

  /**
   * Store `value` under `key`, expiring after `ttlMs`. If `ttlMs <= 0`,
   * the entry is not stored (treat as uncachable).
   */
  set(key, value, ttlMs) {
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) return;
    if (this._map.has(key)) this._map.delete(key);
    this._map.set(key, { value, expiresAt: this.now() + ttlMs });
    if (this._map.size > this.max) {
      // Map iteration order is insertion order in JS; the first key is the LRU.
      const oldest = this._map.keys().next().value;
      if (oldest !== undefined) this._map.delete(oldest);
    }
  }

  /** Number of entries currently held (expired entries may still count). */
  size() {
    return this._map.size;
  }

  clear() {
    this._map.clear();
  }
}

// Use the SDK's b64url helper so this is portable across Node, CF Workers,
// Deno, Bun, and browsers (no Node Buffer dependency).
import { b64urlDecodeString } from "axis-protocol-sdk";

/**
 * Extract the `exp` claim from an AIT without verifying. Returns undefined
 * if the token is malformed or has no exp. Unix seconds.
 */
export function aitExp(token) {
  try {
    if (typeof token !== "string") return undefined;
    const parts = token.split(".");
    if (parts.length !== 3) return undefined;
    const payload = JSON.parse(b64urlDecodeString(parts[1]));
    return typeof payload?.exp === "number" ? payload.exp : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Compute a TTL in ms for caching a verifyAIT result. Clamps to the
 * configured max, never exceeds the AIT's own expiry, and never returns
 * a negative.
 */
export function aitCacheTtlMs(token, { maxMs = 60_000, nowMs = Date.now() } = {}) {
  const exp = aitExp(token);
  if (exp === undefined) return maxMs;
  const msUntilExp = exp * 1000 - nowMs;
  return Math.max(0, Math.min(maxMs, msUntilExp));
}
