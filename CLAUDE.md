# BASEWOOK Automation Platform

## What this project does

Node.js backend that receives JSON task commands and executes automation
sequences across multiple BASEWOOK (Facebook) accounts in parallel using
Hidemium anti-detect browser profiles controlled via Playwright + CDP.

Accepts JSON via `POST /execute`. A natural-language → JSON chat layer
exists as a separate client (`chat/nlToJson.js`) that generates JSON and
hits the same endpoint.

## Tech stack

- **Node.js + Express** — HTTP server exposing the task endpoint
- **Playwright** — Browser automation, connecting via CDP
- **Hidemium** — Anti-detect browser (must be running)
- **No database yet** — Tasks are ephemeral; add SQLite when persistence is needed

## Project structure

```
70R34-BASEWOOK-AI/
├── CLAUDE.md
├── server.js                    # Express entry point, POST /execute
├── runner.js                    # Recursive step runner (core logic)
├── run-task.js                  # Run tasks.json directly (no server)
├── tasks.json                   # Editable task file for manual runs
├── config/
│   └── profiles.json            # Human reference only (not imported)
├── schemas/actionSchemas.js     # Single source of truth for action params
├── actions/                     # One file per action handler
│   ├── homepage_interaction.js  # Home feed (navigator)
│   ├── visit_profile.js         # Navigate to profile URL (navigator)
│   ├── search.js                # Search FB — name/news/page modes (navigator)
│   ├── open_search_result.js    # Open a search result link (navigator)
│   ├── create_page.js           # Create a Facebook Page (navigator)
│   ├── scroll.js                # (leaf)
│   ├── like_posts.js            # Like posts on current page (leaf, feed-aware)
│   ├── share_posts.js           # Share posts on current page (leaf, feed-aware)
│   ├── share_post.js            # Share a specific post by URL
│   ├── add_friend.js            # Friend request — profile pages + inline cards (leaf)
│   ├── follow.js                # Click Follow (leaf)
│   ├── setup_about.js           # Fill About sections + PATCH status/profileSetup
│   ├── setup_avatar.js          # Upload profile picture
│   ├── setup_cover.js           # Upload cover photo
│   ├── schedule_posts.js        # Schedule posts on loaded Page (leaf)
│   ├── switch_profile.js        # Switch back to personal profile (leaf)
│   └── check_ip.js              # Fetch outbound IP + POST to DB (auto-runs)
├── utils/
│   ├── browserManager.js        # ONLY file that knows about Hidemium
│   ├── userApi.js               # Fetches user from 3rd party API
│   ├── humanBehavior.js         # Human-like interaction utilities
│   ├── claudeApi.js             # Stubbed — extractPostContext still used
│   ├── generateMessage.js       # GitHub Models API — share messages
│   ├── pageSetupHelpers.js      # Shared helpers for page setup actions
│   └── pageAddressData.js       # Parses city/state + seeds ZIP codes
└── chat/nlToJson.js             # NL → task JSON via Claude API
```

## Core pattern: recursive steps

Every JSON step has this shape:

```json
{ "type": "action_name", "params": { ... }, "steps": [ ... ] }
```

**Two kinds of actions:**

1. **Navigators** change what page the browser is showing
   (`visit_profile`, `search`, `open_search_result`, `create_page`, `homepage_interaction`)
2. **Leaves** act on whatever page is currently showing
   (`add_friend`, `follow`, `scroll`, `like_posts`, `share_posts`, `schedule_posts`, `switch_profile`)

**The runner walks steps recursively:**

```javascript
async function runStep(page, step) {
  const handler = handlers[step.type];
  if (!handler) throw new Error(`Unknown step type: ${step.type}`);
  await handler(page, step.params || {});
  if (step.steps) {
    for (const child of step.steps) await runStep(page, child);
  }
}
```

**Handlers NEVER call other handlers.** They only do their one job. Chaining
happens via the `steps` array in JSON, not via code.

## Example JSON task

**Task-level fields:**

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `taskId` | yes | — | Unique identifier |
| `profiles` | yes | — | List of user IDs (from 3rd party API) to run |
| `concurrency` | no | all | Max browsers running at the same time |
| `blockMedia` | no | `true` | Block images/video/audio/fonts |
| `steps` | yes | — | Array of step objects |

```json
{
  "taskId": "setup-batch",
  "profiles": ["69e4a3378c3f0a567140fbcd", "69e21c9bbb8fecced7bfda04"],
  "concurrency": 1,
  "blockMedia": true,
  "steps": [
    { "type": "setup_avatar" },
    { "type": "setup_about" },
    { "type": "setup_cover" },
    {
      "type": "visit_profile",
      "params": { "pool": "friends" },
      "steps": [{ "type": "add_friend" }]
    }
  ]
}
```

Note: setup_* params are **auto-injected** from the user API response. Explicit
params always take priority if provided.

## Hidemium integration

`utils/browserManager.js` is the **only** file that knows about Hidemium.
Handlers receive a Playwright `page` and don't care where it came from.

