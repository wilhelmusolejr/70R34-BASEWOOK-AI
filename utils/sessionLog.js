/**
 * Per-profile logging: tags console output with the user's display name and
 * tees every line to the profile's session.log inside the run-scoped log
 * directory.
 *
 * When the run dir has been initialized (via utils/runLogDir.js), each
 * profile gets its own folder:
 *
 *   logs/{taskId}-{ts}/profiles/{DisplayName}-{shortId}/session.log
 *
 * If the run dir hasn't been initialized (legacy entry points / unit tests),
 * we fall back to the flat layout: logs/{DisplayName}-{date}.log.
 *
 * Uses AsyncLocalStorage so any console.log triggered within a profile's
 * lifecycle (runBrowser, action handlers, etc.) is automatically routed to
 * that profile's log file. The profile folder path is also exposed on the
 * ALS context so dumpFailure helpers can write HTML/PNG dumps alongside.
 */

const fs = require('fs');
const path = require('path');
const { AsyncLocalStorage } = require('async_hooks');
const { inspect } = require('util');
const { vaultLog } = require('../vault-log');
const { ensureProfileLogDir } = require('./runLogDir');

const LEGACY_LOGS_DIR = path.join(process.cwd(), 'logs');
const als = new AsyncLocalStorage();

function ensureLegacyLogsDir() {
  try {
    fs.mkdirSync(LEGACY_LOGS_DIR, { recursive: true });
  } catch (_) {}
}

function sanitize(name) {
  return (
    String(name || 'unknown')
      .replace(/[\\/:*?"<>|]/g, '_')
      .trim() || 'unknown'
  );
}

/**
 * Build a folder name unique within the run by appending a short userId
 * suffix to the display name (`Janet Sullivan-69fae777`). When displayName
 * already equals the userId (no firstName/lastName on the user record), the
 * suffix is skipped to avoid `69fae777...-69fae777` duplication.
 */
function buildProfileFolderName(displayName, userId) {
  const safeDisplay = sanitize(displayName);
  if (!userId) return safeDisplay;
  const shortId = String(userId).slice(0, 8);
  if (safeDisplay === sanitize(userId)) return safeDisplay;
  return `${safeDisplay}-${shortId}`;
}

/**
 * Resolve the path for a profile's session log. When the run dir is
 * initialized, returns `{runDir}/profiles/{folderName}/session.log` plus
 * the folder path. Falls back to the flat layout when not.
 */
function resolveSessionLogPaths(displayName, userId) {
  const folderName = buildProfileFolderName(displayName, userId);
  const profileDir = ensureProfileLogDir(folderName);
  if (profileDir) {
    return { logPath: path.join(profileDir, 'session.log'), profileDir };
  }
  ensureLegacyLogsDir();
  const day = new Date().toISOString().slice(0, 10);
  return {
    logPath: path.join(LEGACY_LOGS_DIR, `${sanitize(displayName)}-${day}.log`),
    profileDir: null,
  };
}

function formatArg(a) {
  if (typeof a === 'string') return a;
  if (a instanceof Error) return a.stack || a.message;
  try {
    return inspect(a, { depth: 4, breakLength: 120 });
  } catch (_) {
    return String(a);
  }
}

function appendLine(filePath, line) {
  try {
    fs.appendFileSync(filePath, line + '\n', 'utf8');
  } catch (_) {}
}

let patched = false;

function patchConsole() {
  if (patched) return;
  patched = true;

  const orig = {
    log: console.log.bind(console),
    info: console.info.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
  };

  function wrap(method) {
    return (...args) => {
      const ctx = als.getStore();
      if (!ctx) {
        orig[method](...args);
        return;
      }

      const prefix = `[${ctx.displayName}]`;
      let outArgs = args.slice();

      if (typeof outArgs[0] === 'string') {
        const idStrip = ctx.idsToStrip.find((id) => outArgs[0].startsWith(`[${id}]`));
        if (idStrip) outArgs[0] = outArgs[0].slice(idStrip.length + 2).trimStart();
        outArgs = [prefix, ...outArgs];
      } else {
        outArgs = [prefix, ...outArgs];
      }

      orig[method](...outArgs);

      const ts = new Date().toISOString();
      const line = `${ts} [${method.toUpperCase()}] ${outArgs.slice(1).map(formatArg).join(' ')}`;
      appendLine(ctx.logPath, line);

      // Tee to the Profile Vault dashboard. Same content as the file log,
      // minus the [DisplayName] prefix. Fire-and-forget — vault-log swallows
      // all errors so this can never crash a session.
      if (ctx.browserId) {
        const level = method === 'warn' ? 'warn' : method === 'error' ? 'error' : 'info';
        const msg = outArgs.slice(1).map(formatArg).join(' ').trim();
        if (msg) vaultLog.browser({ browserId: ctx.browserId }, [{ level, msg }]);
      }
    };
  }

  console.log = wrap('log');
  console.info = wrap('info');
  console.warn = wrap('warn');
  console.error = wrap('error');
}

function buildDisplayName(user, fallback) {
  if (user) {
    const name = `${user.firstName || ''} ${user.lastName || ''}`.trim();
    if (name) return name;
  }
  return fallback || 'unknown';
}

/**
 * Run `fn` inside a session-scoped logging context.
 * All console output within `fn` is prefixed with [displayName] and appended
 * to the per-profile session.log inside the run-scoped folder. `idsToStrip`
 * lets the wrapper drop legacy `[uuid]` prefixes already baked into log
 * strings. `userId` is used to disambiguate the profile folder.
 */
function runInSession({ displayName, browserId, idsToStrip = [], userId }, fn) {
  patchConsole();
  const { logPath, profileDir } = resolveSessionLogPaths(displayName, userId);
  const ts = new Date().toISOString();
  appendLine(logPath, `\n=== Session start ${ts} (${displayName}) ===`);
  return als.run({ displayName, logPath, idsToStrip, browserId, profileDir }, fn);
}

/**
 * Add another id (e.g. the browser profileId once the browser opens) to the
 * list of prefixes the wrapper strips before re-tagging. No-op outside a session.
 */
function addStripId(id) {
  const ctx = als.getStore();
  if (ctx && id && !ctx.idsToStrip.includes(id)) ctx.idsToStrip.push(id);
}

/**
 * Return the current profile's log directory (the folder containing
 * session.log) when called inside a `runInSession` scope. Returns null
 * outside a session OR when the run dir wasn't initialized (legacy flat
 * layout — dumps fall back to logs/).
 */
function getProfileLogDir() {
  const ctx = als.getStore();
  return ctx ? ctx.profileDir || null : null;
}

module.exports = {
  runInSession,
  addStripId,
  buildDisplayName,
  buildProfileFolderName,
  getProfileLogDir,
};
