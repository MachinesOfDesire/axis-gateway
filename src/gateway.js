/**
 * Gateway — the request pipeline.
 *
 * Responsibilities:
 *   1. Extract AIT from incoming request (Bearer token or X-AXIS-Token)
 *   2. Verify AIT against the registry (using the SDK)
 *   3. If the AIT carries a `dlg` claim, fetch the delegation chain and
 *      compute effective scopes (attenuated down the chain)
 *   4. Match the request path against the configured routes to find the
 *      applicable policy (min tier, required scopes)
 *   5. Evaluate the policy against the verified identity
 *   6. If allowed: forward to upstream with X-AXIS-* identity headers
 *   7. If denied: return a structured error response
 *
 * The gateway is framework-agnostic. It takes in a Fetch-API `Request`
 * and returns a Fetch-API `Response`. Adapters in cli.js wrap a Node
 * http.Server around it; examples/cloudflare-worker.js does the CF Workers
 * adaptation in ~20 lines.
 */

import { AxisClient } from "axis-protocol-sdk";

import { TtlCache, aitCacheTtlMs } from "./cache.js";
import { evaluate, findRoute } from "./policy.js";
import { attenuate } from "./scope-match.js";

const DEFAULT_VERIFICATION_HEADER_PREFIX = "X-AXIS-";

export class Gateway {
  /**
   * @param {object} opts
   * @param {object} opts.config                     Parsed config (see config.js).
   * @param {string} opts.config.registryUrl
   * @param {string} opts.config.upstreamUrl
   * @param {Array} opts.config.routes
   * @param {object} [opts.config.cache]             Cache config. See README.
   * @param {AxisClient} [opts.client]               Override for testing.
   * @param {string} [opts.headerPrefix]             Default "X-AXIS-"
   */
  constructor({ config, client, headerPrefix = DEFAULT_VERIFICATION_HEADER_PREFIX } = {}) {
    if (!config) throw new Error("Gateway: config is required");
    if (!config.registryUrl) throw new Error("Gateway: config.registryUrl is required");
    if (!config.upstreamUrl) throw new Error("Gateway: config.upstreamUrl is required");
    if (!Array.isArray(config.routes)) throw new Error("Gateway: config.routes must be an array");
    this.config = config;
    this.client = client || new AxisClient({ registryUrl: config.registryUrl });
    this.headerPrefix = headerPrefix;

    // Cache is opt-out. The config knob turns it off or shrinks it; the
    // gateway always reads through the cache wrappers so tests see the same
    // code path. Setting `enabled: false` makes every get() miss.
    const cacheCfg = config.cache || {};
    this._cacheEnabled = cacheCfg.enabled !== false;
    this._aitCacheMaxMs = cacheCfg.aitCacheMaxMs ?? 60_000;
    this._agentCacheTtlMs = cacheCfg.agentCacheTtlMs ?? 30_000;
    this._chainCacheTtlMs = cacheCfg.chainCacheTtlMs ?? 30_000;
    const cacheMax = cacheCfg.max ?? 500;
    this._verifyCache = new TtlCache({ max: cacheMax });
    this._agentCache = new TtlCache({ max: cacheMax });
    this._chainCache = new TtlCache({ max: cacheMax });
  }

  // ── Cached wrappers around the SDK client ───────────────────────────────

  async _cachedVerifyAIT(token) {
    if (this._cacheEnabled) {
      const hit = this._verifyCache.get(token);
      if (hit) return hit;
    }
    const result = await this.client.verifyAIT(token);
    if (this._cacheEnabled && result.valid) {
      // Only cache successful verifications. Caching failures would let a
      // revoked agent's rejection linger; caching successes up to the AIT's
      // own exp is safe because exp is verified on every cache read.
      const ttl = aitCacheTtlMs(token, { maxMs: this._aitCacheMaxMs });
      this._verifyCache.set(token, result, ttl);
    }
    return result;
  }

  async _cachedResolveAgent(agentId) {
    if (this._cacheEnabled) {
      const hit = this._agentCache.get(agentId);
      if (hit !== undefined) return hit;
    }
    let agent;
    try {
      agent = await this.client.resolveAgent(agentId);
    } catch {
      agent = null;
    }
    if (this._cacheEnabled && agent) {
      this._agentCache.set(agentId, agent, this._agentCacheTtlMs);
    }
    return agent;
  }

  async _cachedVerifyChain(delegationId) {
    if (this._cacheEnabled) {
      const hit = this._chainCache.get(delegationId);
      if (hit !== undefined) return hit;
    }
    let chain;
    try {
      chain = await this.client.verifyDelegationChain(delegationId);
    } catch (err) {
      chain = { error: err.message };
    }
    // Cache positive results; negative results are short-circuited so we
    // don't pin a broken chain for the full TTL after transient failure.
    if (this._cacheEnabled && chain && !chain.error) {
      this._chainCache.set(delegationId, chain, this._chainCacheTtlMs);
    }
    return chain;
  }