### Flow: userId → browser session

```
tasks.json profiles[]
  → fetchUser(userId)       via utils/userApi.js  →  GET /api/profiles/:id
  → user.browsers[0]        { browserId, provider }
  → openProfile(browserId)  via Hidemium API      →  CDP port
  → chromium.connectOverCDP(`http://127.0.0.1:${port}`)
  → session { page, user, profileId }
```

Each session carries the full user object. `runner.js` uses it for auto-injection.

### User API — `utils/userApi.js`

Configure in `.env`: `USER_API_BASE_URL=http://localhost:4000` (or prod URL).
Endpoint: `GET ${USER_API_BASE_URL}/api/profiles/:id`

Key user fields and how the runner uses them:

| Field | Used by |
|-------|---------|
| `_id` | `browserManager`, `check_ip`, `create_page`/`setup_about` PATCH target |
| `firstName`/`lastName` | `switch_profile` userName, identity prompts |
| `emails[].address` (selected or `[0]`) | `create_page` email |
| `city` / `hometown` | `setup_about`, `create_page` city/town (via `parseCityState`), `search` (mode=page) |
| `bio` | `setup_about` profile bio. NOT used for `create_page` — uses `linkedPage.bio` only. |
| `personal`, `work`, `education`, `hobbies`, `travel`, `interests` | `setup_about` |
| `identityPrompt` | `userIdentity` for `share_posts`/`share_post` message generation |
| `images[0]` (has face annotation) | `setup_avatar` |
| `images[1]` | `setup_cover` |
| `linkedPage.pageName` / `bio` / `assets[0]` / `assets[1]` / `posts` | `create_page` + `schedule_posts` |
| `browsers[0]` | `browserManager` — `browserId` + `provider` (defaults `"hidemium"`) |
| `pageUrl` | PATCHed back after `create_page` succeeds |

Image URLs are built as `IMAGE_SERVER_BASE_URL + imageId.filename`. Page assets
use **positional fallback** via `resolveSetupPageImages()` — `linkedPage.assets[0]`
→ profile, `linkedPage.assets[1]` → cover (FB-scraped filenames don't contain
reliable keywords). `getAssetFilename(asset)` checks
`asset.imageId.filename → asset.filename → asset.fileName → asset.url`.

## Playwright conventions (anti-detection)

Facebook aggressively detects automation. Code-level rules:

- **Feed scrolling:** use `page.mouse.wheel(0, 500)` — NEVER `window.scrollTo`
  or `element.scrollIntoView` on the main feed. JS scroll has no acceleration
  curve and wrong event source.
- **Form element scrolling:** `scrollIntoViewIfNeeded()` IS acceptable inside
  About panels and modals — they're isolated containers. Use `scrollToCenter`
  from `humanBehavior.js` for mouse-wheel scroll to a specific element.
- **Clicking:** bounding-box clicks via `humanClick(page, box)` for feed/profile
  buttons. Locator clicks can fail silently on FB's React DOM.
- **Typing:** `humanType(page, text)` — varies per-char and pauses after
  punctuation/spaces. NEVER instant-paste, NEVER uniform per-char delay.
- **Waits:** ALWAYS `humanWait(page, min, max)` — NEVER `waitForTimeout(fixedValue)`.
- **Two-pass pattern:** for virtualized feeds, scroll first to trigger render,
  then interact.
- **Scroll before click (forms):** call `scrollIntoViewIfNeeded()` before clicking
  form fields — off-screen elements return null bounding boxes.

### `utils/humanBehavior.js` exports

```javascript
const {
  humanDelay,      // Gaussian-ish random delay
  humanWait,       // await humanWait(page, min, max)
  humanClick,      // Move mouse smoothly → hover → click with offset
  humanType,       // Type with varied per-character delay
  scrollToCenter   // Mouse-wheel scroll element into viewport center
} = require('../utils/humanBehavior');
```

Add "reading pauses" before interactions (800-1500ms) and "watching pauses"
after actions (1000-2500ms).

### Direct `.click()` vs `humanClick`

| Context | Use |
|---------|-----|
| Feed/profile page buttons | `humanClick(page, box)` |
| FB modal/overlay buttons (cover photo, save, file upload) | `element.click()` — humanClick offset can miss small targets |
| After scroll | Always re-fetch `boundingBox()` right before clicking |

## Conventions

- **Adding a new action:**
  1. Add schema entry to `schemas/actionSchemas.js` first
  2. Create `actions/<action_name>.js` exporting `async (page, params) => {...}`
  3. Register in the handler map in `runner.js`
- Validate required params at top of handler, throw clear errors
- Use defaults for optional params (`params.count ?? 1`)
- Per-browser failures must NOT kill the task — use `Promise.allSettled`
- Log per browser, per step, with profile ID
- One action = one file

## What NOT to do

- **Don't create combination action types** like `search_and_add`. Combinations
  live in `steps`, NOT in type names. If you're about to create a type with
  "and" in the name, nest steps instead.
