/**
 * Policy engine: given a request, a verified identity, and a set of
 * configured routes, decide whether to allow the request, and what
 * scopes are required.
 *
 * Route patterns use simple globbing:
 *   "/api/articles"          — exact match
 *   "/api/articles/*"        — match "/api/articles/anything" (no slash in `*`)
 *   "/api/**"                — match everything under "/api/"
 */

const TIER_RANK = {
  email: 1,
  domain: 2,
  kyb_individual: 3,
  kyb_business: 4,
};

/**
 * Does `pattern` match `path`? Patterns support `*` (single segment) and
 * `**` (multi-segment, trailing only).
 */
export function matchRoute(pattern, path) {
  if (pattern === path) return true;
  if (pattern.endsWith("/**")) {
    const prefix = pattern.slice(0, -3);
    return path === prefix || path.startsWith(prefix + "/") || path === prefix.replace(/\/$/, "");
  }
  // Convert "/a/*/c" to a strict regex: `*` matches one path segment.
  const re = new RegExp(
    "^" +
      pattern
        .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
        .replace(/\*/g, "[^/]+") +
      "$",
  );
  return re.test(path);
}

/**
 * Find the most specific matching route for a given request path + method.
 * "Most specific" = longest pattern wins. If multiple tie in length, the
 * first one defined wins.
 *
 * @param {Array<{pathPattern: string, method?: string, ...}>} routes
 * @param {string} path
 * @param {string} method
 * @returns {object | null}
 */
export function findRoute(routes, path, method) {
  let best = null;
  for (const route of routes) {
    if (route.method && route.method.toUpperCase() !== method.toUpperCase()) continue;
    if (!matchRoute(route.pathPattern, path)) continue;
    if (!best || route.pathPattern.length > best.pathPattern.length) best = route;
  }
  return best;
}

/**
 * Given an authenticated identity (from the registry) and a matched
 * route, decide whether to allow. Returns {allow: true} or
 * {allow: false, reason, code}.
 *
 * @param {object} opts
 * @param {object} opts.identity          { agent_id, operator_id, verification_tier, scopes }
 * @param {object} opts.route             { minVerificationTier, requiredScopes }
 * @returns {{allow: true} | {allow: false, code: string, reason: string, detail?: any}}
 */
export function evaluate({ identity, route }) {
  if (route.minVerificationTier) {
    const have = TIER_RANK[identity.verification_tier] || 0;
    const need = TIER_RANK[route.minVerificationTier] || 0;
    if (have < need) {
      return {
        allow: false,
        code: "insufficient_tier",
        reason: `Route requires ${route.minVerificationTier}; caller is ${identity.verification_tier || "unverified"}`,
      };
    }
  }

  const required = route.requiredScopes || [];
  if (required.length > 0) {
    const granted = identity.scopes || [];
    // Inline scope check so policy stays dependency-free except scope-match.
    const missing = [];
    for (const r of required) {
      const covered = granted.some((g) => {
        if (g === r) return true;
        const gp = g.split(":");
        const rp = r.split(":");
        if (gp.length !== rp.length) return false;
        return gp.every((part, i) => part === "*" || part === rp[i]);
      });
      if (!covered) missing.push(r);
    }
    if (missing.length > 0) {
      return {
        allow: false,
        code: "insufficient_scope",
        reason: `Missing required scope(s): ${missing.join(", ")}`,
        detail: { missing, required, granted },
      };
    }
  }

  return { allow: true };
}
