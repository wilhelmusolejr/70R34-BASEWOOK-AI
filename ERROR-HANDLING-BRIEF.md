# BASEWOOK Automation Platform — Project & Error-Handling Brief

> Purpose of this document: hand it to another AI (or engineer) as a self-contained
> explanation of what the system does, **how it handles errors during a browser
> "simulation" (a profile run)**, and the **concrete flow of one real session**.
> The goal is to get an outside opinion on where the error handling can be improved.
> Real log excerpts from one profile are included at the end.

---

## 1. What the project is

A **Node.js + Express** backend that drives **Facebook automation across many
"anti-detect" browser profiles in parallel**. Each profile is a separate identity
(name, email, proxy, fingerprint) hosted in an anti-detect browser provider
(**Hidemium** or **Multilogin X**) and driven with **Playwright over CDP**.

- You `POST /execute` a JSON **task**. It returns `202` immediately and runs in the
  background. `GET /status/:taskId` checks progress.
- A task is a tree of **steps**. Steps are recursive: `{ type, params, steps:[…] }`.
  - **Navigators** change the page (`visit_profile`, `search`, `homepage_interaction`…).
  - **Leaves** act on the current page (`like_posts`, `share_posts`, `connect_loop`,
    `accept_loop`, `wait`, the `setup_*` actions, etc.).
- One profile = one browser session = what we informally call a **"simulation"**.
- Profiles run concurrently up to `concurrency`. Each gets its own log folder.

**Key files for error handling (the focus of this doc):**

| File | Role |
|------|------|
| `runner.js` | The execution engine. Owns retry, checkpoint detection, soft/abort failure classification, tracker logging, resumable state, the per-profile worker loop. |
| `utils/recoverers.js` | A registry of `(matches, apply)` recovery routines tried between retries (EU consent flows, soft checkpoints, "Not now" modals). |
| `utils/browserManager.js` | The only file aware of Hidemium/Multilogin. Profile open/close, auto-provisioning, proxy assignment, orphan-chromium reaper. |
| `utils/sessionLog.js` / `utils/runLogDir.js` | Per-profile `session.log` + per-run log directory. |
| `run-task.js` | Process-level crash diagnostics (signal handlers, heartbeat, unhandled-rejection banners). |

---

## 2. The error-handling model (the important part)

Errors are handled at **four nested layers**. Each layer has a different job.

### Layer 0 — Browser open failure (before any step runs)

In `runTask`'s worker, `launchBrowsers([userId])` is wrapped in try/catch. If the
profile can't even open (MLX/Hidemium API error, proxy provisioning failure, dead
profile), the worker records the profile as `error`, emits an offline vault-log
ping, and **moves to the next profile**. No steps run. The whole task is never
killed by one bad profile.

> Real example: a Multilogin auto-provision that failed on proxy setup —
> `PROXY_SETUP_FAILED` (HTTP 400). The profile is marked FAIL and the run continues.
> (See log excerpt B below.)

### Layer 1 — Per-step retry (`runWithRetry`)

Every handler call is wrapped:

```js
await runWithRetry(() => handler(page, params), profileId, stepType, page);
```

- **3 attempts max** (`STEP_RETRY_ATTEMPTS = 3`).
- On the **first throw** of each error, it dumps **HTML + full-page PNG** forensics
  to the profile folder (`fail-<step>-attempt<N>-<ts>.{html,png}`). `err.dumped`
  guards against double-dumping the same incident.
- Between attempts it calls the **recovery chain** (`tryRecover`, Layer 2) and then
  waits before retrying:
  - normal error → wait **60s** (`RETRY_WAIT_MS`)
  - recovery succeeded → wait shrinks to **2s**
  - recovery returns `'unfixable'` → **skip remaining retries**, soft-fail now
- Several **short-circuit conditions** opt out of retrying:
  - **Browser dead** — message matches `Target page, context or browser has been
    closed` → set `err.browserDead = true`, `err.noRetry = true`, break. (Retrying a
    dead CDP socket just burns 3×60s.)
  - **Checkpoint** — current URL contains `checkpoint`. First tries
    `tryDismissSoftCheckpoint`; if that fails it dumps state, sets `err.checkpoint`,
    `err.noRetry`, breaks.
  - **`err.noRetry`** — handlers with their own internal retries (e.g. `create_page`,
    which would create duplicate FB Pages on restart) set this.

### Layer 2 — Mid-step recovery (`utils/recoverers.js`)

Between retry attempts, `tryRecover(page, { stepType })` walks an ordered registry.
The first recoverer whose `matches(page)` is truthy runs its `apply(page)`. `apply`
returns one of three values:

| Return | Meaning | Runner reaction |
|--------|---------|-----------------|
| `true` | Page fixed | retry with 2s wait |
| `'unfixable'` | Known dead-end URL we can't resolve yet | skip remaining retries, soft-fail |
| `false` | Matched but couldn't fix this time | fall through, normal 60s retry |

Current recoverers (order matters — first match wins):

1. **`eu-cookie-consent`** — `/privacy/consent/?flow=user_cookie_choice_v2`; clicks
   "Allow all cookies".
2. **`ad-free-subscription`** — `flow=ad_free_subscription` EU pay-or-consent funnel;
   4-click sequence (Get started → "Use free of charge with ads" → Continue → Agree → OK).
3. **`data-settings-review`** — `flow=consent_next_3pd` GDPR funnel; 3-click sequence.
4. **`soft-checkpoint`** — `/checkpoint/` with a Dismiss button → dismiss; returns
   `false` on hard checkpoints (no Dismiss button).
5. **`not-now-modal`** — generic "Not now" upsell dismiss.

Matchers are deliberately **tight** (specific `flow=` query params, not loose
substrings) so the wrong fix never fires on the wrong page. Both `matches` and
`apply` swallow their own errors so a buggy recoverer can never break error
reporting. Reading delays (`humanWait`) are inserted before each click to avoid the
instant-click bot tell.

### Layer 3 — Per-step failure classification (`runBrowser`)

When a step's retry budget is exhausted and it still throws, `runBrowser` splits the
error into **abort** vs **soft**:

| Camp | Trigger | Behavior |
|------|---------|----------|
| **Abort** | `err.checkpoint` (FB flagged account) or `err.credentialsRejected` (bad login) or `err.browserDead` | Skip all remaining steps. For checkpoint/credentials, PATCH user `status: "Need Checking"`. Tracker-log header = `FAIL at <step>`. |
| **Soft** | any other exhausted error | Push to `softFailures[]`, **continue to the next top-level step.** |

This is the central design decision: **one failed step does not waste the rest of
the session.** A profile that fails `search` can still complete `connect_loop`,
`share_posts`, etc.

There are also **two extra checkpoint detection points** besides the in-retry one:
- **Pre-flight**: right after navigating to facebook.com, before any step. Catches
  accounts that opened already-flagged.
- **Post-step sweep**: after each successful step in `runStep`, re-reads the URL.
  Catches silent redirects to `/checkpoint/` that didn't throw.

### Layer 4 — Process-level crash diagnostics (`run-task.js`)

For "the bot vanished and left no clue" failures, `run-task.js` installs:
- Signal handlers (SIGINT/SIGTERM/SIGBREAK/SIGHUP) that print a banner + exit code.
- `beforeExit`, `unhandledRejection`, `uncaughtException` banners.
- A 30s heartbeat: `[heartbeat] alive Xm Ys | handles=N requests=M | rss=… heap=…`.

Known Windows gotcha documented in `CLAUDE.md`: the **VS Code integrated terminal
kills child processes via `TerminateProcess` (no signal)** on update/reload/sleep,
so none of the handlers fire and the log just cuts off mid-step. Long runs must use
a standalone PowerShell window or a watchdog.

### Cross-cutting: what gets recorded on failure

- **Forensic dumps** (`fail-*.html` + `.png`) — every step failure, on first throw,
  before recovery mutates the page.
- **Checkpoint dumps** (`checkpoint-{preflight|step-…|post-…}-*.{html,png}`).
- **Tracker log** POSTed once per session to `/api/profiles/:id/tracker`. Header is
  `SUCCESS` / `PARTIAL (N failed)` / `FAIL at <step>`, then a numbered list of
  completed step chains, then a `Failed steps:` block for soft failures.
- **Folder rename** — `{Name}-{shortId}` → `SUCCESS - … ` / `FAIL - …` so the
  `profiles/` listing shows outcomes at a glance.
- **Resumable state** (`state/{taskId}.json`) — per-profile completion map; a killed
  batch resumes instead of re-running everyone. Auto-cleared when all profiles done.
- **`summary.md`** per run with failures/skipped/successes.

### Timeouts

```js
page.setDefaultNavigationTimeout(90000); // 90s nav
page.setDefaultTimeout(60000);           // 60s default
```

---

## 3. Sample flow — one profile, start to finish

Below is a real, **mostly successful** session (`Anna Martinez`, engage-and-add
task, 2026-05-18). It illustrates the happy path plus one soft self-skip.