- **Don't hardcode URLs, comments, names, or counts** — put them in `params`.
- **Don't let handlers call other handlers.** The runner handles chaining.
- **Don't skip per-browser error isolation.**
- **Don't use JS-driven scrolls or instant-paste typing.**
- **Don't put Hidemium-specific code outside `utils/browserManager.js`.**

## `setup_about` — Facebook About page automation

Self-navigates (no `profileUrl` param needed). Covers: bio, city/hometown,
relationship, work, education, hobbies, interests, travel, name pronunciation.

**Database side-effect:** after all sections complete, PATCHes the user record:

```
PATCH {USER_API_BASE_URL}/api/profiles/{userId}
Body: { "status": "Active", "profileSetup": true }
```

`userId` auto-injected from `user._id`. PATCH errors are caught + logged. Runs
only after ALL sections complete — mid-setup failure leaves flags unchanged
so retry re-runs cleanly.

### Navigation

```
facebook.com/me → About tab → sidebar link → panel button → fill form → save
```

- **About tab:** `a[href*="sk=about"][role="tab"]`
- **Sidebar links:** `a[href*="sk=SECTION"]` — confirmed `sk` values:
  `directory_intro`, `directory_personal_details`, `directory_work`,
  `directory_education`, `directory_activites` *(FB typo — not "activities")*,
  `directory_interests`, `directory_travel`, `directory_names`
- **Panel buttons** have no aria-label. Use XPath on descendant text:
  `xpath=//div[@role="button"][.//span[text()="Button Text"]]`

### Save patterns — THREE different save button types

| Context | Selector |
|---------|----------|
| Inline panel forms (bio, personal, hobbies, interests, travel, names) | `xpath=//span[text()="Save"]` |
| Current city | `[aria-label="Current city save"]` |
| Hometown | `[aria-label="Hometown save"]` |
| Bio (`div[role="button"]` form) | `div[role="button"][aria-label="Save"]` |

Always use `waitForSaveComplete` after save — retries 3× (10-15s initial +
5-10s retries) checking save btn is gone and panel closed before next section.

### Duplicate prevention

Before adding data, check for edit button (only appears when data exists):
`[aria-label="Edit Workplace"]`, `[aria-label="Edit college"]`, `[aria-label="Edit school"]`.

### Leave Page confirmation on sidebar switch

If a prior section's save failed silently (proxy hiccup, DOM race), FB keeps
the half-typed input in memory. Clicking the next sidebar tab then pops a
"You have unsaved changes — Leave Page?" modal that blocks navigation.
`clickSubsection` calls `dismissLeavePageDialog` after every sidebar click:
probes `[aria-label="Leave Page"]` with a 2.5s timeout and clicks it if
visible (discards the stale input, lets navigation proceed). Common case
pays only the probe timeout when no modal is shown.

### Key internal helpers

`typeAndSelect` (click → clear → type → ArrowDown → Enter), `selectYearFromDropdown`,
`clickPanelButton`, `setPanelPrivacyPublic`, `fillPanelWithItems`, `waitForSaveComplete`,
`dismissLeavePageDialog`.

## `setup_avatar` — Profile picture upload

Self-navigates to `/me`. Flow:
```
Profile picture actions → Choose profile picture → Upload photo (file chooser)
  → wait for "Drag or use arrow keys to reposition image" → Save
```

Key notes:
- Image downloaded to `os.tmpdir()` via Node `https`/`http`, deleted in `finally`
- Use `Promise.all([page.waitForEvent('filechooser'), btn.click()])` +
  `fileChooser.setFiles(path)`. Do NOT use `setInputFiles` on the hidden input.
- Wait for reposition-text span before proceeding — signals upload complete.
- `description` optional (default `""`) — only typed if non-empty.

Params: `photoUrl` (required), `description` (optional), `userIdentity` (optional, auto-injected from `user.identityPrompt`).

**Caption priority** — explicit `description` → AI-generated via `utils/generateAvatarDescription.js` from `userIdentity` → random fallback from `DESCRIPTION_POOLS` (5 categories × 20 entries = 100 total: `bible_verses`, `inspirational_quotes`, `gratitude`, `life_mottos`, `blessings`). Fallback picks a random category first, then a random entry. Final text gets a light emoji sprinkle (~40% chance, one symbol max from a 10-entry pool). Generator always returns a non-empty string.

**Trigger probe** — looks for `[aria-label="Profile picture actions"]` on the current page with a 3s timeout before navigating to `/me`. That button only appears on your own profile, so "not found" is a safe signal to navigate. Avoids a redundant goto when a prior step (e.g. `setup_about`) already landed on `/me`.

## `setup_cover` — Cover photo upload

Self-navigates to `/me`. Flow:
```
Add cover photo → Upload photo menuitem (file chooser) → wait for Save changes enabled → Save
```

