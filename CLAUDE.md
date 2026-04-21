# BASEWOOK Automation Platform

## What this project does

A Node.js backend that receives JSON task commands and executes automation
sequences across multiple BASEWOOK accounts in parallel using Hidemium
anti-detect browser profiles controlled via Playwright + CDP.

Currently accepts JSON directly via `POST /execute`. A natural-language →
JSON chat layer will be added later as a separate client that generates
JSON and hits the same endpoint.

## Tech stack

- **Node.js + Express** — HTTP server exposing the task endpoint
- **Playwright** — Browser automation, connecting via CDP
- **Hidemium** — Anti-detect browser (must be running with profiles already launched)
- **No database yet** — Tasks are ephemeral; add SQLite when persistence is needed

## Project structure

```
70R34-BASEWOOK-AI/
├── CLAUDE.md                    # This file
├── package.json
├── .gitignore
├── server.js                    # Express entry point, POST /execute
├── runner.js                    # Recursive step runner (core logic)
├── config/
│   └── profiles.json            # Hidemium profile UUIDs (no port — assigned dynamically)
├── schemas/
│   └── actionSchemas.js         # Single source of truth for action params
├── actions/                     # One file per action handler
│   ├── homepage_interaction.js  # Navigate to home feed (href="/" button → goto fallback)
│   ├── visit_profile.js         # Navigate to a profile by URL (navigator)
│   ├── scroll.js
│   ├── like_posts.js            # Like posts on current page (feed-aware)
│   ├── share_posts.js           # Share posts on current page (feed-aware)
│   ├── share_post.js            # Share a specific post by URL
│   ├── add_friend.js            # Send friend request on current profile page
│   ├── setup_about.js           # Fill About page sections
│   ├── setup_avatar.js          # Upload profile picture from URL
│   ├── setup_cover.js           # Upload cover photo from URL
│   └── check_ip.js              # Fetch browser's outbound IP and POST to database (auto-runs on browser open)
├── utils/
│   ├── browserManager.js        # The ONLY file that knows about Hidemium
│   ├── userApi.js               # Fetches user profile data from 3rd party API
│   ├── humanBehavior.js         # Human-like interaction utilities
│   ├── claudeApi.js             # Stubbed — extractPostContext still used by share_post.js
│   └── generateMessage.js       # GitHub Models API — generates share messages
├── run-task.js                  # Run tasks.json directly (no server)
├── tasks.json                   # Editable task file for manual runs
└── chat/                        # (future) NL → JSON converter
    └── nlToJson.js
```

## Core pattern: recursive steps

Every JSON step has this shape:

```json
{
  "type": "action_name",
  "params": { ... },     // optional, shape varies per action
  "steps": [ ... ]       // optional, only for container actions
}
```

**Two kinds of actions:**

1. **Navigators** change what page the browser is showing
   (`visit_profile`, `search`, `visit_group`, `homepage_interaction`)
2. **Leaves** act on whatever page is currently showing
   (`add_friend`, `scroll`, `like_posts`, `comment_post`)

**The runner walks steps recursively:**

```javascript
async function runStep(page, step) {
  const handler = handlers[step.type];
  if (!handler) throw new Error(`Unknown step type: ${step.type}`);

  await handler(page, step.params || {});

  if (step.steps) {
    for (const child of step.steps) {
      await runStep(page, child);
    }
  }
}
```

**Handlers NEVER call other handlers.** They only do their one job. Chaining
happens via the `steps` array in JSON, not via code.

## Example JSON tasks

**Task-level fields:**

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `taskId` | yes | — | Unique identifier for the task |
| `profiles` | yes | — | Explicit list of user IDs (from 3rd party API) to run |
| `concurrency` | no | all | Max browsers running at the same time |
| `blockMedia` | no | `true` | Block images/video/audio/fonts to save bandwidth |
| `steps` | yes | — | Array of step objects |

**Simple — 1 profile, account setup:**
```json
{
  "taskId": "setup-megan",
  "profiles": ["69e4a3378c3f0a567140fbcd"],
  "concurrency": 1,
  "blockMedia": true,
  "steps": [
    { "type": "random_preset" },
    { "type": "setup_avatar" },
    { "type": "setup_about" },
    { "type": "setup_cover" },
    {
      "type": "visit_profile",
      "params": { "random": true },
      "steps": [{ "type": "add_friend" }]
    }
  ]
}
```

**Multi-profile batch — 2 users, 1 at a time:**
```json
{
  "taskId": "setup-batch",
  "profiles": ["69e4a3378c3f0a567140fbcd", "69e21c9bbb8fecced7bfda04"],
  "concurrency": 1,
  "blockMedia": true,
  "steps": [
    { "type": "random_preset" },
    { "type": "setup_avatar" },
    { "type": "setup_about" },
    { "type": "setup_cover" },
    {
      "type": "visit_profile",
      "params": { "random": true },
      "steps": [{ "type": "add_friend" }]
    }
  ]
}
```

Note: `setup_avatar`, `setup_about`, and `setup_cover` params are **auto-injected** from
the user API response — no need to specify them in `tasks.json`. Explicit params always
take priority if provided.

