/**
 * Mid-step recovery registry.
 *
 * When a step throws (selector timeout, navigation timeout, etc.) the runner
 * calls tryRecover(page, ctx) BEFORE its wait-and-retry sleep. Recoverers are
 * tried in order; the first whose `matches(page)` returns truthy gets its
 * `apply(page, ctx)` called. If apply returns true, the page is back in a
 * usable state and the runner's retry has a fresh chance to succeed.
 *
 * Each entry is a (detect, fix) pair so we can grow the list without bloating
 * runWithRetry. Strong match conditions are the contract — we never want to
 * apply the wrong fix to the wrong page.
 *
 * Adding a new recoverer:
 *   1. Append to RECOVERERS with { name, matches, apply }.
 *   2. `matches(page)` should be cheap and URL- or selector-based — no heavy
 *      navigation. Return a boolean (sync or async).
 *   3. `apply(page, ctx)` returns one of THREE values:
 *        true         → recovered, retry will succeed
 *        false        → matched but couldn't fix (e.g. button not visible
 *                       this time); runner moves on to the next recoverer
 *                       AND continues its normal retry-with-60s loop
 *        'unfixable'  → URL/state is a known dead-end with no resolution
 *                       (e.g. an FB consent flow we don't yet handle). The
 *                       runner SKIPS remaining retries — burning them is
 *                       waste. Step soft-fails immediately.
 *      Errors inside apply are caught and logged — never propagated.
 *   4. Order matters — list the cheapest / most specific first.
 */

const { humanClick, humanWait } = require('./humanBehavior');

function safeUrl(page) {
  try {
    return page.url();
  } catch (_) {
    return '';
  }
}

/**
 * Wait for a `div[role="button"]` whose visible span text matches `text`
 * exactly (after trim), then click it. Returns true on success, false if
 * the button never appears within `waitMs`. Adds a reading delay between
 * detection and click — instant-clicking is a bot tell.
 *
 * `text` is the visible label (e.g. "Continue", "Agree", "Accept and continue").
 * XPath uses normalize-space + a contains() fallback so trailing whitespace
 * or wrapper elements don't defeat the match.
 */
async function waitClickByText(page, text, { waitMs = 15000, readMin = 2000, readMax = 3500 } = {}) {
  const xpath =
    `xpath=//div[@role="button"][.//span[normalize-space(text())="${text}"]] | ` +
    `//div[@role="button"][.//span[contains(normalize-space(text()),"${text}")]]`;
  const btn = page.locator(xpath).first();
  const visible = await btn.isVisible({ timeout: waitMs }).catch(() => false);
  if (!visible) {
    console.log(`  [recovery] button with text "${text}" not found within ${waitMs}ms`);
    return false;
  }
  await humanWait(page, readMin, readMax);
  try {
    await btn.click({ force: true });
    console.log(`  [recovery] clicked "${text}"`);
    return true;
  } catch (err) {
    console.warn(`  [recovery] click on "${text}" threw: ${err.message}`);
    return false;
  }
}

/**
 * Wait + click a `div[aria-label="..."]` (typically with role="button").
 * Same reading-delay semantics as `waitClickByText`. Used for buttons that
 * FB labels via aria-label rather than visible text (e.g. "Get started").
 */
async function waitClickByLabel(page, label, { waitMs = 15000, readMin = 2000, readMax = 3500 } = {}) {
  const btn = page.locator(`div[aria-label="${label}"][role="button"]`).first();
  const visible = await btn.isVisible({ timeout: waitMs }).catch(() => false);
  if (!visible) {
    console.log(`  [recovery] button with aria-label="${label}" not found within ${waitMs}ms`);
    return false;
  }
  await humanWait(page, readMin, readMax);
  try {
    await btn.click({ force: true });
    console.log(`  [recovery] clicked aria-label="${label}"`);
    return true;
  } catch (err) {
    console.warn(`  [recovery] click on aria-label="${label}" threw: ${err.message}`);
    return false;
  }
}

