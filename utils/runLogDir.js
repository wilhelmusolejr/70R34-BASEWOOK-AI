/**
 * Run-scoped log directory.
 *
 * Each invocation of `runTask` (or `run-task.js`) gets its own folder under
 * logs/, named `{taskId}-{YYYYMMDD-HHmmss}`. Top-level run output + every
 * profile's session log + any failure dumps for that run all live under one
 * roof:
 *
 *   logs/
 *     engage-and-add-20260517-143022/
 *       tasks-logs.log
 *       profiles/
 *         Janet Sullivan-69fae777/
 *           session.log
 *           outlook-error-2026-05-17T14-31-08-455Z.html
 *           outlook-error-2026-05-17T14-31-08-455Z.png
 *
 * Memoized per process so run-task.js (top-level stdout tee) and runner.js
 * (per-profile dirs) resolve to the same root without coordination.
 */

const fs = require('fs');
const path = require('path');

let currentRunDir = null;

function timestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return (
    d.getFullYear().toString() +
    pad(d.getMonth() + 1) +
    pad(d.getDate()) +
    '-' +
    pad(d.getHours()) +
    pad(d.getMinutes()) +
    pad(d.getSeconds())
  );
}

function sanitize(s) {
  return (
    String(s || 'run')
      .replace(/[\\/:*?"<>|]/g, '_')
      .trim() || 'run'
  );
}

/**
 * Create + memoize the run dir for this process. Subsequent calls return the
 * same path (taskId arg ignored on the second call). Caller passes the
 * taskId from the task JSON.
 */
function initRunLogDir(taskId) {
  if (currentRunDir) return currentRunDir;
  const dir = path.join(
    process.cwd(),
    'logs',
    `${sanitize(taskId)}-${timestamp()}`
  );
  fs.mkdirSync(path.join(dir, 'profiles'), { recursive: true });
  currentRunDir = dir;
  return dir;
}

function getRunLogDir() {
  return currentRunDir;
}

/**
 * Resolve + create the per-profile folder inside the run dir. `folderName`
 * must already be unique within the run (use buildProfileFolderName in
 * sessionLog.js, which appends a short user-id suffix to the display name).
 *
 * Returns null when the run dir hasn't been initialized — caller should fall
 * back to its legacy behavior in that case.
 */
function ensureProfileLogDir(folderName) {
  if (!currentRunDir) return null;
  const dir = path.join(currentRunDir, 'profiles', sanitize(folderName));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

module.exports = { initRunLogDir, getRunLogDir, ensureProfileLogDir };