Key notes:
- "Add cover photo" uses direct `.click()` (humanClick bounding box misses it).
- "Save changes" starts as `aria-disabled="true"` while image processes.
- FB renders **2 elements** matching `[aria-label="Save changes"]` — `waitForSelector`
  gets confused by duplicates. Use `waitForFunction` + `querySelectorAll`:
  ```javascript
  await page.waitForFunction(() => {
    const btns = Array.from(document.querySelectorAll('[aria-label="Save changes"]'));
    return btns.some(btn => btn.getAttribute('aria-disabled') !== 'true');
  }, { timeout: 45000 });
  ```
- Click enabled button via `evaluateHandle` to avoid strict-mode selector issues.

## Facebook Page setup — `create_page` + `schedule_posts` + `switch_profile`

Split into three composable actions so each is retryable and failures don't
re-create Pages:

| Action | Kind | Responsibility |
|--------|------|----------------|
| `create_page` | Navigator | Menu → Pages → Create Page, fill all fields, upload profile/cover, advance through Steps 2-5. Ends on `/profile.php?id=*`. |
| `schedule_posts` | Leaf | Schedule `params.posts[]` on loaded Page, one per day from tomorrow. Per-post failures logged, not thrown. |
| `switch_profile` | Leaf | Your profile → Switch to [userName] → 50s cooldown. Falls back to "Quick switch profiles". |

Composed via the `setup_page_full` preset, or nested:
```json
{ "type": "create_page", "steps": [
  { "type": "schedule_posts" },
  { "type": "switch_profile" }
]}
```

Shared helpers in `utils/pageSetupHelpers.js`.

### Retry strategy — split on the "Create Page" commit click

The click on `div[aria-label="Create Page"][role="button"]` (after
name/category/bio) is what actually commits the Page on FB's side, so retry
semantics differ on each side:

| Phase | Scope | Attempts | Wait |
|-------|-------|----------|------|
| Pre-create (FB home → Pages menu → modal → fill name/category/bio → commit click) | **Whole block restarts** — navigates back to `facebook.com` and presses Escape to dismiss any leftover modal between tries | 3 | 60s |
| Post-create (fill email/address/hours → upload images → advance Steps 2-5 → Done) | **Each action independently** — per-field retry (email fill, street fill, upload profile, Step 2 Next, etc.) | 2 | 60s |

On final exhaustion either phase throws with `err.noRetry = true` so `runner.js`
won't re-run the whole `create_page` handler (a whole-handler retry after the
commit click would spawn a duplicate Page).

Constants in `actions/create_page.js`: `PRE_CREATE_ATTEMPTS=3`,
`POST_FIELD_ATTEMPTS=2`, `RETRY_WAIT_MS=60000`.

### Navigation

```
create_page:
  facebook.com → Facebook menu → Pages → Create Page → Public Page → Next
    → Get started → fill name/category/bio → Create Page (advance)
    → fill contact/location/hours → Next
    → Step 2: upload profile + cover → Next
    → Step 3: Connect WhatsApp       → Skip
    → Step 4: Build audience         → Next
    → Step 5: Stay informed          → Done
    → wait URL: /profile.php?id=*  (confirms creation)
    → dismiss cookies popup if present

schedule_posts:
  loop posts → What's on your mind? → dismiss Not now → type → Next
    → Scheduling options → pick date → Schedule for later → Schedule
    → confirm Publish Original Post if shown → handleAfterSchedule (30-60s)

switch_profile:
  Your profile → Switch to [userName] → 50s cooldown
```

### City/town typeahead

Type `cityName + ", " + first half of stateName` (e.g. `"Birmingham, Alaba"`)
— typing just the city returns too many results. `address.stateName` comes from
`buildPageAddress()` in `utils/pageAddressData.js`.

### Post scheduling loop

post[0] → today+1, post[1] → today+2, etc. `getScheduleDate(dayOffset)` handles
month/year rollover via JS `Date.setDate`.

**"Not now" modal handling** — FB shows this randomly:
- `dismissNotNow()`: loops until no more "Not now" modals (4s timeout each, 5-8s wait)
- Called before each post AND between "What's on your mind?" click and modal load
- `handleAfterSchedule()`: checks "Not now" up to 3× (5s each), then always
  waits 30-60s before next post

**Lexical editor typing** — FB's composer uses a Lexical contenteditable.
`page.keyboard.type()` sends keystrokes to the page and causes scroll jumping.
Fix: click "Create post" heading first, then Tab ×3 with 1s delays to focus
the editor, then type.

### Page URL persistence

After Done, `create_page` captures `page.url()` before/after. If URL changed AND
`waitForURL('**/profile.php?id=**')` confirmed, PATCHes:

```
PATCH {USER_API_BASE_URL}/api/profiles/{userId}
{ "pageUrl": "https://www.facebook.com/profile.php?id=..." }
```

Skipped if URL didn't change (page creation silently failed) so stale URL never
overwrites a good one.

### Params (auto-injected)

