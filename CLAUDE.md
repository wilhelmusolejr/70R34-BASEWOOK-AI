# BASEWOOK Automation Platform

## What this project does

Node.js backend that takes JSON task commands and runs automation across multiple
BASEWOOK (Facebook) accounts in parallel using anti-detect browser profiles
(Hidemium **or** Multilogin X) controlled via Playwright + CDP.

`POST /execute` accepts JSON (fire-and-forget — returns 202 immediately, task
runs in background). `GET /status/:taskId` to check progress.
`chat/nlToJson.js` is a separate NL→JSON layer that posts to the same endpoint.

## Tech stack

- **Node.js + Express** — HTTP server
- **Playwright** — browser automation via CDP
- **Hidemium / Multilogin X** — anti-detect browser (only one runs at a time, picked by env)
- No database yet — tasks are ephemeral

## Project structure

```
70R34-BASEWOOK-AI/
├── server.js                    # Express entry, POST /execute (async), GET /status/:taskId
├── runner.js                    # Recursive step runner
├── run-task.js                  # Run tasks.json directly
├── tasks.json                   # Editable task for manual runs
├── schemas/actionSchemas.js     # Param schema (single source of truth)
├── actions/                     # One file per action
│   ├── homepage_interaction.js  visit_profile.js  search.js
│   ├── open_search_result.js    create_page.js    scroll.js
│   ├── like_posts.js            share_posts.js    share_post.js
│   ├── publish_post.js          add_friend.js     follow.js
│   ├── connect.js               connect_loop.js   accept_loop.js
│   ├── setup_about.js           setup_avatar.js   setup_cover.js
│   ├── setup_privacy.js         schedule_posts.js switch_profile.js
│   ├── marketplace_location.js  wait.js
│   ├── facebook_signup.js       facebook_login.js ensure_login.js
│   ├── outlook_login.js
│   └── check_ip.js
├── update-post-captions.js      # Batch regen user.posts[].caption via Gemini + PATCH
├── utils/
│   ├── browserManager.js        # ONLY file aware of Hidemium / Multilogin
│   ├── userApi.js               # 3rd-party user fetch
│   ├── humanBehavior.js         # human-like interaction
│   ├── generateMessage.js       # Gemini — share/comment messages
│   ├── generatePostCaption.js   # Gemini — original post captions (publish_post)
│   ├── pageSetupHelpers.js      # shared helpers for page setup
│   ├── pageAddressData.js       # city/state parsing + ZIP seeds
│   ├── randomCount.js           # {count} | {min,max} resolver for feed actions
│   ├── runLogDir.js             # per-run scoped log directory (logs/{taskId}-{ts}/)
│   └── sessionLog.js            # per-profile session.log inside the run dir + vault tee
├── system_prompt.txt            # generateMessage system instruction (shares/comments)
├── system_prompt_post.txt       # generatePostCaption system instruction (publish_post)
├── vault-log.js                 # POSTs to Profile Vault Logs dashboard (gated by VAULT_ENABLED)
├── log.md                       # Vault Logs HTTP contract spec
└── chat/nlToJson.js             # NL → task JSON
```

## Core pattern: recursive steps

```json
{ "type": "action_name", "params": { ... }, "steps": [ ... ] }
```

**Two kinds:**
1. **Navigators** change the page: `visit_profile`, `search`, `open_search_result`, `create_page`, `homepage_interaction`.
2. **Leaves** act on the current page: `add_friend`, `follow`, `connect`, `scroll`, `like_posts`, `share_posts`, `schedule_posts`, `switch_profile`, `wait`.

```javascript
async function runStep(page, step) {
  const handler = handlers[step.type];
  if (!handler) throw new Error(`Unknown step type: ${step.type}`);
  await handler(page, step.params || {});
  if (step.steps) for (const child of step.steps) await runStep(page, child);
}
```

**Handlers NEVER call other handlers.** Chaining lives in the JSON `steps` array.

## Task fields

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `taskId` | yes | — | Unique id |
| `profiles` | * | — | Explicit list of user IDs. Wins when non-empty. |
| `profilesFromStatus` | * | — | Dynamic fetch: `GET /api/profiles?status=<value>&limit=500`. Used when `profiles[]` is missing/empty. |
| `cooldown.shareHours` | no | — | Skip profile if `user.onboarding.lastSharedAt` is within this many hours. |
| `concurrency` | no | all | Max parallel browsers |
| `blockMedia` | no | `true` | Block images/video/audio/fonts |
| `steps` | yes | — | Array of steps |

\* One of `profiles[]` (non-empty) OR `profilesFromStatus` is required. Both missing/empty → throws at task start.

```json
{
  "taskId": "setup-batch",
  "profiles": ["69e4a3...", "69e21c..."],
  "concurrency": 1,
  "steps": [
    { "type": "setup_avatar" },
    { "type": "setup_about" },
    { "type": "visit_profile", "params": { "pool": "friends" },
      "steps": [{ "type": "add_friend" }] }
  ]
}
```

```json
{
  "taskId": "engage-and-add",
  "profilesFromStatus": "Active",
  "cooldown": { "shareHours": 24 },
  "concurrency": 5,
  "steps": [ ... ]
}
```

`setup_*` params are auto-injected from the user API; explicit values win.

### Profile-list resolution

`resolveProfileList(task)` in `runner.js` returns `{ source, userIds, prefetched }`:

| `profiles` | `profilesFromStatus` | Outcome |
|---|---|---|
| `["a","b"]` (non-empty) | anything | source = `explicit`, uses `profiles[]` |
| `[]` / missing | `"Active"` | source = `api`, fetches via `fetchProfilesByStatus` |
| `["abc",""]` (only empties after filter) | `"Active"` | source = `api` (the empty string is stripped, length=0) |
| `[]` / missing | `""` / missing | **Throws** with explanatory message |

The `.filter(Boolean)` on `profiles[]` strips empty strings before the length check, so a stray `""` doesn't masquerade as "explicit list set". When the API path is used, the full profile records are returned and stored in a `prefetched` Map by id — the worker reuses them for the cooldown gate AND for display-name resolution, avoiding a second `fetchUser` round-trip per profile.

