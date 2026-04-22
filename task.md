# Worth Knowing (happy-path is fine, these bite later)

Current behavior is solid when proxies stay alive + US. Three weak spots
to revisit when they actually hurt:

1. **Runtime proxy is whatever Hidemium baked in, not what the DB says.**
   `runner.js` reads `user.proxies[0].proxy` for the pre-launch IP log,
   ignoring `status`. The actual proxy used by the browser is embedded
   in the Hidemium profile at creation time. Once a user has >1 proxy
   (rotation) the DB's "active" flag and Hidemium's real proxy can
   disagree. Fix when this matters: either filter by `status==="active"`,
   or store `proxyId` on `user.browsers[0]` so there's a truthful link.

2. **No runtime recovery for a dead proxy.** If the baked-in proxy dies
   mid-task, the session just fails and logs. No retry, no mark-dead,
   no fallback. Manual action required. Acceptable until it happens.

3. **`user.proxies` only grows.** Every `create-profile` run appends a
   new ref. Dead proxies never get pruned. Will need a cleanup pass or
   a policy (e.g. only keep last N, or GC on status=dead) once accounts
   accumulate many proxies.

---

# Open Ideas / Current Thoughts

## Profile pipeline: which userIds go where?

**Manual workflow today:**
1. Create Hidemium browser profile (`node create-profile.js <userId>`)
2. Open that profile, manually log into external sites / BASEWOOK
3. Run automation on it (`node run-task.js`, tasks.json has `profiles: [...]`)

Step 2 is a **hard manual pause** — can't be automated away.

### Problem

Right now the two commands don't share a list. Userids get typed/pasted into
tasks.json AND into `create-profile.js` args. Easy to drift, easy to forget which
accounts are at which stage.

### Options considered

1. **`createIfMissing: true` flag in tasks.json** — reject. Hides the
   creation moment inside `run-task`, which is exactly where the manual-login
   pause needs to happen. Also makes typo'd userIds silently create new profiles.

2. **Shared profile-DB file with two arrays** (`toCreate: [...]`, `toRun: [...]`) —
   works but adds a second source of truth. Have to update both the file and the
   3rd party API every time. The two arrays will drift.

3. **API-level filter (recommended).** Source of truth already exists:
   - `user.browsers[0]` empty → needs creation → feed into `create-profile.js`
   - `user.browsers[0]` populated + `profileSetup: true` → ready to run → feed into `run-task.js`
   - Add a small helper: `node list-profiles.js --needsBrowser` / `--readyToRun`
     that queries the API and prints userIds one per line. Pipe into the other scripts.

### Status

Not implemented. Decide between option 2 and option 3 when it starts to bite.

---

# Page Creation Task Reference (stale — refers to old `setup_page` action)

Use this file as the staging area for page-creation data you want me to turn into tasks.

## Data To Fill In

- `pageName`:
- `bio`:
- `categoryKeyword`:
If left blank, the automation will use the first word of `pageName`.

## Action Contract

Action name: `setup_page`

Params:

- `pageName` - required
- `bio` - optional
- `categoryKeyword` - optional override
- `createUrl` - optional, defaults to `https://www.facebook.com/pages/create`

## Current Selector Notes

1. Page name input: `label:has-text("Page name (required)") input`
2. Page category input: `input[aria-label="Category (required)"]`
3. Bio textarea: `//span[contains(text(), 'Bio')]/following::textarea[1]`
4. Submit button: `div[aria-label="Create Page"]`

Behavior:

- The action opens the page creation screen.
- It types `pageName`.
- It types the category keyword, then presses ArrowDown and Enter.
- It fills the bio if provided.
- It clicks `Create Page`.
- It uses random 3-10 second delays between setup steps.

## Example Task JSON

```json
{
  "taskId": "create-page-example",
  "profiles": ["PUT_USER_ID_HERE"],
  "concurrency": 1,
  "blockMedia": false,
  "steps": [
    {
      "type": "setup_page",
      "params": {
        "pageName": "Builder Picks Manila",
        "bio": "Sharing local finds, ideas, and helpful updates.",
        "categoryKeyword": "Builder"
      }
    }
  ]
}
```
```
