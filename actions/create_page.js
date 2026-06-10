/**
 * create_page - Navigator action.
 * Creates a Facebook Page: fills form fields, uploads profile + cover, advances through
 * Steps 2-5, and lands on the new Page URL (facebook.com/profile.php?id=*).
 *
 * Retry strategy:
 *   - PRE-CREATE phase (up through the "Create Page" advance click that actually
 *     commits the Page on FB's side): the whole block can restart up to 3 times
 *     with a 60s pause between tries. Safe to restart because no Page has been
 *     created yet.
 *   - POST-CREATE phase (fill email/address, upload images, advance steps 2-5):
 *     each individual action retries up to 2 times with a 60s pause. Never
 *     restart the whole flow from scratch here — that would create a duplicate
 *     Page on FB.
 *
 * On exhaustion of either phase, the thrown error is marked `noRetry = true`
 * so `runner.js`'s step-level retry (runWithRetry) does NOT re-run create_page.
 *
 * Child steps (e.g. schedule_posts, switch_profile) run on the newly created page.
 */

const fs = require('fs');
const axios = require('axios');
const { humanClick, humanWait } = require('../utils/humanBehavior');
const { parseCityState, buildPageAddress } = require('../utils/pageAddressData');
const {
  stepWait,
  downloadToTemp,
  clickAndReplace,
  typeAndSelect,
  clickLocator,
  uploadImageFromButton,
} = require('../utils/pageSetupHelpers');
const { setOnboarding, autoAssignPage, fetchPageSetStats } = require('../utils/userApi');

const USER_API_BASE_URL = process.env.USER_API_BASE_URL || '';
const IMAGE_SERVER_BASE_URL = process.env.IMAGE_SERVER_BASE_URL || '';

function buildImageUrl(filename) {
  if (!filename) return '';
  if (/^https?:\/\//i.test(filename)) return filename;
  return `${IMAGE_SERVER_BASE_URL}${filename}`;
}

/**
 * Resolve profile + cover image URLs from an assigned Page's assets[].
 * Prefers the explicit asset `type` field ("profile"/"cover") that the
 * /api/pages records carry, falling back to positional order. Mirrors
 * runner.js resolveSetupPageImages but type-first (more robust than the
 * filename-keyword heuristic when the type is populated).
 */
function resolvePageAssetUrls(assets) {
  const list = Array.isArray(assets) ? assets : [];
  const fileOf = (a) => a?.imageId?.filename || a?.filename || '';
  const byType = (t) => fileOf(list.find((a) => a?.type === t));
  const filenames = list.map(fileOf).filter(Boolean);
  const profile = byType('profile') || filenames[0] || '';
  const cover = byType('cover') || filenames[1] || filenames[0] || '';
  return {
    profilePhotoUrl: buildImageUrl(profile),
    coverPhotoUrl: buildImageUrl(cover),
  };
}

const PRE_CREATE_ATTEMPTS = 3;
const POST_FIELD_ATTEMPTS = 2;
const RETRY_WAIT_MS = 60000;

// Page-setup cooldown. create_page stamps onboarding.pageSetAt once a Page is
// committed FB-side; the entry gate then skips re-runs while the stamp is fresh.
// After this many days, if the profile STILL has no pageUrl, the earlier attempt
// evidently never produced a usable Page, so one more attempt is allowed.
const PAGE_SETUP_RETRY_DAYS = 10;

/**
 * Retry a single post-create action (field fill, upload, step advance).
 * On exhaustion, marks the error with `noRetry = true` so the runner's
 * step-level retry does NOT restart the whole create_page (which would
 * create a duplicate Page on FB).
 */
async function retryField(
  label,
  fn,
  { attempts = POST_FIELD_ATTEMPTS, waitMs = RETRY_WAIT_MS } = {}
) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      console.warn(
        `  [create_page] ${label} failed (attempt ${attempt}/${attempts}): ${err.message}`
      );
      if (attempt < attempts) {
        console.warn(`  [create_page] Waiting ${waitMs / 1000}s before retrying ${label}...`);
        await new Promise((resolve) => setTimeout(resolve, waitMs));
      }
    }
  }
  if (lastError) lastError.noRetry = true;
  throw lastError;
}