| Step | Param | Source |
|------|-------|--------|
| `create_page` | `pageName` | `user.linkedPage.pageName` |
| `create_page` | `bio` | `user.linkedPage.bio` (NOT profile `user.bio`) |
| `create_page` | `email` | `user.emails` (selected or first) |
| `create_page` | `city` / `state` / `zipCode` / `streetAddress` | `buildPageAddress(...)` |
| `create_page` | `profilePhotoUrl` / `coverPhotoUrl` | `resolveSetupPageImages(user)` |
| `schedule_posts` | `posts` | `user.linkedPage.posts` |
| `switch_profile` | `userName` | `user.firstName + user.lastName` |

## `visit_profile` + `add_friend`

- `visit_profile` — navigator, navigates to a profile/page URL. Provide `url`
  for a specific target, or `pool` to random-pick from a config pool file.
  `url` wins when both are set.
- `add_friend` — leaf, works in **two contexts** via union locator:
  - Profile page — `[aria-label^="Add Friend"]` (capital F, dynamic e.g. "Add Friend Joan")
  - Inline search card — `[aria-label="Add friend"]` (lowercase f, exact)
- Scrolls button to viewport center (`scrollToCenter`) before clicking.

| Pool value | Source | Purpose |
|------------|--------|---------|
| `"friends"` | `config/friend_targets.json` | Profiles to send friend requests to |
| `"sharers"` | `config/share_sources.json` | Active pages/profiles that post daily — visit to scroll/like/share from |
| `"users"` | `GET /api/profiles?status=Active&limit=5&random=1` | 5 random Active users from our DB; empty/null `profileUrl` filtered out before random pick |

```json
// Specific URL
{ "type": "visit_profile", "params": { "url": "..." },
  "steps": [{ "type": "add_friend" }] }

// Random friend target
{ "type": "visit_profile", "params": { "pool": "friends" },
  "steps": [{ "type": "add_friend" }] }

// Random sharer → consume content
{ "type": "visit_profile", "params": { "pool": "sharers" },
  "steps": [
    { "type": "scroll", "params": { "duration": 8 } },
    { "type": "like_posts", "params": { "count": 2 } },
    { "type": "share_posts", "params": { "count": 1 } }
  ] }
```

## `search` + `open_search_result` + `follow`

| Action | Kind | Responsibility |
|--------|------|----------------|
| `search` | Navigator | Types query into FB search, submits, optionally clicks results-tab filter |
| `open_search_result` | Navigator | Picks one `a[href*="/profile.php?id="]` anchor, scrolls to center, clicks |
| `follow` | Leaf | Clicks `[aria-label="Follow"]` — works on profiles, pages, AND inline cards |
| `connect` | Leaf | Clicks every Add Friend / Follow / Like button visible on the loaded profile/page, in that priority order. Add Friend matches `aria-label^="Add Friend"` (dynamic name suffix, e.g. "Add Friend Joan Blasiro") + `aria-label="Add friend"` (inline cards). Follow and Like use exact `aria-label="Follow"` / `aria-label="Like"` so already-followed / already-liked states do not re-click (those become "Following" / "Liked"). Never throws if none are visible — logs + skips. |

### `search` modes

| Mode | Generation |
|------|------------|
| `name` (default) | `{first} {last}` — random from 100×100 pools |
| `news` | `{US state} {keyword}` — 50 states × 12 keywords |
| `page` | `{category} in {city}` — 25 categories; `city` from `user.city` |

Optional `filter`: `"People"`, `"Pages"`, `"Posts"`, `"Videos"`, `"Groups"` — clicks
results tab. Filter text matched against visible `<span>` in `a[role="link"]`.

### `open_search_result` pick strategy

1. `page.$$('a[href*="/profile.php?id="]')` — collects all profile/page anchors
2. Dedupes by href (avatar + name link point to same target — without dedupe
   random pick is weighted)
3. `pick`: `"random"` (default), `"first"`, or integer index
4. Uses `scrollToCenter` (mouse-wheel, not JS scroll) before clicking

`/profile.php?id=*` is FB's canonical URL for **both** users and pages. Filter
the result type upstream via `search.filter`.

### Usage examples

```json
// News → scroll + like + share
{ "type": "search", "params": { "mode": "news", "filter": "Posts" },
  "steps": [
    { "type": "scroll", "params": { "duration": 8 } },
    { "type": "like_posts", "params": { "count": 2 } },
    { "type": "share_posts", "params": { "count": 1 } }
  ] }

// Category in city → open page → scroll, like, follow
{ "type": "search", "params": { "mode": "page", "filter": "Pages" },
  "steps": [{ "type": "open_search_result", "steps": [
    { "type": "scroll", "params": { "duration": 10 } },
    { "type": "like_posts", "params": { "count": 2 } },
    { "type": "follow" }
  ]}] }
```

## Virtualized feed — `like_posts` and `share_posts`

FB's feed uses virtualized DOM — only posts near viewport stay in DOM. After
a bulk scroll, old posts are removed and only ~4 near the bottom remain.

**Never query all posts after a bulk scroll and expect to find many.**

### Correct pattern

