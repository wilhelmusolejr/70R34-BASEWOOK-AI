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
 * Wait + click any clickable element whose text-or-label matches `text`.
 * Matches `div[role="button"]` OR `div[role="radio"]` and considers BOTH:
 *   - the element's own `aria-label` (exact, or starts-with so radios that
 *     append " . Description . Radio button . Unselected" still match)
 *   - a child `<span>` with `text` as its trimmed text content
 *
 * This handles every consent-flow click in one helper: "Get started"
 * (button + aria-label exact), "Use free of charge with ads" (radio +
 * aria-label prefix), "Continue" / "Agree" / "OK" / "Accept and continue"
 * / "Done" (button + child span text). If FB swaps button↔radio on any
 * screen, the selector still resolves.
 *
 * `waitFor` (NOT `isVisible`) — `isVisible({ timeout })` returns
 * synchronously in modern Playwright (timeout is a no-op). `waitFor` is
 * the only way to actually wait for the element to render.
 */
async function waitClickByText(page, text, { waitMs = 15000, readMin = 2000, readMax = 3500 } = {}) {
  const xpath =
    `xpath=//div[(@role="button" or @role="radio") and (` +
    `@aria-label="${text}"` +
    ` or starts-with(normalize-space(@aria-label),"${text} ")` +
    ` or .//span[normalize-space(text())="${text}"]` +
    `)]`;
  const el = page.locator(xpath).first();
  try {
    await el.waitFor({ state: 'visible', timeout: waitMs });
  } catch (_) {
    console.log(`  [recovery] element matching "${text}" not found within ${waitMs}ms`);
    return false;
  }
  await humanWait(page, readMin, readMax);
  try {
    await el.click({ force: true });
    console.log(`  [recovery] clicked "${text}"`);
    return true;
  } catch (err) {
    console.warn(`  [recovery] click on "${text}" threw: ${err.message}`);
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
      // waitFor (NOT isVisible({timeout})) — isVisible's timeout is a no-op in
      // modern Playwright (returns synchronously), so on a slow-rendering
      // consent page the old probe returned false before the button mounted
      // and the recoverer reported "matched but couldn't fix". waitFor is the
      // only way to actually wait for the button to appear.
      try {
        await btn.waitFor({ state: 'visible', timeout: 8000 });
      } catch (_) {
        return false;
      }
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
      // Step 1 — "Get started". Probe with a short timeout; if not visible,
      // a previous half-recovery may have already advanced past this screen,
      // so we resume from Step 2 rather than failing.
      if (await waitClickByText(page, 'Get started', { waitMs: 3000, readMin: 2500, readMax: 4500 })) {
        // clicked — continue to Step 2
      } else {
        console.log('  [recovery] "Get started" not visible — resuming from radio screen');
      }

      // Step 2 — pick "Use free of charge with ads" then "Continue".
      // FB renders the option as div[role="radio"], not div[role="button"];
      // waitClickByText matches either, so one call covers both shapes.
      // Continue is disabled until a radio is selected, so the radio is the
      // real gate.
      if (!(await waitClickByText(page, 'Use free of charge with ads', { readMin: 3000, readMax: 5000 }))) {
        return false;
      }
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
      if (!(await waitClickByText(page, 'Get started', { readMin: 2500, readMax: 4500 }))) {
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

/**
 * Cheap check: is the page currently parked on a consent funnel?
 *
 * Scoped to `/privacy/consent/` ONLY — checkpoints (`/checkpoint/`) keep their
 * dedicated handling in runner.js (pre-flight / in-retry / post-step sweep +
 * Need-Checking PATCH). We deliberately do NOT fold checkpoints into this gate
 * so the two concerns stay independent.
 */
function isConsentBlocked(page) {
  return safeUrl(page).includes('/privacy/consent/');
}

/**
 * Proactive recovery GATE. Unlike tryRecover (reactive — only called after a
 * step throws, fixes one screen, hands control back to the retry loop), this
 * keeps recovering until the page is no longer on a consent funnel OR we run
 * out of rounds. FB chains consent funnels (cookie → ad_free → 3pd), so a
 * single tryRecover pass clears only the first; looping clears the whole chain
 * in one gate before the next real step runs.
 *
 * Returns { ready, reason }:
 *   ready: true            → page is clean, safe to run the next step
 *   ready: false, reason   → still blocked after maxRounds, OR a recoverer
 *                            flagged the URL 'unfixable'. Caller should abort.
 *
 * Never throws — recoverer errors are swallowed inside tryRecover.
 */
async function recoverUntilReady(page, ctx = {}, { maxRounds = 4 } = {}) {
  if (!page) return { ready: true };

  for (let round = 1; round <= maxRounds; round++) {
    if (!isConsentBlocked(page)) return { ready: true };

    console.log(
      `  [recovery-gate] page parked on consent funnel (round ${round}/${maxRounds}) — recovering before continuing`
    );
    const { recovered, unfixable } = await tryRecover(page, ctx);

    if (unfixable) return { ready: false, reason: `unfixable:${unfixable}` };
    if (!isConsentBlocked(page)) return { ready: true };

    // recovered but still on a consent URL → FB chained into the next funnel;
    // loop and the matching recoverer fires next round. matched-but-couldn't-fix
    // (recovered === null) → brief wait in case the screen is still rendering,
    // then retry.
    if (!recovered) {
      await humanWait(page, 1500, 2500);
    }
  }

  return { ready: !isConsentBlocked(page), reason: 'recovery exhausted' };
}

module.exports = { tryRecover, recoverUntilReady, isConsentBlocked, RECOVERERS };