/**
 * Normalize a managed-Page anchor href into the canonical Page URL we persist.
 * FB's "Pages you manage" links carry tracking params (e.g. `&__tn__=...`); we
 * keep only the stable `profile.php?id=<numeric>` form. Returns '' if the href
 * isn't a numeric Page link.
 */
function normalizePageUrl(href) {
  const m = String(href || '').match(/profile\.php\?id=(\d+)/);
  return m ? `https://www.facebook.com/profile.php?id=${m[1]}` : '';
}

/**
 * FB-side duplicate-Page guard. The DB `pageUrl` field can be empty/stale even
 * when a Page actually exists FB-side (created out-of-band, or a prior
 * post-create PATCH that never landed) — so trusting it alone risks spawning a
 * SECOND Page. This visits the account's "Pages you manage" listing
 * (`/pages/?category=your_pages`) and returns the existing Page's canonical URL
 * if one is found, else ''.
 *
 * Detection signal (from real DOM captures of both states): the managed-pages
 * list renders an `a[role="link"][href*="/profile.php?id="]` per owned Page.
 * When the account manages NO Pages, zero such anchors exist on the page, and
 * the top-bar "Your profile" entry is a `div[aria-haspopup]` (not a profile.php
 * link) — so there are no false positives. The href selector is locale-proof
 * (unlike the "Profile picture for <name>" aria-label, which is translated).
 *
 * Fail-open: any navigation/probe error returns '' (proceed to create) — a
 * transient hiccup here must never permanently block page creation. The cheap
 * DB gate + the post-create pageUrl PATCH remain the primary duplicate guards;
 * this is the deeper safety net.
 */
async function findExistingManagedPageUrl(page) {
  try {
    await page.goto('https://www.facebook.com/pages/?category=your_pages&ref=bookmarks', {
      waitUntil: 'domcontentloaded',
    });
  } catch (err) {
    console.warn(
      `  [create_page] Could not load managed-Pages list (${err.message}) — skipping FB-side duplicate check.`
    );
    return '';
  }

  // The list lazy-loads after the shell paints. Wait for a managed-Page anchor
  // to appear; if none within the window, the account manages no Pages.
  const pageLink = page.locator('a[role="link"][href*="/profile.php?id="]').first();
  const appeared = await pageLink
    .waitFor({ state: 'visible', timeout: 12000 })
    .then(() => true)
    .catch(() => false);
  if (!appeared) return '';

  const href = await pageLink.getAttribute('href').catch(() => '');
  return normalizePageUrl(href);
}

async function persistPageUrl(userId, pageUrl) {
  if (!userId) {
    console.warn('  [create_page] No userId provided — skipping pageUrl PATCH.');
    return;
  }
  if (!USER_API_BASE_URL) {
    console.warn('  [create_page] USER_API_BASE_URL not set — skipping pageUrl PATCH.');
    return;
  }

  const target = `${USER_API_BASE_URL}/api/profiles/${userId}`;
  try {
    await axios.patch(target, { pageUrl }, { timeout: 15000 });
    console.log(`  [create_page] PATCHed pageUrl → ${target}`);
  } catch (err) {
    console.warn(`  [create_page] Failed to PATCH pageUrl: ${err.message}`);
  }
}

function getCategoryKeyword(pageName, categoryKeyword) {
  if (categoryKeyword && categoryKeyword.trim()) return categoryKeyword.trim();

  const firstWord = String(pageName || '')
    .trim()
    .split(/\s+/)
    .find(Boolean);

  if (!firstWord) return '';
  return firstWord.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '') || firstWord;
}

async function waitForCreateDialog(page) {
  const dialog = page.locator('xpath=//div[@role="dialog"][.//h2[contains(., "Create")]]').first();
  await dialog.waitFor({ state: 'visible', timeout: 15000 });
  await stepWait(page);
  return dialog;
}

