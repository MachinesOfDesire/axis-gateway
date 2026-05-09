# Changelog

All notable changes to `axis-gateway`. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html). Pre-1.0 — breaking changes are possible between minor releases.

## [0.1.0-alpha.3] — 2026-05-09

First public release after the repo was made public on 2026-05-08. Folds in pre-public commits and the portability + CI fixes from the post-public hardening pass.

### Fixed

- **Portability bug**: `decodeClaims` (`src/gateway.js`) and `aitExp` (`src/cache.js`) used Node's `Buffer.from(...)` to decode AIT payload segments. The README claims portability across "Node, Cloudflare Workers, Deno, Bun, modern browsers" but `Buffer` does not exist outside Node. Replaced both with the SDK's `b64urlDecodeString` helper, which uses platform-native `atob`. The gateway now actually does run in every environment the README claims.
- **CI sibling-checkout**: The `Tests` workflow had been failing on every push since 2026-05-08 because `axis-protocol-sdk` is a `file:../axis-protocol-sdk` dependency, but GitHub Actions only checked out the gateway, so the SDK path didn't exist and `import { ... } from "axis-protocol-sdk"` failed with `ERR_MODULE_NOT_FOUND`. Workflow now checks out both repos as siblings, matching the local-dev layout. (Will collapse back to a single checkout once the SDK ships on npm and gateway swaps to a versioned dep.)
- **Node 20 glob expansion**: `npm test` script used `node --test "test/*.test.js"`. Node 22 expands the glob internally; Node 20 does not, and bash leaves the quoted glob alone. Result: Node 20 / Ubuntu CI failed with `Could not find 'test/*.test.js'`. Switched to explicit file enumeration, mirroring the same fix that landed on `axis-protocol-sdk` earlier.

### Internal

- 45/45 tests passing across all four matrix slots (Node 20 + 22 on Ubuntu, Node 22 on Windows + macOS).

## [0.1.0-alpha.2] — 2026-05-08

### Added

- TTL-LRU cache on `verifyAIT` / `resolveAgent` / `verifyChain` (`src/cache.js`). Per-entry expiry; oldest entry evicted at `max`. Synchronous API, in-process Map. Wraps the SDK client's hot paths in the gateway. Configurable via `config.cache` (`enabled`, `aitCacheMaxMs`, `agentCacheTtlMs`, `chainCacheTtlMs`, `max`). Defaults: enabled, 60s/30s/30s, max 500 entries.

## [0.1.0-alpha.1] — 2026-05-07

Initial commit. Scope-enforcement gateway for the AXIS protocol: verifies AITs, walks delegation chains, evaluates per-route policy (min verification tier + required scopes), and forwards to upstream with signed identity headers (`X-AXIS-Agent-Id`, `X-AXIS-Operator-Id`, `X-AXIS-Verification-Tier`, `X-AXIS-Scopes`, `X-AXIS-Delegation-Id`, `X-AXIS-Delegation-Depth`). Framework-agnostic — accepts a Fetch-API `Request` and returns a Fetch-API `Response`; adapters for Node `http.Server` and Cloudflare Workers in the examples directory.