API source caps at **500 profiles per status** (server limit). If a status ever grows past 500, this needs pagination (currently the API doesn't support `skip` on `/profiles`).

### Per-step guards (`step.guard`)

Each step can declare a `guard` block in the task JSON. The runner evaluates
it in `runStep` **BEFORE** the existing `chance` roll — so an ineligible
profile never wastes a probability slot. A skipped step also skips its
nested `steps[]` subtree (same semantics as `chance`).

Supported guard keys (all optional, all must pass when set):

| Key | Pass condition |
|---|---|
| `ifOnboardingMissing: "<key>"` | `user.onboarding.<key>` is falsy. Used for idempotent setup steps — e.g. `setup_avatar` with `ifOnboardingMissing: "profileImageSetAt"` only runs when the avatar hasn't been stamped yet. |
| `ifFieldEmpty: "<top-level field>"` | `user.<field>` is empty string / null / undefined / empty array. Used for things like `create_page` with `ifFieldEmpty: "pageUrl"` to skip when the user already has a Page. |
| `minAccountAgeDays: N` | `(now - user.accountCreated) >= N days`. Empty / invalid `accountCreated` is treated as "age unknown" → guard FAILS (safe default — don't run age-gated actions until we can verify the age). |

Order of evaluation per step:
1. **`guard`** — skip with reason if any condition fails
2. **`chance`** — if guard passed, roll the probability dice
3. **Handler** — if both passed, run

Console output on skip looks like:
```
Skipping: setup_avatar (guard: account age 1.4d < required 3d)
Skipping: setup_about (guard: onboarding.aboutSetAt already stamped (2026-05-30T...))
Skipping: create_page (chance=0.3)
```

Example task config combining all three:
```json
{
  "type": "setup_avatar",
  "guard": { "ifOnboardingMissing": "profileImageSetAt", "minAccountAgeDays": 3 },
  "chance": 0.3
}
```
Means: run only if avatar onboarding stamp is null AND the FB account is at least 3 days old AND a 30% dice roll passes.

### `accountCreated` — the source for `minAccountAgeDays`

`user.accountCreated` (top-level ISO string) is the canonical "FB account
exists and we know when it was first confirmed" timestamp. Populated by:

- **`facebook_signup`** — stamps `accountCreated` on home-feed landing
  whenever the current value is empty. Covers both fresh-signup runs AND
  the `ensure_login` re-auth path (which delegates to `facebook_signup`
  with `skipPostSetup: true`). Idempotent — non-empty values are never
  overwritten. The current value comes through as `params.accountCreated`
  via `injectUserParams`; the action's check is purely local (no
  pre-fetch).

- **`backfill-account-created.js`** — for existing profiles whose
  `accountCreated` was empty before the stamping was wired up. Walks
  Active / Need Setup / Need Checking / Ready / Delivered profiles and
  sets `accountCreated` to the **earliest** known FB-side timestamp:
  `onboarding.privacyPublicAt` > `aboutSetAt` > `profileImageSetAt` >
  `coverImageSetAt` > `lastSharedAt` > `user.createdAt` (last resort).
  Profiles with none of those are skipped — no signal the FB account
  exists. Dry-run by default; `--apply` to write. `--status=<name>` to
  limit to one status.

`accountCreated` is exposed as a top-level field on the user record
(NOT inside `onboarding`) because it's "the account exists" rather than
"a specific onboarding step succeeded".

### Cooldown gate

`checkCooldown(user, task.cooldown)` in `runner.js`, called inside each worker **before `launchBrowsers`** so a skip costs ~0s instead of the ~15s browser-open overhead.

Current gate keys (the shape is extensible):

| Key | What it checks |
|---|---|
| `shareHours` | `user.onboarding.lastSharedAt` — skip if shared within N hours |

Decisions and the underlying timestamp:

- **Missing config**, **missing `lastSharedAt`**, **invalid date**, or **`shareHours ≤ 0`** → never skip.
- **`elapsedHours >= shareHours`** → not skipped, run normally.
- **`elapsedHours < shareHours`** → **SKIPPED**. The worker posts a tracker-log entry `SKIPPED (cooldown): last shared X.Xh ago (cooldown 24h, Y.Yh remaining)`, marks the profile `status: 'skipped'` in `state/{taskId}.json`, and moves on without opening a browser.

Skipped profiles count as "done" for this run, so the auto-clear behavior at task end still fires (next manual run starts fresh and re-evaluates cooldown — by then most skipped profiles will have aged past the threshold and become eligible).

The end-of-task summary and `summary.md` get a dedicated `Skipped` section listing each gated profile with its reason. Folder-rename does NOT fire for skipped profiles (they never opened a browser, no folder to tag).

## Browser providers — Hidemium **or** Multilogin

`utils/browserManager.js` is the ONLY file aware of either provider.
Handlers receive a Playwright `page`.

Provider is chosen by `BROWSER_PROVIDER` env (`hidemium` | `multilogin`).
The user record carries one entry per provider in `browsers[]`; the manager
picks the entry whose `provider` matches the env.

```json
"browsers": [
  { "browserId": "local-...", "provider": "hidemium" },
  { "browserId": "uuid-...",  "provider": "multilogin" }
]
```

### Hidemium flow

```
fetchUser → user.browsers (matched) → openProfile(uuid) via Hidemium local API
  → CDP port → chromium.connectOverCDP(`http://127.0.0.1:${port}`)
```

- Local API: `http://127.0.0.1:2222`, static bearer token in code.
- Start: `GET /openProfile?uuid=X` → `data.data.remote_port`
- Stop: `GET /closeProfile?uuid=X`

### Multilogin X flow

```
signin → user token + refresh_token
  → refresh_token (POST) with workspace_id → workspace-scoped bearer
  → start (GET, v2) → port → chromium.connectOverCDP
```

- Auth: `POST https://api.multilogin.com/user/signin` with `{ email, password (MD5 hex) }` → returns `{ token, refresh_token }`. **MD5 is required** despite some doc claims.
- Workspace bearer: `POST https://api.multilogin.com/user/refresh_token` with `{ email, workspace_id, refresh_token }` → workspace-scoped token. The plain signin token is workspace-less and gets 403 on the launcher.
- Launcher base: `https://launcher.mlx.yt:45001` (HTTPS, cloud-routed).
- Start: `GET /api/v2/profile/f/{folderId}/p/{profileId}/start?automation_type=playwright&headless_mode=false` → `data.data.port`
- Stop: `GET /api/v1/profile/stop/p/{profileId}` (note: **v1**, while start is v2)
- Token cached in module memory; on 401 we re-signin once.
- **Stale-bearer 501 quirk.** MLX's gateway returns the **Python-default
  501 HTML page** (`<html>...Unsupported method ('POST')...</html>`) when
  the workspace bearer is invalid/expired — NOT the standard 401. A
  long-running `server.js` process holding a cached `mlxToken` whose TTL
  has lapsed will get 501 + HTML on every `/profile/create` (and other
  authenticated POST). The helper scripts in `multilogin/` never see this
  because each `node` invocation is a fresh process that signs in once
  and exits. The `withMlxRetry` wrapper in `utils/browserManager.js`
  treats **5xx + HTML body** as auth-style failure: nulls `mlxToken`,
  calls `mlxSignIn()` to get a fresh workspace bearer, then retries.
  Pure-JSON 5xx (real MLX backend errors) goes through the plain
  transient retry path without touching the token.
- `MULTILOGIN_FOLDER_ID` is required (source / "creation" folder); `MULTILOGIN_WORKSPACE_ID` is required for the refresh step.
- `MULTILOGIN_DELIVERY_FOLDER_ID` is the destination folder used by the `multilogin/move_profiles.js` and `multilogin/export_delivery.js` helpers (the bot itself doesn't read it). The pair lets you separate creation-stage profiles from delivery-ready ones in the MLX UI.
- `MULTILOGIN_CORE_VERSION` (or `CORE_VERSION` in `multilogin/.env`) — minimum **143** as of 2026-05. MLX rejects older cores with `BAD_REQUEST_BODY: "Can't set core older than 143. Please set higher core version"`. Default in `utils/browserManager.js` is `143`; the `multilogin/.env` template tracks the same floor.

`closeProfile(profileId, browser, provider, port?)` and `closeBrowsers`
dispatch by the `provider` field on the session object. `port` is the
optional CDP port the session connected over — when supplied AND
`browser.close()` times out, the orphan-chromium reaper kicks in (see
[Orphan-chromium reaper](#orphan-chromium-reaper-windows-only) below).

### Country-aware auto-provisioning

`openBrowserForUser` self-heals when a user record has no `browsers[]`
entry for the active provider. Default ON for `BROWSER_PROVIDER=multilogin`
(disable with `AUTO_PROVISION_BROWSER=false`).

```
openBrowserForUser(userId)
  → fetchUser → no multilogin entry?
    → provisionMultiloginForUser(user)
       1. createMultiloginProfile(user)   → POST /profile/create (MLX)
       2. assignCountryProxy(profileId,    → generate + apply country-matched proxy
                              user.country)
       3. PATCH /api/profiles/:id           → link browserId back to user
    → splice new entry into local user.browsers
    → fall through to openMultiloginProfile(browserId)
```

**Region pool — `utils/browserManager.js` `COUNTRY_REGIONS`**:

| Country | Region count | Form |
|---------|--------------|------|
| `US` | 50 | English/underscored — `alabama, ..., west_virginia, wisconsin, wyoming` |
| `IT` | 20 | English/underscored — `lazio, lombardy, sicily, tuscany, emilia_romagna, ...` |

`randomRegion(country)` picks uniformly at random. `COUNTRY_ALIASES` maps
loose forms (`us/usa/united_states`, `it/ita/italy/italia`) to the canonical
ISO-3166-1 alpha-2 code. To add another country: add the region array +
alias set, restart. No further wiring required — provisioning + verification
both pick it up automatically.

**Skip rules:**
- `user.country` empty → throw (`User X has no country — can't auto-provision`).
- `user.country` not in `COUNTRY_REGIONS` → throw (lists the supported codes in the message).
- Non-`multilogin` providers (`hidemium`) → never auto-provision; throw the legacy "no browsers configured" error. Hidemium's create flow needs the proxy pool walk + ipinfo verification (`utils/browserManager.js` `createProfile`), which is a different shape than the MLX one-shot.

**Shared with the helper scripts.** `multilogin/create_profiles.js` and
`multilogin/assign_us_proxy.js` now both `import` from
`../utils/browserManager.js` so the bot's auto-provision path and the
batch CLI flow use the **same** `createMultiloginProfile` and
`assignCountryProxy` functions. Single source of truth — no risk of the
two paths drifting in proxy shape, masking flags, or region naming.

**Exported for reuse** (`utils/browserManager.js`):
`COUNTRY_REGIONS`, `COUNTRY_ALIASES`, `normalizeCountry`, `randomRegion`,
`proxyCountryCode`, `isMatchingCountryProxy`, `createMultiloginProfile`,
`assignCountryProxy`, `provisionMultiloginForUser`.

**Proxy shape — what actually engages the proxy.** MLX's
`/profile/partial_update` accepts two shapes. The one that ENGAGES the
proxy is:

```js
{
  profile_id,
  proxy: { host, port, type, username, password },     // top-level
  parameters: { flags: { proxy_masking: 'custom' } },  // must be set
}
```

Without `parameters.flags.proxy_masking='custom'`, the proxy is stored on
the profile but ignored at runtime (masking stays `'disabled'` from
creation). `assignCountryProxy` always sets both.

**Verification.** Verify a profile's proxy is actually country-matched:

```js
const meta = await getProfileMetas(token, [profileId]);
isMatchingCountryProxy(meta.parameters.proxy, expectedCountry);
// reads either proxy.country / proxy.country_code OR parses the MLX
// proxy username (`country-it-region-lazio-sid-XXX`) — robust to both
// shapes MLX returns across endpoints.
```

### Known gap — dead MLX profile detection

`openBrowserForUser` triggers auto-provision when there's **no entry** for
the active provider, but **not** when the entry points to an MLX profile
that's been deleted MLX-side. The bot tries `/profile/start`, MLX returns
`500: "Profile is removed"`, retry exhausts 3 attempts, profile is marked
failed for the run. Workaround: manually PATCH the user record's
`browsers` to strip the dead entry, then re-run — auto-provision recreates
fresh. Fix would be narrow-match on the `"Profile is removed"` MLX message
in `openMultiloginProfile`'s catch block, treat as "missing entry,"
re-provision in place. Not implemented yet — would need to confirm MLX
returns this exact message on every removal path.

### `launchBrowsers` error semantics

When `launchBrowsers([userId])` is called with a single userId (the
per-profile path from `runner.js`), the wrapper now **rethrows the
underlying error** instead of swallowing it under a generic `"Could not
connect to any profiles. Make sure Hidemium is running and API token is
correct."` (which was misleading both because it always said Hidemium
even on the multilogin path AND because it masked the real cause). Multi-
profile callers still get the aggregated `"Failed to open N profile(s) — ..."`
wrapper with each underlying message joined. The aggregated error carries
`err.failures = [{ userId, err }, ...]` for programmatic inspection.

### `utils/userApi.js`

`USER_API_BASE_URL` env. `GET /api/profiles/:id`. Image URLs built as
`IMAGE_SERVER_BASE_URL + imageId.filename`. Page assets use **positional fallback**
via `resolveSetupPageImages()` (`linkedPage.assets[0]` → profile, `[1]` → cover).

| Field | Used by |
|-------|---------|
| `_id` | `browserManager`, `check_ip`, PATCH targets for `setup_about` / `create_page` |
| `firstName`/`lastName` | `switch_profile`, identity prompts |
| `emails[].address` (selected or `[0]`) | `create_page` |
| `city` / `hometown` | `setup_about`, `create_page` (via `parseCityState`), `search` (page mode) |
| `bio` | `setup_about` (NOT `create_page` — that uses `linkedPage.bio`) |
| `personal`, `work`, `education`, `hobbies`, `travel`, `interests` | `setup_about` |
| `identityPrompt` | share-message generation, `publish_post` caption generation |
| `images[0]` (face annotation) | `setup_avatar` |
| `images[1]` | `setup_cover` |
| `posts[].{_id,images[],context,caption?}` | `publish_post` (random pick; `images[].filename` resolved via `buildImageUrl`; `context` seeds `postContext`; `caption` seeds `postCaption` for `captionSource: "post"`) |
| `linkedPage.{pageName,bio,assets[0..1],posts}` | `create_page`, `schedule_posts` |
| `browsers[]` | `browserManager` (matched by `provider`) |
| `pageUrl` | PATCHed back after `create_page` |

**Post captions live in their own collection — PATCH endpoint footgun.**
`user.posts[]` is populated on read but **NOT** updatable via
`PATCH /api/profiles/:id` — the profile PATCH runs the body through
`normalizeProfilePayload`'s allow-list, which silently drops `posts`
(returns 200 OK with no actual update — easy to miss). To update a post's
caption:

```js
await axios.patch(
  `${USER_API_BASE_URL}/api/posts/${postId}`,    // one post at a time
  { caption: 'new caption' }
);
```

`update-post-captions.js` uses this endpoint for batch caption regen.

### Onboarding stamps — `setOnboarding(userId, key, value?)`

Each setup-style action stamps a completion timestamp on the profile's
`onboarding` subdocument when it succeeds. Endpoint:
`PATCH /api/profiles/:id/onboarding/:key` with body `{ value: "<ISO date>" }`
(or `null`/`""` to clear). Returns 200 + full profile, 400 on bad id/key/date,
404 if profile missing.

| Action | Stamps key | When |
|--------|------------|------|
| `setup_privacy` | `privacyPublicAt` | After Confirm on /settings/bundled |
| `setup_avatar` | `profileImageSetAt` | After Save closes the avatar modal |
| `setup_cover` | `coverImageSetAt` | After Save changes wins |
| `setup_about` | `aboutSetAt` | After every section completes + markProfileSetup PATCH |
| `marketplace_location` | `marketplaceSetAt` | After Apply + verification succeeds |
| `publish_post` | `publishPostAt` | After the Create-post dialog detaches |
| `share_post` | `lastSharedAt` | After "Share now" click |
| `share_posts` | `lastSharedAt` | After loop completes with at least 1 share |

Other supported keys not currently stamped (future work):
`groupJoinedAt`, `highlightsSetAt`, `recoveryEmailSetAt`.

**Best-effort, non-throwing.** `setOnboarding` swallows axios errors and warns —
a transient PATCH hiccup never fails the action that just succeeded. `userId` is
auto-injected via `injectUserParams` for every action that stamps. When `userId`
is empty (test rigs without a real user record), the stamp is silently skipped.

`lastSharedAt` is the only key that's expected to *change* over time
(latest-share marker). The rest are first-completion markers that re-stamp
to the latest successful run — harmless re-state, useful for "ran-recently"
queries against the DB.

**Backfill script — `backfill-onboarding.js`.** One-shot utility that
walks every Active profile's `trackerLog` and stamps missing
`onboarding.*` keys based on which top-level steps appear in the
numbered list of any past entry (the list shows COMPLETED steps even
on FAIL entries — FAIL just means a later step crashed). Use after
wiring a new onboarding key so existing profiles don't appear "not yet
done" forever. Idempotent — re-running doesn't re-stamp already-set
keys.

## Playwright conventions (anti-detection)

- **Feed scroll:** `page.mouse.wheel(0, 500)`. NEVER `window.scrollTo` or `element.scrollIntoView` on the feed.
- **`scrollIntoViewIfNeeded` is OK** in About panels/modals (isolated containers) and for profile/page header buttons (`connect`) — headers aren't virtualized, mouse-wheel can overshoot. Use `scrollToCenter` only when mouse-wheel is needed (feed).
- **Click:** `humanClick(page, await locator.boundingBox())` for feed/profile buttons. Locator clicks can fail silently on FB's React DOM.
- **Type:** `humanType(page, text)` — varies per char + pauses after punctuation. NEVER instant-paste, NEVER uniform per-char delay.
- **Wait:** `humanWait(page, min, max)` — NEVER `waitForTimeout(fixedValue)`.
- **Two-pass for virtualized feeds:** scroll first, then interact.
- **Scroll before click for forms:** `scrollIntoViewIfNeeded()` first — off-screen elements return null bbox.

### `utils/humanBehavior.js`

```javascript
const { humanDelay, humanWait, humanClick, humanType, scrollToCenter } = require('../utils/humanBehavior');
```

Add reading pauses (800-1500ms) before interactions and watching pauses
(1000-2500ms) after.

### Direct `.click()` vs `humanClick`

| Context | Use |
|---------|-----|
| Feed/profile page buttons | `humanClick(page, box)` |
| FB modal/overlay buttons (cover save, file upload) | `element.click()` — humanClick offset can miss small targets |
| After scroll | Always re-fetch `boundingBox()` right before click |

## Code formatting

Prettier configured (`.prettierrc`, `.prettierignore`). Run:
- `npm run format` — rewrites `**/*.{js,json,md}`.
- `npm run format:check` — non-mutating CI gate.

Settings: `semi`, `singleQuote`, `trailingComma: es5`, `printWidth: 100`,
`tabWidth: 2`, `arrowParens: always`, `endOfLine: lf`. Ignored: `node_modules`,
`package-lock.json`, `.env*`, `*.log`, `config/profiles.json`, `CLAUDE.md`.

## Adding a new action

1. Add schema entry to `schemas/actionSchemas.js`.
2. Create `actions/<name>.js` exporting `async (page, params) => {...}`.
3. Register in the handler map in `runner.js`.

Validate required params at top, throw clear errors. Default optionals
(`params.count ?? 1`). Per-browser failures must NOT kill the task —
`Promise.allSettled`. One action = one file.

## Run-scoped log directory

Every `runTask` invocation gets its own folder under `logs/`, named
`{taskId}-{YYYYMMDD-HHmmss}`. Top-level run output + every profile's session
log + any failure dumps for that run all live under one roof:

```
logs/
  engage-and-add-20260517-200351/
    tasks-logs.log                   ← top-level stream: banners, heartbeats,
                                       Result JSON, !!! beforeExit / exit /
                                       UNHANDLED REJECTION diagnostics
    profiles/
      Natalie Gray-6a03d4b0/
        session.log                  ← per-profile console output, tagged
                                       with [DisplayName] prefix
        publish_post-error-4img-2026-05-18T03-09-27-064Z.html
        publish_post-error-4img-2026-05-18T03-09-27-064Z.png
        checkpoint-preflight-2026-05-17T20-04-15-732Z.{html,png}
```

**Folder name = `{DisplayName}-{first 8 chars of userId}`.** The short-id
suffix prevents collisions when two profiles share `firstName + lastName`.

`utils/runLogDir.js` owns the layout. `initRunLogDir(taskId)` is memoized
per process, so `run-task.js` (which sets it up before anything else logs)
and `runner.js` (which calls it again from `runTask`) both resolve to the
same dir without coordination.

**stdout/stderr tee.** `run-task.js` wraps `process.stdout.write` and
`process.stderr.write` synchronously (`fs.writeSync`, not `createWriteStream`)
so every byte going to either stream is also appended to `tasks-logs.log`.
The sync path is critical: an async stream queues work on the event loop,
which makes `beforeExit` fire on every drain, which writes the banner via
`console.error`, which queues more work — infinite loop, 1.6M lines in
seconds. Sync writes don't queue work; `beforeExit` fires exactly once and
the final bytes are guaranteed flushed before `process.exit`.

**Per-profile log file = `session.log` inside the profile folder** (fixed
name; the folder identifies the profile). Written by `utils/sessionLog.js`
via a `console.{log,info,warn,error}` monkey-patch that re-routes output
when inside a `runInSession` scope. The profile folder path is also stored
in the AsyncLocalStorage context — actions can read it via
`getProfileLogDir()` from `sessionLog` to drop dumps alongside.

## Failure forensics — HTML + screenshot dumps

When an action interacts with a 3rd-party site whose DOM can change without
warning (Microsoft, Facebook, etc.), a thrown selector timeout tells you
*what* timed out but not *why*. Re-running just to inspect doesn't help —
the failing state may not reproduce. Capture the page state at the moment
of failure instead.

**Convention.** Add a small helper at the top of the action file. Drop the
dump into the **run-scoped profile folder** via `getProfileLogDir()` so all
forensics for a profile land alongside its `session.log`:

```javascript
const fs = require('fs');
const path = require('path');
const { getProfileLogDir } = require('../utils/sessionLog');

async function dumpFailure(page, label) {
  try {
    if (!page) return;
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const safeLabel = String(label || 'failure').replace(/[^a-z0-9_-]+/gi, '_');

    // Prefer the per-profile run-scoped dir. Falls back to flat logs/ when
    // called outside a runInSession scope (dev scripts, unit tests).
    const profileDir = getProfileLogDir();
    const targetDir = profileDir || path.join(process.cwd(), 'logs');
    try {
      if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
    } catch (_) {}

    const baseName = `<action>-${safeLabel}-${ts}`;
    const htmlPath = path.join(targetDir, `${baseName}.html`);
    const pngPath = path.join(targetDir, `${baseName}.png`);

    let url = '(unknown)';
    try { url = page.url(); } catch (_) {}

    try {
      const html = await page.content();
      fs.writeFileSync(htmlPath, `<!-- url: ${url} -->\n${html}`, 'utf8');
      console.warn(`  [<action>] dumped HTML → ${htmlPath}`);
    } catch (err) {
      console.warn(`  [<action>] HTML dump failed: ${err.message}`);
    }

    try {
      await page.screenshot({ path: pngPath, fullPage: true });
      console.warn(`  [<action>] dumped screenshot → ${pngPath}`);
    } catch (err) {
      console.warn(`  [<action>] screenshot failed: ${err.message}`);
    }
  } catch (err) {
    console.warn(`  [<action>] dumpFailure swallowed: ${err.message}`);
  }
}
```

Then wrap the body of the action in `try/catch`, dump on throw, **re-throw**
so the runner sees the original error:

```javascript
module.exports = async function my_action(page, params) {
  try {
    // ... action logic
  } catch (err) {
    await dumpFailure(page, `error-${params.userId || 'unknown'}`);
    throw err;
  }
};
```

**Rules.**
- Output dir is the **per-profile run-scoped folder** when called inside a
  `runInSession` scope (which is every action invocation from the runner):
  `logs/{taskId}-{YYYYMMDD-HHmmss}/profiles/{DisplayName}-{shortUserId}/`.
  Falls back to flat `logs/` outside a session.
- Filename: `<action>-<label>-<ISO-ts>.{html,png}`. The folder already
  identifies the profile, so labels can be terse (`error-preflight`,
  `error-4img`) — they're for distinguishing concurrent failures within
  the same profile.
- Embed the URL as an HTML comment in the dump (`<!-- url: ... -->`).
  When you open the HTML standalone it lacks the address bar context.
- `fullPage: true` on the screenshot — failures often involve a banner or
  modal off the initial viewport.
- **Helper swallows its own errors.** A dump-on-dump failure must never
  mask the original throw — the action's stack is what runWithRetry sees.
- **Always re-throw** in the catch. The dump is forensics, not recovery.
- Reference implementations: `actions/outlook_login.js` (Microsoft login),
  `actions/publish_post.js` (FB composer), `runner.js`
  `dumpCheckpointState` (pre-flight + post-step checkpoint detection).

**When NOT to add it.**
- Pure-FB actions where the same `humanClick` / selector pattern is used
  across many handlers — selector breakage usually surfaces in one of the
  feed actions first, and FB checkpoint URLs already get short-circuited
  by `runner.js`. Adding dumps to every FB action would flood `logs/`.
- Use it for actions that talk to 3rd-party sites with DOM that's hard to
  reason about live (Microsoft, Outlook, OAuth flows, Stripe, etc.).

## What NOT to do

- No combination action types (`search_and_add`) — combinations live in `steps`.
- No hardcoded URLs/comments/names/counts — use `params`.
- No handler calling another handler.
- No skipping per-browser error isolation.
- No JS-driven scrolls or instant-paste typing.
- No Hidemium/Multilogin code outside `utils/browserManager.js`.

## `setup_about`

Self-navigates (no `profileUrl` needed). Sections: bio, city/hometown, relationship,
work, education, hobbies, interests, travel, name pronunciation. Section order is
shuffled per run.

After all sections complete, PATCHes `{ status: "Active", profileSetup: true }`
to `/api/profiles/{userId}`. PATCH errors are caught + logged. Mid-setup failure
leaves flags unchanged so retry re-runs cleanly.

**`profileUrl` capture (mirrors `create_page` → `pageUrl`):** when the user record's
`profileUrl` is empty, `setup_about` waits for the `/me` redirect to settle, captures
`page.url()`, normalizes (strips `/about|/friends|/photos|/videos|/reels` tab suffixes
and `sk=` query), and PATCHes `{ profileUrl }` before the status PATCH. If the user
already has a `profileUrl`, the capture is skipped — never overwrites a good URL.
`profileUrl` is auto-injected from the user record by `injectUserParams`.

### Navigation

```
facebook.com/me → About tab → sidebar link → panel button → fill → save
```

- About tab: matched by ANY of: href contains `sk=about`, href has `/about(?:/|?|$)` path-style, `aria-label="About"`, or `role="tab"` + `textContent === "About"`. FB's tab markup varies across account states / locales / fingerprints. Polled in-page via `waitForFunction(..., timeout: 30000)`. Use `textContent` (DOM-only), not `innerText` (layout-dependent — returns `''` on slow renders).
- Sidebar `sk` values: `directory_intro`, `directory_personal_details`, `directory_work`, `directory_education`, `directory_activites` *(FB typo, not "activities")*, `directory_interests`, `directory_travel`, `directory_names`
- **`clickSubsection` three-tier fallback:** (1) `a[href*="skFragment"]` sidebar link, (2) `getByRole('tab', { name })` text match, (3) **direct URL navigation** — sets `?sk=skFragment` on the current About page URL. The URL fallback is critical for fresh accounts where FB doesn't render sidebar links until data exists.
- Panel buttons (no aria-label): `xpath=//div[@role="button"][.//span[text()="Button Text"]]`

### Save patterns — three button shapes

| Context | Selector |
|---------|----------|
| Inline panel forms (bio, personal, hobbies, interests, travel, names) | `xpath=//span[text()="Save"]` |
| Current city | `[aria-label="Current city save"]` |
| Hometown | `[aria-label="Hometown save"]` |
| Bio (`div[role="button"]` form) | `div[role="button"][aria-label="Save"]` |

Always `waitForSaveComplete` after save (3× retry, 10-15s + 5-10s) to confirm
button is gone + panel closed.

### Duplicate prevention

Edit button only renders when data exists:
`[aria-label="Edit Workplace"]`, `[aria-label="Edit college"]`, `[aria-label="Edit school"]`.

### "Leave Page" modal on sidebar switch

Half-typed input + sidebar click triggers the unsaved-changes modal that blocks
navigation. `clickSubsection` calls `dismissLeavePageDialog` after every sidebar
click (probes `[aria-label="Leave Page"]`, 2.5s timeout, click if visible).

### Hobbies / Interests combobox clear

After typing → ArrowDown → Enter, FB's combobox sometimes leaves residual
text/chip. **Ctrl+A + Delete does not clear it reliably.** Mash `Backspace`
for ~5s (80-140ms intervals) before the next iteration. `Backspace` is the
only key the field always honors.

### Key helpers

`typeAndSelect`, `selectYearFromDropdown`, `clickPanelButton`, `setPanelPrivacyPublic`,
`fillPanelWithItems`, `waitForSaveComplete`, `dismissLeavePageDialog`.

## `setup_avatar`

Self-navigates to `/me`. Probe `[aria-label="Profile picture actions"]` (3s)
on current page first; only `goto /me` on miss.

Flow: actions → "Choose profile picture" → "Upload photo" (file chooser)
→ wait for "Drag or use arrow keys to reposition image" → Save.

- Image downloaded to `os.tmpdir()` via `https`/`http`, deleted in `finally`.
- `Promise.all([page.waitForEvent('filechooser'), btn.click()])` + `setFiles(path)`. Do NOT use `setInputFiles` on the hidden input.
- `description` optional. Caption priority: explicit `description` → AI-generated via `utils/generateAvatarDescription.js` from `userIdentity` → random from `DESCRIPTION_POOLS` (5 categories × 20 = 100 entries). ~40% chance of a single emoji from a 10-entry pool. Generator always returns non-empty.
- Save selector: `div[aria-label="Save"][role="button"]`, `scrollIntoViewIfNeeded` + `humanWait` then direct `.click()`.

## `setup_cover`

Self-navigates to `/me`. Flow:
```
"Add cover photo" → "Upload photo" menuitem (file chooser) → wait for Save changes enabled → Save
```

- "Add cover photo" uses direct `.click()` (humanClick offset misses).
- "Save changes" starts `aria-disabled="true"` while image processes.
- **FB renders 2 elements matching `[aria-label="Save changes"]`** — one hidden, one visible. Playwright's `waitForSelector` picks the first match (often hidden) and the visibility gate times out. Fix: `page.locator('[aria-label="Save changes"]').count()`, iterate **last to first** until one is `isVisible() && isEnabled()`, then click that.

## `setup_privacy`

Leaf action. Walks the `/settings/bundled` privacy acknowledgment page
after a fresh signup. Extracted from `facebook_signup` as a standalone
action so it can be composed via `steps`:

```json
{ "type": "facebook_signup", "steps": [{ "type": "setup_privacy" }] }
```

Or run standalone for accounts that skipped the walkthrough.

Flow:
```
goto facebook.com/settings/bundled
  → if "Public · Your current setting" label visible → stamp + return
  → else: select "Public" radio (3 attempts, throws if all fail)
  → try Next  (soft — warn + continue if missing)
  → try Confirm (soft — warn + continue if missing)
  → stamp privacyPublicAt
```

**Pre-flight skip via onboarding.** `injectUserParams` reads
`user.onboarding.privacyPublicAt` and passes it as `params.privacyPublicAt`.
When the value is set, the action logs `privacyPublicAt already stamped
(<ts>) — skipping` and returns immediately — no /settings/bundled nav, no
walkthrough, ~90s saved per re-run. Pass an explicit empty string in the
step's params to force re-run on a stamped account.

**Strict-vs-soft step boundaries.** The Public-radio click is the only
strict step (throws on failure — it's what actually changes the stored
privacy). Next + Confirm are best-effort acknowledgment UI; FB renders
them inconsistently across account states, so missing them is logged as a
warning and execution continues. The `setOnboarding('privacyPublicAt')`
stamp fires only after the radio click + (soft) acknowledgments — so
re-running an action that crashed on the radio still gets retried
tomorrow instead of being marked "done" with stale privacy state.

**Already-public short-circuit.** Detects "Public · Your current setting"
label on the bundled page — this is the ONLY signal of the stored value.
The first-radio-checked fallback that `selectPublicPrivacy` uses internally
would false-positive here because FB's walkthrough defaults the radio to
Public regardless of the current setting (you can see this when the page
labels "Custom · Your current setting" on a different row while Public's
radio is highlighted). On match, stamps `privacyPublicAt` and returns —
already-configured accounts skip the buggy Next/Confirm flow entirely.

Auto-injected: `userId`, `privacyPublicAt`.

## Cookie consent popup — EU/IT proxies

FB shows a full-page cookie consent modal on EU proxy IPs before any form
interaction is possible. Dismissed in two places:

1. **`ensure_login`** — immediately after navigating to `/reg/`
2. **`facebook_signup`** — before filling the form (catches both paths)

**Selector:** `div[aria-label="Allow all cookies"]:not([aria-hidden="true"])`.
FB renders TWO matching elements — one with `aria-hidden="true"` /
`aria-disabled="true"` (decoy) and one real. The `:not()` filter targets
only the real button. `force: true` is required because FB's
`data-visualcompletion="ignore"` overlay div with `inset: 0px` covers
the button (same pattern as `share_posts`).

**Fallback in `fillHuman` and `selectOption`:** if any form field or
dropdown option times out, the handler tries `dismissCookieConsent` and
retries — catches the case where the popup appeared after the initial
dismiss check.

**Failure forensics:** `facebook_signup` wraps its entire form-fill block
in try/catch. On any throw, dumps HTML + full-page screenshot to the
profile's run-scoped log folder (`signup-error-<name>-<ts>.{html,png}`)
before re-throwing.

## Facebook Page setup — `create_page` + `schedule_posts` + `switch_profile`

| Action | Kind | Job |
|--------|------|-----|
| `create_page` | Navigator | Menu → Pages → Create, fill all fields, upload profile/cover, advance Steps 2-5. Ends on `/profile.php?id=*`. |
| `schedule_posts` | Leaf | Schedule `params.posts[]` on loaded Page, one per day starting tomorrow. Per-post failures logged, not thrown. |
| `switch_profile` | Leaf | Your profile → Switch to [userName] → 50s cooldown. Falls back to "Quick switch profiles". |

Composed via the `setup_page_full` preset, or nested:
```json
{ "type": "create_page", "steps": [
  { "type": "schedule_posts" }, { "type": "switch_profile" }
]}
```

Shared helpers in `utils/pageSetupHelpers.js`.

### Retry strategy — split on the "Create Page" commit click

The click on `div[aria-label="Create Page"][role="button"]` (after name/category/bio)
commits the Page on FB's side. Retry semantics differ on each side:

| Phase | Scope | Attempts | Wait |
|-------|-------|----------|------|
| Pre-create (FB home → Pages → modal → fill → commit click) | Whole block restarts (back to facebook.com, Escape any leftover modal) | 3 | 60s |
| Post-create (email/address/hours → uploads → Steps 2-5 → Done) | Each action retries independently | 2 | 60s |

Final exhaustion throws with `err.noRetry = true` so `runner.js` won't restart
the whole `create_page` (would spawn duplicate Pages).

Constants: `PRE_CREATE_ATTEMPTS=3`, `POST_FIELD_ATTEMPTS=2`, `RETRY_WAIT_MS=60000`.

### Post-create form canary

After the commit click, `create_page` probes `label:has-text("Email") input`
with a 15s timeout. If the email field doesn't appear, FB rendered a flow
variant without the contact form — the action **returns cleanly** instead of
waitFor'ing every subsequent field × 2 retries × 15s (which used to burn
~11 minutes per failing profile). The Page is already committed FB-side, so
a half-configured Page is the intended outcome — the worker moves on to its
next step instead of marking FAIL.

### Navigation

```
create_page:
  facebook.com → Facebook menu → Pages → Create Page → Public Page → Next
    → Get started → fill name/category/bio → Create Page (commit)
    → fill contact/location/hours → Next
    → Step 2: upload profile + cover → Next
    → Step 3: WhatsApp              → Skip
    → Step 4: Build audience        → Next
    → Step 5: Stay informed         → Done
    → wait URL: /profile.php?id=*   (creation confirmed)
    → dismiss cookies popup if present
```

### City/town typeahead

Type `cityName + ", " + first half of stateName` (e.g. `"Birmingham, Alaba"`).
City alone returns too many results. `address.stateName` from `buildPageAddress()`.

### Post scheduling loop

post[0] → today+1, post[1] → today+2, etc. `getScheduleDate(dayOffset)` handles
month/year rollover via `Date.setDate`.

- **"Not now" modal:** FB shows randomly. `dismissNotNow()` loops until gone (4s timeout each). Called before each post AND between "What's on your mind?" click + modal load. `handleAfterSchedule()` checks 3× (5s each), then 30-60s wait before next post.
- **Lexical editor:** FB's composer is contenteditable. `page.keyboard.type()` causes scroll jump. Click "Create post" heading first, then Tab ×3 (1s delays) to focus editor, then type.

### Page URL persistence

After Done, `create_page` captures `page.url()` before/after. If URL changed AND
`waitForURL('**/profile.php?id=**')` confirmed, PATCHes:

```
PATCH /api/profiles/{userId}  { "pageUrl": "..." }
```

Skipped if URL didn't change (silent failure) so stale URL never overwrites a good one.

### Duplicate-Page guard

`create_page` is destructive: the commit click creates a real FB Page that
cannot be undone via the same flow, and running the action twice on an
account that already has a Page produces a second Page (which then needs
manual cleanup AND splits page-asset state in the DB).

The action checks `params.pageUrl` at entry. If non-empty (trimmed), it
logs `User already has pageUrl="..." — skipping (guard against duplicate
Page)` and `return`s — **no throw, no error**. From the runner's
perspective the step completed successfully, so it moves on to the next
top-level step in the task as if `create_page` had been a no-op.

**Nested children are NOT executed when the guard fires.** The recursive
child walk in `runStep` happens after the handler returns; an early
return short-circuits the whole subtree. This is intentional —
`switch_profile` (the typical create_page child) only makes sense if
`create_page` left the session on a Page profile. If the guard fired,
the session never switched to a Page in the first place, so running
`switch_profile` would be a no-op or mis-fire.

`injectUserParams` passes `user.pageUrl` through to `params.pageUrl`, so
the guard fires automatically once the user record has a Page URL
recorded (set by the persistence PATCH above). To force re-creation
(e.g. testing on a known account), pass an explicit `"pageUrl": ""` in
the step's params — the runner respects explicit-empty over the user
record.

### Auto-injected params

| Step | Param | Source |
|------|-------|--------|
| `create_page` | `pageName` | `user.linkedPage.pageName` |
| `create_page` | `bio` | `user.linkedPage.bio` |
| `create_page` | `email` | `user.emails` (selected or `[0]`) |
| `create_page` | `city`/`state`/`zipCode`/`streetAddress` | `buildPageAddress(...)` |
| `create_page` | `profilePhotoUrl`/`coverPhotoUrl` | `resolveSetupPageImages(user)` |
| `create_page` | `pageUrl` | `user.pageUrl` (duplicate-Page guard — non-empty short-circuits the action) |
| `schedule_posts` | `posts` | `user.linkedPage.posts` |
| `switch_profile` | `userName` | `firstName + lastName` |

## `marketplace_location` — Set FB Marketplace location

Leaf action. Opens the FB Marketplace "Change location" dialog and sets the
location for that account. Two modes:

| Mode | Behavior |
|------|----------|
| `auto` (default) | Clicks the **geolocation picker** button inside the dialog. Browser resolves coordinates from the proxy IP via the Geolocation API. No typing. |
| `manual` | Clicks the Location field, types `params.city`, picks the first suggestion. |

### Flow (both modes)

```
sidebar Marketplace link → /marketplace/   (fallback: direct goto + crash-page reload)
  → read current location from div[aria-label^="Location:"] (sidebar)
  → click location → "Change location" dialog opens
  → [auto]   click div[aria-label="Marketplace geolocation picker"][role="button"]
  → [manual] click Location field → type city → pick suggestion
  → wait for input value to actually change (poll up to 30s)
  → click div[aria-label="Apply"][role="button"]
  → reload marketplace → verify location text
```

### Guards (auto mode)

- **Old value captured first** before clicking the picker, then polled — only
  clicks Apply once the input value actually changed from the old one.
- **Philippines fallback detection** — if geolocation resolves to a Philippines
  city (proxy down → browser fell back to host IP, where most accounts were
  signed up), throws with the unchanged value so the run doesn't mark success
  on a no-op.
- **Permission popup** — `page.context().grantPermissions(['geolocation'], { origin: 'https://www.facebook.com' })` runs before the picker click. Falls
  back to `Browser.grantPermissions` over CDP if Playwright's version fails.
  Multilogin's CDP wrapping sometimes ignores both — when that happens, the
  unchanged-value guard catches it cleanly instead of false-success.

### Key selectors (from real DOM dump)

```
sidebar location:       div[aria-label^="Location:"]
dialog (scoped):        xpath=//div[@role="dialog"][.//span[text()="Change location"]]
location input:         input[aria-label="Location"][role="combobox"]
geolocation picker:     div[aria-label="Marketplace geolocation picker"][role="button"]
apply button:           div[aria-label="Apply"][role="button"]
crash page banner:      "Sorry, something went wrong" + div[role="button"][.//span[text()="Reload Page"]]
```

`div[role="dialog"]` alone is unsafe — FB renders multiple hidden dialogs
(Notifications, etc.). Always scope by the Change location title text.

### Crash page handling

Some accounts hit FB's `"Sorry, something went wrong"` error page on
`/marketplace/`. The action tries `Reload Page` once; if still broken,
throws with `err.noRetry = true` so the runner short-circuits instead of
burning 3 minutes on retries.

### Auto-injected params

| Param | Source |
|-------|--------|
| `city` | `user.city` (used in manual mode + as country check in auto mode) |
| `country` | `user.country` (controls IT-vs-US match detection) |

## `visit_profile` + `add_friend`

- `visit_profile` — navigator. `url` for specific target, `pool` for random pick. `url` wins.
- `add_friend` — leaf, two contexts via union locator:
  - Profile page: `[aria-label^="Add Friend"]` (capital F, dynamic suffix)
  - Inline search card: `[aria-label="Add friend"]` (lowercase f, exact)
- Scrolls button to viewport center via `scrollToCenter` before clicking.

| Pool | Source | Purpose |
|------|--------|---------|
| `friends` | `config/friend_targets.json` | Friend-request targets |
| `sharers` | `config/share_sources.json` | Pages/profiles posting daily — visit to scroll/like/share |
| `users` | `GET /api/profiles?status=Active` + `status=Need%20Setup` (parallel, deduped, limit=5 each) | Up to 10 random users across both statuses; empty/null `profileUrl` filtered out before random pick |

## `search` + `open_search_result` + `follow` + `connect`

| Action | Kind | Job |
|--------|------|-----|
| `search` | Navigator | Type query, submit, optionally click results-tab filter |
| `open_search_result` | Navigator | Pick `a[href*="/profile.php?id="]`, scroll center, click |
| `follow` | Leaf | Click `[aria-label="Follow"]` (works on profiles, pages, inline cards) |
| `connect` | Leaf | Click Add Friend / Follow / Like in priority order, on the loaded profile/page |

### `connect` details

Targets via has-text XPath on exact inner `<span>` text (`"Add friend"`, `"Follow"`, `"Like"`)
— stable across FB's aria-label variants. Already-followed/liked become `"Following"`/`"Liked"`,
so exact match naturally skips re-clicks. Uses `scrollIntoViewIfNeeded` (header is static
container, deterministic). Per target: presence → visibility → scroll → bbox → `humanClick`
→ verify gone. Only logs `Clicked "X"` after post-click verification. Never throws.

### `search` modes

| Mode | Generation |
|------|------------|
| `name` (default) | `{first} {last}` from country-matched 50×50 pools |
| `news` | `{region} {keyword}` — country-matched |
| `page` | `{category} in {city}` — country-matched categories; `city` from `user.city` |
| `general` | Country-matched local-topic phrase; randomly suffixed with `"near me"` / `"vicino a me"` OR `in {city}` (50/50). Falls back to `near me` alone when city is empty. |

**Country-aware** — `country` auto-injected from `user.country`. Per-country pools:

| Country | name pool | news regions | news keywords | page categories | general topics |
|---------|-----------|--------------|---------------|-----------------|----------------|
| `US` (default) | 100 first × 100 last, US names | 50 US states | 12 English keywords | 25 English categories | 50 English local-topic phrases ("best pizza", "thrift stores", ...) |
| `IT` | 50 first × 50 last, Italian names | 20 Italian regions | 12 Italian keywords | 25 Italian categories ("Ristorante", "Palestra", ...) | 50 Italian local-topic phrases ("pizza", "ristoranti", "aperitivo", ...) |

`normalizeCountry()` accepts loose forms (`it/ita/italy/italia` → `IT`, `us/usa/united_states` → `US`). To add another country, add the pools + alias mapping in `actions/search.js`.

Optional `filter`: `"People"`, `"Pages"`, `"Posts"`, `"Videos"`, `"Groups"` —
clicks results tab. Matched against visible `<span>` in `a[role="link"]`.

### `open_search_result` pick

1. `page.$$('a[href*="/profile.php?id="]')`
2. Dedupe by href (avatar + name link point to same target)
3. `pick`: `"random"` (default), `"first"`, integer index
4. `scrollToCenter` before click

`/profile.php?id=*` is FB's canonical URL for **both** users and pages —
filter type upstream via `search.filter`.

## `connect_loop` + `accept_loop` — friend-graph loops

Two leaf actions that iterate friend-graph activity in a single step instead
of requiring the caller to manually chain `visit_profile + add_friend` /
`visit_profile + connect`.

| Action | Loop body | Stops on |
|--------|-----------|----------|
| `connect_loop` | Pick random target from pool → visit → probe action button (priority: Add friend > Cancel request > Confirm request) → click + DB sync | `count` successful Add-friend presses, FB rate-limit modal, `maxAttempts`, empty pool |
| `accept_loop` | Fetch sender's `friendRequests[status="Pending"]` from the user record → for each, visit sender's profile → click "Confirm request" → PATCH record status=Accepted | List exhausted |

### `connect_loop` action-button priority

Exactly ONE button click per visited profile, picked in priority order:

1. **Add friend** → click + check rate-limit modal + POST `friend-request`
   record. Increments `successCount`.
2. **Cancel request** → already-sent state; no click, just sync the record
   (POST → 409-on-duplicate → PATCH status=Pending). Does NOT increment.
3. **Confirm request** → incoming request (you're the receiver); click only,
   no DB side effect, no count. Lets the same task pick up reciprocal adds
   along the way.

Trust model: a click is reported as pressed as soon as `humanClick` fires.
The rate-limit modal ("You Can't Use This Feature Right Now") is the only
failure signal — no DOM-state verification of the button afterwards, since
FB's DOM updates were producing false "click did not register" reports.

### `connect_loop.maxFriends` — target-side filter

When `pool: "users"`, candidates with `user.friends >= maxFriends` are
filtered out (already-popular profiles get fewer requests). Profiles with
no recorded count are still eligible; their count gets PATCHed during the
visit via `readFriendCount`.

### `connect_loop.skipIfFriendsAbove` — sender-side skip

Opt-in. When set, the action navigates to `/me` first, reads **this
account's own** friend count from the profile header (`a[href*="sk=friends_all"]
strong`), opportunistically PATCHes it back to the user record (sender
friend count is otherwise only updated when ANOTHER bot visits this
profile, so the DB value drifts stale), and skips the loop if the count
exceeds the threshold.

Use case: daily-engage tasks can keep firing `connect_loop` once per day
without manually pruning accounts that have already filled out their
target social graph.

```json
{ "type": "connect_loop", "params": { "count": 3, "skipIfFriendsAbove": 30 } }
```

Edge cases — none of these fail the action:
- Friend-count selector not found on `/me` → log and proceed without skip.
- `/me` navigation fails → log and proceed without skip.
- `senderId` empty → still does the skip check on the page-read count,
  just doesn't PATCH back.

Param omitted (default) → no `/me` navigation, original loop behavior.

### `accept_loop` — confirm pending incoming requests

Source list is the receiver's `user.friendRequests` array filtered to
`status == "Pending"`. Fetched fresh at action start, so a fast-moving
graph picks up new requests added between task runs.

For each pending sender, the action navigates to `sender.profileUrl`,
clicks "Confirm request" via the same XPath used by `connect_loop`, and
PATCHes the request record to `status: "Accepted"`. Senders whose profile
no longer renders the Confirm button (already accepted out-of-band, or
profile gone) are silently skipped.

Random wait between iterations: `waitMin`-`waitMax` seconds (default
30-60). Same anti-detection pacing as `connect_loop`.

## Feed actions — `like_posts` and `share_posts`

FB's feed is virtualized (off-screen posts unmount), but the **action buttons
themselves** are stable selectors. Both handlers query the buttons directly,
filter to ones currently in the viewport, pick one at random, and click. **No
post-container indirection** — `div[aria-posinset]` was unreliable on Page
timelines and across browser providers (Multilogin Chrome variant doesn't
always set it).

### Pattern (used by both)

```
query buttons → for each: read boundingBox → keep only ones with non-zero box
                in the viewport → dedup by bbox position → random pick → click
                → scroll a bit and try again until target count reached or
                MAX_ATTEMPTS (10) hit
```

Dedup key is `Math.round(box.x),Math.round(box.y)` — survives across iterations
within a single invocation.

### `share_posts` — selector and click strategy

Selector union (first match wins):
1. `div[role="button"]:has([data-ad-rendering-role="share_button"])` — anchors on FB's own internal marker; stable across feed/Page/locale
2. `[aria-label="Send this to friends or post it on your profile."]` — older feed variant
3. `div[role="button"][aria-label="Share"]` — Page variant fallback

Click uses **`btn.click({ force: true })`**: FB renders an overlay div with
`data-visualcompletion="ignore"` and `inset: 0px` covering the share button.
Without `force: true`, Playwright's actionability check fails the click as
"not visible" even though clicks reach the button. `force: true` bypasses
the gate — the click event still fires correctly.

### Context extraction — fallback chain

Walk up from the share button to find a post container:
1. `closest('[aria-posinset]')` → `closest('[role="article"]')` → `closest('[data-pagelet*="FeedUnit"]')` → `closest('[data-pagelet*="TimelineFeedUnit"]')`
2. Walk-up fallback: first ancestor that contains `[data-ad-rendering-role="story_message"]` or `[data-ad-comet-preview="message"]`

Then read text via 3 progressively looser selectors (marker `[dir="auto"]` →
marker root → any `[dir="auto"]` in container). Image: `img[data-imgperflogname="feedImage"]`
or any `img[alt]` with non-empty alt.

### `like_posts` — selector

`div[role="button"][aria-label="Like"]`. Same viewport-filter / random-pick
pattern. After click, 2-3s wait for FB to register, then 5-10s pause before
the next like.

### Key feed selectors

```
Share button:            div[role="button"]:has([data-ad-rendering-role="share_button"])
                         (fallback: aria-label "Send this to friends or post it on your profile.")
Share modal confirm:     [aria-label="Share now"]
Share message input:     [aria-placeholder="Say something about this..."]
Like (unliked):          div[role="button"][aria-label="Like"]
Like confirmed:          [aria-label="Remove Like"] or [aria-label="Unlike"]
```

## `share_post` — Share specific URL

Single-post version. Navigates to post URL directly, extracts context, shares with
static `message` OR API-generated via `userIdentity` + `instruction`.

## `publish_post` — Create a new post on the user's timeline

Leaf action. Publishes a new post (one or more images + AI-generated caption)
to the user's own profile.

### Flow

```
goto facebook.com/me  ← unconditional, /me is the known-good landing page
  → find page-level <input type="file" multiple accept*="image">
  → setInputFiles(tmpPaths)   ← THIS triggers FB's React modal-open handler
  → wait for div[role="dialog"][aria-label="Create post"] to appear (30s)
  → (best-effort) set audience to Public
  → wait for img[alt] preview inside dialog (45s)
  → click dialog-scoped textbox div[role="textbox"][data-lexical-editor="true"]
  → focus() + humanType(caption)
  → click div[role="button"][aria-label="Post"]
  → wait for dialog detach (60s) = success signal
  → unlink all tmp files in finally
```

### Caption sources — `captionSource` param

Three modes, in priority order:

1. **Explicit `params.caption`** — always wins (used for testing or hardcoded text).
2. **`captionSource: "post"`** — uses the picked entry's `user.posts[].caption`
   (auto-injected as `postCaption` by `injectUserParams`). Falls back to AI if the
   field is empty. Use this when captions are pre-generated and stored in the DB.
3. **`captionSource: "ai"` (default)** — `generatePostCaption(userIdentity, postContext)`
   generates a fresh voice-matched caption each call.
4. Empty (post goes captionless).

```json
{ "type": "publish_post" }                                              // ai (default)
{ "type": "publish_post", "params": { "captionSource": "post" } }       // use DB caption
{ "type": "publish_post", "params": { "caption": "hardcoded text" } }   // explicit
```

The Gemini system prompt (`system_prompt_post.txt`) does the heavy lifting for AI
mode: persona matching from `userIdentity`, 50-reasons-people-post-on-Facebook
fallback when `postContext` is vague, emoji/hashtag restraint, no AI tells.

**Pre-generating + storing captions** (use `captionSource: "post"` to consume):
`update-post-captions.js` regenerates `user.posts[].caption` for a list of user IDs
using the same Gemini path, then PATCHes them via the `/api/posts/:postId` endpoint
(see [User API → post caption updates](#utilsuserapijs) — `posts` are stored in
their own collection, NOT updatable via `PATCH /api/profiles/:id`).

### Composer modal-vs-inline — why we skip every click

FB serves the post composer in two layouts depending on where the session
lands after the homepage navigation:

| Layout | Trigger | Behavior |
|--------|---------|----------|
| Home Feed | `div[role="button"]` "What's on your mind?" | Click opens the Create post modal. `Photo/video` is INSIDE the modal. |
| `/me` Profile | `[role="textbox"]` + inline quick-action row | Clicking the textbox just focuses it. Clicking the inline `Photo/video` triggers a NATIVE file chooser, which Playwright auto-cancels without a `waitForEvent` listener — modal never appears. |

Both layouts mount a hidden `<input type="file" multiple
accept="image/*,video/*,...">` in the page DOM as part of the composer
surface. **Calling `setInputFiles` directly on that input fires FB's React
change handler, which opens the modal with previews loaded.** This bypasses
every click-trigger ambiguity, works identically on both layouts, and avoids
the native-chooser auto-cancel trap.

The CLAUDE.md `setup_avatar` warning ("Do NOT use `setInputFiles` on the
hidden input") is about a different React state path — it does not apply to
the composer's flow.

### Other gotchas

- **Lexical textbox locator MUST be scoped to the dialog**
  (`dialog.locator('div[role="textbox"][data-lexical-editor="true"]').first()`).
  FB pre-renders ~4 hidden Lexical editors page-wide (Stories composer,
  Marketplace search, etc.). A page-level `.first()` grabs an off-screen
  instance, Playwright auto-scrolls the page to it (the visible "scroll
  jump"), focus + keys land on the wrong editor.

- **`textbox.click()` (NOT `humanClick`).** Direct locator click — humanClick's
  bbox-center offset can miss padded child hit regions on modal targets.

- **Audience widget timeout is non-fatal.** When the account already defaults
  to Public, `[aria-label="Audience selector"]` never renders and our 3s
  wait warns + continues. Real (non-default) audience changes still work.

### Auto-injected params

| Param | Source |
|-------|--------|
| `imageUrls` | random pick from `user.posts[].images`, each `{filename}` resolved through `buildImageUrl(IMAGE_SERVER_BASE_URL + filename)` |
| `postContext` | `pick.context` (the picked entry's image description) |
| `userIdentity` | `user.identityPrompt` |

Explicit params always win.

## `wait` — Idle action

Two modes:
- `{ "duration": 30 }` — fixed seconds.
- `{ "min": 10, "max": 30 }` — random uniform in range (seconds).

`duration` wins if both set. Defaults to 5s.

## `utils/generateMessage.js` — Share message generation

Used by `share_posts`/`share_post` when `userIdentity` is set.

`.env`:
```
GITHUB_MODELS_TOKEN
GITHUB_MODELS_MODEL       # default: openai/gpt-4.1
GITHUB_MODELS_BASE_URL    # default: https://models.github.ai/inference/chat/completions
GITHUB_MODELS_API_VERSION # default: 2026-03-10
```

- Returns plain string for share dialog.
- Returns `''` on API error → share proceeds silently.
- Returns `''` if model says `SKIP` (empty/unreadable context).
- Sanitizes em/en dashes + spaced hyphens → space. In-word hyphens preserved.

Prompt baked-in: always English, 5-20 words, plain, no hashtags/quotes.
Matches persona style. Never starts with "Check this out", "Pretty cool", "Wow",
"Interesting". Reacts to post mood.

`userIdentity` alone triggers API. `message` (static) wins over API.

## `utils/generatePostCaption.js` — Original post caption generation

Used by `publish_post` to generate first-person captions for an account's own
timeline posts (NOT reactions to someone else's content — that's
`generateMessage`).

Same Gemini env vars as `generateMessage` (`GEMINI_API_KEY`, `GEMINI_MODEL`),
but reads from a separate `system_prompt_post.txt` at the repo root. Split
marker on read: `/^##\s*Input Format|^INPUT FORMAT:/im` (matches either the
markdown-heading or the legacy line-marker form).

Differences from `generateMessage`:

- Voice-first prompt — persona match is the north star. A 22-year-old in
  marketing writes nothing like a 55-year-old engineer.
- 50-reasons fallback: when `postContext` is vague ("four lifestyle shots",
  "person at a place"), the prompt picks the most believable posting reason
  from a 50-entry list (photo dump, birthday shoutout, conference, etc.)
  cross-referenced against the user's age + job + hobbies + relationship.
- Caption length: 1-3 sentences typical, 4-6 OK for photo dumps. Never an
  essay.
- Emojis: ~50% chance of 1-2 emojis, biased lower for older / professional
  personas.
- Higher temperature (`0.95` vs `0.9`) and longer `maxOutputTokens` (300 vs
  200) for more identity variance.

Returns plain string, or `''` on API error / SKIP / empty. Same em/en-dash
sanitization as `generateMessage`. `params.caption` (static) wins over the
API call. `userIdentity` alone triggers the call; `postContext` is
recommended but optional.

## `outlook_login` — Sign in to outlook.com

Leaf action. Navigates to `outlook.live.com/mail/?prompt=select_account` and
walks Microsoft's login flow. `prompt=select_account` forces the email-entry
form even when a cached account exists (otherwise FB-style cached-tile flows
land us on the marketing page).

### Flow

```
goto outlook.live.com/mail (with prompt=select_account)
  → if URL already on /mail → return early (signed in)
  → probe "Use another account" tile BEFORE waitForSelector(#i0116) — when
    present, the email input is hidden until clicked; reverse order burns 60s
  → wait for #i0116 (email input), 60s timeout
  → fillFormInput #i0116 + click #idSIButton9
  → fillFormInput input[name='passwd'] + click button[data-testid='primaryButton'], #idSIButton9
  → detectCredentialError(page) — fast-fail on Microsoft rejection (~2s)
  → walkPostLoginPrompts(page) — 12 ticks × 2.5-3.5s
      KMSI → Yes (gated on "Stay signed in?" header text, NOT #idSIButton9 alone)
      Passkey/FIDO → Skip for now (gated on /fido|/passkey URL)
      Protect-account → Skip for now
      Generic Not now / Skip setup / iCancel / idBtn_Back
      every tick: detectCredentialError check (in case the banner appears late)
  → if final URL not on outlook.live.com/mail → goto inbox to normalize
```

Credentials auto-injected from the user record:
- `email` ← `user.emails.find(e=>e.selected)?.address || user.emails[0]?.address`
- `password` ← `user.emailPassword`

### Credential rejection — fast-fail patterns

`CREDENTIAL_ERROR_PATTERNS` (regex, case-insensitive). Matched against rendered
page text by `detectCredentialError(page)`:

```
/that password is incorrect/i
/your account or password is incorrect/i
/incorrect account or password/i           ← word-order variant
/tried to sign in too many times/i         ← rate-limit
/we couldn't find an account with that username/i
/this username may be incorrect/i
/sign-in is blocked/i
/your account has been locked/i
/account has been temporarily blocked/i
```

When matched, throws `Error('outlook_login: credentials rejected (<reason>)')`
with `err.credentialsRejected = true` + `err.noRetry = true`. Runner catches,
PATCHes `status: "Need Checking"`, writes the specific reason to the tracker
log (see Network resilience > Credential rejection short-circuit above).

Check runs in TWO places:
1. Immediately after the password submit (~2s after click) — fast-fail
2. At the top of every `walkPostLoginPrompts` tick — catches delayed banner renders

### Failure forensics — `dumpFailure(page, label)`

Whole action wrapped in try/catch. On ANY throw, writes to `logs/`:
- `outlook-error-<email-prefix>-<ISO-ts>.html` (with URL embedded as HTML comment)
- `outlook-error-<email-prefix>-<ISO-ts>.png` (full-page screenshot)

Then re-throws. The dump itself swallows its own errors so a dump-on-dump
failure can't mask the original. Always check the screenshot first when
debugging — it usually shows the Microsoft error inline.

### Why Multilogin can fail when manual login works

A successful manual login in a normal browser + a failing automated login in
Multilogin with the SAME password almost always means **proxy IP reputation**.
Microsoft's risk engine silently rejects logins from flagged datacenter /
abused residential IPs with the generic "incorrect password" message — it
won't reveal the real reason. Verify by hitting `ipqualityscore.com` /
`scamalytics.com` on the proxy IP. Fix is to rotate the proxy, not the
credentials. The `Need Checking` flag from the runner correctly surfaces this
for manual review regardless of root cause.

## Network resilience — `runner.js`

### Timeouts (per browser)

```javascript
page.setDefaultNavigationTimeout(90000);
page.setDefaultTimeout(60000);
```

### Step retry

Every handler is wrapped in `runWithRetry(fn, profileId, stepType, page)`:
- Network errors (ERR_CONNECTION, ETIMEDOUT, ECONNRESET, proxy, timeout): wait 60s
- Other errors (selector, params, DOM): wait 5s
- 3 attempts max.

`err.noRetry = true` opts out — handlers with internal retries (e.g. `create_page`)
set this so `runWithRetry` won't restart and re-trigger committed side effects.

### Generic step-failure dump — safety net

After the retry loop exhausts, `runWithRetry` calls `dumpStepFailure(page, stepType, err)`
to capture HTML + full-page PNG into the per-profile run-scoped folder:

```
logs/{taskId}-{ts}/profiles/{Name}-{shortId}/
  fail-{stepType}-{ISO-ts}.html  ← <!-- step: ... --> <!-- url: ... --> <!-- error: ... -->
  fail-{stepType}-{ISO-ts}.png   ← fullPage screenshot
```

This fires for **every** step failure, regardless of whether the action's own
internal `dumpFailure` ran. The error message is embedded in the HTML comment
alongside the URL — open any `fail-*.html` standalone and you immediately know
what step failed, where, and why.

To avoid double-dumps, the runner sets `err.dumped = true` after writing — if
both the runner and an action's internal dump fire, only the first runs.
Actions that need an action-specific dump (e.g. `marketplace_location` capturing
the dialog state mid-flow) can still dump WITHIN the catch; the runner-level
dump on the same error is then skipped.

### Summary log — `summary.md`

After every `runTask` invocation, the runner writes `summary.md` to the
run-scoped log directory alongside `tasks-logs.log`:

```
logs/engage-and-add-20260528-XXXXXX/
  tasks-logs.log
  summary.md           ← per-run summary
  profiles/...
```

Contents: started/finished timestamps, total duration, success/fail counts,
per-profile avg/min/max, and **profile name + ID + elapsed time + error message**
for every failure. Successes are listed too (name + ID + elapsed). Console output
also includes the profile name now (`- Rocco Pellegrini [6a0d52c7...]`), not just
the ID — easier triage at a glance.

### Recovery chain — `utils/recoverers.js`

Between attempts, `runWithRetry` calls `tryRecover(page, { stepType })` from
`utils/recoverers.js`. This is a registry of `(matches, apply)` pairs that
try to fix the current page state before the next retry. `tryRecover`
returns `{ recovered, unfixable }` — three possible outcomes drive the
retry behavior:

| Outcome | Recovery `apply()` returned | Runner behavior |
|---|---|---|
| **recovered** | `true` | Retry wait shrinks from 60s → 2s; next attempt fires on the now-usable page |
| **unfixable** | `'unfixable'` | URL/state is a known dead-end (e.g. consent flow we don't yet handle). Remaining retries SKIPPED — step soft-fails immediately. Burning 3×60s on a deterministic block is waste. |
| **neither** | `false` from every matched recoverer (or none matched) | Normal 60s wait + retry |

```js
{
  name: 'eu-cookie-consent',
  matches: (page) => /* tight URL check, NOT loose substring */,
  apply: async (page) => {
    // wait → reading delay → click button
    // returns true on success, false on "matched but couldn't fix",
    // or 'unfixable' on "this URL has no resolution today"
  },
}
```

**Current registry (order matters — first match fires):**
1. **`eu-cookie-consent`** — FB redirects mid-navigation to
   `/privacy/consent/?flow=user_cookie_choice_v2&...` and blocks every
   subsequent navigation until the cookie banner is dismissed. Clicks
   `div[aria-label="Allow all cookies"]` after a 2.5-4.5s reading delay,
   waits for the URL to leave `/privacy/consent/`. Matcher requires
   `flow=user_cookie_choice_v2` explicitly so it doesn't bleed into the
   ad-free flow below.
2. **`ad-free-subscription`** — EU "pay-or-consent" funnel at
   `/privacy/consent/?flow=ad_free_subscription`. 4-step click sequence
   captured from real session HTML:
   1. `aria-label="Get started"`
   2. Select "Use free of charge with ads" → `Continue`
   3. `Agree` (data-processing info screen)
   4. `OK` (ad-experience review)
   Then waits for the URL to leave `flow=ad_free_subscription`. Each
   click has its own reading delay (1.5-5s) calibrated to the modal
   text length. Per-profile this fires ONCE — FB remembers the choice
   indefinitely.
3. **`data-settings-review`** — GDPR "Required: Review Your Data
   Settings" funnel at `/privacy/consent/?flow=consent_next_3pd`.
   Often appears right after `ad-free-subscription` finishes; the
   3-attempt step-retry budget handles both back-to-back. 3-step
   click sequence:
   1. `aria-label="Get started"`
   2. `Accept and continue`
   3. `Done`
   Then waits for the URL to leave `flow=consent_next_3pd`. Fires
   once per profile lifetime.
4. **`soft-checkpoint`** — URL contains `/checkpoint/`. Clicks the
   `div[aria-label="Dismiss"][role="button"]` after a 3-5s reading delay.
   Returns false on hard checkpoints (no Dismiss button — banned /
   verification required), letting `runner.js`'s checkpoint
   short-circuit kick in.
5. **`not-now-modal`** — generic `div[role="button"][aria-label="Not now"]`
   probe. Catches FB's intermittent upsell modals after a 1.2-2.5s
   reading delay.

**Multi-step recoverers use two helpers** (`utils/recoverers.js`):

- `waitClickByLabel(page, ariaLabel, { waitMs, readMin, readMax })` —
  for buttons FB labels via aria-label (e.g. "Get started").
- `waitClickByText(page, visibleSpanText, { waitMs, readMin, readMax })` —
  for buttons FB renders as `div[role="button"]` with a child `<span>`
  bearing the visible label (e.g. "Continue", "Agree", "Accept and
  continue"). XPath uses `normalize-space + contains()` fallback so
  trailing whitespace doesn't defeat the match.

Both add a reading delay between detection and click, log a clear
no-match line on timeout, and never throw — return false on miss so
the caller can decide whether to abort the recovery or continue.

**Reading delays are calibrated to the modal.** A real user reads the
content before clicking — instant-click is a strong bot tell. Each
recoverer uses `humanWait(page, min, max)` between detection and click,
range tuned to the modal's text length.

**`facebook_signup.js` polling integration.** The 5-minute home-button
wait after submit is **not** a single `waitFor` — it polls in 15s
windows, calling `tryRecover` each cycle. Catches the EU cookie consent
screen mid-redirect (a single `waitFor` would just sit on it until the
5-minute timeout). This is wired into `ensure_login`'s auto re-auth
path too, since `ensure_login` delegates to `facebook_signup`.

**Adding a new recoverer:**
1. Append to `RECOVERERS` with `{ name, matches, apply }`.
2. `matches(page)` should be cheap — URL-based or quick selector probe.
   Return boolean (sync or async). Tight matchers are mandatory — a loose
   substring like `/privacy/consent/` will bleed into multiple FB flows
   (cookie banner vs ad-free upsell) and trigger the wrong fix.
3. `apply(page, ctx)` returns one of THREE values:
   - `true` → page is fixed, runner retries with 2s wait
   - `false` → matched but couldn't fix this time (e.g. button not
     visible yet); chain moves to the next recoverer AND runner
     continues its normal 60s-wait retry path
   - `'unfixable'` → URL/state is a known dead-end with no resolution
     today (e.g. a consent flow we don't yet implement). Runner SKIPS
     remaining retries — step soft-fails immediately. Use this when
     the page is identifiable but the fix is non-trivial work for
     later.
4. Errors inside both `matches` and `apply` are caught and logged in
   `tryRecover` — never propagated. A buggy recoverer can never break
   the actual error reporting.
5. Order matters — list cheapest / most-specific first.

**Browser-dead short-circuit.** When the underlying chromium / CDP socket
dies (MLX session timeout, native crash, navigation broke the page),
Playwright throws `Target page, context or browser has been closed` on
every subsequent operation. `runWithRetry` detects this message pattern
on a step error, sets `err.browserDead = true` + `err.noRetry = true`,
and breaks the retry loop. `runBrowser`'s per-step catch then treats
`err.browserDead` as a third abort condition (alongside checkpoint and
credentials-rejected): tracker note gets `FAIL at <step>`, remaining
steps are skipped, profile-folder is renamed FAIL. **Status is NOT
PATCHed to Need Checking** for browser-dead — the cause is usually
MLX-side (session timeout, agent crash) and the FB account itself is
fine. Without this short-circuit, every remaining step burns 3×60s on
the same closed-page error before soft-failing.

**Checkpoint short-circuit:** FB redirects flagged accounts to
`/checkpoint/{id}/?next=...` URLs. Retrying any step from that state is
pointless. Detected in three places:

1. **Pre-flight** (`runBrowser`, immediately after the facebook.com nav,
   before any task step runs). Catches profiles that were already on a
   checkpoint when the browser opened, OR that FB redirected after the
   nav. Failure here is reported as `FAIL at pre_flight_checkpoint` (not
   misattributed to whatever step would have run first).
2. **Step error** (inside `runWithRetry`, when a step throws). The URL is
   re-read on every error tick; if it contains `"checkpoint"`, the retry
   loop short-circuits.
3. **Post-step sweep** (after each successful step in `runStep`). Catches
   FB redirects that didn't throw — e.g. a like_posts that finishes its
   clicks while the next navigation lands on `/checkpoint/`.

All three call `tryDismissSoftCheckpoint(page)` first. Some checkpoint
URLs are "soft" — FB shows a modal with a Dismiss button on top of an
otherwise functional page. The helper:

- Waits `domcontentloaded` (10s) so the modal has time to mount.
- Waits up to 10s for `div[aria-label="Dismiss"][role="button"]` to be
  visible (`waitFor`, NOT `isVisible({timeout})` — the latter only
  partially honors the timeout and the previous 2s probe was firing
  before the modal mounted).
- **No warning-text gate.** Callers have already confirmed the URL
  contains `"checkpoint"`, so any Dismiss button on the page IS the
  checkpoint dismiss. The text gate previously made the helper brittle
  to FB's wording + locale tweaks.
- If clicked, returns true → retry continues on the now-clean page.

If the dismiss helper returns false (hard checkpoint, no Dismiss button),
the error is tagged `err.checkpoint = true` + `err.noRetry = true`,
`runWithRetry` breaks the loop, `runBrowser`'s catch logs
`Checkpoint hit during <step> — skipping remaining steps for this profile`,
PATCHes the user record `{ status: "Need Checking" }`, fires the tracker
log, and the worker moves on. **Before throwing, `dumpCheckpointState` in
`runner.js` writes the page HTML + full-page PNG to the profile folder**
(`checkpoint-preflight-<ts>.{html,png}`, `checkpoint-step-<type>-<ts>`,
`checkpoint-post-<type>-<ts>`) so the actual checkpoint variant can be
inspected later — was it a real hard checkpoint, or a soft modal variant
the dismiss helper didn't recognize?

**Credential rejection short-circuit:** handlers like `outlook_login` set
`err.credentialsRejected = true` + `err.noRetry = true` when Microsoft
returns "incorrect account or password" / "we couldn't find an account" /
soft-lock messages. `runWithRetry` does NOT retry (noRetry); `runBrowser`'s
per-step catch logs `Credentials rejected during <step> — flagging profile`
and PATCHes the user record `{ status: "Need Checking" }`. The tracker
log entry written in the finally block carries the *specific* Microsoft
message (e.g. `FAIL at outlook_login (1m 4s): outlook_login: credentials
rejected (incorrect account or password)`) so triage can distinguish
"checkpoint" vs "bad password" vs "rate-limited" vs "account doesn't exist"
from the same `status: "Need Checking"` flag.

Constants: `STEP_RETRY_ATTEMPTS=3`, `RETRY_WAIT_MS=60000`.

### Auto-navigate before first step

If not on facebook.com, `runBrowser` navigates first.

### Auto re-login

After the nav, `runBrowser` calls
`isLoggedOut(page, { profileProbeUrl, country, excludeUserId })`
(from `ensure_login`). Three detection signals:

1. URL match — current URL contains `/login` or `login.php`
2. Password field — `input[name="pass"]` visible on the page
3. Profile probe — navigate to a real FB profile URL; if FB rewrites it to
   `/people/...` or `/pfbid...`, the session is browsing as guest

**Probe URL selection (when quick signals don't fire):**

1. `options.profileProbeUrl` if it starts with `http(s)://` — usually
   `user.profileUrl`, the account's own canonical URL captured by
   `setup_about`.
2. **API fallback** — when `profileProbeUrl` is empty OR doesn't look like
   a URL (e.g. a stray email pasted into the field by mistake),
   `pickFallbackProbeUrl(country, excludeUserId)` calls
   `fetchActiveProfiles(5, country)` and picks a random Active /
   Need-Setup profile from the same country, excluding the current
   user's own `_id`. So an IT user gets probed against a random IT
   profile, a US user against a US one — the proxy region matches the
   probed URL's expected geo, which keeps FB from flagging the probe as
   suspicious.
3. No probe target → skip the probe step; rely on the quick signals only.

The fallback is what saved us from `Cannot navigate to invalid URL`
crashes when a user record had its email accidentally stored in the
`profileUrl` field — without it, `isLoggedOut` returned `false` (probe
failure is non-fatal) and the runner pressed on assuming the session was
authenticated.

**Gate:** the auto re-login only runs when the task actually touches Facebook.
`taskNeedsFacebookSession(steps)` walks the (injected) step tree and returns
false if every step type is in `NON_FB_STEP_TYPES = {'outlook_login',
'check_ip', 'wait'}`. An outlook-only task would otherwise be hijacked by the
FB signup form (since the profile is logged out of FB by default). Logs
`Skipping auto re-login — no step in this task requires a Facebook session.`
when skipped.

If logged out (and the task requires FB), `ensure_login` is invoked as a
synthetic step before any task step runs. Re-auth strategy is **not** the login form — it navigates to
`https://web.facebook.com/reg/?entry_point=login&next=` and re-runs the
signup form fill via `facebook_signup` (called with `skipPostSetup: true` so
it stops at the home href — no `/settings/bundled` walk, no status PATCH).
The bundled-settings walkthrough is now a separate `setup_privacy` action.
All signup params auto-injected from the user record.

`facebook_signup` detects when the URL already contains `/reg/` and skips its
own facebook.com nav + "Create new account" click — that's what makes the
delegation work.

Failures log `FAIL at ensure_login: ...` and short-circuit the profile with
`noRetry`.

**`ensure_login` vs `facebook_login`:** `ensure_login` is the auto session
recovery (signup-as-login). `facebook_login` is a separate password-form
login action that lives next to `facebook_signup`. Don't conflate them.

### Crash diagnostics — `run-task.js`

Bot exits "out of nowhere" used to leave no clue why. `run-task.js` now
installs four diagnostic surfaces; the LAST line printed before the prompt
returns tells you the cause:

| Banner | Meaning |
|---|---|
| `!!! Received SIGINT / SIGTERM / SIGBREAK / SIGHUP` | External kill — Ctrl+C, terminal close, RDP drop, taskkill. Signal handlers force a print + `process.exit(130|143)`. |
| `!!! beforeExit (code N)` | Event loop drained naturally — every worker resolved OR every pending promise was silently dropped. |
| `!!! UNHANDLED REJECTION` / `!!! UNCAUGHT EXCEPTION` | Async rejection or sync throw escaped — stack trace follows. |
| `!!! process.exit(N)` | Always the final line. Reports the exit code. |

Plus a heartbeat every 30s:
`[heartbeat] alive Xm Ys | handles=N requests=M | rss=N MB heap=U/T MB ext=N MB`.

- `handles=` / `requests=` from `process._getActiveHandles()` /
  `_getActiveRequests()` — libuv-tracked work keeping the loop alive.
- `rss` / `heap` / `ext` from `process.memoryUsage()` — `rss` is the
  number Windows sees. A slow climb across the run = a leak; a sudden
  spike right before death = a runaway allocation. Both are visible
  live now, not only in retrospect.

If the last heartbeat is at T-30s before the prompt returns, Node died
abruptly. If heartbeats go silent first, then output stops, then prompt
returns — slow drain. `setInterval` is `.unref()`d so the heartbeat alone
can never block exit.

**Windows-specific gotchas:**
- **VS Code integrated terminal is unsafe for long-running bots.** When
  VS Code auto-updates, reloads its window, crashes its extension host,
  or suspends background work while the laptop sleeps, it kills its
  child processes via `TerminateProcess` — no signal, so our
  SIGINT/SIGHUP/SIGBREAK/SIGTERM handlers never fire, and there's no
  System / Application / Kernel-Power event log entry to find later.
  Death looks identical to a `taskkill /F`: `tasks-logs.log` cuts off
  mid-step with no banner. **Run the bot from a non-VS-Code PowerShell
  window**, or from a watchdog loop, for runs longer than a few
  minutes. This was the cause of the silent 60-80 minute deaths on
  `task-daily-engage.json` before we tracked it down.
- **QuickEdit Mode**: clicking in the PowerShell window pauses stdout. Node
  keeps running but `console.log` blocks. Right-click title bar → Properties
  → uncheck QuickEdit.
- **Tee-Object buffering**: PowerShell's `Tee-Object` batches stdout, so the
  last few seconds (including the diagnostic banner) may be in the buffer
  when the pipe closes. Prefer `Start-Process node -ArgumentList "run-task.js"
  -RedirectStandardOutput "run.log" -NoNewWindow` for forensics.

`run-task.js` also accepts a positional task file argument:
`node run-task.js [task-file]` (defaults to `tasks.json`). Lets us run
alternates without juggling the main file.

### Open-time tab cleanup

Right after the page timeouts are set (before media-blocking), `runBrowser`
closes every page in the context except `session.page`. Catches welcome tabs,
session-restore tabs, and any extras Hidemium / Multilogin happen to launch
with. Logs `Closed N extra tab(s) on open` when there were any.

### Orphan-chromium reaper (Windows-only)

`closeBrowserWithTimeout` races `browser.close()` against a 10s timer.
When the timer wins, the CDP socket is abandoned — but the underlying
chromium process is NOT necessarily killed. The MLX agent's `stop`
endpoint sometimes acks the request without actually terminating
chromium server-side, so over a long run the leaked browsers accumulate
and eventually starve the machine.

The reaper closes that gap. On a `browser.close()` timeout,
`closeProfile`:

1. Looks up the PID listening on the abandoned CDP port via
   `netstat -ano -p TCP`.
2. Verifies the process **name contains "chrom"** (so we never kill
   node / the MLX agent / unrelated listeners), **isn't this Node
   process**, and exists at all.
3. Force-kills it with `taskkill /F /PID <pid>`.

On success: `[browserManager] Reaped orphan chrome.exe PID 12345 on port 54277 for b210ca0f`.

Non-Windows is a no-op; safety checks all swallow errors. The reaper
runs in addition to the existing MLX / Hidemium `stop` calls, not
instead of them — `stop` still gets a chance to clean up MLX-side
bookkeeping first.

Related fix: `closeBrowserWithTimeout` previously leaked a 10s
`setTimeout` on every successful close (the timer was never cleared,
so the "timed out / abandoning CDP" warning fired AFTER the profile
had already closed cleanly, holding an active libuv handle for the
full 10s). The race now `clearTimeout`s in a `finally` block — the
warning is now only emitted on real timeouts.

### End-of-task tab cleanup

After all steps complete (in the success path, after the tracker-log finally),
`runBrowser` opens a fresh `about:blank` tab and closes every other page in
the context. Net result: one blank tab visible during the 10-15s cooldown
before the profile is closed.

### Delays

- Between top-level steps: 5-15s
- Between child steps: 5-15s
- After all steps: 10-15s cooldown before close

### Resumable state — `state/{taskId}.json`

`runTask` persists a per-profile completion map to `state/{taskId}.json`
after every profile finishes (success OR error). On startup it reads
that file and **skips profiles already marked done in this state**, so
a process killed mid-batch — by the hypervisor, OOM, taskkill, or a
native crash — picks up where it left off instead of re-running every
profile from scratch.

```
state/engage-and-add.json
{
  "taskId": "engage-and-add",
  "profilesHash": "<sha1 of sorted profile ids>",
  "startedAt": "2026-05-23T04:03:36Z",
  "lastUpdatedAt": "2026-05-23T04:47:00Z",
  "completed": {
    "<userId>": { "status": "success" | "error",
                  "completedAt": "<iso>",
                  "elapsedSec": <num>,
                  "error": "<message>"  // only on error
                }
  }
}
```

Lifecycle:
- **Load** at task start. Hash mismatch (profile list edited) → start
  fresh. File missing / unparseable → start fresh.
- **Write** sync after each profile completes (success or error both
  count — re-running shouldn't re-attempt either). Uses
  `writeFileSync` + atomic `renameSync` so a hard kill mid-write can't
  corrupt the file.
- **Clear** automatically when every profile in the task is in the
  completed map — so tomorrow's run starts clean while a same-day
  restart resumes.
- **Manual clear**: `node run-task.js task-daily-engage.json --fresh`
  wipes the state for that taskId before the run starts.

Errored profiles are treated as completed (don't auto-retry inside the
same state). The next manual run starts fresh because the file was
auto-cleared at task end; if you want to retry only the errored ones,
edit `completed` and remove their entries before re-running, or pass
`--fresh` to redo everything.

`state/` is gitignored.

### `injectUserParams(steps, user)`

Walks step tree before execution, fills missing params from user record.

| Step | Injected |
|------|----------|
| `setup_about` | `bio`, `city`, `hometown`, `personal`, `work`, `education`, `hobbies`, `travel`, `userId`, `profileUrl` (current value — empty triggers capture+PATCH) |
| `setup_avatar` | `photoUrl`, `userIdentity`, `userId` |
| `setup_cover` | `photoUrl`, `userId` |
| `setup_privacy` | `userId` |
| `create_page` | `pageName`, `bio`, `email`, `city`, `state`, `zipCode`, `streetAddress`, `profilePhotoUrl`, `coverPhotoUrl`, `userId` |
| `schedule_posts` | `posts` from `linkedPage.posts` |
| `switch_profile` | `userName` from `firstName + lastName` |
| `search` | `city` from `user.city` (page/general modes), `country` from `user.country` (all modes — IT vs US pool selection) |
| `marketplace_location` | `city` from `user.city`, `country` from `user.country`, `userId` |
| `check_ip` | `userId` |
| `share_posts` / `share_post` | `userIdentity`, `userId` |
| `publish_post` | `imageUrls` (random pick from `user.posts[].images`, resolved via `buildImageUrl`), `postContext` (picked entry's `context`), `postCaption` (picked entry's `caption` — used when `captionSource: "post"`), `userIdentity`, `userId` |
| `facebook_signup` / `ensure_login` | `firstName`, `lastName`, `birthdayDate` (or `dob`), `gender`, `email` (selected or `[0]`), `password` from `user.facebookPassword` |
| `facebook_login` | `email` (selected or `[0]`), `password` from `user.facebookPassword` |
| `outlook_login` | `email` (selected or `[0]`), `password` from `user.emailPassword` |

Explicit params always win.

## `create-profile.js` — Hidemium profile creation

```bash
node create-profile.js <userId> [userId2] ...
```

Per userId:
1. `fetchUser(userId)`
2. **Proxy pool** — `selectWorkingProxy(userId, user.proxies)`:
   - 5 rounds × 10 proxies = 50 max
   - `GET /api/proxies?status=pending&limit=10` per round
   - `testProxy(proxy)` via ipinfo.io (20s)
     - fetch fail → `PATCH proxies/:id { status:"dead" }`, continue
     - country ≠ requireCountry → skip (leave pending)
     - works + matches → `PATCH proxies/:id { status:"active", lastKnownIp }`, break
   - `PATCH profiles/:userId { proxies: [...existing, { proxyId, assignedAt }] }`
   - Throws if no working proxy
3. `POST {HIDEMIUM}/create-profile-custom?is_local=true` — local profile (lifetime plan unlimited; cloud quota fails as "Usage limit reached")
4. Success: response body has `uuid`. No `status: "successfully"` wrapper.
5. `POST /update-note` with `{ uuid, note }` — note not accepted on `create-profile-custom`, must be set separately. Contains `ip/city/region/country/loc/org/postal/timezone`.
6. `PATCH /api/profiles/{userId} { browsers: [{ browserId: uuid, provider: "hidemium" }] }`

### Profile body (FB-optimized)

- `os: "win"`, `osVersion` random `["10","11"]`, `browser: "chrome"`, `version: "136"`
- `canvas: "noise"` (NOT `"perfect"` — identical across fleet — or `"off"` — leaks)
- `webGLImage`, `webGLMetadata`, `audioContext`, `clientRectsEnable`, `noiseFont` all `true`
- `hardwareConcurrency` random `[4,8,12,16]`, `deviceMemory` `[4,8,16]`, `resolution` `["1920x1080","1366x768","1536x864","2560x1440"]`
- `proxy: "HTTP|host|port|user|pass"` (pipe-separated, NOT colon)
- `language: "en-US"`, `StartURL: "https://www.facebook.com"`, `disableAutofillPopup: true`
- `userAgent` omitted — Hidemium derives from os+browser+version (mismatches get detected)

Timezone + geo auto-derived from proxy IP.

Multilogin profile creation: not implemented in `create-profile.js` yet (assumes
profile exists in MLX dashboard). Profile fetch + linking via `browsers[]` works.

## `multilogin/` helper scripts

Standalone ESM scripts for MLX-side operations the bot itself doesn't
perform. Each one signs in with `MULTILOGIN_EMAIL` / `MULTILOGIN_PASSWORD`,
refreshes into `MULTILOGIN_WORKSPACE_ID`, then calls the relevant MLX
endpoint. Run with plain `node multilogin/<script>.js`.

| Script | Job | Key endpoints |
|---|---|---|
| `create_profiles.js` | Batch-create MLX profiles for every userId in `profiles.json`. **Thin wrapper around `createMultiloginProfile` from `utils/browserManager.js`** — single source of truth with the runtime auto-provision path. Skips users that already have a `provider: "multilogin"` entry in `browsers[]`. Sets the MLX `notes` field to the user's Mongo ObjectId so `export_delivery.js` can join the records later. | `POST /profile/create`, `PATCH /api/profiles/:id` (link browserId) |
| `assign_us_proxy.js` | Batch-assign country-matched proxies to every MLX profile in `profiles.json`. **Thin wrapper around `assignCountryProxy` from `utils/browserManager.js`** — picks region from `COUNTRY_REGIONS[user.country]` (US: random state, IT: random region). Verifies post-assign via `profile/metas` + `isMatchingCountryProxy`. Skips when the existing proxy already matches the user's country AND `proxy_masking=custom`. Name is historical (was US-only); now handles every country in `COUNTRY_REGIONS`. | `POST /profile/partial_update`, `POST /profile/metas`, `POST {PROXY_BASE}/v1/proxy/connection_url` |
| `list_folders.js [filter]` | Print every workspace folder with `folder_id`, `name`, `profiles_count`. Optional substring filter highlights matches. | `GET /workspace/folders` |
| `list_profiles.js` | Dump every profile in `FOLDER_ID` (env) to `profile_ids.json` as `[{fullName, profile_id}]`. Paginated 100/page. | `POST /profile/search` |
| `move_profiles.js` | Move profiles from the creation folder to the delivery folder. Edit the hardcoded `USER_IDS` array at the top — these are MongoDB `_id`s, not MLX UUIDs. The script resolves each via `GET /api/profiles/:id` → `browsers[].browserId` (where `provider === "multilogin"`). Pre-checks both folders so already-delivered and not-in-source ids are skipped without an API call. Moves one at a time with `MOVE_DELAY_MS=4000` between calls and exponential backoff on 5xx/429 (`[10s, 30s, 60s]`). | `POST /profile/move` (one-id-per-call), `POST /profile/search` (source + dest enumeration) |
| `export_delivery.js [--out=…] [--folder=…]` | Dump every profile in the delivery folder to a CSV, joining MLX profile data with the linked user record. The MLX `notes` field carries the Mongo ObjectId (set by `create_profiles.js`); when notes parse as a 24-hex ObjectId the script fetches `/api/profiles/:id` and merges fields. Profiles without a user link still get a row with blank user columns. | `POST /profile/search`, `GET /api/profiles/:id` |

**`multilogin/.env`** uses legacy short names (`MLX_EMAIL`, `MLX_PASSWORD`,
`WORKSPACE_ID`, `FOLDER_ID`, `API_BASE`). The scripts bridge these to the
canonical `MULTILOGIN_*` / `USER_API_BASE_URL` names the shared module
reads. New deployments can use either name set — bridge is idempotent.

**`PROFILES_FILE` is script-relative.** `path.resolve(__dirname, ...)`
equivalent. `node multilogin/create_profiles.js` works from any CWD; no
`cd multilogin/` required.

CSV columns (`export_delivery.js`):
`mlx_profile_id`, `mlx_profile_name`, `mlx_notes`, `mlx_created_at`,
`mlx_browser_type`, `mlx_os_type`, `user_id`, `first_name`, `last_name`,
`email`, `email_password`, `facebook_password`, `birthday_date`,
`gender`, `profile_url`, `page_url`, `city`, `status`.

The CSV contains credentials — `.gitignore` blocks `delivery_export_*.csv`
along with `profile_ids.json` / `profiles.json` for the same reason.

**Folder model.** Two folders are referenced by env:
`MULTILOGIN_FOLDER_ID` is the source ("creation") folder — where
`create_profiles.js` drops new MLX profiles AND where the bot reads
from at runtime. `MULTILOGIN_DELIVERY_FOLDER_ID` is the destination
folder for `move_profiles.js` and the source folder
`export_delivery.js` reads from. The runtime bot **only** reads
`MULTILOGIN_FOLDER_ID`; the delivery folder exists purely so the MLX
UI can show what's been handed off.

## `homepage_interaction`

Uses `a[href="/"][role="link"]`. NOT `aria-label="Home"` (changes with notification
count). href is always `"/"`. Click if found + has bbox → fall back to `goto facebook.com`.

## `check_ip`

Fetches outbound IP from `https://ipinfo.io/json`, POSTs to DB. Auto-runs at session
start (after FB nav, before user steps). Also a leaf action.

### Critical: use `page.evaluate(fetch)`, NOT Node fetch

```javascript
await page.evaluate(async (url) => {
  const res = await fetch(url, { cache: 'no-store' });
  return res.json();
}, 'https://ipinfo.io/json');
```

Page context → routes through profile's proxy. Node fetch/axios exits via host IP.
`page.request.get()` doesn't reliably inherit CDP browser's proxy. Page must be on
real origin (about:blank has no fetch context) — that's why auto-run fires only
after FB navigation. ipinfo.io has CORS `*`.

### Endpoint resolution

1. `params.endpoint`
2. `IP_LOG_ENDPOINT` env (`:userId` placeholder)
3. `${USER_API_BASE_URL}/api/profiles/:userId/ip-records`
4. Logging only

Payload: `{ userId, recordedAt, ipInfo }`. Errors caught + warned. Auto-run wrapped
in try/catch so proxy hiccup doesn't abort task.

## Anti-detection — behavior-level risks

Code-level risks (delays, mouse, offsets, typing variance) are handled by `humanBehavior.js`.

### Don't reintroduce

| Pattern | Fix |
|---------|-----|
| `element.click()` on critical interactions | `humanClick(page, await locator.boundingBox())` |
| `page.keyboard.type(text, { delay: N })` uniform | `humanType(page, text)` |
| Fixed `waitForTimeout(N)` | `humanWait(page, min, max)` |

### Behavior-level risks

1. **Compound session workload.** New account doing avatar + about + cover + page + posts + switch + adds in one session = near-certain ban.
2. **Early `create_page`.** Page creation is high-trust; FB's first-72h trust model weights it heavily.
3. **Uniform fleet timing.** N accounts running same task simultaneously = detectable repeating shape. Stagger.
4. **Duplicate media/content.** Reused avatars/covers/posts get hash-detected. Each account needs unique assets (handled in DB).

### Recommended staging for new accounts

```
Day 1   : setup_avatar + setup_about
Day 1-2 : home_feed × 2-3
Day 3   : setup_cover
Day 3-4 : home_feed × 2-3
Day 5+  : add_friend × few
Day 7+  : setup_page_full
```

`trackerLog` records what happened when, so the scheduler can pick next-safe-action
without re-reading FB state.

### Auto-tracking — one entry per session

`runBrowser` posts a tracker-log at end (in `try/finally` so partial failures still log):

```
POST /api/profiles/{userId}/tracker
{ "date": "YYYY-MM-DD", "note": "<multiline>" }
```

**Header is one of three outcomes** (severity descending — abort wins):

- `FAIL at <stepType> (<elapsed>): <msg>` — abort-level failure
  (checkpoint, credentials rejected, pre-flight, ensure_login). The whole
  session was aborted at that step; remaining steps were never attempted.
- `PARTIAL (<N> failed) (<elapsed>)` — at least one non-fatal step failure,
  but the session continued past it and ran the rest. Triage can see what
  worked and what didn't.
- `SUCCESS (<elapsed>)` — every top-level step completed (whether or not
  it took retries to get there).

After the header: numbered list of completed top-level steps with child
chains flattened via ` - ` (e.g. `search - open_search_result - connect -
scroll - share_posts`). `random_preset` logged as-is, not resolved.

When PARTIAL fires, a `Failed steps:` block follows the completed list
with one line per soft failure: `- <stepType>: <message>`.

POST errors caught + warned. Skipped if `userId`, `note`, or `USER_API_BASE_URL` empty.

### Soft-failure semantics — what aborts vs. continues

`runBrowser`'s per-step error handler splits errors into two camps:

| Camp | Triggered by | Behavior |
|------|--------------|----------|
| **Abort** | `err.checkpoint` or `err.credentialsRejected` | PATCHes user to `status: "Need Checking"`, fires the tracker-log with `FAIL`, **skips all remaining steps**. |
| **Soft** | any other error after `runWithRetry` exhausted its 3 attempts | Logged + collected in `softFailures[]`, runner **continues to the next top-level step**. |

This is the post-2026-05-30 design — a single mid-session failure no
longer wastes the rest of the run. A profile that fails `search` can
still complete `connect_loop`, `accept_loop`, `homepage_interaction`,
and stamp the onboarding keys for the steps that succeeded. Vault-log
"profile complete" line carries the soft-failure count
(`profile complete (2 non-fatal failure(s))`) so the dashboard can
distinguish clean vs. partial sessions at a glance.

The only special cases that still abort are FB-flagged accounts
(checkpoint) and rejected credentials (e.g. outlook_login's
`incorrect password`) — both genuinely poison the rest of the session.

### Per-step failure forensics — dump on first throw

`runWithRetry`'s catch block calls `dumpStepFailure(page, stepType, err,
attempt)` **on the FIRST throw**, before the checkpoint short-circuit or
`tryRecover` can mutate the page (dismissing modals, navigating off the
failure URL). One dump per error — `err.dumped` survives across retry
attempts so the same incident never gets re-written. Filename includes
the attempt number (`fail-<step>-attempt1-<ts>.{html,png}`) so
concurrent retries on the same step never overwrite each other, though
in practice only attempt 1 dumps.

The synthetic `ensure_login` call from `runBrowser` is NOT wrapped in
`runWithRetry`, so it has its own inline `dumpStepFailure` in the catch
to keep that path on par. `err.dumped` guards against double-dumps when
an inner action (e.g. `facebook_signup`) already captured one.

### Per-profile folder rename — SUCCESS / FAIL prefix

After each profile's session ends (in `runTask`'s per-worker `finally`),
`renameProfileFolderWithStatus` renames the profile's run-scoped folder
from `{Name}-{shortId}/` to `{STATUS} - {Name} - {shortId}/` where
STATUS is SUCCESS or FAIL. Scanning the `profiles/` listing at a glance
shows outcomes without opening tracker logs:

```
logs/engage-and-add-20260530-...
  profiles/
    SUCCESS - Marco Rossi - 6a020462/
    SUCCESS - Anna Bianchi - 6a02943a/
    FAIL - Giorgia Gentile - 6a066bab/
    ...
```

Best-effort — swallows errors so a Windows file-lock or already-renamed
collision can never break the run. The rename runs AFTER `runInSession`
has exited (no more file handles into the folder).

## `server.js` — HTTP API for remote task execution

Express server on `PORT` env (default 3000). Designed to be called from the
7or34.space website backend running on the same machine (`localhost:3000`).

### Endpoints

| Method | Path | Response | Description |
|--------|------|----------|-------------|
| `POST` | `/execute` | `202 Accepted` | Validates task, starts `runTask` in background, returns immediately |
| `GET` | `/status/:taskId` | `200` / `404` | Check task progress: `running`, `done`, or `error` |

### `POST /execute` body

```json
{
  "taskId": "onboard-69f358...-1716600000000",
  "profiles": ["69f3585493738d563ce2182e"],
  "concurrency": 1,
  "steps": [
    { "type": "setup_about" },
    { "type": "homepage_interaction", "steps": [
      { "type": "like_posts", "params": { "count": 2 } },
      { "type": "share_posts", "params": { "count": 1 } }
    ]}
  ]
}
```

Required: `taskId`, `profiles` (non-empty array of user IDs), `steps`.

### Behavior

- **Fire-and-forget.** `runTask` runs as a detached promise. The HTTP
  response returns `{ taskId, status: "running", message: "Task started" }`
  immediately.
- **Duplicate guard.** A second POST with the same `taskId` while the first
  is still running returns `409 Conflict`.
- **Concurrent calls.** Two POSTs with different taskIds/profiles run in
  parallel — multiple browsers open simultaneously. Limited by the machine's
  RAM/CPU and the MLX plan's concurrent profile cap.
- **In-memory state.** Task status lives in a `Map` — lost on server restart.
  The runner's own `state/{taskId}.json` persistence is unaffected.

### Integration with 7or34.space

Website backend (same machine) calls:

```
POST http://localhost:3000/execute
```

No tunnel needed — both processes share `localhost`. The website frontend
hits its own backend (e.g. `POST /api/profiles/:id/run`), which forwards
to the bot server.

### Running alongside `run-task.js`

Both can run simultaneously as separate Node processes. Since they target
different profiles, Multilogin opens separate browsers with no conflict.
Same-profile collision is not guarded — avoid running the same profile
from both entry points.

## Current status

**Done:** server (async fire-and-forget + status endpoint, localhost integration
with 7or34.space), runner, browserManager (Hidemium + Multilogin), humanBehavior,
all actions listed in project structure, virtualized-feed pattern, network resilience,
retry-all-errors, user API integration, `injectUserParams`, `concurrency` + `blockMedia`,
Gemini share + post caption generation (`generateMessage` + `generatePostCaption`),
`publish_post` with input-driven modal opening + `captionSource` (ai|post) toggle,
`marketplace_location` (auto via geolocation picker + manual via city typing),
country-aware `search` (US + IT pools: names, regions, page categories, general topics)
with `general` mode mixing `near me` / `in {city}` randomly, between-step delays,
end-of-task tab cleanup, auto tracker-log, NL→JSON, pre-flight + per-step checkpoint
detection with HTML/PNG forensic dumps + generic step-failure dump safety net,
per-run `summary.md` + per-run scoped log dirs (`logs/{taskId}-{ts}/profiles/{name}-{shortId}/`),
`setup_privacy` (extracted from `facebook_signup`), EU cookie consent auto-dismiss,
`facebook_signup` failure dumps, `setup_about` URL-based subsection fallback for fresh
accounts, `update-post-captions.js` batch caption regen (PATCHes `/api/posts/:postId`).

**TODO:** `comment_post`, `join_group`, `send_message`; comment generation; SQLite task state;
Web UI for chat; schema validation on generated JSON; Multilogin profile creation in
`create-profile.js`.

## Notes

- Re-read "Core pattern" before adding features — easy to violate recursive-steps thinking.
- New action → update `schemas/actionSchemas.js` in the same change.
- FB selector not working → assume FB changed the DOM. Use `page.pause()` + inspect live.
- Prefer small, composable handlers.
