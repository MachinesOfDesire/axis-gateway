import { test } from "node:test";
import assert from "node:assert/strict";

import { attenuate, scopeCovers, scopesCover } from "../src/scope-match.js";

test("scopeCovers: exact match", () => {
  assert.equal(scopeCovers("read:articles", "read:articles"), true);
  assert.equal(scopeCovers("read:articles", "write:articles"), false);
});

test("scopeCovers: trailing wildcard", () => {
  assert.equal(scopeCovers("admin:*", "admin:users"), true);
  assert.equal(scopeCovers("admin:*", "admin:roles"), true);
  assert.equal(scopeCovers("admin:*", "user:read"), false);
});

test("scopeCovers: wildcard must match same segment count", () => {
  assert.equal(scopeCovers("admin:*", "admin:users:delete"), false);
  assert.equal(scopeCovers("admin:*:*", "admin:users:delete"), true);
});

test("scopeCovers: rejects empty inputs", () => {
  assert.equal(scopeCovers("", "foo"), false);
  assert.equal(scopeCovers("foo", ""), false);
});

test("scopesCover: empty required always passes", () => {
  assert.deepEqual(scopesCover([], []), { ok: true });
  assert.deepEqual(scopesCover(["read:x"], []), { ok: true });
});

test("scopesCover: reports missing scopes", () => {
  const result = scopesCover(["read:articles"], ["read:articles", "write:articles"]);
  assert.equal(result.ok, false);
  assert.deepEqual(result.missing, ["write:articles"]);
});

test("scopesCover: wildcards in granted cover specific required", () => {
  assert.deepEqual(
    scopesCover(["admin:*"], ["admin:users", "admin:roles"]),
    { ok: true },
  );
});

test("attenuate: child can only grant subset of parent", () => {
  assert.deepEqual(
    attenuate(["read:articles", "write:articles"], ["read:articles", "delete:articles"]),
    ["read:articles"],
  );
});

test("attenuate: parent wildcard covers specific child", () => {
  assert.deepEqual(
    attenuate(["admin:*"], ["admin:users", "admin:roles", "other:thing"]),
    ["admin:users", "admin:roles"],
  );
});