  /**
   * Handle one incoming Fetch-API Request, return a Fetch-API Response.
   * This is the core loop; call it from a Node http server adapter,
   * a Cloudflare Worker, Deno.serve, etc.
   *
   * @param {Request} request
   * @returns {Promise<Response>}
   */
  async handle(request) {
    const url = new URL(request.url);

    // 1. Find the applicable route. If none, we don't manage this path ---
    //    forward without auth (transparent fallthrough) if the config says
    //    so, else deny. Default is strict deny.
    const route = findRoute(this.config.routes, url.pathname, request.method);
    if (!route) {
      if (this.config.passthroughUnmatched) {
        return this._forward(request, url, {});
      }
      return this._deny(404, "no_matching_route", `No route configured for ${request.method} ${url.pathname}`);
    }

    // 2. Extract the AIT. Support both "Authorization: Bearer <tok>" and a
    //    custom header so callers can pass the AIT alongside other tokens.
    const token = extractToken(request);
    if (!token) {
      // If the route has no auth requirements at all, pass through anonymously.
      if (!route.requiredScopes?.length && !route.minVerificationTier) {
        return this._forward(request, url, {});
      }
      return this._deny(401, "missing_token", "This route requires an AXIS Identity Token");
    }

    // 3. Verify with the registry. _cachedVerifyAIT returns {valid: bool, ...}
    //    without throwing for bad tokens; it only throws on transport.
    let verified;
    try {
      verified = await this._cachedVerifyAIT(token);
    } catch (err) {
      return this._deny(503, "registry_unreachable", `Registry verification failed: ${err.message}`);
    }
    if (!verified.valid) {
      return this._deny(401, "invalid_token", verified.error || "Token rejected by registry");
    }

    // 4. Build the identity the policy engine sees. Agent info carries
    //    verification_tier + revocation state. Delegation chain only if
    //    the AIT claims one.
    const agent = await this._cachedResolveAgent(verified.agent_id);
    const verificationTier = agent?.operator?.verification_tier || agent?.operator_verification_tier || null;

    let scopes = [];
    let delegationTrace = null;
    const claims = decodeClaims(token);
    if (claims?.dlg) {
      const chain = await this._cachedVerifyChain(claims.dlg);
      if (chain?.error) {
        return this._deny(403, "delegation_invalid", chain.error);
      }
      if (chain?.delegations?.length) {
        scopes = chain.delegations.reduce(
          (acc, d, i) => (i === 0 ? [...(d.scope || [])] : attenuate(acc, d.scope || [])),
          [],
        );
        delegationTrace = {
          delegation_id: claims.dlg,
          depth: chain.delegations.length,
          effective_scopes: scopes,
        };
      }
    }

    // 5. Policy evaluation.
    const identity = {
      agent_id: verified.agent_id,
      operator_id: verified.operator_id,
      verification_tier: verificationTier,
      scopes,
    };
    const decision = evaluate({ identity, route });
    if (!decision.allow) {
      return this._deny(403, decision.code, decision.reason, decision.detail);
    }

    // 6. Forward with signed identity headers.
    return this._forward(request, url, { identity, delegationTrace, token });
  }

  // ── Internals ────────────────────────────────────────────────────────────

  async _forward(originalRequest, url, { identity, delegationTrace }) {
    const upstream = new URL(url.pathname + url.search, this.config.upstreamUrl);
    const outgoing = new Headers(originalRequest.headers);
    outgoing.delete("host");

    if (identity) {
      outgoing.set(`${this.headerPrefix}Agent-Id`, identity.agent_id || "");
      outgoing.set(`${this.headerPrefix}Operator-Id`, identity.operator_id || "");
      if (identity.verification_tier) {
        outgoing.set(`${this.headerPrefix}Verification-Tier`, identity.verification_tier);
      }
      if (identity.scopes?.length) {
        outgoing.set(`${this.headerPrefix}Scopes`, identity.scopes.join(" "));
      }
    }
    if (delegationTrace) {
      outgoing.set(`${this.headerPrefix}Delegation-Id`, delegationTrace.delegation_id);
      outgoing.set(`${this.headerPrefix}Delegation-Depth`, String(delegationTrace.depth));
    }

    // The gateway identifies itself to upstream so upstream can trust the
    // X-AXIS-* headers. In production this would be an HMAC; the prototype
    // uses a shared-secret header, configured via config.upstreamSharedSecret.
    if (this.config.upstreamSharedSecret) {
      outgoing.set(`${this.headerPrefix}Gateway-Secret`, this.config.upstreamSharedSecret);
    }

    const init = {
      method: originalRequest.method,
      headers: outgoing,
      redirect: "manual",
    };
    if (!["GET", "HEAD"].includes(originalRequest.method.toUpperCase())) {
      init.body = await originalRequest.arrayBuffer();
      if (init.body.byteLength === 0) init.body = undefined;
    }

    try {
      const upstreamResp = await fetch(upstream.toString(), init);
      return upstreamResp;
    } catch (err) {
      return this._deny(502, "upstream_unreachable", `Upstream unreachable: ${err.message}`);
    }
  }

  _deny(status, code, message, detail) {
    const body = { error: { code, message } };
    if (detail) body.error.detail = detail;
    return new Response(JSON.stringify(body, null, 2), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }
}

// ── Token extraction and claim decoding ─────────────────────────────────────

export function extractToken(request) {
  const auth = request.headers.get("authorization");
  if (auth) {
    const m = /^Bearer (.+)$/i.exec(auth);
    if (m) return m[1];
  }
  const xaxis = request.headers.get("x-axis-token");
  if (xaxis) return xaxis;
  return null;
}

/** Decode an AIT's payload claims without verifying. Returns null on bad shape. */
export function decodeClaims(token) {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const padded = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padLen = (4 - (padded.length % 4)) % 4;
    const b64 = padded + "=".repeat(padLen);
    const json = Buffer.from(b64, "base64").toString("utf-8");
    return JSON.parse(json);
  } catch {
    return null;
  }
}
