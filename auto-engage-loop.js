/**
 * auto-engage-loop.js — self-running scheduler for the daily-engage task.
 *
 * Replaces running `node run-task.js task-daily-engage.json` by hand every day.
 * Every AUTO_LOOP_INTERVAL_MS (default 10 min) it checks whether a batch is
 * already running; if not, it launches the engage task against
 * `profilesFromStatus: "Active"` with a `shareHours` cooldown gate.
 *
 *   node auto-engage-loop.js
 *
 * "Ready for share" is decided by the runner's cooldown gate: it skips any
 * profile whose `onboarding.lastSharedAt` is < shareHours old (missing = ready),
 * BEFORE opening a browser — so each batch only works the profiles that have
 * aged past the threshold. Up to `concurrency` run at once (FIFO worker pool);
 * as each finishes the next ready profile starts. When the whole batch drains,
 * the next tick re-checks and launches the next batch automatically — so the
 * cooldown-expired profiles get picked up on their own, no manual tracking.
 *
 * Env (all optional):
 *   AUTO_LOOP_INTERVAL_MS   poll interval ms          (default 600000 = 10 min)
 *   AUTO_LOOP_SHARE_HOURS   cooldown threshold hours  (default 24)
 *   AUTO_LOOP_CONCURRENCY   max profiles at once      (default: task file value)
 *   AUTO_LOOP_TASK_ID       taskId for state/logs      (default "auto-engage")
 *
 * Steps come from task-daily-engage.json so the loop stays in sync with the
 * manual task. But the profile source (Active), cooldown, and concurrency are
 * FORCED here — the task file's `cooldown` is 0 (disabled) and its `profiles[]`
 * holds a single test id that would otherwise win over profilesFromStatus.
 *
 * Run from a NON-VS-Code terminal for long uptime (CLAUDE.md silent-death note).
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { runTask } = require('./runner');
const baseTask = require('./task-daily-engage.json');

const INTERVAL_MS = Number(process.env.AUTO_LOOP_INTERVAL_MS) || 10 * 60 * 1000;
const SHARE_HOURS = Number(process.env.AUTO_LOOP_SHARE_HOURS) || 24;
const CONCURRENCY = Number(process.env.AUTO_LOOP_CONCURRENCY) || baseTask.concurrency || 10;
const TASK_ID = process.env.AUTO_LOOP_TASK_ID || 'auto-engage';

// ── Loop-level log ─────────────────────────────────────────────────────────
// Only the loop's own events (ticks / launches / batch summaries / heartbeat)
// go here — the detailed per-profile logs still live in each batch's own
// logs/{taskId}-{ts}/ folder. appendFileSync (not a stream) so it can never
// hold the event loop open or trip the beforeExit feedback loop.
const LOG_DIR = path.join(process.cwd(), 'logs');
const LOOP_LOG = path.join(LOG_DIR, 'auto-loop.log');
try {
  if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
} catch (_) {}

function loopLog(msg, isErr = false) {
  const line = `${new Date().toISOString()} [auto-loop] ${msg}`;
  (isErr ? console.error : console.log)(line);
  try {
    fs.appendFileSync(LOOP_LOG, line + '\n');
  } catch (_) {}
}

// ── Crash diagnostics — keep the loop ALIVE through stray errors ────────────
// A 24/7 babysitter should survive an unexpected rejection in one batch rather
// than die silently. Batch errors are already caught in tick(); these handlers
// catch anything that escapes and log it WITHOUT exiting (having the handler
// also suppresses Node's default crash-on-unhandledRejection).
process.on('unhandledRejection', (reason) => {
  loopLog(`!!! UNHANDLED REJECTION (loop survives): ${(reason && reason.stack) || reason}`, true);
});
process.on('uncaughtException', (err) => {
  loopLog(`!!! UNCAUGHT EXCEPTION (loop survives): ${(err && err.stack) || err}`, true);
});

const startedAt = Date.now();
function fmtElapsed(ms) {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

let running = false;
let tickCount = 0;
let batchCount = 0;

async function tick() {
  tickCount += 1;

  if (running) {
    loopLog(`tick #${tickCount} — batch still running, skipping.`);
    return;
  }

  running = true;
  batchCount += 1;
  const batchNo = batchCount;
  try {
    const task = {
      taskId: TASK_ID,
      profilesFromStatus: 'Active', // force API source (ignore task file's profiles[])
      concurrency: CONCURRENCY,
      blockMedia: baseTask.blockMedia !== false,
      cooldown: { shareHours: SHARE_HOURS }, // force the gate (task file has 0)
      steps: baseTask.steps,
    };

    loopLog(
      `tick #${tickCount} — launching batch #${batchNo} (status=Active, shareHours=${SHARE_HOURS}, concurrency=${CONCURRENCY})`
    );

    const res = await runTask(task);

    const r = (res && res.results) || [];
    const success = r.filter((x) => x.status === 'success').length;
    const skipped = r.filter((x) => x.status === 'skipped').length;
    const errored = r.filter((x) => x.status === 'error').length;
    loopLog(
      `batch #${batchNo} done — ${r.length} Active: ${success} ran, ${skipped} cooled-down, ${errored} failed.`
    );
  } catch (err) {
    loopLog(`batch #${batchNo} errored: ${(err && err.stack) || err}`, true);
  } finally {
    running = false;
  }
}

// Heartbeat so a silent death is diagnosable — last line tells you when the
// loop was still alive. Unref'd so it can never block exit.
const hb = setInterval(() => {
  const m = process.memoryUsage();
  loopLog(
    `[heartbeat] alive ${fmtElapsed(Date.now() - startedAt)} | running=${running} | batches=${batchCount} | rss=${Math.round(m.rss / 1048576)}MB`
  );
}, 60000);
hb.unref();

loopLog(
  `starting — poll every ${(INTERVAL_MS / 60000).toFixed(1)} min, status=Active, ${SHARE_HOURS}h cooldown, concurrency=${CONCURRENCY}, taskId="${TASK_ID}". Loop log: ${LOOP_LOG}`
);
loopLog(`tip: run from a non-VS-Code terminal for long uptime (CLAUDE.md silent-death note).`);

tick(); // run immediately, then on the interval
const timer = setInterval(tick, INTERVAL_MS);

for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP']) {
  process.on(sig, () => {
    loopLog(`${sig} received — stopping scheduler (running=${running}).`, true);
    clearInterval(timer);
    process.exit(0);
  });
}
