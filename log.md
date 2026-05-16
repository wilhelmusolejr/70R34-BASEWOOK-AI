# L0r3a bot → Profile Vault Logs integration

This document is for whoever is implementing the bot side (`run-task.js`). It tells you exactly what HTTP calls the bot must make so the **Logs** page in Profile Vault shows live activity.

## Mental model

```
  [your bot: run-task.js]  ── POST ──►  [profile-vault server]  ── WebSocket ──►  [Logs page in browser]
```

The bot is the **source of truth** for what's happening. The vault server is a thin in-memory relay: it stores the latest snapshot and fans events out to any connected browser via WebSocket. **The bot does not speak WebSocket** — it just POSTs JSON to the endpoints below.

## Base URL

```
VAULT_URL  =  http://localhost:4000   # dev default; set via env var in prod
```

All endpoints below are `POST`, `Content-Type: application/json`, and return `{ ok: true }` on success. Errors are 400 with `{ message }`.

## The four endpoints

### 1. `POST /api/logs/task` — start of a run

Call **once** when `run-task.js` reads `tasks.json` and is about to begin. Calling it again resets the dashboard state (cleared browsers, cleared processed list).

Request body:

```jsonc
{
  "taskId": "homepage-then-connect-loop",   // string, freeform — shown as the task title
  "concurrency": 3,                          // number of parallel browsers
  "blockMedia": true,                        // boolean, informational only
  "startedAt": 1715800000000,                // unix ms; optional, defaults to server now
  "profiles": [                              // every profileId in this run (used for "12 / 47" math)
    "69e22287bb8fecced7bfda54",
    "69e22e3dbb8fecced7bfdaa0"
  ],
  "steps": [                                 // ordered step plan, shown as chips
    { "type": "homepage_interaction" },
    { "type": "accept_loop" },
    { "type": "wait" },
    { "type": "connect_loop" }
  ]
}
```

### 2. `POST /api/logs/browser` — per-worker update

Call this **every time a browser does something worth showing**: it came online, started a step, logged a line, hit a captcha, errored, etc. The server **appends** the `logs[]` array to whatever it already has for that `browserId` — so only send the *new* lines.

Request body:

```jsonc
{
  "browserId": "hidemium-1",                 // REQUIRED. Stable id for this worker slot
  "profileId": "69f488af93738d563ce21fee",   // current profile in this slot
  "profileName": "Jane Doe",                 // display name for the UI
  "online": true,                            // false = grayed-out status dot
  "currentStepPath": "homepage_interaction › like_posts",
  "logs": [                                  // NEW lines only — do not resend history
    { "ts": "14:02:11", "level": "info",  "msg": "browser:online" },
    { "ts": "14:02:14", "level": "warn",  "msg": "Captcha appeared, solving…" },
    { "ts": "14:02:18", "level": "error", "msg": "Proxy timeout" }
  ]
}
```

Field rules:
- `browserId` is required; everything else is optional and partial-merged into the existing record.
- `level` must be `"info"`, `"warn"`, or `"error"` (anything else becomes `"info"`).
- `ts` is a freeform display string (we use `HH:MM:SS`). If omitted, the server stamps one.
- `msg` must be a non-empty string. Empty/invalid log entries are silently dropped.
- Server keeps the last **500 log lines** per browser. Older lines are evicted.

### 3. `POST /api/logs/processed` — profile finished

Call this when a profile fully finishes (success or terminal failure — it's just "done").

Request body:

```jsonc
{ "profileId": "69f488af93738d563ce21fee" }
```

This is what drives the `12 / 47` counter and the progress bar.

### 4. `POST /api/logs/reset` — wipe the dashboard

Optional. Clears the active task, processed list, and all browsers. Useful between manual test runs. No body needed.

## Ending a profile = two calls

When a profile run terminates (success or terminal failure), the bot sends **both**:

1. A final `POST /api/logs/browser` with `online: false` — so the UI's status dot turns gray and the worker stops looking active.
2. A `POST /api/logs/processed` with that `profileId` — so the counter and progress bar advance.

```jsonc
// (a) — final browser update
POST /api/logs/browser
{
  "browserId": "hidemium-1",
  "currentStepPath": "done",
  "online": false,
  "logs": [
    { "level": "info", "msg": "profile complete" },
    { "level": "info", "msg": "browser:offline" }
  ]
}

// (b) — mark profile processed
POST /api/logs/processed
{ "profileId": "69fd72f01e49eec688fd0552" }
```

If the worker then picks up a **new** profile in the same slot, just send `/browser` again with the new `profileId` / `profileName` and `online: true`. The server will reset the displayed step but the log buffer for that `browserId` persists (capped at 500 lines).

## Full sequenced walkthrough

What a single profile run looks like end-to-end on the wire:

```jsonc
// 1. Task starts (once, at the top of run-task.js)
POST /api/logs/task
{
  "taskId": "setup-engage-share-connect",
  "concurrency": 3,
  "blockMedia": true,
  "profiles": ["69fd...02ff", "69fd...045f", "69fd...0552"],
  "steps": [
    { "type": "facebook_signup" },
    { "type": "wait" },
    { "type": "visit_profile" }
  ]
}

// 2. Worker comes online — first call carries full state
POST /api/logs/browser
{
  "browserId": "hidemium-1",
  "profileId": "69fd72f01e49eec688fd0552",
  "profileName": "Lia Park",
  "online": true,
  "currentStepPath": "facebook_signup",
  "logs": [
    { "level": "info", "msg": "browser:online" },
    { "level": "info", "msg": "step:facebook_signup start" }
  ]
}

// 3. Progress — only browserId + what changed
POST /api/logs/browser
{
  "browserId": "hidemium-1",
  "currentStepPath": "visit_profile -> like_posts",
  "logs": [
    { "level": "info", "msg": "step:visit_profile start (pool=sharers)" },
    { "level": "info", "msg": "like_posts -> liked 1 of 2" }
  ]
}

// 4. Something goes wrong mid-run — just send the new lines
POST /api/logs/browser
{
  "browserId": "hidemium-1",
  "logs": [
    { "level": "warn",  "msg": "Captcha appeared, solving..." },
    { "level": "error", "msg": "Proxy timeout (1 retry)" },
    { "level": "info",  "msg": "Reconnected via fallback" }
  ]
}

// 5. Profile finishes — see "Ending a profile" above
POST /api/logs/browser   // online: false
POST /api/logs/processed // { profileId }
```

After step 5, `hidemium-1` is free. Either send a new `/browser` with the next `profileId` (slot reused), or just leave it offline if the run is over.

## A drop-in helper

Save this as `vault-log.js` next to `run-task.js`:

```js
const VAULT = process.env.VAULT_URL || "http://localhost:4000";

async function post(path, body) {
  try {
    await fetch(`${VAULT}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    // Never crash the bot if the dashboard is down.
  }
}