## Hidemium integration

`utils/browserManager.js` is the **only** file that knows about Hidemium.
Handlers receive a Playwright `page` object and don't care where it came from.

### Flow: userId → browser session

```
tasks.json profiles[]
  → fetchUser(userId)       via utils/userApi.js  →  GET /api/profiles/:id
  → user.browsers[0]        { browserId, provider }
  → openProfile(browserId)  via Hidemium API      →  CDP port
  → chromium.connectOverCDP
  → session { page, user, profileId }
```

Each session carries the full user object. `runner.js` uses it to auto-inject
params into `setup_avatar`, `setup_about`, and `setup_cover` steps.

### User API — `utils/userApi.js`

Fetches user data from the 3rd party API. Configure in `.env`:

```
USER_API_BASE_URL=http://localhost:4000   # local
USER_API_BASE_URL=https://yourdomain.com  # dev/prod
```

Endpoint: `GET ${USER_API_BASE_URL}/api/profiles/:id`

Expected user shape (relevant fields):

```json
{
  "_id": "69e4a3378c3f0a567140fbcd",
  "firstName": "Megan", "lastName": "Walker",
  "bio": "...", "city": "...", "hometown": "...",
  "personal": { "relationshipStatus": "...", "relationshipStatusSince": "...", "languages": [] },
  "work": [...], "education": { "college": {...}, "highSchool": {...} },
  "hobbies": [...], "travel": [...],
  "images": [
    { "imageId": { "filename": "/images/avatar.jpg" }, ... },
    { "imageId": { "filename": "/images/cover.jpg"  }, ... }
  ],
  "browsers": [
    { "browserId": "local-uuid-here", "provider": "hidemium" }
  ]
}
```

- `images[0]` → avatar (has face annotation)
- `images[1]` → cover photo
- `browsers[0]` → always used (one provider per user)
- `provider` field defaults to `"hidemium"` if empty or missing

Image URLs are built as `IMAGE_SERVER_BASE_URL + imageId.filename`.

### `config/profiles.json` — human reference only

No longer imported by code. Just a convenience lookup for operators:

```json
[
  { "name": "Rosalba Wren",  "userId": "69e21c9bbb8fecced7bfda04" },
  { "name": "Megan Walker",  "userId": "69e4a3378c3f0a567140fbcd" }
]
```

### Hidemium CDP connection

Playwright connects via CDP — port assigned dynamically by Hidemium at open time:

```javascript
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
```

## Playwright conventions (learned from hidemium-autopilot)

Facebook aggressively detects automation. Follow these rules in every handler:

- **Feed/content scrolling:** use `page.mouse.wheel(0, 500)` — NEVER
  `window.scrollTo` or `element.scrollIntoView` on the main feed. JS-driven
  scroll on the feed is trivially detected (no acceleration curve, wrong event source).
- **Form element scrolling:** `element.scrollIntoViewIfNeeded()` is acceptable
  inside About page panels and modals — these are isolated containers, not the
  feed, so scroll event monitoring is not active there. Use `scrollToCenter`
  from `humanBehavior.js` if you need mouse-wheel scroll for a specific element.
- **Clicking:** use bounding-box clicks via `page.mouse.click(x, y)` where
  possible, especially for virtualized/React-rendered elements. Locator
  clicks can fail silently on FB's React DOM.
- **Typing:** use `page.keyboard.type(text, { delay: 50 + Math.random() * 100 })`
  with per-character delay — no instant-paste typing.
- **Waits:** between actions, always add human-like randomized delays:
  `await page.waitForTimeout(1000 + Math.random() * 2000)`.
- **Two-pass pattern:** for feeds with virtualized DOM, scroll first to
  trigger render, then interact — don't assume elements exist on first look.
- **Scroll before click (forms):** call `element.scrollIntoViewIfNeeded()` before
  clicking form fields inside panels/modals. Elements off-screen return null
  bounding boxes and cause missed clicks.

## Human-like behavior (`utils/humanBehavior.js`)

All action handlers MUST use the shared human behavior utilities to avoid
detection. Import and use these in every handler:

```javascript
const {
  humanDelay,      // Gaussian-ish random delay (not uniform)
  humanWait,       // await humanWait(page, min, max)
  humanClick,      // Move mouse smoothly → hover → click with offset
  humanType,       // Type with varied per-character delay
  scrollToCenter   // Scroll element into viewport center
} = require('../utils/humanBehavior');
```

**Why these matter:**

| Behavior | Detectable Pattern | Human-like Alternative |
|----------|-------------------|----------------------|
| Uniform delays | `waitForTimeout(1000)` always | `humanWait(page, 800, 1500)` varies |
| Instant mouse teleport | `mouse.click(x, y)` directly | `humanMouseMove` then click |
| Dead-center clicks | Always `box.x + width/2` | Random offset within center 60% |
| Uniform typing | Same delay per char | Longer after punctuation/spaces |

**Rules:**

- NEVER use `page.waitForTimeout(fixedValue)` — always `humanWait(min, max)`
- NEVER click without moving mouse first — use `humanClick(page, box)`
- NEVER type without varied delays — use `humanType(page, text)`
- Add "reading pauses" before interactions (800-1500ms)
- Add "watching pauses" after actions complete (1000-2500ms)

