# BASEWOOK Automation Platform

## What this project does

Node.js backend that takes JSON task commands and runs automation across multiple
BASEWOOK (Facebook) accounts in parallel using anti-detect browser profiles
(Hidemium **or** Multilogin X) controlled via Playwright + CDP.

`POST /execute` accepts JSON. `chat/nlToJson.js` is a separate NL→JSON layer
that posts to the same endpoint.

## Tech stack

- **Node.js + Express** — HTTP server
- **Playwright** — browser automation via CDP
- **Hidemium / Multilogin X** — anti-detect browser (only one runs at a time, picked by env)
- No database yet — tasks are ephemeral

## Project structure

```
70R34-BASEWOOK-AI/
├── server.js                    # Express entry, POST /execute
├── runner.js                    # Recursive step runner
├── run-task.js                  # Run tasks.json directly
├── tasks.json                   # Editable task for manual runs
├── schemas/actionSchemas.js     # Param schema (single source of truth)
├── actions/                     # One file per action
│   ├── homepage_interaction.js  visit_profile.js  search.js
│   ├── open_search_result.js    create_page.js    scroll.js
│   ├── like_posts.js            share_posts.js    share_post.js
│   ├── add_friend.js            follow.js         connect.js
│   ├── connect_loop.js          accept_loop.js
│   ├── setup_about.js           setup_avatar.js   setup_cover.js
│   ├── schedule_posts.js        switch_profile.js wait.js
│   ├── facebook_signup.js       facebook_login.js ensure_login.js
│   ├── outlook_login.js
│   └── check_ip.js
├── utils/
│   ├── browserManager.js        # ONLY file aware of Hidemium / Multilogin
│   ├── userApi.js               # 3rd-party user fetch
│   ├── humanBehavior.js         # human-like interaction
│   ├── generateMessage.js       # GitHub Models — share messages
│   ├── pageSetupHelpers.js      # shared helpers for page setup
│   ├── pageAddressData.js       # city/state parsing + ZIP seeds
│   ├── randomCount.js           # {count} | {min,max} resolver for feed actions
│   └── sessionLog.js            # per-profile log file + vault tee
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
| `profiles` | yes | — | List of user IDs |
| `concurrency` | no | all | Max parallel browsers |
| `blockMedia` | no | `true` | Block images/video/audio/fonts |
| `steps` | yes | — | Array of steps |

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

`setup_*` params are auto-injected from the user API; explicit values win.

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
- `MULTILOGIN_FOLDER_ID` is required; `WORKSPACE_ID` is required for the refresh step.

`closeProfile(profileId, browser, provider)` and `closeBrowsers` dispatch by
the `provider` field on the session object.

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
| `identityPrompt` | share-message generation |
| `images[0]` (face annotation) | `setup_avatar` |
| `images[1]` | `setup_cover` |
| `linkedPage.{pageName,bio,assets[0..1],posts}` | `create_page`, `schedule_posts` |
| `browsers[]` | `browserManager` (matched by `provider`) |
| `pageUrl` | PATCHed back after `create_page` |

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

### Auto-injected params

| Step | Param | Source |
|------|-------|--------|
| `create_page` | `pageName` | `user.linkedPage.pageName` |
| `create_page` | `bio` | `user.linkedPage.bio` |
| `create_page` | `email` | `user.emails` (selected or `[0]`) |
| `create_page` | `city`/`state`/`zipCode`/`streetAddress` | `buildPageAddress(...)` |
| `create_page` | `profilePhotoUrl`/`coverPhotoUrl` | `resolveSetupPageImages(user)` |
| `schedule_posts` | `posts` | `user.linkedPage.posts` |
| `switch_profile` | `userName` | `firstName + lastName` |

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
| `name` (default) | `{first} {last}` from 100×100 pools |
| `news` | `{US state} {keyword}` — 50 states × 12 keywords |
| `page` | `{category} in {city}` — 25 categories; `city` from `user.city` |

Optional `filter`: `"People"`, `"Pages"`, `"Posts"`, `"Videos"`, `"Groups"` —
clicks results tab. Matched against visible `<span>` in `a[role="link"]`.

### `open_search_result` pick

1. `page.$$('a[href*="/profile.php?id="]')`
2. Dedupe by href (avatar + name link point to same target)
3. `pick`: `"random"` (default), `"first"`, integer index
4. `scrollToCenter` before click

`/profile.php?id=*` is FB's canonical URL for **both** users and pages —
filter type upstream via `search.filter`.

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

**Checkpoint short-circuit:** after every step error, `runWithRetry` reads
`page.url()` (via `safePageUrl`). If the URL contains `"checkpoint"`, FB has
flagged the profile (login challenge / ID verification / etc.) — retrying is
pointless. `runWithRetry` first calls `tryDismissSoftCheckpoint(page)` (FB's
"We suspect automated behavior" modal has a Dismiss button on a clean page
underneath — gated on both the button AND the warning text being visible).
If dismissed, the retry continues. If not, the error is tagged
`err.checkpoint = true` + `err.noRetry = true`, the retry loop breaks
immediately, `runBrowser`'s per-step catch logs `Checkpoint hit during
<step> — skipping remaining steps for this profile`, PATCHes the user
record `{ status: "Need Checking" }` so it's surfaced for manual review,
fires the tracker log, and the worker moves on. The post-action sweep in
`runStep` also re-checks the URL after a successful step — catches FB
redirects that didn't throw.

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

After the nav, `runBrowser` calls `isLoggedOut(page, { profileProbeUrl: user.profileUrl })`
(from `ensure_login`). Three detection signals:

1. URL match — current URL contains `/login` or `login.php`
2. Password field — `input[name="pass"]` visible on the page
3. Profile probe — if `user.profileUrl` is set, navigate to it; if FB rewrites
   to `/people/...` or `/pfbid...`, the session is browsing as guest

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
it stops at the home href and skips the `/settings/bundled` walk + status
PATCH). All signup params auto-injected from the user record.

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

Plus a heartbeat every 30s: `[heartbeat] alive Xm Ys | handles=N requests=M`.
If the last heartbeat is at T-30s before the prompt returns, Node died
abruptly. If heartbeats go silent first, then output stops, then prompt
returns — slow drain. `setInterval` is `.unref()`d so the heartbeat alone
can never block exit.

**Windows-specific gotchas:**
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

### End-of-task tab cleanup

After all steps complete (in the success path, after the tracker-log finally),
`runBrowser` opens a fresh `about:blank` tab and closes every other page in
the context. Net result: one blank tab visible during the 10-15s cooldown
before the profile is closed.

### Delays

- Between top-level steps: 5-15s
- Between child steps: 5-15s
- After all steps: 10-15s cooldown before close

### `injectUserParams(steps, user)`

Walks step tree before execution, fills missing params from user record.

| Step | Injected |
|------|----------|
| `setup_about` | `bio`, `city`, `hometown`, `personal`, `work`, `education`, `hobbies`, `travel`, `userId`, `profileUrl` (current value — empty triggers capture+PATCH) |
| `setup_avatar` | `photoUrl`, `userIdentity` |
| `setup_cover` | `photoUrl` |
| `create_page` | `pageName`, `bio`, `email`, `city`, `state`, `zipCode`, `streetAddress`, `profilePhotoUrl`, `coverPhotoUrl`, `userId` |
| `schedule_posts` | `posts` from `linkedPage.posts` |
| `switch_profile` | `userName` from `firstName + lastName` |
| `search` | `city` from `user.city` (page mode) |
| `check_ip` | `userId` |
| `share_posts` / `share_post` | `userIdentity` |
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

`note` first line: `SUCCESS` or `FAIL at <stepType>: <msg>`. Then numbered list of
completed top-level steps with child chains flattened via ` - ` (e.g.
`search - open_search_result - connect - scroll - share_posts`). `random_preset`
logged as-is, not resolved.

POST errors caught + warned. Skipped if `userId`, `note`, or `USER_API_BASE_URL` empty.

## Current status

**Done:** server, runner, browserManager (Hidemium + Multilogin), humanBehavior, all actions
listed in project structure, virtualized-feed pattern, network resilience, retry-all-errors,
user API integration, `injectUserParams`, `concurrency` + `blockMedia`, GitHub Models share
generation, between-step delays, end-of-task tab cleanup, auto tracker-log, NL→JSON.

**TODO:** `comment_post`, `join_group`, `send_message`; comment generation; SQLite task state;
per-task/per-browser logging; Web UI for chat; schema validation on generated JSON; Multilogin
profile creation in `create-profile.js`.

## Notes

- Re-read "Core pattern" before adding features — easy to violate recursive-steps thinking.
- New action → update `schemas/actionSchemas.js` in the same change.
- FB selector not working → assume FB changed the DOM. Use `page.pause()` + inspect live.
- Prefer small, composable handlers.
