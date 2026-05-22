/**
 * Run a task file without needing the server.
 *
 * Usage:
 *   node run-task.js [task-file]
 *
 * Defaults to tasks.json.
 */

const fs = require('fs');
const path = require('path');
const { runTask } = require('./runner');
const { initRunLogDir } = require('./utils/runLogDir');

// Crash diagnostics — modern Node (15+) kills the process on unhandled
// rejections by default. If that happens inside a patched console.log path,
// the underlying error can get swallowed and the process just exits. These
// handlers force the actual cause to be printed before exit.
process.on('unhandledRejection', (reason) => {
  console.error('\n!!! UNHANDLED REJECTION — bot is about to die:');
  console.error(reason && reason.stack ? reason.stack : reason);
});
process.on('uncaughtException', (err) => {
  console.error('\n!!! UNCAUGHT EXCEPTION — bot is about to die:');
  console.error(err && err.stack ? err.stack : err);
});

// Signal handlers — Windows console delivers SIGINT (Ctrl+C), SIGBREAK
// (Ctrl+Break / window close), SIGTERM (taskkill), SIGHUP (RDP drop) when
// something external kills the process. Without these, the bot would exit
// silently with no clue why. We log the signal, then re-raise the default
// behavior so the process actually terminates (otherwise Ctrl+C is ignored).
for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP']) {
  process.on(sig, () => {
    console.error(`\n!!! Received ${sig} — bot is being killed by the OS/terminal.`);
    // Default-exit so the process actually dies. 130 = 128 + 2 (SIGINT).
    process.exit(sig === 'SIGINT' ? 130 : 143);
  });
}

// beforeExit fires when the event loop has no more work scheduled. If the
// bot is mid-task and this fires, it means every pending await was dropped —
// usually a sign that something silently rejected a promise or the worker
// pool drained because the queue emptied. Either way: knowing this fired
// (vs. an external kill signal) narrows the diagnosis.
process.on('beforeExit', (code) => {
  console.error(`\n!!! beforeExit (code ${code}) — event loop drained, Node about to exit cleanly.`);
});

process.on('exit', (code) => {
  console.error(`\n!!! process.exit(${code}) — final termination.`);
});

// Heartbeat — prints once every 30s with elapsed time and the count of
// active handles still keeping the loop alive. If the bot dies "out of
// nowhere," the last heartbeat timestamp tells us exactly when Node was
// still healthy. Unref'd so the heartbeat alone can never block exit.
const HEARTBEAT_MS = 30000;
const startedAt = Date.now();
function formatElapsed(ms) {
  const sec = Math.floor(ms / 1000);
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}m ${s}s`;
}
const hb = setInterval(() => {
  const handles = process._getActiveHandles ? process._getActiveHandles().length : '?';
  const requests = process._getActiveRequests ? process._getActiveRequests().length : '?';
  const m = process.memoryUsage();
  const mb = (n) => Math.round(n / 1024 / 1024);
  console.log(
    `[heartbeat] alive ${formatElapsed(Date.now() - startedAt)} | handles=${handles} requests=${requests} | rss=${mb(m.rss)}MB heap=${mb(m.heapUsed)}/${mb(m.heapTotal)}MB ext=${mb(m.external)}MB`
  );
}, HEARTBEAT_MS);
hb.unref();

function loadTask(fileArg) {
  const taskFile = path.resolve(process.cwd(), fileArg || 'tasks.json');
  if (!fs.existsSync(taskFile)) {
    throw new Error(
      `Task file not found: ${taskFile}\nPass a task file, for example: node run-task.js task-warmup-full.json`
    );
  }

  try {
    return JSON.parse(fs.readFileSync(taskFile, 'utf8'));
  } catch (err) {
    throw new Error(`Failed to read task file ${taskFile}: ${err.message}`);
  }
}

/**
 * Tee stdout + stderr to `tasks-logs.log` inside the run-scoped folder.
 * Wraps the raw process stream writers so it captures EVERYTHING: the
 * top-level banners, heartbeats, the final Result JSON, AND every per-profile
 * line that flows through the sessionLog console patch (which still calls
 * the original console methods → process.stdout.write under the hood).
 *
 * **Writes must be synchronous.** An async fs.createWriteStream queues work
 * on the event loop, which prevents Node from exiting after the final
 * Result print — and worse, it makes `beforeExit` fire on every drain. The
 * beforeExit handler writes a diagnostic line via console.error, which
 * queues another async write, which drains, which fires beforeExit, which
 * writes, ad infinitum (1.6M lines in seconds the first time). fs.writeSync
 * adds no event-loop work, so beforeExit fires exactly once and the final
 * bytes (`!!! process.exit`) are guaranteed flushed before the process dies.
 *
 * Per-profile session.log files are still written separately by sessionLog,
 * so the top-level file is a complete superset transcript while per-profile
 * files give you the filtered view.
 */
function teeStdoutToFile(filePath) {
  let fd = null;
  try {
    fd = fs.openSync(filePath, 'a');
  } catch (_) {
    return; // file unwritable — skip tee, original stdout/stderr untouched
  }

  const wrap = (origWrite) => {
    return function (chunk, encoding, cb) {
      try {
        const buf = Buffer.isBuffer(chunk)
          ? chunk
          : Buffer.from(String(chunk), typeof encoding === 'string' ? encoding : 'utf8');
        fs.writeSync(fd, buf);
      } catch (_) {}
      return origWrite.call(this, chunk, encoding, cb);
    };
  };

  process.stdout.write = wrap(process.stdout.write);
  process.stderr.write = wrap(process.stderr.write);
}

async function main() {
  let task;
  try {
    task = loadTask(process.argv[2]);
  } catch (err) {
    console.error('Task failed:', err.message);
    process.exitCode = 1;
    return;
  }

  // Initialize the run-scoped log dir BEFORE anything else logs — this way
  // even the "=== Task ... ===" banner and the resolved-paths line from
  // runner.js end up in tasks-logs.log. runTask's own initRunLogDir call is
  // memoized and will return the same dir.
  const runLogDir = initRunLogDir(task.taskId);
  teeStdoutToFile(path.join(runLogDir, 'tasks-logs.log'));
  console.log(`Top-level log: ${path.join(runLogDir, 'tasks-logs.log')}`);

  try {
    const result = await runTask(task);
    console.log('\nResult:', JSON.stringify(result, null, 2));
  } catch (err) {
    console.error('Task failed:', err.message);
    process.exitCode = 1;
  }
}

main();
