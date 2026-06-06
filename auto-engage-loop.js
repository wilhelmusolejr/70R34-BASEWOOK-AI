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
 * Config is DRIVEN BY task-daily-engage.json — steps, concurrency,
 * openStaggerSeconds, blockMedia, profilesFromStatus, and cooldown.shareHours
 * are all read from the file. Edit the file and restart the loop to change them.
 * Each env var below is an OPTIONAL override that wins over the file value.
 *
 * Env (all optional — override the task file):
 *   AUTO_LOOP_INTERVAL_MS   poll interval ms          (default 600000 = 10 min)
 *   AUTO_LOOP_SHARE_HOURS   cooldown threshold hours  (default: file cooldown.shareHours, else 24)
 *   AUTO_LOOP_CONCURRENCY   max profiles at once      (default: file concurrency, else 10)
 *   AUTO_LOOP_STAGGER_SECONDS  min seconds between browser opens
 *                                            (default: file openStaggerSeconds, else 0)
 *   AUTO_LOOP_STATUS        profile status to batch   (default: file profilesFromStatus, else "Active")
 *   AUTO_LOOP_TASK_ID       taskId for state/logs      (default "auto-engage")
 *
 * The one thing NOT taken from the file is `profiles[]` — the loop is a status
 * batch runner, so it always uses profilesFromStatus and ignores any explicit
 * profiles[] (which would otherwise win and pin the loop to a single test id).
 * taskId also defaults to "auto-engage" (not the file's) to keep the loop's
 * state/{taskId}.json + logs separate from manual run-task.js runs.
 *
 * NOTE: the file is require()d once at startup, so edits need a loop RESTART.
 *
 * Run from a NON-VS-Code terminal for long uptime (CLAUDE.md silent-death note).
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { runTask } = require('./runner');
const baseTask = require('./task-daily-engage.json');

const INTERVAL_MS = Number(process.env.AUTO_LOOP_INTERVAL_MS) || 10 * 60 * 1000;
// shareHours now READS the task file's cooldown.shareHours (env override wins).
// Edit `cooldown.shareHours` in task-daily-engage.json to change it for the loop.
const SHARE_HOURS =
  process.env.AUTO_LOOP_SHARE_HOURS !== undefined
    ? Number(process.env.AUTO_LOOP_SHARE_HOURS)
    : (baseTask.cooldown && baseTask.cooldown.shareHours) || 24;
const CONCURRENCY = Number(process.env.AUTO_LOOP_CONCURRENCY) || baseTask.concurrency || 10;
// Profile status batch source — reads the task file's profilesFromStatus (env
// override wins). The task file's `profiles[]` is still bypassed (a status batch
// runner, not a single-profile run), so an explicit profiles[] never leaks in.
const STATUS = process.env.AUTO_LOOP_STATUS || baseTask.profilesFromStatus || 'Active';
const TASK_ID = process.env.AUTO_LOOP_TASK_ID || 'auto-engage';
// Browser-open stagger. Carries over the task file's openStaggerSeconds so the
// loop spreads opens the same way the manual run-task.js path does (avoids the
// startup RAM/CPU spike + the fleet-timing signal of N browsers opening at once).
// Env override wins; `0`/unset in both → all `concurrency` browsers open at once.
const STAGGER_SECONDS =
  process.env.AUTO_LOOP_STAGGER_SECONDS !== undefined
    ? Number(process.env.AUTO_LOOP_STAGGER_SECONDS)
    : baseTask.openStaggerSeconds || 0;

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
      profilesFromStatus: STATUS, // from task file (env override wins); profiles[] bypassed
      concurrency: CONCURRENCY,
      openStaggerSeconds: STAGGER_SECONDS, // spread browser opens (≥ N seconds apart)
      blockMedia: baseTask.blockMedia !== false,
      cooldown: { shareHours: SHARE_HOURS }, // from task file's cooldown.shareHours (env override wins)
      steps: baseTask.steps,
    };

    loopLog(
      `tick #${tickCount} — launching batch #${batchNo} (status=${STATUS}, shareHours=${SHARE_HOURS}, concurrency=${CONCURRENCY}, stagger=${STAGGER_SECONDS}s)`
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
  `starting — poll every ${(INTERVAL_MS / 60000).toFixed(1)} min, status=${STATUS}, ${SHARE_HOURS}h cooldown, concurrency=${CONCURRENCY}, stagger=${STAGGER_SECONDS}s, taskId="${TASK_ID}". Loop log: ${LOOP_LOG}`
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
