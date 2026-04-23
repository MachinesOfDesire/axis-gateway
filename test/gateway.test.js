import { test } from "node:test";
import assert from "node:assert/strict";

import { Gateway, decodeClaims, extractToken } from "../src/gateway.js";

// ── Token extraction ───────────────────────────────────────────────────────

test("extractToken: pulls Bearer from Authorization", () => {
  const req = new Request("http://x/", { headers: { authorization: "Bearer abc.def.ghi" } });
  assert.equal(extractToken(req), "abc.def.ghi");
});

test("extractToken: pulls from X-AXIS-Token when no bearer", () => {
  const req = new Request("http://x/", { headers: { "x-axis-token": "a.b.c" } });
  assert.equal(extractToken(req), "a.b.c");
});

test("extractToken: returns null when absent", () => {
  assert.equal(extractToken(new Request("http://x/")), null);
});

// ── Claim decoding ─────────────────────────────────────────────────────────

test("decodeClaims: extracts payload from a well-formed AIT", () => {
  // Build a fake AIT with known claims; signature is not verified here.
  const header = b64("{\"alg\":\"EdDSA\",\"typ\":\"AIT\"}");
  const payload = b64("{\"iss\":\"axis:op:agent\",\"dlg\":\"deleg_abc\"}");
  const token = `${header}.${payload}.SIGNATURE_IGNORED`;
  const claims = decodeClaims(token);
  assert.equal(claims.iss, "axis:op:agent");
  assert.equal(claims.dlg, "deleg_abc");
});

test("decodeClaims: returns null on malformed token", () => {
  assert.equal(decodeClaims("not-a-jwt"), null);
  assert.equal(decodeClaims("a.b"), null);
});