## Conventions

- **Adding a new action:**
  1. Add its schema entry to `schemas/actionSchemas.js` first
  2. Create `actions/<action_name>.js` exporting `async (page, params) => {...}`
  3. Register it in the handler map in `runner.js`
- **Handlers:** validate required params at the top, throw clear errors
- **Params:** use defaults for optional params (`params.count ?? 1`)
- **Errors:** per-browser failures must NOT kill the task — use
  `Promise.allSettled` in the runner
- **Logging:** log per browser, per step, with profile ID — you'll need it
- **File size:** one action = one file, keep them small and focused

## What NOT to do

- **Don't create combination action types** like `search_and_add` or
  `homepage_interaction_and_like`. Combinations live in the `steps` array,
  NOT in type names. If you're about to create a type with "and" in the
  name, stop and nest steps instead.
- **Don't hardcode URLs, comments, names, or counts** — everything the user
  would want to change goes in `params`.
- **Don't let handlers call other handlers.** The recursive runner handles
  chaining. Handlers do one job only.
- **Don't skip per-browser error isolation.** If one browser crashes on
  step 2, the others should continue.
- **Don't use JS-driven scrolls or instant-paste typing** — anti-detection.
- **Don't put Hidemium-specific code outside `utils/browserManager.js`.**

## `setup_about` — Facebook About page automation

`actions/setup_about.js` fills every section of the Facebook About page for the
logged-in account. It self-navigates (no `profileUrl` param needed) and covers:
bio, city/hometown, relationship status, work, education, hobbies, interests,
travel, and name pronunciation.

### Navigation pattern

```
facebook.com/me  →  click About tab  →  click sidebar link  →  click panel button  →  fill form  →  save
```

- **About tab:** `a[href*="sk=about"][role="tab"]`
- **Sidebar links:** `a[href*="sk=SECTION"]` — confirmed sk values:

| Section | sk value |
|---------|----------|
| Intro (bio) | `directory_intro` |
| Personal Details (city, hometown, relationship) | `directory_personal_details` |
| Work | `directory_work` |
| Education | `directory_education` |
| Hobbies | `directory_activites` *(Facebook typo — not "activities")* |
| Interests | `directory_interests` |
| Travel | `directory_travel` |
| Names | `directory_names` |

- **Panel buttons** (open the inline form within each section) have no `aria-label`.
  Use XPath on descendant text:
  `xpath=//div[@role="button"][.//span[text()="Button Text"]]`

### Key internal helpers

| Helper | Purpose |
|--------|---------|
| `typeAndSelect(page, selector, value)` | Click input → clear → type → ArrowDown → Enter (picks first suggestion) |
| `selectYearFromDropdown(page, selector, year)` | Open FB year dropdown → XPath-click matching year option |
| `clickPanelButton(page, spanText)` | Click a `div[role="button"]` by its inner span text |
| `setPanelPrivacyPublic(page)` | Open privacy picker → select Public → close modal |
| `fillPanelWithItems(page, panelText, items)` | Full flow: open panel → set privacy → add items → save |
| `waitForSaveComplete(page, saveBtnSelector, panelText)` | After save click: wait 10-15s, check save btn is gone, verify panel closed |

### Save patterns

Facebook About uses **three different save button types**:

| Context | Save selector |
|---------|--------------|
| Inline panel forms (bio, personal details, hobbies, interests, travel, names) | `xpath=//span[text()="Save"]` |
| Current city | `[aria-label="Current city save"]` |
| Hometown | `[aria-label="Hometown save"]` |
| Bio (`div[role="button"]` form) | `div[role="button"][aria-label="Save"]` |

Always use `waitForSaveComplete` after clicking save — it retries up to 3×
(10-15s initial + 5-10s retries) checking that the save button disappears and
the panel form closes before moving to the next section.

### Duplicate prevention

Before adding data, check for the edit button that only appears when data exists:

| Section | Duplicate check selector |
|---------|--------------------------|
| Work | `[aria-label="Edit Workplace"]` |
| College | `[aria-label="Edit college"]` |
| High school | `[aria-label="Edit school"]` |

### Known Facebook selectors (confirmed working)

