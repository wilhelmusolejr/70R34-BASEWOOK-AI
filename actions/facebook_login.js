/**
 * facebook_login — Leaf action.
 * Sign into an existing Facebook account from the logged-out homepage.
 *
 * Detection (used by both this handler and the runner auto-check):
 *   - URL contains /login or login.php  → logged out
 *   - OR #login_form / input[name="pass"] present → logged out
 *   - a[href="/"][role="link"] visible → logged in (positive signal)
 *
 * Flow:
 *   1. If not on facebook.com, navigate there.
 *   2. Fill email/phone field, then password field (humanType).
 *   3. Press Enter to submit (matches the hidden submit input).
 *   4. Dismiss "Save your login info?" prompt if it appears.
 *   5. Wait for a[href="/"] to confirm logged-in state.
 *
 * Auto-injected by `injectUserParams`:
 *   email    ← user.emails.find(e=>e.selected)?.address || user.emails[0]?.address
 *   password ← user.facebookPassword
 */

const { humanWait, humanClick, humanType } = require('../utils/humanBehavior');

/**
 * Return true if the current page looks like the logged-out state.
 * Exported so `runner.js` can use the same probe.
 */
async function isLoggedOut(page) {
  try {
    const url = page.url();
    if (/\/login(\/|\?|$)|login\.php/i.test(url)) return true;
  } catch (_) {
    // page may have been disposed — treat as not-logged-out and let caller handle
  }

  const loginForm = await page
    .locator('#login_form, input[name="pass"]')
    .first()
    .isVisible({ timeout: 1500 })
    .catch(() => false);
  return loginForm;
}

async function clickHuman(page, locator, label) {
  await locator.waitFor({ state: 'visible', timeout: 20000 });
  await locator.scrollIntoViewIfNeeded().catch(() => {});
  const box = await locator.boundingBox();
  if (!box) throw new Error(`facebook_login: "${label}" has no bounding box`);
  await humanClick(page, box);
}

async function fillHuman(page, locator, value, label) {
  await clickHuman(page, locator, label);
  await humanWait(page, 300, 700);
  await humanType(page, value);
  await humanWait(page, 400, 900);
}

async function dismissSaveLoginPrompt(page) {
  // FB often shows "Save your login info?" after a successful sign-in.
  // "Not now" leaves the cookie store untouched; ignore failures silently.
  try {
    const notNow = page.getByRole('button', { name: /not now/i }).first();
    if (await notNow.isVisible({ timeout: 3000 }).catch(() => false)) {
      const box = await notNow.boundingBox();
      if (box) {
        await humanClick(page, box);
        await humanWait(page, 1500, 2500);
      }
    }
  } catch (_) {
    // best-effort
  }
}

module.exports = async function facebook_login(page, params) {
  const email = (params.email || '').trim();
  const password = params.password || '';

  if (!email) throw new Error('facebook_login: email is required');
  if (!password) throw new Error('facebook_login: password is required');

  const currentUrl = page.url();
  if (!currentUrl.includes('facebook.com')) {
    console.log('  [facebook_login] not on facebook — navigating...');
    await page.goto('https://www.facebook.com', { waitUntil: 'domcontentloaded' });
    await humanWait(page, 2500, 4000);
  }

  console.log(`  [facebook_login] signing in as "${email}"`);

  console.log('  [facebook_login] filling email...');
  await fillHuman(
    page,
    page.locator('#login_form input[name="email"], input[name="email"][type="email"]').first(),
    email,
    'Email or phone'
  );

  console.log('  [facebook_login] filling password...');
  const passLocator = page
    .locator('#login_form input[name="pass"], input[name="pass"]')
    .first();
  await fillHuman(page, passLocator, password, 'Password');

  await humanWait(page, 800, 1600);

  console.log('  [facebook_login] submitting...');
  await passLocator.press('Enter');

  await page.waitForLoadState('domcontentloaded', { timeout: 60000 }).catch(() => {});
  await humanWait(page, 2500, 4500);

  await dismissSaveLoginPrompt(page);

  console.log('  [facebook_login] waiting for Home button (up to 2 min)...');
  await page
    .locator('a[href="/"][role="link"]')
    .first()
    .waitFor({ state: 'visible', timeout: 120000 });

  console.log('  [facebook_login] Home button visible — login confirmed.');
};

module.exports.isLoggedOut = isLoggedOut;