const RECOVERERS = [
  // --------------------------------------------------------------------------
  // EU cookie-consent screen. FB redirects mid-navigation to
  // /privacy/consent/?flow=user_cookie_choice_v2 and blocks every subsequent
  // navigation until the user clicks "Allow all cookies" or "Decline".
  // Without this recoverer the bot hangs waiting for the home-button selector
  // (a[href="/"][role="link"]) until the 5-minute step timeout fires.
  //
  // Matcher requires `flow=user_cookie_choice_v2` specifically — a plain
  // `/privacy/consent/` substring would also match the ad-free-subscription
  // flow below (different page, different button, NOT a cookie banner).
  // --------------------------------------------------------------------------
  {
    name: 'eu-cookie-consent',
    matches: (page) => {
      const u = safeUrl(page);
      return u.includes('/privacy/consent/') && u.includes('flow=user_cookie_choice_v2');
    },
    apply: async (page) => {
      const btn = page
        .locator('div[aria-label="Allow all cookies"]:not([aria-hidden="true"])')
        .first();
      const visible = await btn.isVisible({ timeout: 5000 }).catch(() => false);
      if (!visible) return false;
      // Reading delay — a real human glances at the consent text before clicking.
      // Cookie banners are long-ish, so 2.5-4.5s.
      await humanWait(page, 2500, 4500);
      await btn.click({ force: true });
      console.log('  [recovery:eu-cookie-consent] clicked "Allow all cookies"');
      try {
        await page.waitForURL((u) => !String(u).includes('/privacy/consent/'), {
          timeout: 30000,
        });
      } catch (_) {
        // Click registered but no redirect — still count as recovered;
        // the retry can re-navigate explicitly if it needs to.
      }
      await humanWait(page, 1500, 2500);
      return true;
    },
  },

  // --------------------------------------------------------------------------
  // EU "pay-or-consent" ad-free subscription funnel. FB intercepts every
  // navigation with `/privacy/consent/?flow=ad_free_subscription` until
  // the profile completes a 4-step click sequence. Per-profile this only
  // needs to fire ONCE — FB remembers the choice indefinitely.
  //
  // Click sequence (captured from real session HTML in /fix on 2026-05-31):
  //   1. aria-label="Get started"
  //   2. Pick the "Use free of charge with ads" option → "Continue"
  //   3. "Agree" (ads-data-processing info screen)
  //   4. "OK" (ad-experience review)
  // Then FB redirects either back to the original target OR straight into
  // the second consent funnel (data-settings-review below). The 3-attempt
  // retry budget handles both back-to-back.
  // --------------------------------------------------------------------------
  {
    name: 'ad-free-subscription',
    matches: (page) => {
      const u = safeUrl(page);
      return u.includes('/privacy/consent/') && u.includes('flow=ad_free_subscription');
    },
    apply: async (page) => {
      // Step 1 — "Get started"
      if (!(await waitClickByLabel(page, 'Get started', { readMin: 2500, readMax: 4500 }))) {
        return false;
      }

      // Step 2 — pick "Use free of charge with ads" then "Continue"
      // FB renders the radio with the option label as a child <span>. Clicking
      // the visible row label triggers the radio selection.
      await waitClickByText(page, 'Use free of charge with ads', {
        waitMs: 15000,
        readMin: 3000,
        readMax: 5000,
      });
      if (!(await waitClickByText(page, 'Continue', { readMin: 1500, readMax: 2500 }))) {
        return false;
      }

      // Step 3 — "Agree" on the data-processing info screen
      if (!(await waitClickByText(page, 'Agree', { readMin: 3000, readMax: 5000 }))) {
        return false;
      }

      // Step 4 — "OK" on the ad-experience review
      if (!(await waitClickByText(page, 'OK', { readMin: 2000, readMax: 3500 }))) {
        return false;
      }

      // Wait for the URL to leave ad_free_subscription. FB may chain into
      // consent_next_3pd (handled by the next recoverer on the next retry),
      // OR redirect back to the original target. Either way is success.
      try {
        await page.waitForURL((u) => !String(u).includes('flow=ad_free_subscription'), {
          timeout: 30000,
        });
      } catch (_) {}
      await humanWait(page, 1500, 2500);
      return true;
    },
  },

  // --------------------------------------------------------------------------
  // GDPR "Required: Review Your Data Settings" funnel — FB's second consent
  // that often appears right after ad-free-subscription. URL has
  // `/privacy/consent/?flow=consent_next_3pd`. 3-step click sequence:
  //   1. aria-label="Get started"
  //   2. "Accept and continue"
  //   3. "Done"
  // After this FB returns to normal navigation. Like ad-free, fires only
  // once per profile lifetime.
  // --------------------------------------------------------------------------
  {
    name: 'data-settings-review',
    matches: (page) => {
      const u = safeUrl(page);
      return u.includes('/privacy/consent/') && u.includes('flow=consent_next_3pd');
    },
    apply: async (page) => {
      if (!(await waitClickByLabel(page, 'Get started', { readMin: 2500, readMax: 4500 }))) {
        return false;
      }
      if (
        !(await waitClickByText(page, 'Accept and continue', { readMin: 3000, readMax: 5000 }))
      ) {
        return false;
      }
      if (!(await waitClickByText(page, 'Done', { readMin: 1500, readMax: 2500 }))) {
        return false;
      }
      try {
        await page.waitForURL((u) => !String(u).includes('flow=consent_next_3pd'), {
          timeout: 30000,
        });
      } catch (_) {}
      await humanWait(page, 1500, 2500);
      return true;
    },
  },

  // --------------------------------------------------------------------------
  // Soft checkpoint modal. FB has TWO variants of /checkpoint/:
  //   • SOFT — "we suspect automated behavior" with a Dismiss button. The
  //     Dismiss handler here clears the modal and returns the session to a
  //     usable state, so the retry can proceed.
  //   • HARD — banned / verification required, NO Dismiss button. This
  //     recoverer returns false on hard checkpoints; runner.js detects the
  //     non-recovery and short-circuits the profile to status=Need Checking
  //     (it then surfaces for manual triage).
  // --------------------------------------------------------------------------
  {
    name: 'soft-checkpoint',
    matches: (page) => safeUrl(page).includes('/checkpoint/'),
    apply: async (page) => {
      try {
        await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {});
        const dismissBtn = page.locator('div[aria-label="Dismiss"][role="button"]').first();
        await dismissBtn.waitFor({ state: 'visible', timeout: 10000 });
        const box = await dismissBtn.boundingBox();
        if (!box) return false;
        // Reading delay — checkpoint modals have a wall of warning text.
        // A real user would scan it before clicking Dismiss. 3-5s.
        await humanWait(page, 3000, 5000);
        await humanClick(page, box);
        await humanWait(page, 2000, 3500);
        console.log('  [recovery:soft-checkpoint] Dismiss clicked');
        return true;
      } catch (_) {
        // No Dismiss button visible — hard checkpoint, caller handles
        return false;
      }
    },
  },

  // --------------------------------------------------------------------------
  // "Not now" upsell modal that FB sprinkles on schedule_posts and other
  // composer flows. Specific actions already dismiss this inline, but having
  // a generic recoverer covers the case where some other step bumps into it.
  // --------------------------------------------------------------------------
  {
    name: 'not-now-modal',
    matches: async (page) => {
      try {
        const btn = page.locator('div[role="button"][aria-label="Not now"]').first();
        return await btn.isVisible({ timeout: 1500 }).catch(() => false);
      } catch (_) {
        return false;
      }
    },
    apply: async (page) => {
      const btn = page.locator('div[role="button"][aria-label="Not now"]').first();
      try {
        // Reading delay — short, "Not now" upsells are one-liners. 1.2-2.5s.
        await humanWait(page, 1200, 2500);
        await btn.click({ force: true });
        await humanWait(page, 1000, 2000);
        console.log('  [recovery:not-now-modal] dismissed');
        return true;
      } catch (_) {
        return false;
      }
    },
  },
];

