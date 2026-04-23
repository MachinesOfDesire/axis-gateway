import { test } from "node:test";
import assert from "node:assert/strict";

import { TtlCache, aitCacheTtlMs, aitExp } from "../src/cache.js";

test("TtlCache: stores and retrieves within TTL", () => {
  let now = 1000;
  const cache = new TtlCache({ max: 10, now: () => now });
  cache.set("k", "v", 500);
  assert.equal(cache.get("k"), "v");
  now = 1400;
  assert.equal(cache.get("k"), "v"); // still within ttl
});

test("TtlCache: expires entries past TTL", () => {
  let now = 1000;
  const cache = new TtlCache({ max: 10, now: () => now });
  cache.set("k", "v", 500);
  now = 1600; // past expiry
  assert.equal(cache.get("k"), undefined);
});

test("TtlCache: refuses to store non-positive TTL", () => {
  const cache = new TtlCache({ max: 10 });
  cache.set("k", "v", 0);
  cache.set("k2", "v2", -100);
  cache.set("k3", "v3", NaN);
  assert.equal(cache.size(), 0);
});

test("TtlCache: evicts oldest when size exceeds max", () => {
  const cache = new TtlCache({ max: 3, now: () => 0 });
  cache.set("a", 1, 60_000);
  cache.set("b", 2, 60_000);
  cache.set("c", 3, 60_000);
  cache.set("d", 4, 60_000); // evicts "a"
  assert.equal(cache.get("a"), undefined);
  assert.equal(cache.get("b"), 2);
  assert.equal(cache.get("c"), 3);
  assert.equal(cache.get("d"), 4);
});

test("TtlCache: get refreshes LRU order", () => {
  const cache = new TtlCache({ max: 2, now: () => 0 });
  cache.set("a", 1, 60_000);
  cache.set("b", 2, 60_000);
  cache.get("a"); // a is now MRU
  cache.set("c", 3, 60_000); // should evict b, not a
  assert.equal(cache.get("a"), 1);
  assert.equal(cache.get("b"), undefined);
  assert.equal(cache.get("c"), 3);
});

test("aitExp: extracts numeric exp from a JWT-shaped token", () => {
  // Build a token with {exp: 2000000000} in payload.
  const header = b64(JSON.stringify({ alg: "EdDSA", typ: "AIT" }));
  const payload = b64(JSON.stringify({ iss: "axis:x:y", exp: 2000000000 }));
  const token = `${header}.${payload}.FAKESIG`;
  assert.equal(aitExp(token), 2000000000);
});

test("aitExp: returns undefined for malformed tokens", () => {
  assert.equal(aitExp("garbage"), undefined);
  assert.equal(aitExp("a.b"), undefined);
  assert.equal(aitExp("a.b.c"), undefined); // b is not valid base64-json
});

test("aitCacheTtlMs: returns ms until exp, clamped to max", () => {
  // exp 100s in the future, max 60s -> expect 60_000
  const future = Math.floor(Date.now() / 1000) + 100;
  const token = buildAit(future);
  const ttl = aitCacheTtlMs(token, { maxMs: 60_000 });
  assert.ok(ttl <= 60_000 && ttl > 50_000);

  // exp 10s in the future, max 60s -> expect ~10_000
  const sooner = Math.floor(Date.now() / 1000) + 10;
  const tokenSooner = buildAit(sooner);
  const ttlSooner = aitCacheTtlMs(tokenSooner, { maxMs: 60_000 });
  assert.ok(ttlSooner <= 10_000 && ttlSooner > 5_000);
});

test("aitCacheTtlMs: returns 0 for expired tokens", () => {
  const past = Math.floor(Date.now() / 1000) - 10;
  const token = buildAit(past);
  assert.equal(aitCacheTtlMs(token), 0);
});

function b64(s) {
  return Buffer.from(s).toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}
function buildAit(exp) {
  return `${b64(JSON.stringify({ alg: "EdDSA", typ: "AIT" }))}.${b64(JSON.stringify({ iss: "axis:x:y", exp }))}.SIG`;
}