```
Bio textarea:           textarea[aria-describedby]  or  //textarea[@maxlength="101"]
Current city input:     [aria-label="Current city"]
Hometown input:         [aria-label="Hometown"]
Relationship dropdown:  [aria-label="Select your relationship status"]
Relationship year:      [aria-label="Edit ending date  year. Current selection is none"]  (double space)
Company input:          [aria-label="Company"]
Position input:         [aria-label="Position"]
Work start year:        [aria-label="Edit starting date workplace year. Current selection is none"]
Work end year:          [aria-label="Edit ending date workplace year. Current selection is none"]
Currently work here:    input[name="is_current"]
College name:           [aria-label="College name"]
College start year:     [aria-label="Edit starting date college year. Current selection is none"]
College end year:       [aria-label="Edit ending date college year. Current selection is none"]
HS school name:         [aria-label="School"]
HS start year:          [aria-label="Edit starting date secondary school year. Current selection is none"]
HS end year:            [aria-label="Edit ending date secondary school year. Current selection is none"]
Graduated checkbox:     input[aria-label="Graduated"]  (default unchecked — only click if graduated: true)
Hobbies/Interest input: input[aria-label="Search"][role="combobox"]
Place visited input:    [aria-label="Place visited"]  (use page.$$() and take last element for multi-place)
Privacy button:         [aria-label="Edit privacy. Sharing with Your friends of friends. "]
Privacy public radio:   //label[.//span[text()="Public"]]//input[@type="radio"]
Privacy done button:    [aria-label="Done with privacy audience selection and close dialog"]
First name pronunc.:    (//input[@name="firstname-pronunciation"])[N]  where N = 1|2|3
Last name pronunc.:     input[name="lastname-pronunciation"][type="radio"]
```

## `setup_avatar` — Profile picture upload

`actions/setup_avatar.js` uploads a profile picture from a URL for the logged-in
account. Self-navigates to `/me` — no `profileUrl` param needed.

### Navigation pattern

```
facebook.com/me  →  Profile picture actions  →  Choose profile picture  →  Upload photo (file chooser)  →  wait for reposition text  →  Save
```

### Key implementation notes

- **File download:** image is downloaded to `os.tmpdir()` via Node `https`/`http`,
  then deleted in a `finally` block after upload.
- **File chooser:** use `Promise.all([page.waitForEvent('filechooser'), btn.click()])` +
  `fileChooser.setFiles(path)` — do NOT use `setInputFiles` on the hidden input directly.
  Clicking "Upload photo" opens the OS file picker; intercepting the `filechooser` event
  is the correct Playwright pattern.
- **Upload complete signal:** wait for `xpath=//span[text()="Drag or use arrow keys to reposition image"]`
  before proceeding — this appears once FB finishes processing the image.
- **Description:** optional param, defaults to `""`. Only typed if non-empty.

### Confirmed selectors

```
Profile picture actions btn:  [aria-label="Profile picture actions"]
Choose profile picture:       xpath=//div[@role="menuitem"][.//span[text()="Choose profile picture"]]
Upload photo btn:             [aria-label="Upload photo"]
File input (hidden):          input[type="file"][accept*="image"]  (state: 'attached')
Upload complete signal:       xpath=//span[text()="Drag or use arrow keys to reposition image"]
Description textarea:         xpath=//label[.//span[text()="Description"]]//textarea
Save button:                  xpath=//div[@role="button"][.//span[text()="Save"]]
```

### Params

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `photoUrl` | string | yes | Public URL of image to upload |
| `description` | string | no (default `""`) | Caption for the profile picture post |

## `setup_cover` — Cover photo upload

`actions/setup_cover.js` uploads a cover photo from a URL. Self-navigates to `/me`.

### Navigation pattern

```
facebook.com/me  →  Add cover photo  →  Upload photo (menuitem, file chooser)  →  wait for Save changes enabled  →  Save
```

### Key implementation notes

- **"Add cover photo" button** uses direct `.click()` — `humanClick` bounding-box misses it.
- **"Save changes"** starts as `aria-disabled="true"` while image processes. Wait for
  `:not([aria-disabled="true"])` before clicking, then use direct `.click()`.
- Same `filechooser` intercept pattern as `setup_avatar`.

### Key implementation notes

- FB renders **2 elements** matching `[aria-label="Save changes"]` — `waitForSelector` confuses
  Playwright when there are duplicates. Use `waitForFunction` + `querySelectorAll` instead:
  ```javascript
  await page.waitForFunction(() => {
    const btns = Array.from(document.querySelectorAll('[aria-label="Save changes"]'));
    return btns.some(btn => btn.getAttribute('aria-disabled') !== 'true');
  }, { timeout: 45000 });
  ```
- Click the enabled button via `evaluateHandle` to avoid strict-mode selector issues.

### Confirmed selectors

```
Add cover photo btn:    [aria-label="Add cover photo"]
Upload photo menuitem:  xpath=//div[@role="menuitem"][.//span[text()="Upload photo"]]
Save changes (polling): querySelectorAll('[aria-label="Save changes"]') via waitForFunction
```

## Facebook Page setup — `create_page` + `schedule_posts` + `switch_profile`

Facebook Page setup is split into three composable actions so each step is
retryable on its own and doesn't re-run Page creation on downstream failures:

| Action | Kind | Responsibility |
|--------|------|----------------|
| `create_page` | Navigator | Open Facebook menu → Pages → Create Page, fill all form fields, upload profile + cover, advance through Steps 2-5. Ends on the new Page URL (`/profile.php?id=*`). |
| `schedule_posts` | Leaf | Schedule posts from `params.posts[]` on the currently loaded Page — one per day starting tomorrow. Individual post failures are logged, not rethrown. |
| `switch_profile` | Leaf | Your profile → Switch to [userName] → 50s cooldown. Falls back to "Quick switch profiles". |

Composed via the `setup_page_full` preset (`config/presets.json`):

```json
{ "type": "random_preset", "params": { "from": ["setup_page_full"] } }
```