Use `div[aria-posinset]` to enumerate currently-rendered posts, filter for
those with target button, pick randomly, scroll to each with `mouse.wheel`,
act, then scroll more to load new posts. Track processed posts by
`aria-posinset` value to avoid repeating.

### Post context extraction — always use `post.evaluate()`

To extract text/image/sub-description, run it **inside the browser** on the
exact element. Never use Playwright's `element.$('xpath=//...')` — `//` searches
from document root regardless of scope.

```javascript
const postContext = await post.evaluate(el => {
  const textEl = el.querySelector('[data-ad-rendering-role="story_message"] [dir="auto"]');
  const imgEl  = el.querySelector('img[data-imgperflogname="feedImage"]');
  const subEl  = el.querySelector('[data-ad-rendering-role="description"]');
  return [
    textEl ? textEl.innerText.trim() : '',
    subEl  ? subEl.innerText.trim()  : '',
    imgEl  ? `[Image: ${imgEl.getAttribute('alt')}]` : ''
  ].filter(Boolean).join('\n');
});
```

### Key feed selectors

```
Virtualized post:        div[aria-posinset]
Like (unliked):          [aria-label="Like"]
Like confirmed:          [aria-label="Remove Like"]  (or [aria-label="Unlike"])
Share button:            [aria-label="Send this to friends or post it on your profile."]
Share modal confirm:     [aria-label="Share now"]
Share message input:     [aria-placeholder="Say something about this..."]
```

After Like click, verify by checking `[aria-label="Unlike"]` in same post
container. If not found, retry once with fresh bounding box.
Between likes: random 5-10s.

## `share_post` — Share a specific post by URL

Single-post version of `share_posts`. Navigates to post URL directly, extracts
context from page, shares with static `message` param OR API-generated message
via `userIdentity` + `instruction` params.

## `utils/generateMessage.js` — Share message generation (GitHub Models)

Used by `share_posts`/`share_post` when `userIdentity` is provided.

### `.env` vars

```
GITHUB_MODELS_TOKEN       # PAT with Models access
GITHUB_MODELS_MODEL       # default: openai/gpt-4.1
GITHUB_MODELS_BASE_URL    # default: https://models.github.ai/inference/chat/completions
GITHUB_MODELS_API_VERSION # default: 2026-03-10
```

### Behavior

- Returns plain string ready for share dialog
- Returns `''` on any API error — share proceeds silently
- Returns `''` if model responds with `SKIP` (empty/unreadable context)
- Sanitizes: em/en dashes and spaced hyphens → space. Hyphens inside words preserved.

### Prompt constraints baked in

- Always **English** regardless of persona location
- 5-20 words, plain text, no hashtags, no quotes
- Matches persona typing style (casual, lowercase, slang)
- Never starts with "Check this out", "Pretty cool", "Wow", "Interesting"
- Reacts to post mood (news, humor, opinion, product)

`userIdentity` alone triggers API generation. `message` (static) takes priority
over API if both provided.

## `utils/claudeApi.js` — Stubbed

`generateShareMessage` commented out — replaced by `generateMessage.js`.
`extractPostContext` still used by `share_post.js`.

## Network resilience — `runner.js`

### Extended timeouts (per browser)

```javascript
page.setDefaultNavigationTimeout(90000);
page.setDefaultTimeout(60000);
```

### Step-level retry for ALL errors

Every handler wrapped in `runWithRetry` — retries up to 3×:
- Network errors (ERR_CONNECTION, ETIMEDOUT, ECONNRESET, proxy, timeout): wait 60s
- All other errors (selector, bad params, DOM): wait 5s

Constants: `STEP_RETRY_ATTEMPTS=3`, `NETWORK_RETRY_WAIT_MS=60000`, `SELECTOR_RETRY_WAIT_MS=5000`.

**`err.noRetry = true` opts out of step-level retry.** Handlers that run their
own internal retries (e.g. `create_page`) set this flag on the final error so
`runWithRetry` does NOT restart the whole handler — doing so would re-trigger
side effects already committed (e.g. duplicate Pages on FB).

### Auto-navigate before first step

`runBrowser` checks current URL. If not on basewook.com, navigates first so
no step starts on blank or wrong page.

### Between-step and post-task delays

- Between top-level steps: 5-15s random
- Between child steps: 5-15s random
- After all steps: 10-15s cooldown before close

### User param injection — `injectUserParams(steps, user)`

Runs before steps execute. Walks step tree, fills missing params from user:

| Step | Injected |
|------|----------|
| `setup_about` | `bio`, `city`, `hometown`, `personal`, `work`, `education`, `hobbies`, `travel`, `userId` |
| `setup_avatar` | `photoUrl` = `IMAGE_SERVER_BASE_URL + images[0].imageId.filename`, `userIdentity` = `user.identityPrompt` |
| `setup_cover` | `photoUrl` = `IMAGE_SERVER_BASE_URL + images[1].imageId.filename` |
| `create_page` | `pageName`, `bio`, `email`, `city`, `state`, `zipCode`, `streetAddress`, `profilePhotoUrl`, `coverPhotoUrl`, `userId` |
| `schedule_posts` | `posts` from `user.linkedPage.posts` |
| `switch_profile` | `userName` from firstName + lastName |
| `search` | `city` from `user.city` (mode=page) |
| `check_ip` | `userId` from `user._id` |
| `share_posts` / `share_post` | `userIdentity` from `user.identityPrompt` |

