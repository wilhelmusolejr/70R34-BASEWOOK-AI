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
const { setOnboarding } = require('../utils/userApi');

const USER_API_BASE_URL = process.env.USER_API_BASE_URL || '';

const PRE_CREATE_ATTEMPTS = 3;
const POST_FIELD_ATTEMPTS = 2;
const RETRY_WAIT_MS = 60000;

// Page-setup cooldown. create_page stamps onboarding.pageSetupAt once a Page is
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
 *   2. Nothing-to-create guard — no pageName → skip (no data to build a Page).
 *   3. Page-setup cooldown — onboarding.pageSetupAt stamped & fresh (< 10d) →
 *      skip. Stamped & stale (≥ 10d) with pageUrl still empty (proven by gate 1)
 *      and a pageName present (proven by gate 2) → the earlier attempt never
 *      produced a usable Page, so allow a retry (no skip). Stamped but
 *      unparseable date → skip (safe default: an attempt was made, don't risk a
 *      duplicate on a bad timestamp).
 *
 * Shared by the action (defense-in-depth / direct invocation) AND the runner's
 * pre-`chance` guard phase (so an ineligible profile never wastes a probability
 * slot). Single source of truth — keep the two callers in sync via this fn.
 */
function createPageGate({ pageUrl = '', pageName = '', pageSetupAt = '' } = {}) {
  if (pageUrl && String(pageUrl).trim()) {
    return {
      skip: true,
      reason: `already has pageUrl="${pageUrl}" (duplicate-Page guard)`,
    };
  }

  if (!pageName || !String(pageName).trim()) {
    return { skip: true, reason: 'no linkedPage.pageName configured (nothing to create)' };
  }

  if (pageSetupAt && String(pageSetupAt).trim()) {
    const stampedMs = Date.parse(pageSetupAt);
    if (Number.isNaN(stampedMs)) {
      return {
        skip: true,
        reason: `pageSetupAt set but unparseable ("${pageSetupAt}") (safe default)`,
      };
    }
    const ageDays = (Date.now() - stampedMs) / 86400000;
    if (ageDays < PAGE_SETUP_RETRY_DAYS) {
      return {
        skip: true,
        reason: `pageSetupAt stamped ${ageDays.toFixed(1)}d ago (< ${PAGE_SETUP_RETRY_DAYS}d page-setup cooldown)`,
      };
    }
    // Stale stamp, still no pageUrl → fall through and allow a retry.
  }

  return { skip: false, reason: '' };
}

module.exports = async function create_page(page, params) {
  const {
    pageName,
    bio = '',
    email = '',
    streetAddress = '',
    city = '',
    state = '',
    zipCode = '',
    profilePhotoUrl = '',
    coverPhotoUrl = '',
    categoryKeyword = '',
    userId = '',
  } = params;

  // Entry gate — duplicate-Page / nothing-to-create / page-setup cooldown.
  // Defense-in-depth: when invoked via the runner this has already been checked
  // in the pre-`chance` guard phase, but the action re-checks so a direct
  // invocation (dev script / test) is still protected from spawning a duplicate
  // Page. `return` (no throw) — from the runner's view the step was a clean no-op.
  const gate = createPageGate(params);
  if (gate.skip) {
    console.log(`  [create_page] skipping — ${gate.reason}.`);
    return;
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
    if (userId) await setOnboarding(userId, 'pageSetupAt');
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