/**
 * Dismiss any modals left open from a failed pre-create attempt by
 * pressing Escape a few times. Safe to call when no modal is present.
 */
async function resetModals(page) {
  for (let i = 0; i < 3; i++) {
    await page.keyboard.press('Escape').catch(() => {});
    await humanWait(page, 300, 600);
  }
}

/**
 * Pure eligibility gate for create_page — no Playwright, just the user-derived
 * params. Returns `{ skip, reason }`. Evaluated in priority order:
 *
 *   1. Duplicate-Page guard — pageUrl already recorded → skip (create_page is
 *      destructive; a second run spawns a duplicate Page that needs manual
 *      cleanup AND splits page-asset state in the DB).
 *   2. Page-setup cooldown — onboarding.pageSetAt stamped & fresh (< 10d) →
 *      skip. Stamped & stale (≥ 10d) with pageUrl still empty (proven by gate 1)
 *      → the earlier attempt never produced a usable Page, so allow a retry (no
 *      skip). Stamped but unparseable date → skip (safe default: an attempt was
 *      made, don't risk a duplicate on a bad timestamp).
 *
 *      NOTE: the server's onboarding key is `pageSetAt` (no "up") — that's the
 *      only spelling /api/profiles/:id/onboarding/:key accepts. Using
 *      `pageSetupAt` 400s ("Unknown onboarding key") and the stamp never lands.
 *
 * NOTE: a missing linkedPage is intentionally NOT a gate. A profile with no
 * blueprint is still eligible — the action claims one from the online pool
 * (POST /api/pages/auto-assign) AFTER passing this gate + the chance roll, so a
 * pool page is only consumed when we're actually about to create. The gate
 * therefore no longer reads pageName.
 *
 * Shared by the action (defense-in-depth / direct invocation) AND the runner's
 * pre-`chance` guard phase (so an ineligible profile never wastes a probability
 * slot). Single source of truth — keep the two callers in sync via this fn.
 */
/**
 * Resolve the tz offset (minutes, JS getTimezoneOffset() convention — UTC+8 →
 * -480) used to align the page-set-stats day boundary with the intended
 * "current date". Precedence: explicit step-param override → PAGE_STATS_TZ_OFFSET
 * env → the bot machine's own offset. Set PAGE_STATS_TZ_OFFSET=-480 so the
 * day window matches the PH-time dashboard regardless of the server's clock.
 */
function resolveStatsTzOffset(override) {
  for (const candidate of [override, process.env.PAGE_STATS_TZ_OFFSET]) {
    const n = Number(candidate);
    if (candidate !== undefined && candidate !== null && candidate !== '' && Number.isFinite(n)) {
      return n;
    }
  }
  return new Date().getTimezoneOffset();
}

/**
 * Today's date (YYYY-MM-DD) for a given tz offset — the local wall-clock day at
 * that offset. Computed from the SAME offset sent to the endpoint so the date
 * and the boundary stay consistent.
 */
function statsDateForOffset(tzOffset) {
  return new Date(Date.now() - tzOffset * 60000).toISOString().slice(0, 10);
}

/**
 * Daily page-creation circuit breaker (operationalizes the volume finding:
 * FB's create_page gate is a cumulative per-day rate limit, so once it starts
 * pushing back, back off for the rest of the day).
 *
 * Reads today's page-set stats from the server — profiles whose
 * `onboarding.pageSetAt` was stamped today, split into passed (has pageUrl) vs
 * failed (no pageUrl, i.e. checkpoint / no-form) — and skips this profile once
 * the day's `failed` count EXCEEDS the tolerated budget.
 *
 * `allowedFailures` = failures tolerated before tripping:
 *   0 → trip on the first failure today, 1 → allow one (trip on the 2nd), etc.
 *   Trips when `failedToday > allowedFailures`.
 *
 * Opt-in: disabled (never skips) when `allowedFailures` is not a finite number,
 * so tasks that don't set it are unaffected. Fails OPEN on any API error — a
 * stats-endpoint hiccup must never silently halt all page creation.
 *
 * @param {*} allowedFailures — from step params (number or numeric string)
 * @param {*} [tzOffsetOverride] — optional step-param tz offset override
 * @returns {Promise<{skip:boolean, reason:string}>}
 */