Explicit params always win over injected values.

## `create-profile.js` — Create Hidemium profile for a user

CLI that creates a Hidemium profile + links it back to the user record:

```bash
node create-profile.js <userId> [userId2] ...
# or: npm run create-profile -- <userId>
```

Flow per userId:
1. `fetchUser(userId)` — pulls firstName, lastName, existing `proxies[]` refs
2. **Proxy pool selection** — `selectWorkingProxy(userId, user.proxies)`:
   - Loop up to **5 rounds × 10 proxies = 50 max**
   - Each round: `GET /api/proxies?status=pending&limit=10`
   - Per proxy: `testProxy(proxy)` via axios + ipinfo.io (20s timeout)
     - ipinfo fetch fails → `PATCH /api/proxies/:id { status:"dead", lastCheckedAt }`, continue
     - Country ≠ `requireCountry` (default `"US"`) → skip (leave pending), continue
     - Works + US → `PATCH /api/proxies/:id { status:"active", lastCheckedAt, lastKnownIp }`, break
   - Append to `user.proxies` via `PATCH /api/profiles/:userId { proxies: [...existingEntries, { proxyId, assignedAt }] }` — preserves prior entries (already in `{ proxyId, assignedAt }` shape) and appends the new one. `proxyId` refs the `proxies` collection; `assignedAt` is ISO-now.
   - Throws if no working proxy after 50 tries
3. `POST ${HIDEMIUM}/create-profile-custom?is_local=true` — **local profile** (lifetime plan
   allows unlimited local; `is_local=false` hits cloud quota → "Usage limit reached")
4. Success check: response body contains `uuid`. No `status: "successfully"` wrapper.
5. `POST ${HIDEMIUM}/update-note` with `{ uuid, note }` — note field not accepted on
   create-profile-custom, must be set separately. Contains `ip/city/region/country/loc/org/postal/timezone`.
6. `PATCH ${USER_API_BASE_URL}/api/profiles/{userId}` with
   `{ browsers: [{ browserId: uuid, provider: "hidemium" }] }` — so `tasks.json` can
   launch by `userId` immediately after creation

### Profile body — FB-optimized defaults

- `os: "win"`, `osVersion` random from `["10", "11"]`, `browser: "chrome"`, `version: "136"`
- `canvas: "noise"` — NOT `"perfect"` (identical across fleet) or `"off"` (leaks real canvas)
- `webGLImage`, `webGLMetadata`, `audioContext`, `clientRectsEnable`, `noiseFont` all `true`
- `hardwareConcurrency` random from `[4, 8, 12, 16]`, `deviceMemory` from `[4, 8, 16]`,
  `resolution` from `["1920x1080", "1366x768", "1536x864", "2560x1440"]` — varied per profile
- `proxy`: `"HTTP|host|port|user|pass"` (pipe-separated, NOT colon)
- `language: "en-US"`, `StartURL: "https://www.facebook.com"`, `disableAutofillPopup: true`
- `userAgent` omitted — let Hidemium derive from os+browser+version (mismatches get detected)

Timezone + geolocation auto-derived from proxy IP by Hidemium — no `timezone` field needed.

### Known gaps

- **Proxy Optimize preset** (e.g. "FACEBOOK"): not exposed in the public API. Response body
  carries `proxy_optimize_id`/`proxy_optimize_ids` fields but there's no documented endpoint
  to list presets or set them on a profile. Set manually in the Hidemium UI after creation.

## `homepage_interaction` — Home button

Uses `a[href="/"][role="link"]` — NOT `aria-label="Home"` (aria-label changes
with notification count, e.g. "Home, 3 notifications"). href is always `"/"`.

Flow: click if found + has bounding box → fall back to `goto facebook.com`.

## `check_ip` — Auto IP recording on every browser open

Fetches browser's outbound IP from `https://ipinfo.io/json`, POSTs to DB.
Auto-runs at browser session start (after FB nav, before user steps). Also
registered as leaf action — can be composed in tasks.

### How the IP is fetched — `page.evaluate(fetch)`, NOT Node fetch

```javascript
await page.evaluate(async (url) => {
  const res = await fetch(url, { cache: 'no-store' });
  return res.json();
}, 'https://ipinfo.io/json');
```

Runs inside the page context so request goes through the Hidemium profile's
proxy. A Node `fetch`/`axios` call exits through the **host's IP** (wrong).
`page.request.get()` uses Playwright's separate APIRequestContext which does
NOT reliably inherit CDP browser's proxy.

