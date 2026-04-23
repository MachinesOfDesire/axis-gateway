/**
 * Config loader and validator.
 *
 * Example shape:
 *   {
 *     "registryUrl": "https://registry.axisprime.ai",
 *     "upstreamUrl": "https://api.internal.example.com",
 *     "listenPort": 8080,
 *     "upstreamSharedSecret": "...",
 *     "passthroughUnmatched": false,
 *     "routes": [
 *       {
 *         "pathPattern": "/api/articles/**",
 *         "method": "POST",
 *         "requiredScopes": ["write:articles"],
 *         "minVerificationTier": "domain"
 *       }
 *     ]
 *   }
 */

import { readFileSync } from "node:fs";

const VALID_TIERS = new Set(["email", "domain", "kyb_individual", "kyb_business"]);

export function loadConfig(path) {
  let raw;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (e) {
    throw new Error(`Failed to read config at ${path}: ${e.message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`Config is not valid JSON: ${e.message}`);
  }
  return validateConfig(parsed);
}

export function validateConfig(cfg) {
  const errors = [];
  if (!cfg || typeof cfg !== "object") {
    throw new Error("Config must be an object");
  }
  if (typeof cfg.registryUrl !== "string" || !cfg.registryUrl) {
    errors.push("registryUrl: required string");
  }
  if (typeof cfg.upstreamUrl !== "string" || !cfg.upstreamUrl) {
    errors.push("upstreamUrl: required string");
  }
  if (!Array.isArray(cfg.routes)) {
    errors.push("routes: required array");
  } else {
    cfg.routes.forEach((r, i) => {
      if (!r || typeof r !== "object") {
        errors.push(`routes[${i}]: must be an object`);
        return;
      }
      if (typeof r.pathPattern !== "string" || !r.pathPattern) {
        errors.push(`routes[${i}].pathPattern: required string`);
      }
      if (r.method && typeof r.method !== "string") {
        errors.push(`routes[${i}].method: must be a string`);
      }
      if (r.requiredScopes && !Array.isArray(r.requiredScopes)) {
        errors.push(`routes[${i}].requiredScopes: must be an array of strings`);
      }
      if (r.minVerificationTier && !VALID_TIERS.has(r.minVerificationTier)) {
        errors.push(
          `routes[${i}].minVerificationTier: must be one of ${[...VALID_TIERS].join(", ")}`,
        );
      }
    });
  }
  if (errors.length) {
    throw new Error("Invalid config:\n  " + errors.join("\n  "));
  }
  return {
    registryUrl: cfg.registryUrl.replace(/\/$/, ""),
    upstreamUrl: cfg.upstreamUrl.replace(/\/$/, ""),
    listenPort: cfg.listenPort || 8080,
    upstreamSharedSecret: cfg.upstreamSharedSecret || null,
    passthroughUnmatched: Boolean(cfg.passthroughUnmatched),
    routes: cfg.routes.map((r) => ({
      pathPattern: r.pathPattern,
      method: r.method || null,
      requiredScopes: r.requiredScopes || [],
      minVerificationTier: r.minVerificationTier || null,
    })),
  };
}
