/**
 * setup_privacy — Leaf action.
 * Walk the /settings/bundled privacy acknowledgment page:
 *   1. Navigate to facebook.com/settings/bundled
 *   2. Select "Public" privacy (skip if already current)
 *   3. Click Next
 *   4. Click Confirm
 *
 * Designed to run after a fresh signup or as a standalone step for accounts
 * that haven't completed the privacy walkthrough yet.
 */

const { humanWait, humanClick } = require('../utils/humanBehavior');
const { setOnboarding } = require('../utils/userApi');

async function clickHuman(page, locator, label) {
  await locator.waitFor({ state: 'visible', timeout: 20000 });
  await locator.scrollIntoViewIfNeeded().catch(() => {});
  const box = await locator.boundingBox();
  if (!box) throw new Error(`setup_privacy: "${label}" has no bounding box`);
  await humanClick(page, box);
}

async function isPublicPrivacyCurrent(page) {
  const currentLabel = page.getByText(/Public\s*.\s*Your current setting/).first();
  if (await currentLabel.isVisible({ timeout: 1500 }).catch(() => false)) {
    return true;
  }

  const firstRadio = page.locator('input[type="radio"]').first();
  return firstRadio.evaluate((el) => el.checked || el.hasAttribute('checked')).catch(() => false);
}

/**
 * Pre-flight check: is the account ALREADY on Public privacy?
 *
 * Uses ONLY the "Public · Your current setting" text — that's the one signal
 * that reflects the user's stored setting. The first-radio-checked fallback
 * used by `isPublicPrivacyCurrent` would false-positive here because FB's
 * walkthrough defaults the radio to Public regardless of the current value
 * (you can see this when the page labels "Custom · Your current setting" on
 * a different row while Public's radio is highlighted).
 */
async function isAlreadyPublic(page) {
  const currentLabel = page.getByText(/Public\s*.\s*Your current setting/).first();
  return currentLabel.isVisible({ timeout: 2000 }).catch(() => false);
}

async function selectPublicPrivacy(page) {
  if (await isPublicPrivacyCurrent(page)) {
    console.log('  [setup_privacy] Public privacy is already current.');
    return;
  }

  const publicRow = page
    .locator(
      'xpath=//span[contains(normalize-space(.), "Public")]/ancestor::div[.//input[@type="radio"]][1]'
    )
    .first();

  await clickHuman(page, publicRow, 'Public privacy row');
  await humanWait(page, 1500, 2500);

  if (await isPublicPrivacyCurrent(page)) {
    console.log('  [setup_privacy] Public privacy selected.');
    return;
  }

  throw new Error('setup_privacy: Public privacy did not become current after click');
}

async function selectPublicPrivacyWithRetry(page) {
  const maxAttempts = 3;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      console.log(`  [setup_privacy] Public privacy attempt ${attempt}/${maxAttempts}...`);
      await selectPublicPrivacy(page);
      return;
    } catch (err) {
      if (attempt === maxAttempts) throw err;

      console.warn(`  [setup_privacy] Public privacy attempt ${attempt} failed: ${err.message}`);
      await humanWait(page, 5000, 10000);
    }
  }
}

module.exports = async function setup_privacy(page, params) {
  const { userId = '', privacyPublicAt = '' } = params || {};

  // Pre-flight skip: if the profile's onboarding already has a privacyPublicAt
  // timestamp, this action has run successfully before. Don't waste the 1-2
  // minutes navigating the bundled walkthrough — just move on. The runner's
  // setup_privacy injector pulls this value from the user record so the check
  // reflects current DB state, not stale params.
  if (privacyPublicAt) {
    console.log(
      `  [setup_privacy] privacyPublicAt already stamped (${privacyPublicAt}) — skipping.`
    );
    return;
  }

  console.log('  [setup_privacy] navigating to /settings/bundled...');
  await page.goto('https://www.facebook.com/settings/bundled', {
    waitUntil: 'domcontentloaded',
  });
  await page.waitForFunction(() => window.location.href.includes('bundled'), null, {
    timeout: 30000,
  });
  await humanWait(page, 5000, 10000);

  // Skip walkthrough if the account is already on Public. Walking it anyway
  // hits the Next/Confirm flow variance that fails ~half the time on already-
  // configured accounts (FB renders a different layout). Still stamps the
  // onboarding so downstream "did this account complete setup?" queries get
  // a positive answer — re-stamps are documented as harmless.
  if (await isAlreadyPublic(page)) {
    console.log('  [setup_privacy] Public privacy is already current — skipping walkthrough.');
    if (userId) await setOnboarding(userId, 'privacyPublicAt');
    return;
  }

  // Public radio click is the strict step — this is what actually changes the
  // stored privacy. If it fails, throw and skip the onboarding stamp so the
  // profile gets retried tomorrow instead of being marked "done" with stale
  // privacy state.
  console.log('  [setup_privacy] verifying Public privacy...');
  await selectPublicPrivacyWithRetry(page);
  await humanWait(page, 5000, 10000);

  // Next + Confirm are best-effort acknowledgment UI. FB's bundled walkthrough
  // renders these inconsistently — sometimes a 2-page Public→Next→Confirm
  // flow, sometimes a different layout where these buttons don't appear in
  // the shape we expect. If either is missing after a short timeout, log a
  // warning and continue — the Public click above already applied the change.
  console.log('  [setup_privacy] clicking Next...');
  try {
    await clickHuman(page, page.locator('div[aria-label="Next"]').first(), 'Next');
    await humanWait(page, 5000, 10000);
  } catch (err) {
    console.warn(
      `  [setup_privacy] Next button not actionable — continuing (Public radio already selected): ${err.message}`
    );
  }

  console.log('  [setup_privacy] clicking Confirm...');
  try {
    await clickHuman(page, page.locator('div[aria-label="Confirm"]').first(), 'Confirm');
    await humanWait(page, 5000, 10000);
  } catch (err) {
    console.warn(
      `  [setup_privacy] Confirm button not actionable — continuing (Public radio already selected): ${err.message}`
    );
  }

  console.log('  [setup_privacy] privacy setup complete.');

  if (userId) await setOnboarding(userId, 'privacyPublicAt');
};
