/**
 * Per-task resumable state.
 *
 * Persists "which profiles in this task have been processed" to
 * `state/{taskId}.json` so that if the process dies mid-batch (hypervisor
 * kill, OOM, Ctrl+C, native crash, anything), restarting the bot picks up
 * where it left off instead of re-running every profile from scratch.
 *
 * Lifecycle:
 *   runTask start  → loadState(taskId, profileIds)
 *                    ├─ hash matches → return completed map, queue skips those
 *                    └─ hash differs / no file → return empty, start fresh
 *   per profile    → state.completed[userId] = {status, completedAt, elapsedSec, error?}
 *                    saveState(...)  (sync write — survives hard kill)
 *   task end       → if all userIds in state.completed → clearState()
 *                    (so tomorrow's run starts fresh; a mid-day restart resumes)
 *
 * The hash check protects against stale state when the task's profile list
 * is edited — adding/removing a profile invalidates the previous run's state
 * and the next run starts from scratch.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const STATE_DIR = path.join(process.cwd(), 'state');

function computeProfilesHash(profileIds) {
  const sorted = [...profileIds].sort().join(',');
  return crypto.createHash('sha1').update(sorted).digest('hex');
}

function stateFilePath(taskId) {
  return path.join(STATE_DIR, `${taskId}.json`);
}

/**
 * Load completed-profile map for this taskId. Returns `{ completed, startedAt }`.
 *
 * - File missing  → `{ completed: {}, startedAt: null }`
 * - Hash mismatch → log + return empty (task config changed)
 * - Parse error   → log + return empty (corrupted state)
 */
function loadState(taskId, profileIds) {
  const file = stateFilePath(taskId);
  if (!fs.existsSync(file)) {
    return { completed: {}, startedAt: null };
  }
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    const expectedHash = computeProfilesHash(profileIds);
    if (data.profilesHash !== expectedHash) {
      console.warn(
        `[taskState] ${taskId} state hash mismatch — profile list changed, starting fresh`
      );
      return { completed: {}, startedAt: null };
    }
    const completed = data.completed || {};
    const count = Object.keys(completed).length;
    if (count > 0) {
      console.log(
        `[taskState] Resuming ${taskId}: ${count}/${profileIds.length} profile(s) already completed`
      );
    }
    return { completed, startedAt: data.startedAt || null };
  } catch (err) {
    console.warn(`[taskState] ${taskId} state file unreadable (${err.message}) — starting fresh`);
    return { completed: {}, startedAt: null };
  }
}

/**
 * Persist current in-memory state to disk. Synchronous so the write actually
 * lands before a possible hard kill (no event-loop scheduling).
 */
function saveState(taskId, profileIds, state) {
  try {
    if (!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR, { recursive: true });
    const file = stateFilePath(taskId);
    const tmp = `${file}.tmp`;
    const payload = JSON.stringify(
      {
        taskId,
        profilesHash: computeProfilesHash(profileIds),
        startedAt: state.startedAt || new Date().toISOString(),
        lastUpdatedAt: new Date().toISOString(),
        completed: state.completed,
      },
      null,
      2
    );
    fs.writeFileSync(tmp, payload, 'utf8');
    fs.renameSync(tmp, file);
  } catch (err) {
    console.warn(`[taskState] saveState failed: ${err.message}`);
  }
}

/**
 * Delete the state file for this task. Called automatically when all
 * profiles in the task have been processed (so the next manual run starts
 * clean), and exposed for the `--fresh` CLI flag.
 */
function clearState(taskId) {
  const file = stateFilePath(taskId);
  try {
    if (fs.existsSync(file)) {
      fs.unlinkSync(file);
      console.log(`[taskState] cleared state for ${taskId}`);
    }
  } catch (err) {
    console.warn(`[taskState] clearState failed: ${err.message}`);
  }
}

module.exports = { loadState, saveState, clearState };