async function checkDailyFailureBreaker(allowedFailures, tzOffsetOverride) {
  const allowed = Number(allowedFailures);
  if (!Number.isFinite(allowed)) return { skip: false, reason: '' };

  const tzOffset = resolveStatsTzOffset(tzOffsetOverride);
  const date = statsDateForOffset(tzOffset);
  try {
    const stats = await fetchPageSetStats(date, tzOffset);
    if (stats.failed > allowed) {
      return {
        skip: true,
        reason:
          `${stats.failed} page-creation failure(s) already today (${date}) > ` +
          `allowed ${allowed} — daily circuit breaker`,
      };
    }
    console.log(
      `  [create_page] daily breaker OK — ${stats.failed} failure(s) today (${date}), ` +
        `allowed ${allowed} (passed=${stats.passed}, total=${stats.total}).`
    );
    return { skip: false, reason: '' };
  } catch (err) {
    console.warn(
      `  [create_page] daily breaker check failed (${err.message}) — allowing creation (fail-open).`
    );
    return { skip: false, reason: '' };
  }
}

function createPageGate({ pageUrl = '', pageSetAt = '' } = {}) {
  if (pageUrl && String(pageUrl).trim()) {
    return {
      skip: true,
      reason: `already has pageUrl="${pageUrl}" (duplicate-Page guard)`,
    };
  }

  if (pageSetAt && String(pageSetAt).trim()) {
    const stampedMs = Date.parse(pageSetAt);
    if (Number.isNaN(stampedMs)) {
      return {
        skip: true,
        reason: `pageSetAt set but unparseable ("${pageSetAt}") (safe default)`,
      };
    }
    const ageDays = (Date.now() - stampedMs) / 86400000;
    if (ageDays < PAGE_SETUP_RETRY_DAYS) {
      return {
        skip: true,
        reason: `pageSetAt stamped ${ageDays.toFixed(1)}d ago (< ${PAGE_SETUP_RETRY_DAYS}d page-setup cooldown)`,
      };
    }
    // Stale stamp, still no pageUrl → fall through and allow a retry.
  }

  return { skip: false, reason: '' };
}