/**
 * Walk the registry. First matcher that fires gets a chance to fix the page.
 *
 * @param {import('playwright').Page} page
 * @param {Object} [ctx] — caller-provided context (user, stepType, etc.)
 * @returns {Promise<{ recovered: string|null, unfixable: string|null }>}
 *   recovered → name of the recoverer that fixed the page (retry will try again)
 *   unfixable → name of the recoverer that flagged the URL as a dead-end
 *               (runner should skip remaining retries)
 *   both null → no recoverer matched (runner continues normal retry path)
 */
async function tryRecover(page, ctx = {}) {
  if (!page) return { recovered: null, unfixable: null };

  for (const r of RECOVERERS) {
    let matched = false;
    try {
      matched = await r.matches(page);
    } catch (err) {
      console.warn(`  [recovery:${r.name}] matches() threw: ${err.message}`);
      continue;
    }
    if (!matched) continue;

    console.log(`  [recovery] trying "${r.name}"`);
    try {
      const result = await r.apply(page, ctx);
      if (result === true) {
        console.log(`  [recovery] "${r.name}" recovered`);
        return { recovered: r.name, unfixable: null };
      }
      if (result === 'unfixable') {
        console.warn(
          `  [recovery] "${r.name}" flagged URL as unfixable — runner will skip remaining retries`
        );
        return { recovered: null, unfixable: r.name };
      }
      console.log(`  [recovery] "${r.name}" matched but couldn't fix — moving on`);
    } catch (err) {
      console.warn(`  [recovery:${r.name}] apply() threw: ${err.message}`);
    }
  }

  return { recovered: null, unfixable: null };
}

module.exports = { tryRecover, RECOVERERS };
