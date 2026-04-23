# axis-gateway

**Scope-enforcement gateway for the AXIS protocol.** A thin reverse proxy that verifies AXIS Identity Tokens (AITs), walks delegation chains, checks required scopes, and forwards allowed requests to your upstream with signed identity headers.

> **Status:** v0.1.0-alpha. Prototype. Breaking changes expected.

The third layer of the AXIS three-layer model (identity, access policy, scope enforcement). Together with the registry and the SDK, it closes the loop: your upstream service stops having to know anything about AIT verification or delegation chain walking. It trusts the gateway's `X-AXIS-*` headers.

---

## Why

A service that wants "only verified agents, with the right scope, from an operator at KYB-individual or above" has two choices:

1. Re-implement verification in every route (every language, every codebase)
2. Put the gateway in front and forget about it

Pick (2).

## Install

```bash
npm install axis-gateway
```

Node 20+. Zero runtime dependencies beyond `axis-protocol-sdk` (which itself has none).

## Quick start (Node)

```bash
# 1. Write a config:
cat > gateway.config.json <<'EOF'
{
  "registryUrl": "https://registry.axisprime.ai",
  "upstreamUrl": "http://localhost:3000",
  "listenPort": 8080,
  "routes": [
    {
      "pathPattern": "/api/articles",
      "method": "POST",
      "requiredScopes": ["write:articles"],
      "minVerificationTier": "domain"
    },
    { "pathPattern": "/public/**" }
  ]
}
EOF

# 2. Run it:
npx axis-gateway gateway.config.json
```

Now point traffic at `http://localhost:8080`. The gateway verifies tokens, enforces scopes, and forwards to `http://localhost:3000`.

## Quick start (Cloudflare Worker)

See [`examples/cloudflare-worker.js`](./examples/cloudflare-worker.js). About 20 lines.

## How it decides

For each incoming request:

1. **Match route.** The most specific pattern wins (longest-match). Patterns support `*` (single segment) and `**` (multi-segment trailing).
2. **Extract token.** `Authorization: Bearer <AIT>` or `X-AXIS-Token: <AIT>`.
3. **Verify token.** Calls the registry's `GET /verify?token=`. Valid + not expired + agent not revoked.
4. **Resolve agent.** Pulls the registry's record for the agent to get `verification_tier`.
5. **Walk delegation chain.** If the AIT carries a `dlg` claim, fetch that delegation's chain (`GET /delegations/:id/chain`) and compute effective scopes = intersection down the chain.
6. **Policy check.** Route's `minVerificationTier` and `requiredScopes` must be satisfied.
7. **Forward or deny.** On allow, proxy to `upstreamUrl` with signed identity headers. On deny, return a structured JSON error.

## Headers sent to upstream

| Header | Meaning |
|---|---|
| `X-AXIS-Agent-Id` | Verified agent axis_id |
| `X-AXIS-Operator-Id` | Operator that owns the agent |
| `X-AXIS-Verification-Tier` | `email` \| `domain` \| `kyb_individual` \| `kyb_business` |
| `X-AXIS-Scopes` | Space-separated effective scopes |
| `X-AXIS-Delegation-Id` | Delegation the agent is acting under (if any) |
| `X-AXIS-Delegation-Depth` | Length of the delegation chain |
| `X-AXIS-Gateway-Secret` | Shared secret (if configured) — upstream uses this to trust the other headers |

## Config reference

```jsonc
{
  "registryUrl": "https://registry.axisprime.ai",
  "upstreamUrl": "https://api.internal.example.com",
  "listenPort": 8080,
  "upstreamSharedSecret": "rotate-per-deploy",
  "passthroughUnmatched": false,
  "routes": [
    {
      "pathPattern": "/api/articles",
      "method": "POST",
      "requiredScopes": ["write:articles"],
      "minVerificationTier": "domain"
    }
  ]
}
```

- `registryUrl` (required): the AXIS registry the gateway consults
- `upstreamUrl` (required): where allowed requests are forwarded
- `listenPort` (default 8080): only used by the Node CLI adapter
- `upstreamSharedSecret` (optional): sent to upstream so it can verify identity headers came from the gateway
- `passthroughUnmatched` (default false): if true, unmatched paths are forwarded unverified. Useful when the gateway fronts a mix of protected and legacy routes. Off by default for safety.
- `routes[]`:
  - `pathPattern` (required): `/exact`, `/prefix/*` (one segment), `/prefix/**` (any depth)
  - `method` (optional): filter to a specific HTTP method
  - `requiredScopes` (optional): all must be covered by the caller's effective scopes
  - `minVerificationTier` (optional): `email` | `domain` | `kyb_individual` | `kyb_business`

## Error responses

All denials return JSON:

```json
{ "error": { "code": "insufficient_scope", "message": "Missing required scope(s): write:articles", "detail": { "missing": ["write:articles"], "required": ["write:articles"], "granted": [] } } }
```

Codes:

- `no_matching_route` (404): no route matched and passthrough is disabled
- `missing_token` (401): route requires auth, no token present
- `invalid_token` (401): registry rejected the token (expired, bad signature, agent revoked)
- `registry_unreachable` (503): couldn't reach the registry
- `insufficient_tier` (403): caller's operator verification is below the route minimum
- `insufficient_scope` (403): required scopes not covered by the delegation chain
- `delegation_invalid` (403): AIT's `dlg` claim couldn't be resolved
- `upstream_unreachable` (502): upstream didn't respond

## Caching

Enabled by default. An in-process TTL-LRU caches three hot paths:

- **verifyAIT** — cached up to `aitCacheMaxMs` (default 60s), but never longer than the AIT's own `exp` claim
- **resolveAgent** — cached for `agentCacheTtlMs` (default 30s)
- **verifyDelegationChain** — cached for `chainCacheTtlMs` (default 30s)

Only successful verifications are cached; failures always re-hit the registry so revocation surfaces fast. Configure in `wrangler`-style config:

```json
{
  "cache": {
    "enabled": true,
    "max": 500,
    "aitCacheMaxMs": 60000,
    "agentCacheTtlMs": 30000,
    "chainCacheTtlMs": 30000
  }
}
```

Disable with `"cache": { "enabled": false }` if you want strict freshness (and can afford the extra registry load).

**Revocation caveat:** if you revoke an agent mid-session and their AIT is still in cache, the gateway will keep accepting their token until the cache expires. Keep `aitCacheMaxMs` short if immediate revocation matters more than throughput.

## What the gateway does NOT do

Kept narrow on purpose:

- **No local verification.** Every check (on cache miss) goes to the registry. That is where the truth lives. If the registry is down, the gateway fails closed.
- **No rate limiting.** Stick that in front of the gateway.
- **No response inspection.** Forwards whatever upstream returns.
- **No body rewriting.** Your upstream sees the original body.

## Development

```bash
npm install
npm test        # 34 tests against scope match, policy, gateway core
```

Tests stub out the SDK client, so no network. Run `node src/cli.js examples/simple-config.json` for a live integration test against the real registry.

## License

Apache 2.0. See [LICENSE](./LICENSE).
