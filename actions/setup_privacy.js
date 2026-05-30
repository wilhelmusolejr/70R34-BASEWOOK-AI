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
  const { userId = '' } = params || {};
  console.log('  [setup_privacy] navigating to /settings/bundled...');
  await page.goto('https://www.facebook.com/settings/bundled', {
    waitUntil: 'domcontentloaded',
  });
  await page.waitForFunction(() => window.location.href.includes('bundled'), null, {
    timeout: 30000,
  });
  await humanWait(page, 5000, 10000);

  console.log('  [setup_privacy] verifying Public privacy...');
  await selectPublicPrivacyWithRetry(page);
  await humanWait(page, 5000, 10000);

  console.log('  [setup_privacy] clicking Next...');
  await clickHuman(page, page.locator('div[aria-label="Next"]').first(), 'Next');
  await humanWait(page, 5000, 10000);

  console.log('  [setup_privacy] clicking Confirm...');
  await clickHuman(page, page.locator('div[aria-label="Confirm"]').first(), 'Confirm');
  await humanWait(page, 5000, 10000);

  console.log('  [setup_privacy] privacy setup complete.');

  if (userId) await setOnboarding(userId, 'privacyPublicAt');
};