Or directly as nested steps:

```json
{
  "type": "create_page",
  "steps": [
    { "type": "schedule_posts" },
    { "type": "switch_profile" }
  ]
}
```

Shared helpers live in `utils/pageSetupHelpers.js` (`stepWait`, `downloadToTemp`,
`clickAndReplace`, `typeAndSelect`, `clickLocator`, `uploadImageFromButton`,
`getFirstVisibleLocator`).

### Navigation pattern

```
create_page:
  facebook.com  →  Facebook menu  →  Pages  →  Create Page  →  Public Page  →  Next
    →  Get started  →  fill name/category/bio  →  Create Page (advance)
    →  fill contact/location/hours  →  Next
    →  Step 2: upload profile + cover  →  Next
    →  Step 3: Connect WhatsApp       →  Skip
    →  Step 4: Build Page audience    →  Next
    →  Step 5: Stay informed          →  Done  (page now created)
    →  wait for URL: facebook.com/profile.php?id=*  (confirms creation)
    →  dismiss cookies popup if present

schedule_posts (child step — runs on the newly created Page):
  loop posts → What's on your mind? → dismiss Not now → type content → Next
    → Scheduling options → pick date → Schedule for later → Schedule
    → confirm Publish Original Post if shown → handleAfterSchedule (30-60s wait)

switch_profile (child step):
  Your profile  →  Switch to [userName]  →  50s cooldown
```

### Image resolution — `linkedPage.assets`

Page images come from `user.linkedPage.assets[]`, not `user.images[]`.
Asset filenames are generic (e.g. `page_post_abc123.png`) — no `profile`/`cover`
keywords. Resolution uses **positional fallback**:

```
assets[0] → profile photo
assets[1] → cover photo   (falls back to assets[0] if only one asset)
```

`getAssetFilename(asset)` checks `asset.imageId.filename → asset.filename → asset.fileName → asset.url`.

### City/town typeahead input

FB's City/town field is a typeahead. Type `cityName + ", " + first half of stateName`
to get the right suggestion — typing just the city name often returns too many results:

```
"Birmingham, Alabama"  →  type  "Birmingham, Alaba"
"Los Angeles, California"  →  type  "Los Angeles, Calif"
```

`address.stateName` comes from `buildPageAddress()` in `utils/pageAddressData.js`.

### Post scheduling loop

After page creation, loops through `params.posts[]` (injected from `user.linkedPage.posts`).
Each post = 1 day: post[0] → today+1, post[1] → today+2, etc. `getScheduleDate(dayOffset)`
handles month/year rollover automatically via JS `Date.setDate`.

**"Not now" modal handling** — FB shows this popup randomly after scheduling:
- `dismissNotNow()`: loops until no more "Not now" modals (4s timeout each, 5-8s wait after click)
- Called before each post AND between "What's on your mind?" click and modal load
- `handleAfterSchedule()`: after every Schedule click, checks "Not now" up to 3×
  (5s each), then always waits 30–60s before next post regardless

**Lexical editor typing** — FB's post composer uses a Lexical contenteditable.
`page.keyboard.type()` sends keystrokes to the page and causes scroll jumping.
Fix: click "Create post" heading first, then Tab ×3 with 1s delays to focus
the editor, then `page.keyboard.type(content, { delay: 80 })`.

### Post-creation error safety

The split itself enforces retry safety — `runner.js` retries only the failing
step, so a `schedule_posts` or `switch_profile` failure never re-runs
`create_page` and never creates a duplicate Facebook Page.

- `create_page` errors → runner retries safely (Page not yet created on attempt 1)
- `schedule_posts` errors → per-post retry inside the handler (reload + retry
  up to 3×); final failures logged and skipped so the loop continues
- `switch_profile` errors → handler retries per normal step retry policy

### Confirmed selectors

```
Facebook menu btn:        div[aria-label="Facebook menu"]
Pages link:               xpath=//a[@role="link"]//span[text()="Pages"]
Create Page btn:          [aria-label="Create Page"]
Public Page option:       label:has-text("Public Page")
Next btn:                 div[aria-label="Next"]  or  [aria-label="Next"]
Get started link:         a[aria-label="Get started"]
Page name input:          label:has-text("Page name (required)") input
Category input:           input[aria-label="Category (required)"]
Bio textarea:             xpath=//span[contains(text(), "Bio")]/following::textarea[1]
Create Page (advance):    div[aria-label="Create Page"][role="button"]
Email input:              label:has-text("Email") input
Address input:            label:has-text("Address") input
City/town input:          input[aria-label="City/town"]
ZIP code input:           label:has-text("ZIP code") input
Hours options:            input[type="radio"][value="NO_HOURS_AVAILABLE|ALWAYS_OPEN"]
Add profile picture btn:  div[role="button"]:has-text("Add profile picture")
Add cover photo btn:      div[role="button"]:has-text("Add cover photo")
Skip btn (WhatsApp):      [aria-label="Skip"]
Done btn (Step 5):        [aria-label="Done"]
Allow all cookies popup:  div[aria-label="Allow all cookies"]
What's on your mind btn:  div[role="button"]:has-text("What's on your mind?")
Create post modal:        div[role="dialog"][aria-label="Create post"]  (.first())
Lexical editor:           div[role="textbox"][data-lexical-editor="true"]
Scheduling options:       xpath=//span[contains(text(), "Scheduling options")]
Schedule for later wait:  div[role="button"]:has-text("Schedule for later")
Date input:               div:has(span[aria-label="Open Date Picker"]) input[type="text"]
Schedule for later btn:   div[role="button"][aria-label="Schedule for later"]
Schedule confirm btn:     [aria-label="Schedule"]
Not now modal btn:        [aria-label="Not now"]
Your profile btn:         [aria-label="Your profile"]
Switch to user btn:       [aria-label="Switch to {userName}"]  (fallback: [aria-label="Quick switch profiles"])
```

