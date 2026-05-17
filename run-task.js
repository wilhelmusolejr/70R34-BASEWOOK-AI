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
  console.log(
    `[heartbeat] alive ${formatElapsed(Date.now() - startedAt)} | handles=${handles} requests=${requests}`
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

async function main() {
  try {
    const task = loadTask(process.argv[2]);
    const result = await runTask(task);
    console.log('\nResult:', JSON.stringify(result, null, 2));
  } catch (err) {
    console.error('Task failed:', err.message);
    process.exitCode = 1;
  }
}

main();
