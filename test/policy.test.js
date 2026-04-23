import { test } from "node:test";
import assert from "node:assert/strict";

import { evaluate, findRoute, matchRoute } from "../src/policy.js";

// ── matchRoute ─────────────────────────────────────────────────────────────

test("matchRoute: exact", () => {
  assert.equal(matchRoute("/api/articles", "/api/articles"), true);
  assert.equal(matchRoute("/api/articles", "/api/articles/"), false);
});

test("matchRoute: single-segment wildcard", () => {
  assert.equal(matchRoute("/api/*/edit", "/api/123/edit"), true);
  assert.equal(matchRoute("/api/*/edit", "/api/abc/def/edit"), false);
});

test("matchRoute: double-wildcard suffix", () => {
  assert.equal(matchRoute("/api/**", "/api"), true);
  assert.equal(matchRoute("/api/**", "/api/x"), true);
  assert.equal(matchRoute("/api/**", "/api/x/y/z"), true);
  assert.equal(matchRoute("/api/**", "/not-api"), false);
});

// ── findRoute ─────────────────────────────────────────────────────────────

test("findRoute: most specific wins", () => {
  const routes = [
    { pathPattern: "/api/**" },
    { pathPattern: "/api/articles/**" },
    { pathPattern: "/api/articles/featured" },
  ];
  assert.equal(findRoute(routes, "/api/articles/featured", "GET").pathPattern, "/api/articles/featured");
  assert.equal(findRoute(routes, "/api/articles/123", "GET").pathPattern, "/api/articles/**");
  assert.equal(findRoute(routes, "/api/other", "GET").pathPattern, "/api/**");
});

test("findRoute: method filters", () => {
  const routes = [
    { pathPattern: "/api/articles", method: "GET" },
    { pathPattern: "/api/articles", method: "POST", requiredScopes: ["write:articles"] },
  ];
  assert.equal(findRoute(routes, "/api/articles", "POST").requiredScopes[0], "write:articles");
});

test("findRoute: no match returns null", () => {
  assert.equal(findRoute([{ pathPattern: "/a" }], "/b", "GET"), null);
});

// ── evaluate ──────────────────────────────────────────────────────────────

test("evaluate: allows when route has no requirements", () => {
  const decision = evaluate({ identity: { scopes: [] }, route: {} });
  assert.equal(decision.allow, true);
});

test("evaluate: denies when verification tier is too low", () => {
  const decision = evaluate({
    identity: { verification_tier: "email" },
    route: { minVerificationTier: "domain" },
  });
  assert.equal(decision.allow, false);
  assert.equal(decision.code, "insufficient_tier");
});

test("evaluate: allows when tier is exact match", () => {
  const decision = evaluate({
    identity: { verification_tier: "domain" },
    route: { minVerificationTier: "domain" },
  });
  assert.equal(decision.allow, true);
});

test("evaluate: allows when tier exceeds minimum", () => {
  const decision = evaluate({
    identity: { verification_tier: "kyb_business" },
    route: { minVerificationTier: "domain" },
  });
  assert.equal(decision.allow, true);
});

test("evaluate: denies with specific missing scopes", () => {
  const decision = evaluate({
    identity: { scopes: ["read:articles"] },
    route: { requiredScopes: ["read:articles", "write:articles"] },
  });
  assert.equal(decision.allow, false);
  assert.equal(decision.code, "insufficient_scope");
  assert.deepEqual(decision.detail.missing, ["write:articles"]);
});

test("evaluate: wildcard grant covers specific required", () => {
  const decision = evaluate({
    identity: { scopes: ["admin:*"], verification_tier: "domain" },
    route: { requiredScopes: ["admin:users"], minVerificationTier: "domain" },
  });
  assert.equal(decision.allow, true);
});