```
=== Session start (Anna Martinez) ===
[browserManager] Opening browser (multilogin: b7d1ab23) → port 22124
Media blocking: ON
Not on Facebook — navigating to homepage first...
Soft checkpoint modal detected — clicking Dismiss     ← Layer 1/2 soft-checkpoint
Soft checkpoint dismissed at pre-flight — continuing   ← pre-flight recovery worked
Starting: homepage_interaction → Completed
Starting: scroll (37.9s) → Completed
Starting: like_posts → Like complete: 0/4 posts liked  ← no error, just found 0 targets
Starting: wait (52.8s) → Completed
Starting: accept_loop  (4 pending requests)
  (1/4) Confirm request clicked → PATCH status=Accepted
  …(2/4, 3/4, 4/4)… Done. Accepted 4/4.
Starting: visit_profile → "sharers": .../BrooklynPaper
Starting: scroll (56.8s)
Starting: like_posts → 2/2 liked
Starting: share_posts
  Attempt 1: modal didn't open, skipping              ← self-retry inside the action
  Attempt 2: context extracted → generateMessage → Shared 1/1
Starting: visit_profile / scroll / like_posts / share_posts (second cycle)
Starting: connect_loop (target=3, skipIfFriendsAbove=30)
  Sender friends=34 > 30 — skipping action.            ← graceful self-skip, not error
Completed: connect_loop
[trackerLog] Logged "SUCCESS (13m 48s) | 1. homepage_interaction - scroll - like_posts | …"
Closed all tabs except one blank tab
Task done — cooling down 12.4s...
[browserManager] Profile b7d1ab23 closed (multilogin)
[WARN] browser.close() timed out after 10000ms — abandoning CDP connection
```

Things worth noting in this "happy" run:

- The **soft checkpoint** at pre-flight was auto-dismissed (Layer 2).
- `like_posts: 0/4` and `connect_loop: skipping` are **not errors** — actions
  degrade gracefully and report what they did.
- `share_posts` has its **own internal retry** ("Attempt 1 … Attempt 2") separate
  from `runWithRetry`.
- The final `browser.close() timed out` is the known MLX close-hang; the
  orphan-chromium reaper handles it on Windows.

---

## 4. Sample flow — a PARTIAL (soft-failure) session

This is the most instructive log for error-handling review (`Susan Wood`,
2026-06-01). It shows the **60s retry × 3**, **forensic dumps**, **soft-fail
continue**, and a few sharp edges.

```
Starting: visit_profile → "sharers": facebook.com/stjude
  [fail] dumped HTML → …/fail-visit_profile-attempt1-….html
  [fail] screenshot failed: page.screenshot: Timeout 60000ms exceeded.   ← dump itself timed out
  Error on visit_profile (attempt 1/3): page.goto: Timeout 90000ms exceeded.
  Retrying in 60s...
Starting (retry) visit_profile → facebook.com/newyorkhistoryusa
  …attempt 2/3 → Timeout → Retrying in 60s...
  …attempt 3/3 → facebook.com/HudsonRiverPark → Timeout
Step visit_profile failed (non-fatal): page.goto: Timeout 90000ms exceeded. — continuing to next step
Starting: wait → Completed
Starting: search "Gym in Houston, Texas"
  …attempt 1/3 → locator.waitFor: Timeout 15000ms (search box never appeared)
  …attempt 2/3 → "Yoga in Houston" → same
  …attempt 3/3 → "Salon in Houston" → same
Step search failed (non-fatal): locator.waitFor Timeout — continuing to next step
Starting: visit_profile → facebook.com/PublicArtFund → Completed   ← network recovered
Starting: connect → Clicked "Follow"
Starting: scroll / like_posts (0/3) / share_posts → Shared 1/1 → stamped lastSharedAt
Starting: connect_loop (target=5)
  Sender friends=4 → proceed
  (1/15) Add friend pressed 1/5 … (2/15) pressed 2/5
  (3/15) goto failed: Timeout 90000ms — skipping
  (4/15) goto failed: Timeout — skipping
  (5/15) goto failed: Cannot navigate to invalid URL   ← "manuela.damico1986@outlook.com" in profileUrl field!
  (6/15)…(15/15) all goto Timeout — skipping
```

**What this run reveals (candidate improvement areas):**

1. **Network brown-out, not a code bug.** A run of `page.goto: Timeout 90000ms`
   across `visit_profile`, `search`, and 13 `connect_loop` visits indicates the
   proxy/network degraded for ~20 minutes. The system **kept paying 90s + 60s per
   attempt** the whole time. No circuit-breaker: when N consecutive navigations time
   out, we keep grinding instead of backing off, aborting the profile, or pausing.

2. **The forensic dump is expensive on a timed-out page.** Each failure does
   `page.content()` then `page.screenshot({ fullPage:true })`, and on a hung page the
   **screenshot itself times out after 60s** — adding ~60s to every failure on top of
   the 90s nav timeout. On the `visit_profile` failures this nearly doubled the cost.
   Consider a short screenshot timeout, or skipping the screenshot when the page is
   known-unresponsive (nav already timed out).