### Params (auto-injected by `injectUserParams`)

| Step type | Param | Source |
|-----------|-------|--------|
| `create_page` | `pageName` | `user.linkedPage.pageName` |
| `create_page` | `bio` | `user.linkedPage.bio` → `user.bio` |
| `create_page` | `email` | `user.emails` (selected or first) |
| `create_page` | `city` / `state` / `zipCode` / `streetAddress` | `buildPageAddress({ city, state, zip_code })` |
| `create_page` | `profilePhotoUrl` / `coverPhotoUrl` | `resolveSetupPageImages(user)` from `linkedPage.assets` |
| `schedule_posts` | `posts` | `user.linkedPage.posts` |
| `switch_profile` | `userName` | `user.firstName + user.lastName` |

## `visit_profile` + `add_friend` — Profile visit and friend request

- `visit_profile` is a **navigator** — navigates to a profile URL, then child steps act on it.
- `add_friend` is a **leaf** — clicks the Add Friend button on the currently loaded profile.
- `aria-label^="Add Friend"` prefix match handles the dynamic name (e.g. "Add Friend Joan").

### Usage

```json
{
  "type": "visit_profile",
  "params": { "url": "https://www.facebook.com/some.profile" },
  "steps": [{ "type": "add_friend" }]
}
```

### Confirmed selectors

```
Add Friend button:  div[role="button"][aria-label^="Add Friend"]
```

## Virtualized feed — `like_posts` and `share_posts`

Facebook's feed uses virtualized DOM — only posts near the viewport stay in the DOM.
After a bulk scroll, old posts are removed and only ~4 near the bottom remain.

**Never query all posts after a bulk scroll and expect to find many.**

### Correct pattern (both `like_posts` and `share_posts`)

Use `div[aria-posinset]` to enumerate currently-rendered posts, filter for those
with the target button, pick randomly, scroll to each with `mouse.wheel`, act on it,
then scroll a bit more to load new posts. Loop until target count reached.

```javascript
const allPosts = await page.$$('div[aria-posinset]');
// filter by aria-posinset value (dedup) + presence of Like/Share button
// shuffle candidates, pick one
// scroll to it with mouse.wheel loop
// act, then scroll down to load more
```

Track processed posts by `aria-posinset` value (unique per post) to avoid repeating.

### Post context extraction — always use `post.evaluate()`

To extract text/image/sub-description from a specific post, run it **inside the browser**
on the exact element. Never use Playwright's `element.$('xpath=//...')` for this —
`//` searches from document root regardless of scope.

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

### Confirmed feed selectors

```
Virtualized post container:  div[aria-posinset]
Like button (unliked):       [aria-label="Like"]       (within post container)
Like confirmed:              [aria-label="Remove Like"]  (appears after successful like)
Share button:                [aria-label="Send this to friends or post it on your profile."]
Share modal confirm:         [aria-label="Share now"]
Share message input:         [aria-placeholder="Say something about this..."]
Post text:                   [data-ad-rendering-role="story_message"] [dir="auto"]
Post image alt:              img[data-imgperflogname="feedImage"]  → getAttribute('alt')
Post sub-description:        [data-ad-rendering-role="description"]
```

### Like verification

After clicking Like, verify it registered by checking for `[aria-label="Unlike"]`
in the same post container. If not found, retry once with fresh bounding box.

### Timing

Between likes: random 5–10s pause (human reading/browsing gap).

## `share_post` — Share a specific post by URL

Single-post version of `share_posts`. Navigates to the post URL directly, extracts
context from the page, then shares with static `message` param OR Claude API-generated
message via `userIdentity` + `instruction` params.

## `utils/generateMessage.js` — GitHub Models API for share message generation

Generates a human-sounding Facebook share message based on post context and user identity.
Used by `share_posts` and `share_post` when `userIdentity` param is provided.

### Env vars (set in `.env`)

```
GITHUB_MODELS_TOKEN       - GitHub personal access token with Models access
GITHUB_MODELS_MODEL       - model name (default: openai/gpt-4.1)
GITHUB_MODELS_BASE_URL    - API endpoint (default: https://models.github.ai/inference/chat/completions)
GITHUB_MODELS_API_VERSION - API version header (default: 2026-03-10)
```

### Behavior