module.exports = async function create_page(page, params) {
  const {
    email = '',
    streetAddress = '',
    city = '',
    state = '',
    zipCode = '',
    categoryKeyword = '',
    userId = '',
    pageCountryMode = 'random',
  } = params;

  // Page-derived fields. Mutable because when the profile has no linkedPage
  // blueprint these arrive empty and get filled from a pool page claimed below.
  let { pageName = '', bio = '', profilePhotoUrl = '', coverPhotoUrl = '' } = params;

  // Entry gate — duplicate-Page / page-setup cooldown (NOT nothing-to-create;
  // a missing blueprint is recoverable via the pool claim below).
  // Defense-in-depth: when invoked via the runner this has already been checked
  // in the pre-`chance` guard phase, but the action re-checks so a direct
  // invocation (dev script / test) is still protected from spawning a duplicate
  // Page. `return` (no throw) — from the runner's view the step was a clean no-op.
  const gate = createPageGate(params);
  if (gate.skip) {
    console.log(`  [create_page] skipping — ${gate.reason}.`);
    return;
  }

  // FB-side duplicate-Page guard. Runs BEFORE the pool claim + the destructive
  // create flow, so a Page that already exists FB-side (but isn't recorded in
  // the DB `pageUrl`) is caught without consuming a pool page or spawning a
  // duplicate. On a hit: back-fill pageUrl (so the cheap DB gate short-circuits
  // next time) + stamp pageSetAt, then clean-skip (no throw — a no-op step).
  const existingPageUrl = await findExistingManagedPageUrl(page);
  if (existingPageUrl) {
    console.log(
      `  [create_page] Account already manages a Page (${existingPageUrl}) — ` +
        'back-filling pageUrl and skipping (FB-side duplicate-Page guard).'
    );
    await persistPageUrl(userId, existingPageUrl);
    if (userId) await setOnboarding(userId, 'pageSetAt');
    return;
  }

  // No linked Page blueprint on the profile → claim one from the online pool
  // (POST /api/pages/auto-assign). Done HERE — after the gate + the runner's
  // chance roll — so a pool page is only consumed when we're actually about to
  // create. The endpoint links the page to this profile server-side and returns
  // it; we map its fields into the locals the rest of the flow uses. On an empty
  // pool / endpoint refusal there's nothing to build → clean skip (no throw).
  if (!String(pageName).trim()) {
    console.log(
      `  [create_page] No linked Page blueprint — requesting one from the pool (mode=${pageCountryMode})...`
    );
    const assigned = await autoAssignPage(userId, pageCountryMode);
    if (!assigned || !assigned.pageName) {
      console.log('  [create_page] No Page available to assign — nothing to create, skipping.');
      return;
    }
    pageName = assigned.pageName;
    if (assigned.bio) bio = assigned.bio;
    const photos = resolvePageAssetUrls(assigned.assets);
    if (photos.profilePhotoUrl) profilePhotoUrl = photos.profilePhotoUrl;
    if (photos.coverPhotoUrl) coverPhotoUrl = photos.coverPhotoUrl;
    console.log(
      `  [create_page] Assigned Page "${pageName}" from pool ` +
        `(bio=${bio ? 'set' : 'empty'}, profileImg=${profilePhotoUrl ? 'y' : 'n'}, ` +
        `coverImg=${coverPhotoUrl ? 'y' : 'n'}).`
    );
  }

  // pageName is present but we couldn't derive a category from it. Deterministic
  // (same name always fails the same way), so mark noRetry — fail fast instead
  // of retrying 3×60s.
  const categoryText = getCategoryKeyword(pageName, categoryKeyword);
  if (!categoryText) {
    const err = new Error('create_page: could not derive category keyword from pageName');
    err.noRetry = true;
    throw err;
  }
  const parsedCity = parseCityState(city);
  const address = buildPageAddress({ city, state, zipCode });
  const emailValue = String(email || '').trim();
  const streetValue = String(streetAddress || address.streetAddress || '').trim();
  const cityValue = parsedCity.cityName || address.cityName || '';

  console.log('  [create_page] Resolved address fields:');
  console.log(`    email       : ${emailValue || '(empty)'}`);
  console.log(`    street      : ${streetValue || '(empty)'}`);
  console.log(`    city        : ${cityValue || '(empty)'}`);
  console.log(`    state       : ${address.stateName || '(empty)'}`);
  console.log(`    zip         : ${address.zipCode || '(empty)'}`);

  let profileTempPath = '';
  let coverTempPath = '';

  try {
    if (profilePhotoUrl) {
      console.log('  [create_page] Downloading page profile image...');
      profileTempPath = await downloadToTemp(profilePhotoUrl, 'page_profile');
    }

    if (coverPhotoUrl) {
      console.log('  [create_page] Downloading page cover image...');
      coverTempPath = await downloadToTemp(coverPhotoUrl, 'page_cover');
    }

    /* ---------- PRE-CREATE phase — retriable as a whole ---------- */
    const runPreCreate = async () => {
      console.log('  [create_page] Opening Facebook...');
      await page.goto('https://www.facebook.com', { waitUntil: 'domcontentloaded' });
      await stepWait(page);

      console.log('  [create_page] Opening Facebook menu...');
      await clickLocator(
        page,
        page.locator('div[aria-label="Facebook menu"]'),
        'create_page: Facebook menu button has no bounding box'
      );

      console.log('  [create_page] Opening Pages...');
      await clickLocator(
        page,
        page.locator('xpath=//a[@role="link"]//span[text()="Pages"]'),
        'create_page: Pages link has no bounding box'
      );

      console.log('  [create_page] Opening Create Page...');
      await clickLocator(
        page,
        page.locator('[aria-label="Create Page"]'),
        'create_page: Create Page button has no bounding box'
      );

      console.log('  [create_page] Waiting for create modal...');
      await waitForCreateDialog(page);

      console.log('  [create_page] Selecting Public Page...');
      const publicPageOption = page.locator('label:has-text("Public Page")').first();
      const publicPageVisible = await publicPageOption.isVisible().catch(() => false);

      if (publicPageVisible) {
        await clickLocator(
          page,
          publicPageOption,
          'create_page: Public Page option has no bounding box'
        );
      } else {
        await clickLocator(
          page,
          page.locator('xpath=//label[.//span[text()="Public Page"]]'),
          'create_page: Public Page option has no bounding box'
        );
      }

      console.log('  [create_page] Moving to next step...');
      await clickLocator(
        page,
        page.locator('div[aria-label="Next"]'),
        'create_page: Next button has no bounding box'
      );

      console.log('  [create_page] Opening page setup form...');
      await clickLocator(
        page,
        page.locator('a[aria-label="Get started"]'),
        'create_page: Get started link has no bounding box'
      );

      const pageNameInput = page.locator('label:has-text("Page name (required)") input').first();
      await pageNameInput.waitFor({ state: 'visible', timeout: 15000 });
      console.log(`  [create_page] Filling page name: ${pageName}`);
      await clickAndReplace(page, pageNameInput, pageName);
      await stepWait(page);

      const categoryInput = page.locator('input[aria-label="Category (required)"]').first();
      await categoryInput.waitFor({ state: 'visible', timeout: 15000 });
      console.log(`  [create_page] Filling category from keyword: ${categoryText}`);
      await clickAndReplace(page, categoryInput, categoryText);
      await stepWait(page);
      await page.keyboard.press('ArrowDown');
      await stepWait(page);
      await page.keyboard.press('Enter');
      await stepWait(page);

      if (bio) {
        const bioInput = page
          .locator(`xpath=//span[contains(text(), "Bio")]/following::textarea[1]`)
          .first();
        await bioInput.waitFor({ state: 'visible', timeout: 15000 });
        console.log('  [create_page] Filling bio...');
        await clickAndReplace(page, bioInput, bio);
        await stepWait(page);
      }

      console.log('  [create_page] Clicking "Create Page" to commit page creation...');
      await clickLocator(
        page,
        page.locator('div[aria-label="Create Page"][role="button"]'),
        'create_page: Create Page (advance) button has no bounding box'
      );
    };

    let preLastError;
    for (let attempt = 1; attempt <= PRE_CREATE_ATTEMPTS; attempt++) {
      try {
        await runPreCreate();
        preLastError = null;
        break;
      } catch (err) {
        preLastError = err;
        console.warn(
          `  [create_page] Pre-create phase failed (attempt ${attempt}/${PRE_CREATE_ATTEMPTS}): ${err.message}`
        );
        if (attempt < PRE_CREATE_ATTEMPTS) {
          console.warn(
            `  [create_page] Waiting ${RETRY_WAIT_MS / 1000}s before restarting pre-create phase...`
          );
          await new Promise((resolve) => setTimeout(resolve, RETRY_WAIT_MS));
          await resetModals(page);
        }
      }
    }
    if (preLastError) {
      preLastError.noRetry = true;
      throw preLastError;
    }

    console.log('  [create_page] Page committed — entering post-create phase (per-field retry).');
    // Stamp the page-setup cooldown marker right after the "Create Page" commit
    // click succeeded — i.e. once a Page actually exists on FB. This is the
    // destructive point we must not repeat, so from here on the profile is on
    // the PAGE_SETUP_RETRY_DAYS cooldown regardless of how the post-create phase
    // goes (the canary early-return and full-completion both flow through here).
    // Pre-commit failures (couldn't even reach the button) are intentionally NOT
    // stamped — nothing was created, so they stay retriable on the next run
    // rather than locking out for the full cooldown on a transient nav issue.
    // A successful run also persists pageUrl, after which the duplicate-Page
    // guard takes over; a committed-but-half-configured Page keeps pageUrl empty
    // and becomes eligible again only once the cooldown lapses. Best-effort —
    // setOnboarding swallows its own errors.
    if (userId) await setOnboarding(userId, 'pageSetAt');
    await stepWait(page);

    /* ---------- POST-CREATE phase — each field retried individually ---------- */
    // Canary probe: if the email input isn't visible within 15s, FB rendered
    // a flow variant without the contact form. Bail out cleanly rather than
    // burning ~11 min waitFor'ing every subsequent field × 2 retries × 15s.
    // The Page was already committed in pre-create, so a half-configured
    // Page is the intended outcome — don't fail the worker over it.
    const emailProbe = page.locator('label:has-text("Email") input').first();
    const postCreateFormVisible = await emailProbe
      .waitFor({ state: 'visible', timeout: 15000 })
      .then(() => true)
      .catch(() => false);

    if (!postCreateFormVisible) {
      console.warn(
        '  [create_page] Post-create email field not found within 15s — skipping rest of create_page (Page already committed on FB).'
      );
      return;
    }

    if (emailValue) {
      await retryField('Fill email', async () => {
        const emailInput = page.locator('label:has-text("Email") input').first();
        await emailInput.waitFor({ state: 'visible', timeout: 15000 });
        console.log(`  [create_page] Filling email: ${emailValue}`);
        await clickAndReplace(page, emailInput, emailValue);
        await stepWait(page);
      });
    }

    if (streetValue) {
      await retryField('Fill street address', async () => {
        const addressInput = page.locator('label:has-text("Address") input').first();
        await addressInput.waitFor({ state: 'visible', timeout: 15000 });
        console.log(`  [create_page] Filling street address: ${streetValue}`);
        await clickAndReplace(page, addressInput, streetValue);
        await stepWait(page);
      });
    }

    if (cityValue) {
      await retryField('Fill city/town', async () => {
        const stateHalf = address.stateName
          ? address.stateName.slice(0, Math.ceil(address.stateName.length / 2))
          : '';
        const cityTypeText = stateHalf ? `${cityValue}, ${stateHalf}` : cityValue;
        const cityInput = page.locator('input[aria-label="City/town"]').first();
        await cityInput.waitFor({ state: 'visible', timeout: 15000 });
        console.log(`  [create_page] Filling city/town: ${cityTypeText}`);
        await typeAndSelect(page, cityInput, cityTypeText);
        await stepWait(page);
      });
    }

    if (address.zipCode) {
      await retryField('Fill ZIP code', async () => {
        const zipInput = page.locator('label:has-text("ZIP code") input').first();
        await zipInput.waitFor({ state: 'visible', timeout: 15000 });
        console.log(`  [create_page] Filling ZIP code: ${address.zipCode}`);
        await clickAndReplace(page, zipInput, address.zipCode);
        await stepWait(page);
      });
    }

    await retryField('Select hours option', async () => {
      const hoursOptions = [
        'input[type="radio"][value="NO_HOURS_AVAILABLE"]',
        'input[type="radio"][value="ALWAYS_OPEN"]',
      ];
      const chosenHoursSelector = hoursOptions[Math.floor(Math.random() * hoursOptions.length)];
      console.log(`  [create_page] Selecting hours option: ${chosenHoursSelector}`);
      await clickLocator(
        page,
        page.locator(chosenHoursSelector),
        'create_page: Hours option has no visible match'
      );
      await stepWait(page);
    });

    await retryField('Step 1 Next (post-contact)', async () => {
      console.log('  [create_page] Moving to next page section...');
      await clickLocator(
        page,
        page.locator('[aria-label="Next"]'),
        'create_page: Next button has no visible match'
      );
      await stepWait(page);
    });

    if (profileTempPath) {
      await retryField('Upload page profile picture', async () => {
        console.log('  [create_page] Uploading page profile picture...');
        await uploadImageFromButton(
          page,
          page.locator('div[role="button"]:has-text("Add profile picture")'),
          profileTempPath,
          'Add profile picture'
        );
        await stepWait(page);
      });
    }

    if (coverTempPath) {
      await retryField('Upload page cover photo', async () => {
        console.log('  [create_page] Uploading page cover photo...');
        await uploadImageFromButton(
          page,
          page.locator('div[role="button"]:has-text("Add cover photo")'),
          coverTempPath,
          'Add cover photo'
        );
        await stepWait(page);
      });
    }

    if (profileTempPath || coverTempPath) {
      console.log('  [create_page] Waiting ~30s for page images to finish processing...');
      await humanWait(page, 25000, 35000);
    }

    await retryField('Step 2 Next', async () => {
      console.log('  [create_page] Step 2 → Next...');
      await clickLocator(
        page,
        page.locator('[aria-label="Next"]'),
        'create_page: Step 2 Next button has no visible match'
      );
      await stepWait(page);
    });

    await retryField('Step 3 Skip (WhatsApp)', async () => {
      console.log('  [create_page] Step 3 → Skip (WhatsApp)...');
      await clickLocator(
        page,
        page.locator('[aria-label="Skip"]'),
        'create_page: Skip button has no visible match'
      );
      await stepWait(page);
    });

    await retryField('Step 4 Next (Build audience)', async () => {
      console.log('  [create_page] Step 4 → Next (Build audience)...');
      await clickLocator(
        page,
        page.locator('[aria-label="Next"]'),
        'create_page: Step 4 Next button has no visible match'
      );
      await stepWait(page);
    });

    const urlBeforeDone = page.url();
    console.log(`  [create_page] URL before Done: ${urlBeforeDone}`);

    await retryField('Step 5 Done', async () => {
      console.log('  [create_page] Step 5 → Done...');
      await clickLocator(
        page,
        page.locator('[aria-label="Done"]'),
        'create_page: Done button has no visible match'
      );
      await stepWait(page);
    });

    console.log('  [create_page] Waiting for page creation URL confirmation...');
    let pageCreated = false;
    try {
      await page.waitForURL('**/profile.php?id=**', { timeout: 30000 });
      console.log('  [create_page] Page creation confirmed — URL changed to page profile.');
      pageCreated = true;
    } catch {
      console.warn(
        '  [create_page] URL did not change to profile.php within 30s — page may still be loading.'
      );
    }

    const urlAfterDone = page.url();
    if (pageCreated && urlAfterDone && urlAfterDone !== urlBeforeDone) {
      console.log(`  [create_page] New page URL: ${urlAfterDone} — persisting to database...`);
      await persistPageUrl(userId, urlAfterDone);
    } else {
      console.warn('  [create_page] URL did not change after Done — skipping pageUrl PATCH.');
    }

    try {
      const cookiesBtn = page.locator('div[aria-label="Allow all cookies"]').first();
      await cookiesBtn.waitFor({ state: 'visible', timeout: 5000 });
      console.log('  [create_page] Cookies popup detected — dismissing...');
      await humanClick(page, await cookiesBtn.boundingBox());
      await stepWait(page);
    } catch {
      // no cookies popup — continue
    }
  } finally {
    if (profileTempPath) fs.unlink(profileTempPath, () => {});
    if (coverTempPath) fs.unlink(coverTempPath, () => {});
  }
};

// Exposed so the runner can evaluate the same gate in its pre-`chance` guard
// phase (an ineligible profile then never wastes a probability slot).
module.exports.createPageGate = createPageGate;
module.exports.checkDailyFailureBreaker = checkDailyFailureBreaker;
// Exposed so the read-only `check_existing_page` backfill action reuses the
// exact same FB-side detection + pageUrl PATCH (single source of truth).
module.exports.findExistingManagedPageUrl = findExistingManagedPageUrl;
module.exports.persistPageUrl = persistPageUrl;
