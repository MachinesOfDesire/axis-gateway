/**
 * Cloudflare Worker adaptation of axis-gateway.
 *
 * The Gateway class is framework-agnostic: it takes a Fetch-API Request
 * and returns a Fetch-API Response. Cloudflare Workers speak the same
 * Fetch API natively, so the adapter is a one-liner.
 *
 * Deploy with wrangler:
 *   wrangler deploy
 *
 * Required wrangler.toml:
 *   name = "my-gateway"
 *   main = "examples/cloudflare-worker.js"
 *   compatibility_date = "2024-10-01"
 *
 *   [vars]
 *   AXIS_REGISTRY_URL = "https://registry.axisprime.ai"
 *   AXIS_UPSTREAM_URL = "https://your-upstream.workers.dev"
 *
 *   [[routes]]
 *   pattern = "gateway.yourdomain.com/*"
 *   custom_domain = true
 */

import { Gateway } from "axis-gateway";

// Inline config. For a richer deployment, fetch from KV or R2.
const CONFIG = {
  registryUrl: "https://registry.axisprime.ai",
  upstreamUrl: "https://upstream.example.com",
  routes: [
    {
      pathPattern: "/api/articles",
      method: "POST",
      requiredScopes: ["write:articles"],
      minVerificationTier: "domain",
    },
    { pathPattern: "/public/**" },
  ],
};

let gateway;

export default {
  async fetch(request, env, ctx) {
    if (!gateway) {
      gateway = new Gateway({
        config: {
          ...CONFIG,
          registryUrl: env.AXIS_REGISTRY_URL || CONFIG.registryUrl,
          upstreamUrl: env.AXIS_UPSTREAM_URL || CONFIG.upstreamUrl,
          upstreamSharedSecret: env.AXIS_UPSTREAM_SECRET || null,
        },
      });
    }
    return gateway.handle(request);
  },
};