3. **Bad data poisons a real action.** `connect_loop (5/15)` tried to navigate to
   `manuela.damico1986@outlook.com` — an **email address stored in the `profileUrl`
   field**. `connect_loop` swallows it as "skipping," but this is a data-quality bug
   that should be validated/normalized upstream (and `isLoggedOut`'s probe has a
   documented fallback for exactly this). No URL sanity check at point of use.

4. **`connect_loop` has no early-exit on a streak of nav failures.** It attempted all
   15 candidates, each ~90s, ~22 minutes total, after the network was clearly down.
   Same circuit-breaker gap as #1, but inside an action this time.

5. **Two different retry philosophies coexist.** `runWithRetry` retries 3× with 60s
   waits; `connect_loop` does its own one-shot "skip on goto failure." That's
   intentional, but it means the same root cause (network) is handled inconsistently
   — one place burns 3×(90+60)s, the other burns 1×90s. Worth a shared navigation
   helper with unified timeout/backoff policy.

---

## 5. Sample flow — a hard FAIL (browser never opened)

`Flavia Mazzola`, 2026-06-02 — Layer 0 failure:

```
[browserManager] Auto-provisioning MLX profile (country=IT)
[WARN] MLX profile/create got 501 + HTML (stale bearer) attempt 1/3 — refreshing token  ← recovered
[browserManager] created MLX profile dfd85320
[ERROR] Failed for userId …:
  message : Request failed with status code 400
  API body: { error_code: 'PROXY_SETUP_FAILED' }
[ERROR] Failed to open browser: Request failed with status code 400
```

Notes:
- The **stale-bearer 501 retry worked** (token refreshed, profile created).
- But **proxy assignment failed** (`PROXY_SETUP_FAILED`) and **there is no retry or
  fallback for proxy setup** — the half-provisioned profile is left orphaned MLX-side
  and the profile is marked FAIL. Candidate improvement: retry proxy setup, or tear
  down the just-created profile on proxy failure to avoid orphans.

---

## 6. Summary of error-handling strengths & gaps (for the reviewing AI)

**Strengths**
- Clear severity ladder: open-fail → retry → recovery → soft/abort classification →
  process diagnostics.
- One bad step / one bad profile never kills the task (`Promise.allSettled`,
  soft-fail continue, per-profile isolation).
- Rich forensics (HTML+PNG dumps, tracker logs, folder rename, summary.md).
- Resumable state survives hard kills.
- Tight, self-isolating recovery registry for known FB consent/checkpoint funnels.
- Browser-dead and checkpoint short-circuits avoid pointless 3×60s grinds.

**Gaps / candidate improvements**
1. **No network circuit-breaker.** Repeated `page.goto` timeouts (proxy brown-out)
   are retried indefinitely across steps; no "N consecutive nav failures → back off /
   abort profile / pause and re-test proxy."
2. **Forensic screenshot cost on hung pages** can add ~60s per failure; needs a short
   timeout or conditional skip.
3. **`profileUrl` / data validation** — email-in-URL field reaches `page.goto` and
   only fails there. Validate/normalize URLs at injection time and at point of use.
4. **Inconsistent retry policies** between `runWithRetry` and in-action loops
   (`connect_loop`, `share_posts`). A shared navigation/retry helper would unify
   timeout + backoff.
5. **Proxy-setup failure has no retry/cleanup** in auto-provisioning, leaving orphan
   MLX profiles.
6. **Retry waits are fixed (60s), not exponential**, and not adaptive to error class
   beyond "network vs other." Could tune by error type (selector timeout shouldn't
   wait 60s; nav timeout maybe should back off progressively).
7. **`like_posts: 0/N`** is silently treated as success — there may be value in
   distinguishing "no posts to like" from "couldn't find the Like button" (selector
   drift), which currently look identical.

---

### Appendix: error flags used to steer behavior

| Flag on `err` | Set by | Effect |
|---------------|--------|--------|
| `err.noRetry` | handlers with internal retries; recovery `'unfixable'`; browser-dead; checkpoint | `runWithRetry` stops retrying |
| `err.checkpoint` | checkpoint detection (pre-flight / in-retry / post-step) | abort profile, PATCH `Need Checking` |
| `err.credentialsRejected` | `outlook_login` etc. on bad creds | abort profile, PATCH `Need Checking` |
| `err.browserDead` | "Target page/context/browser closed" match | abort profile, **no** status PATCH (MLX-side cause) |
| `err.dumped` | `dumpStepFailure` | prevents double forensic dumps |