const ts = () => new Date().toTimeString().slice(0, 8);

function normalizeLine(line) {
  if (typeof line === "string") return { ts: ts(), level: "info", msg: line };
  return { ts: ts(), level: "info", ...line };
}

export const vaultLog = {
  task: (t) => post("/api/logs/task", { startedAt: Date.now(), ...t }),
  browser: (state, lines = []) =>
    post("/api/logs/browser", { ...state, logs: lines.map(normalizeLine) }),
  done: (profileId) => post("/api/logs/processed", { profileId }),
  reset: () => post("/api/logs/reset", {}),
};
```

## Wiring it into `run-task.js`

```js
import fs from "node:fs";
import { vaultLog } from "./vault-log.js";

const task = JSON.parse(fs.readFileSync("tasks.json", "utf8"));

// 1. Tell the dashboard a run is starting.
await vaultLog.task({
  taskId: task.taskId,
  concurrency: task.concurrency,
  blockMedia: task.blockMedia ?? true,
  profiles: task.profileIds,
  steps: task.steps,
});

// 2. Inside each worker, after meaningful events:
await vaultLog.browser(
  {
    browserId: "hidemium-1",
    profileId,
    profileName,
    online: true,
    currentStepPath: "homepage_interaction › like_posts",
  },
  [
    "Login successful",
    { level: "warn", msg: "Captcha appeared, solving…" },
  ],
);

// 3. When the profile is done:
await vaultLog.done(profileId);
```

### When to call `browser` (rule of thumb)

- Worker startup / shutdown (`online: true` / `online: false`).
- At the start of each step — update `currentStepPath`.
- On every notable sub-action (like, comment, scroll batch, etc.) — one log line is fine.
- On any error or retry — `level: "error"` or `"warn"`.
- **Don't** spam one call per millisecond. Batch sub-step events into a single call with multiple `logs[]` entries when they happen within ~500ms of each other.

## Smoke test (no bot needed)

After `cd server; npm run dev` and `npm run dev` for the frontend, open the Logs page (should say "● connected, Waiting for bot…"), then in PowerShell:

```powershell
$task = @{
  taskId = "smoke"
  concurrency = 2
  profiles = @("a","b","c")
  steps = @(@{type="login"}, @{type="like_posts"})
} | ConvertTo-Json -Depth 5
Invoke-RestMethod http://localhost:4000/api/logs/task -Method Post -ContentType "application/json" -Body $task

$browser = @{
  browserId = "hidemium-1"
  profileId = "a"
  profileName = "Test"
  online = $true
  currentStepPath = "login"
  logs = @(@{ts="14:00:00"; level="info"; msg="hello from curl"})
} | ConvertTo-Json -Depth 5
Invoke-RestMethod http://localhost:4000/api/logs/browser -Method Post -ContentType "application/json" -Body $browser

Invoke-RestMethod http://localhost:4000/api/logs/processed -Method Post -ContentType "application/json" -Body (@{profileId="a"} | ConvertTo-Json)
```

You should see the task panel, a `hidemium-1` column, and the `1 / 3` counter tick.

## Notes & gotchas

- **State is in-memory only.** If the vault server restarts, all log state is gone. Connected clients reconnect automatically and receive an empty snapshot.
- **Late-joining browsers hydrate instantly.** When the page loads (or refreshes), the server sends a `snapshot` event with everything it currently holds. The bot does not need to "replay" anything.
- **Cross-origin.** The vault server enables CORS for all origins (`cors()` in `server/src/app.js`), so the bot can be on any host.
- **Auth.** None right now. If you put the vault behind a real auth layer later, the bot will need to send the same credentials.
- **No retries / no queue.** The helper above swallows network errors silently. If the vault is down, those events are lost — that's intentional, the bot must never block on the dashboard.
