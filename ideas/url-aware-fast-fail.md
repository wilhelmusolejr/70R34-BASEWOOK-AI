# Idea: URL-aware fast-fail + browser-dead short-circuit

Saved 2026-05-31 — surfaced after the Renzo Battistini run burned ~12 min
on the EU ad-free-subscription consent intercept that no recovery handled.

## Problem we observed

The runner's retry loop (3 attempts × 60s wait) is great for transient
flake. It's wasteful for **deterministic** failure modes:

1. Page is on a known-intercept URL we have no recovery for
   (e.g. `flow=ad_free_subscription`)
2. Browser/page is dead (`Target page, context or browser has been closed`)

Both cases burn ~3.5 min per step before soft-failing, then EVERY subsequent
step burns another ~3.5 min on the same failure mode. On the Renzo run,
4 cascading failing steps × 3.5 min = ~14 min of pure waste while we
watched heartbeats with handles=0.

## Proposed change — three flavors, recommend (b)

### (a) URL fast-fail list
A registry of URL patterns meaning "deterministic block — no retry helps":
```js
const UNFIXABLE_URL_PATTERNS = [
  { pattern: /flow=ad_free_subscription/,
    reason: 'EU ad-free subscription upsell (no recovery yet)' },
  { pattern: /\/login\.php\?next/,
    reason: 'logged out mid-step (re-login already attempted)' },
];
```
In `runWithRetry` catch block, BEFORE the 60s wait:
```js
const blocker = matchUnfixableUrl(page);
if (blocker) {
  console.warn(`Step blocked by URL: ${blocker.reason} — skipping remaining attempts`);
  err.noRetry = true;
  break;
}
```

### (b) Extend recovery registry with 'unfixable' return value — RECOMMENDED
Today recoverers return `true | false`. Add a third: `'unfixable'`:
```js
{
  name: 'ad-free-subscription',
  matches: (page) => safeUrl(page).includes('flow=ad_free_subscription'),
  apply: async () => 'unfixable',  // until we build the multi-step click sequence
}
```
- `tryRecover` propagates the `'unfixable'` signal as a sentinel
- `runWithRetry` treats `'unfixable'` as `noRetry` — step soft-fails
  immediately, runner moves to next sibling step
- Same outcome as (a) but URL knowledge stays in the recovery registry
- Extends naturally: when we later build the multi-step click sequence
  for ad-free, the recoverer can return `true` and retry resumes

### (c) Per-step expected-URL guard — SKIP for now
Each handler declares URL patterns it expects:
```js
const EXPECTED_URLS = {
  accept_loop: [/\/profile\.php/, /facebook\.com\/[^/]+$/],
  search:      [/\/search\//, /facebook\.com\/$/],
};
```
Bigger surface area, brittle to FB URL mutation. Skip unless (a)+(b) miss.

## Bundle with: browser-dead short-circuit

Different mechanism, same goal. When `err.message` matches
`Target page, context or browser has been closed`, abort the whole session
like a checkpoint (PATCH user status to `Need Checking`? or just bail without
status change?). No URL to inspect — the page is gone.

Currently runWithRetry treats this as a transient error and burns full 3
attempts × 60s on every step until end-of-task.

## Expected impact on the Renzo run we saw

- Ad-free-subscription block → 5s soft-fail per step instead of 3.5 min
- Browser-dead after connect_loop → whole session aborts instead of
  burning every remaining step's 3 × 60s loop
- Total task time: ~25 min instead of 50+ min for the same outcome

## Deliverable (when we come back to this)

1. `utils/recoverers.js`:
   - Add `'unfixable'` return value semantics
   - Add `ad-free-subscription` recoverer that matches
     `flow=ad_free_subscription` and returns `'unfixable'` (until the
     multi-step click sequence is built)
2. `runner.js` `runWithRetry`:
   - Catch `'unfixable'` from `tryRecover`, set `err.noRetry = true`,
     break the retry loop
   - Detect `Target page, context or browser has been closed` in
     `err.message`, treat as session-abort (like checkpoint)
3. CLAUDE.md:
   - Update "Recovery chain" section to mention `'unfixable'` as a
     legitimate apply() return value
   - Add "Session-abort triggers" or extend the existing checkpoint
     section with the browser-dead case

## Future companion: multi-step ad-free-subscription recovery

When we want to actually handle this consent flow (not just fast-fail):

```
1. URL matches /privacy/consent/?flow=ad_free_subscription
2. Click "Get started"  (aria-label="Get started", confirmed from dump)
3. Wait for next page to load
4. Look for "Use Facebook with ads" / Italian "Continua con gli annunci"
   (selector TBD — need to capture HTML once we click through)
5. Click it
6. Wait for redirect off /privacy/consent/
7. Return true (recovered, retry the original step)
```

Per-profile this only needs to fire ONCE — FB remembers the choice
indefinitely. So a fleet run on the first day would consume ~10s per
profile for this dance, then never again.

## Related observation

The "matched but couldn't fix" log line for the `eu-cookie-consent`
recovery on the ad-free page is misleading — the matcher's URL prefix
check is too loose. Even without (b), tightening the matcher to require
`flow=user_cookie_choice_v2` would already help diagnostic clarity.