function b64(s) {
  return Buffer.from(s).toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

// ── Gateway request handling ───────────────────────────────────────────────

/** Fake AxisClient for Gateway unit tests. */
function fakeClient(overrides = {}) {
  return {
    async verifyAIT(token) {
      if (overrides.verifyAIT) return overrides.verifyAIT(token);
      return { valid: true, agent_id: "axis:ops:mira", operator_id: "ops" };
    },
    async resolveAgent(id) {
      if (overrides.resolveAgent) return overrides.resolveAgent(id);
      return { axis_id: id, operator_verification_tier: "domain" };
    },
    async verifyDelegationChain(id) {
      if (overrides.verifyDelegationChain) return overrides.verifyDelegationChain(id);
      return { delegations: [{ scope: ["write:articles"] }] };
    },
    ...overrides._extra,
  };
}

const BASE_CONFIG = {
  registryUrl: "https://registry.test",
  upstreamUrl: "https://upstream.test",
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

test("Gateway: 404 when no route matches and passthrough disabled", async () => {
  const g = new Gateway({ config: BASE_CONFIG, client: fakeClient() });
  const resp = await g.handle(new Request("http://x/nowhere"));
  assert.equal(resp.status, 404);
  const body = await resp.json();
  assert.equal(body.error.code, "no_matching_route");
});

test("Gateway: 401 when route needs auth and no token is sent", async () => {
  const g = new Gateway({ config: BASE_CONFIG, client: fakeClient() });
  const resp = await g.handle(
    new Request("http://x/api/articles", { method: "POST" }),
  );
  assert.equal(resp.status, 401);
  const body = await resp.json();
  assert.equal(body.error.code, "missing_token");
});

test("Gateway: 401 when registry rejects the token", async () => {
  const g = new Gateway({
    config: BASE_CONFIG,
    client: fakeClient({
      verifyAIT: async () => ({ valid: false, error: "expired" }),
    }),
  });
  const resp = await g.handle(
    new Request("http://x/api/articles", {
      method: "POST",
      headers: { authorization: "Bearer tok" },
    }),
  );
  assert.equal(resp.status, 401);
  const body = await resp.json();
  assert.equal(body.error.code, "invalid_token");
});

test("Gateway: 503 on registry transport failure", async () => {
  const g = new Gateway({
    config: BASE_CONFIG,
    client: fakeClient({
      verifyAIT: async () => {
        throw new Error("ECONNRESET");
      },
    }),
  });
  const resp = await g.handle(
    new Request("http://x/api/articles", {
      method: "POST",
      headers: { authorization: "Bearer tok" },
    }),
  );
  assert.equal(resp.status, 503);
});

test("Gateway: 403 when verification tier is below route minimum", async () => {
  const g = new Gateway({
    config: BASE_CONFIG,
    client: fakeClient({
      resolveAgent: async () => ({ operator_verification_tier: "email" }),
    }),
  });
  const resp = await g.handle(
    new Request("http://x/api/articles", {
      method: "POST",
      headers: { authorization: "Bearer tok" },
    }),
  );
  assert.equal(resp.status, 403);
  const body = await resp.json();
  assert.equal(body.error.code, "insufficient_tier");
});

test("Gateway: 403 when required scope is missing (no delegation)", async () => {
  // AIT without a dlg claim -> no effective scopes.
  const tokenNoDlg = `${b64("{\"alg\":\"EdDSA\",\"typ\":\"AIT\"}")}.${b64("{\"iss\":\"axis:ops:mira\"}")}.SIG`;
  const g = new Gateway({ config: BASE_CONFIG, client: fakeClient() });
  const resp = await g.handle(
    new Request("http://x/api/articles", {
      method: "POST",
      headers: { authorization: `Bearer ${tokenNoDlg}` },
    }),
  );
  assert.equal(resp.status, 403);
  const body = await resp.json();
  assert.equal(body.error.code, "insufficient_scope");
  assert.deepEqual(body.error.detail.missing, ["write:articles"]);
});

test("Gateway: forwards with identity headers when all checks pass", async () => {
  const tokenWithDlg = `${b64("{\"alg\":\"EdDSA\",\"typ\":\"AIT\"}")}.${b64("{\"iss\":\"axis:ops:mira\",\"dlg\":\"deleg_abc\"}")}.SIG`;

  let forwardedUrl = null;
  let forwardedHeaders = null;
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    forwardedUrl = url;
    forwardedHeaders = init.headers;
    return new Response("upstream-ok", { status: 200 });
  };

  try {
    const g = new Gateway({ config: BASE_CONFIG, client: fakeClient() });
    const resp = await g.handle(
      new Request("http://x/api/articles", {
        method: "POST",
        headers: {
          authorization: `Bearer ${tokenWithDlg}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ hello: "world" }),
      }),
    );
    assert.equal(resp.status, 200);
    assert.equal(await resp.text(), "upstream-ok");
    assert.equal(forwardedUrl, "https://upstream.test/api/articles");
    assert.equal(forwardedHeaders.get("x-axis-agent-id"), "axis:ops:mira");
    assert.equal(forwardedHeaders.get("x-axis-operator-id"), "ops");
    assert.equal(forwardedHeaders.get("x-axis-verification-tier"), "domain");
    assert.equal(forwardedHeaders.get("x-axis-delegation-id"), "deleg_abc");
    assert.equal(forwardedHeaders.get("x-axis-scopes"), "write:articles");
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("Gateway: cache short-circuits the second verifyAIT call", async () => {
  const tokenWithDlg = `${b64("{\"alg\":\"EdDSA\",\"typ\":\"AIT\"}")}.${b64(`{"iss":"axis:ops:mira","dlg":"deleg_abc","exp":${Math.floor(Date.now() / 1000) + 300}}`)}.SIG`;

  let verifyCalls = 0;
  let agentCalls = 0;
  let chainCalls = 0;
  const client = {
    async verifyAIT() {
      verifyCalls++;
      return { valid: true, agent_id: "axis:ops:mira", operator_id: "ops" };
    },
    async resolveAgent() {
      agentCalls++;
      return { operator_verification_tier: "domain" };
    },
    async verifyDelegationChain() {
      chainCalls++;
      return { delegations: [{ scope: ["write:articles"] }] };
    },
  };

  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("ok", { status: 200 });
  try {
    const g = new Gateway({ config: BASE_CONFIG, client });
    const makeReq = () =>
      new Request("http://x/api/articles", {
        method: "POST",
        headers: { authorization: `Bearer ${tokenWithDlg}` },
        body: JSON.stringify({}),
      });

    await g.handle(makeReq());
    await g.handle(makeReq());
    await g.handle(makeReq());

    // Three requests, but the client was called once per endpoint thanks to the cache.
    assert.equal(verifyCalls, 1, `verifyAIT should hit once, got ${verifyCalls}`);
    assert.equal(agentCalls, 1, `resolveAgent should hit once, got ${agentCalls}`);
    assert.equal(chainCalls, 1, `verifyDelegationChain should hit once, got ${chainCalls}`);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("Gateway: cache disabled via config makes every call go through", async () => {
  const tokenWithDlg = `${b64("{\"alg\":\"EdDSA\",\"typ\":\"AIT\"}")}.${b64(`{"iss":"axis:ops:mira","dlg":"deleg_abc","exp":${Math.floor(Date.now() / 1000) + 300}}`)}.SIG`;

  let verifyCalls = 0;
  const client = {
    async verifyAIT() {
      verifyCalls++;
      return { valid: true, agent_id: "axis:ops:mira", operator_id: "ops" };
    },
    async resolveAgent() {
      return { operator_verification_tier: "domain" };
    },
    async verifyDelegationChain() {
      return { delegations: [{ scope: ["write:articles"] }] };
    },
  };

  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("ok", { status: 200 });
  try {
    const g = new Gateway({
      config: { ...BASE_CONFIG, cache: { enabled: false } },
      client,
    });
    const makeReq = () =>
      new Request("http://x/api/articles", {
        method: "POST",
        headers: { authorization: `Bearer ${tokenWithDlg}` },
        body: JSON.stringify({}),
      });
    await g.handle(makeReq());
    await g.handle(makeReq());
    assert.equal(verifyCalls, 2, "cache was supposed to be disabled");
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("Gateway: public route with no token passes through", async () => {
  let forwardedUrl = null;
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    forwardedUrl = url;
    return new Response("ok", { status: 200 });
  };
  try {
    const g = new Gateway({ config: BASE_CONFIG, client: fakeClient() });
    const resp = await g.handle(new Request("http://x/public/home"));
    assert.equal(resp.status, 200);
    assert.equal(forwardedUrl, "https://upstream.test/public/home");
  } finally {
    globalThis.fetch = origFetch;
  }
});
