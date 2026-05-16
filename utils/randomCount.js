/**
 * Resolve a count-style param using the repo's range convention.
 * Matches the shape used by `wait.js` and `scroll.js`:
 *
 *   { count: 3 }            → 3                  (scalar wins)
 *   { min: 0, max: 5 }      → random int in [0,5] inclusive
 *   {} / undefined          → defaultValue
 *
 * Range bounds are clamped to >= 0 and order-tolerant.
 */
function resolveCount(params, defaultValue = 1) {
  if (!params || typeof params !== 'object') return defaultValue;

  if (typeof params.count === 'number' && Number.isFinite(params.count)) {
    return Math.max(0, Math.floor(params.count));
  }

  if (typeof params.min === 'number' && typeof params.max === 'number') {
    const lo = Math.max(0, Math.floor(Math.min(params.min, params.max)));
    const hi = Math.max(0, Math.floor(Math.max(params.min, params.max)));
    return lo + Math.floor(Math.random() * (hi - lo + 1));
  }

  return defaultValue;
}

module.exports = { resolveCount };
