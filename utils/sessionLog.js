/**
 * Per-profile logging: tags console output with the user's display name and
 * tees every line to logs/{name}-{date}.log. Uses AsyncLocalStorage so any
 * console.log triggered within a profile's lifecycle (runBrowser, action
 * handlers, etc.) is automatically routed to that profile's log file.
 */

const fs = require('fs');
const path = require('path');
const { AsyncLocalStorage } = require('async_hooks');
const { inspect } = require('util');

const LOGS_DIR = path.join(process.cwd(), 'logs');
const als = new AsyncLocalStorage();

function ensureLogsDir() {
  try {
    fs.mkdirSync(LOGS_DIR, { recursive: true });
  } catch (_) {}
}

function sanitize(name) {
  return String(name || 'unknown')
    .replace(/[\\/:*?"<>|]/g, '_')
    .trim() || 'unknown';
}

function logFilePath(displayName) {
  ensureLogsDir();
  const day = new Date().toISOString().slice(0, 10);
  return path.join(LOGS_DIR, `${sanitize(displayName)}-${day}.log`);
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
 * to the per-profile log file. `idsToStrip` lets the wrapper drop legacy
 * `[uuid]` prefixes already baked into log strings.
 */
function runInSession({ displayName, idsToStrip = [] }, fn) {
  patchConsole();
  const logPath = logFilePath(displayName);
  const ts = new Date().toISOString();
  appendLine(logPath, `\n=== Session start ${ts} (${displayName}) ===`);
  return als.run({ displayName, logPath, idsToStrip }, fn);
}

/**
 * Add another id (e.g. the browser profileId once the browser opens) to the
 * list of prefixes the wrapper strips before re-tagging. No-op outside a session.
 */
function addStripId(id) {
  const ctx = als.getStore();
  if (ctx && id && !ctx.idsToStrip.includes(id)) ctx.idsToStrip.push(id);
}

module.exports = { runInSession, addStripId, buildDisplayName, logFilePath };