Page must be on real origin — `about:blank` has no fetch context. That's why
auto-run fires only after FB navigation. ipinfo.io returns `Access-Control-Allow-Origin: *`,
so cross-origin fetch from facebook.com works.

### Endpoint resolution

1. `params.endpoint` — explicit override
2. `IP_LOG_ENDPOINT` env (`:userId` placeholder replaced)
3. `${USER_API_BASE_URL}/api/profiles/:userId/ip-records` (default)
4. Logging only — no POST, no error

POST payload: `{ userId, recordedAt, ipInfo }`. Errors caught + `console.warn`'d.
Whole auto-run wrapped in try/catch so proxy hiccup doesn't abort task.

## Anti-detection — behavior-level risks

Code-level risks (delays, mouse, offsets, typing variance) are handled by
`humanBehavior.js`. Any handler bypassing those reintroduces risk.

### Historical fixes — don't reintroduce these patterns

| Pattern | Fix |
|---------|-----|
| `element.click()` on critical interactions | `humanClick(page, await locator.boundingBox())` |
| `page.keyboard.type(text, { delay: N })` uniform per-char | `humanType(page, text)` — varies + pauses after punctuation |
| Fixed `waitForTimeout(N)` between actions | `humanWait(page, min, max)` — real range |
| Fixed `waitForTimeout` for long cooldowns | `humanWait(page, min, max)` — even for longer waits |

### Behavior-level risks (can't be fixed in code)

1. **Compound session workload.** A brand-new account doing `setup_avatar →
   setup_about → setup_cover → create_page → schedule_posts → switch_profile →
   add_friend × N` in one session = near-certain ban, even with perfect clicks.
2. **Early `create_page`.** Page creation is high-trust. FB's first-72-hour
   trust model weights it heavily. Don't call on an account with no history.
3. **Uniform account timing.** N accounts running same task simultaneously =
   repeating session shape across accounts, detectable at network fleet level.
   Stagger start times per account.
4. **Duplicate media/content.** Reused avatars/covers/posts get hash-detected.
   Each account must have unique assets (handled upstream in the database).

### Recommended staging for new accounts

Spread setup over days — do NOT bundle `setup_page_full` with the rest:

```
Day 1   : setup_avatar + setup_about      (light identity)
Day 1-2 : home_feed preset × 2-3          (warmup)
Day 3   : setup_cover
Day 3-4 : home_feed × 2-3 more
Day 5+  : add_friend × few
Day 7+  : setup_page_full                 (only after real history)
```

`trackerLog` on each user records what was done when, so the scheduler can pick
next-safe-action per account without re-reading Facebook state.

### Auto-tracking — one entry per session

`runBrowser` posts a tracker-log at end of every session (in `try/finally` so
partial failures still log what completed):

```
POST {USER_API_BASE_URL}/api/profiles/{userId}/tracker-logs
Body: { "date": "YYYY-MM-DD", "note": "<multiline note>" }
```

- `date` — today ISO short form
- `userId` — from `user._id` / `user.id`
- `note` — multiline body, first line is `SUCCESS` or `FAIL at <stepType>: <msg>`,
  then a numbered list of completed top-level steps with their child chains
  flattened via ` - ` (e.g. `search - open_search_result - connect - scroll - share_posts`).
  `random_preset` logged as-is, not as resolved steps.

Example success body:
```
SUCCESS
1. search - open_search_result - connect - scroll - share_posts
2. setup_avatar
3. setup_about
```

Example failure body (failed on step 2, nothing after it logged):
```
FAIL at setup_avatar: photoUrl is required
1. search - open_search_result - connect - scroll - share_posts
```

POST errors caught + `console.warn`'d. Skipped if `userId`, `note`, or
`USER_API_BASE_URL` empty.

## Current status

**Done:** server.js, runner, browserManager, humanBehavior, `homepage_interaction`,
`scroll`, `like_posts`, `share_posts`, `share_post`, `setup_about` (+ PATCH status/profileSetup),
`setup_avatar`, `setup_cover`, `visit_profile`, `add_friend` (profile + inline),
`follow`, `search` (name/news/page), `open_search_result`, `create_page`,
`schedule_posts`, `switch_profile` (split from old `setup_page`), `check_ip`,
virtualized-feed rewrite, network resilience + retry-all-errors, user API integration,
`injectUserParams`, `concurrency` + `blockMedia` task fields, GitHub Models share
generation, auto-navigate + between-step delays, auto tracker-log, `chat/nlToJson.js`.

**TODO:** `comment_post`, `join_group`, `send_message`; Claude API for comment generation;
SQLite task state; per-task/per-browser logging; Web UI for chat; schema validation on generated JSON.

## Notes for Claude Code

- Before adding features, re-read the "Core pattern" section — easy to
  accidentally violate recursive-steps thinking.
- When adding a new action, always update `schemas/actionSchemas.js` in the
  same change.
- If an FB selector isn't working, assume FB changed the DOM — try `page.pause()`
  and inspect live.
- Prefer small, composable handlers over clever large ones.
