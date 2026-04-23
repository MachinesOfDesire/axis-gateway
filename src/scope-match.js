/**
 * Scope matching. A scope is a colon-separated string like
 * "read:articles" or "admin:users". Prefix-matched wildcards with a
 * trailing `*` component are supported: "admin:*" matches "admin:users"
 * and "admin:roles".
 *
 * Matching is deliberately simple for v0.1 — one level of wildcard,
 * no recursion, no globs. If the protocol grows richer scope grammar,
 * this module gets more interesting.
 */

/**
 * Does `granted` cover `required`? I.e. can a caller who was granted
 * `granted` claim to have the permission `required`?
 *
 * @param {string} granted
 * @param {string} required
 * @returns {boolean}
 */
export function scopeCovers(granted, required) {
  if (!granted || !required) return false;
  if (granted === required) return true;
  // Wildcard: "foo:*" covers "foo:anything", "foo:*:*" covers "foo:a:b", etc.
  const gParts = granted.split(":");
  const rParts = required.split(":");
  if (gParts.length !== rParts.length) return false;
  for (let i = 0; i < gParts.length; i++) {
    if (gParts[i] === "*") continue;
    if (gParts[i] !== rParts[i]) return false;
  }
  return true;
}

/**
 * Does the list of granted scopes cover every required scope?
 * Required is the demand; granted is the supply. Empty required passes.
 *
 * @param {string[]} granted
 * @param {string[]} required
 * @returns {{ok: true} | {ok: false, missing: string[]}}
 */
export function scopesCover(granted = [], required = []) {
  if (!Array.isArray(granted) || !Array.isArray(required)) {
    return { ok: false, missing: required };
  }
  const missing = [];
  for (const r of required) {
    if (!granted.some((g) => scopeCovers(g, r))) {
      missing.push(r);
    }
  }
  return missing.length === 0 ? { ok: true } : { ok: false, missing };
}

/**
 * Attenuate child scopes against parent scopes. A child delegation can
 * only grant a subset of what the parent holds. Returns the effective
 * grant: every child scope that is covered by at least one parent scope.
 *
 * @param {string[]} parent
 * @param {string[]} child
 * @returns {string[]}
 */
export function attenuate(parent, child) {
  return child.filter((c) => parent.some((p) => scopeCovers(p, c)));
}
