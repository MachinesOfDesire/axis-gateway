/**
 * axis-gateway — scope-enforcement gateway for the AXIS protocol.
 *
 * Public entry. Most callers use this from a server adapter (see cli.js
 * for Node, examples/cloudflare-worker.js for Workers).
 *
 *   import { Gateway, loadConfig } from "axis-gateway";
 *   const gateway = new Gateway({ config: loadConfig("./cfg.json") });
 *   // gateway.handle(request) -> response
 */

export { Gateway, extractToken, decodeClaims } from "./gateway.js";
export { loadConfig, validateConfig } from "./config.js";
export { evaluate, findRoute, matchRoute } from "./policy.js";
export { scopeCovers, scopesCover, attenuate } from "./scope-match.js";
export { TtlCache, aitCacheTtlMs, aitExp } from "./cache.js";

export const GATEWAY_VERSION = "0.1.0-alpha.2";
