/**
 * Cooldown-skip log de-duplication.
 *
 * The auto-engage loop re-runs every ~10 min. Without this, every tick posts a
 * fresh `SKIPPED (cooldown)` tracker-log entry for each cooled-down profile —
 * flooding the profile's trackerLog with ~144 identical entries/day.
 *
 * This marks, per profile, the `lastSharedAt` value for which a cooldown skip
 * was already logged. `shouldLogCooldownSkip` returns true only the FIRST time a
 * given (userId, lastSharedAt) window is seen, and false on every subsequent
 * skip for the same window. Because the key is `lastSharedAt`, the next time the
 * profile actually shares (lastSharedAt changes) and later re-enters cooldown,
 * the new window logs exactly once again.
 *
 * Persisted to `state/cooldown-log-markers.json` so the suppression survives
 * across auto-loop batches AND process restarts. An in-memory cache is the
 * source of truth within the process; the function is fully synchronous (no
 * await between read and write), so concurrent workers can't race it.
 */

const fs = require('fs');
const path = require('path');

const STATE_DIR = path.join(process.cwd(), 'state');
const FILE = path.join(STATE_DIR, 'cooldown-log-markers.json');

let cache = null;

function ensureLoaded() {
  if (cache) return cache;
  try {
    cache = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (!cache || typeof cache !== 'object') cache = {};
  } catch (_) {
    cache = {};
  }
  return cache;
}

function persist(map) {
  try {
    if (!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR, { recursive: true });
    const tmp = `${FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(map, null, 2), 'utf8');
    fs.renameSync(tmp, FILE);
  } catch (err) {
    console.warn(`[cooldownLogMarker] persist failed: ${err.message}`);
  }
}

/**
 * @param {string} userId
 * @param {string} lastSharedAt — the cooldown window key (ISO timestamp)
 * @returns {boolean} true if this skip should be logged (first time for this
 *   window), false if it was already logged.
 */
function shouldLogCooldownSkip(userId, lastSharedAt) {
  if (!userId) return true; // can't track → don't suppress (log it)
  const map = ensureLoaded();
  const key = String(userId);
  const val = lastSharedAt ? String(lastSharedAt) : '';
  if (map[key] === val) return false; // already logged this cooldown window
  map[key] = val;
  persist(map);
  return true;
}

module.exports = { shouldLogCooldownSkip };