- Returns a plain string ready to type into the share dialog
- Returns `''` on any API error — share proceeds silently without a message
- Returns `''` if model responds with `SKIP` (empty/unreadable post context)
- Sanitizes output: em dashes (`—`), en dashes (`–`), and spaced hyphens (` - `) are replaced with a space. Hyphens inside words (e.g. "nature-loving") are preserved.

### Prompt constraints baked in

- Always in **English** regardless of persona location
- 5–20 words, plain text only, no hashtags, no quotes
- Matches persona typing style (casual, lowercase, slang if appropriate)
- Never starts with "Check this out", "Pretty cool", "Wow", or "Interesting"
- Reacts dynamically to post mood (news, humor, opinion, product)
- Skips only if context is truly empty or contains random characters/codes

### Usage in params

```json
{ "type": "share_posts", "params": { "count": 1, "userIdentity": "Dog lover from Sacramento..." } }
```

`userIdentity` alone triggers API generation. `message` (static) takes priority over API if both provided.

## `utils/claudeApi.js` — Stubbed (kept for `extractPostContext` only)

`generateShareMessage` is commented out — replaced by `utils/generateMessage.js`.
`extractPostContext` is still used by `share_post.js` for full-page context extraction.

## Network resilience — `runner.js`

### Extended timeouts (set per browser at start of `runBrowser`)

```javascript
page.setDefaultNavigationTimeout(90000); // page loads
page.setDefaultTimeout(60000);           // selectors / actions
```

### Step-level retry for all errors

Every handler call is wrapped in `runWithRetry` — retries up to 3× for **all** errors.
Wait time differs by error type:

```
STEP_RETRY_ATTEMPTS    = 3
NETWORK_RETRY_WAIT_MS  = 60000  (covers brief proxy disconnections)
SELECTOR_RETRY_WAIT_MS = 5000   (gives FB DOM time to settle)
```

Network errors (ERR_CONNECTION, ETIMEDOUT, ECONNRESET, proxy, timeout) wait 60s.
All other errors (selector not found, bad params, DOM errors) wait 5s then retry.

### Auto-navigate before first step

Before any steps run, `runBrowser` checks the current URL. If the tab is not already
on basewook.com, it navigates there first so no step ever starts on a blank or wrong page.

### Between-step and post-task delays

Every step pause is randomized to simulate human browsing pace:

```
Between top-level steps : 5–15s random
Between child steps     : 5–15s random
After all steps done    : 10–15s cooldown before browser closes
```

### User param injection — `injectUserParams(steps, user)`

Runs inside `runBrowser` before steps execute. Walks the step tree and fills missing
params from the fetched user object:

| Step type | Injected from user |
|-----------|-------------------|
| `setup_about` | `bio`, `city`, `hometown`, `personal`, `work`, `education`, `hobbies`, `travel` |
| `setup_avatar` | `photoUrl` = `IMAGE_SERVER_BASE_URL + images[0].imageId.filename` |
| `setup_cover` | `photoUrl` = `IMAGE_SERVER_BASE_URL + images[1].imageId.filename` |
| `create_page` | `pageName`, `bio`, `email`, `city`, `state`, `zipCode`, `streetAddress`, `profilePhotoUrl`, `coverPhotoUrl` — from `user.linkedPage` + `buildPageAddress` |
| `schedule_posts` | `posts` from `user.linkedPage.posts` |
| `switch_profile` | `userName` from `user.firstName` + `user.lastName` |

Explicit params in `tasks.json` always take priority over injected values.

## `homepage_interaction` — Home button selector

Uses `a[href="/"][role="link"]` — **not** `aria-label="Home"`. The aria-label changes
when notifications are present (e.g. "Home, 3 notifications") making it unreliable.
The href is always `"/"` regardless of notification state.

**Flow:** click the Home button if found + has bounding box → fall back to
`goto https://www.facebook.com` if not.

## `check_ip` — Auto IP recording on every browser open

`actions/check_ip.js` fetches the browser's outbound IP from `https://ipinfo.io/json`
and POSTs the result to the database. It runs automatically at the start of every
browser session in `runner.js` (right after the Facebook navigation, before any
user steps) so every browser open is recorded — and it's also registered as a
regular leaf action, so it can be composed in `tasks.json` when needed.

### How the IP is fetched — `page.evaluate(fetch)`, not Node fetch

```javascript
await page.evaluate(async (url) => {
  const res = await fetch(url, { cache: 'no-store' });
  return res.json();
}, 'https://ipinfo.io/json');
```

This runs inside the browser's page context so the request goes through the
Hidemium profile's configured proxy. A Node `fetch`/`axios` call from the server
process would exit through the **host machine's IP** — wrong — and
`page.request.get()` uses Playwright's separate APIRequestContext which does
**not** reliably inherit the CDP-connected browser's proxy.

The page must be on a real origin before calling — `about:blank` has no fetch
context. That's why the auto-run in `runBrowser` fires only after the Facebook
navigation has completed. `ipinfo.io` returns `Access-Control-Allow-Origin: *`,
so the cross-origin fetch from `facebook.com` succeeds.

### Endpoint resolution (database POST target)

Resolved in this priority order:

1. `params.endpoint` — explicit override in a `tasks.json` step
2. `IP_LOG_ENDPOINT` env var (`:userId` placeholder is replaced at call time)
3. `${USER_API_BASE_URL}/api/profiles/:userId/ip-records` (default construction)
4. Falls back to logging only — no POST, no error thrown

POST payload shape:

```json
{
  "userId": "69e4a3378c3f0a567140fbcd",
  "recordedAt": "2026-04-21T14:05:12.000Z",
  "ipInfo": { "ip": "...", "city": "...", "region": "...", "country": "...", "org": "...", "...": "..." }
}
```

POST errors are caught and logged with `console.warn` — they never kill the
session. The whole auto-run is also wrapped in a try/catch in `runBrowser` so a
proxy hiccup on the IP lookup doesn't abort the task.

### Params

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `userId` | string | no | Auto-injected from `user._id` / `user.id` via `injectUserParams` |
| `endpoint` | string | no | Full override URL. Defaults to `IP_LOG_ENDPOINT` env → `USER_API_BASE_URL + /api/profiles/:userId/ip-records` |

### `.env` var

```
IP_LOG_ENDPOINT=https://yourdomain.com/api/profiles/:userId/ip-records
```

Optional — if unset, the default constructed from `USER_API_BASE_URL` is used.

## Direct `.click()` vs `humanClick`

| Context | Use |
|---------|-----|
| Feed/profile page buttons | `humanClick(page, box)` — mouse movement looks human |
| FB modal/overlay buttons (cover photo, save, file upload) | `element.click()` directly — humanClick offset can miss small targets |
| After scroll (fresh coordinates needed) | Always re-fetch `boundingBox()` right before clicking |

## Current status / roadmap

**Phase 1 (proof of concept) — DONE**
- [x] server.js with POST /execute
- [x] runner.js with recursive step executor
- [x] utils/browserManager.js with Hidemium API integration (open/close profiles)
- [x] utils/humanBehavior.js with anti-detection utilities
- [x] Handlers: `homepage_interaction`, `scroll`, `like_posts`, `share_posts`
- [x] Manual testing via `npm run task` with tasks.json

**Phase 2 (feature expansion) — CURRENT**
- [x] `setup_about` — fills all About page sections (bio, city, hometown, relationship,
       work, education, hobbies, interests, travel, name pronunciation)
- [x] `setup_avatar` — uploads profile picture from URL
- [x] `setup_cover` — uploads cover photo from URL
- [x] `visit_profile` — navigator action, navigate to profile by URL
- [x] `add_friend` — send friend request on current profile page
- [x] `share_post` — share a specific post by URL (static or API-generated message)
- [x] `like_posts` + `share_posts` rewritten for virtualized feed (aria-posinset)
- [x] Network resilience in runner (retry + extended timeouts for proxy drops)
- [x] `utils/generateMessage.js` — GitHub Models API for share message generation (active)
- [x] `.env` — env vars for GitHub Models token and model config
- [x] `concurrency` task field — cap parallel browsers (sliding window worker pool)
- [x] `blockMedia` task field — toggle image/video/font blocking per task
- [x] All step errors retry (not just network) — selector errors wait 5s, network 60s
- [x] Auto-navigate to basewook.com before first step if tab is on wrong page
- [x] `profiles` array in tasks.json — explicit user IDs instead of browser count
- [x] `utils/userApi.js` — fetch user from 3rd party API (`GET /api/profiles/:id`)
- [x] `browserManager` resolves `user.browsers[0].browserId` + `user.browsers[0].provider`
- [x] `injectUserParams` — auto-fills `setup_about/avatar/cover` params from user data
- [x] Between-step delays (5–15s) and post-task cooldown (10–15s)
- [x] `setup_cover` fixed for duplicate `[aria-label="Save changes"]` elements
- [x] `IMAGE_SERVER_BASE_URL` + `USER_API_BASE_URL` + `NODE_ENV` in `.env`
- [x] `create_page` + `schedule_posts` + `switch_profile` — split from the old `setup_page` action into one navigator + two leaves, composed via the `setup_page_full` preset
- [x] `utils/pageAddressData.js` — parses city/state strings, seeds ZIP codes by state
- [ ] `comment_post`, `follow`, `join_group`, `send_message`
- [ ] Enable Claude API for comment/share generation
- [ ] Task state tracking (SQLite)
- [ ] Per-task, per-browser logging

**Phase 3 (chat layer)**
- [x] `chat/nlToJson.js` — Claude API (Haiku) converts NL → task JSON using actionSchemas as the contract
- [x] `chat.js` — interactive CLI: type instruction → preview JSON → confirm → writes tasks.json
- [ ] Web UI for chat input
- [ ] Schema validation on generated JSON before execution

## Notes for Claude Code

When working on this project:

- Before adding features, re-read the "Core pattern" section — it's
  easy to accidentally violate recursive-steps thinking
- When asked to add a new action, always update `schemas/actionSchemas.js`
  in the same change
- If a Facebook selector isn't working, assume FB changed the DOM (they
  do this often) — try `page.pause()` and inspect live
- Prefer small, composable handlers over clever large ones
