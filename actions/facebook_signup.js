/**
 * facebook_signup — Leaf action.
 * Sign up for a new Facebook account from the logged-out homepage.
 *
 * Flow:
 *   1. If not on facebook.com, navigate there.
 *   2. Click "Create new account" → /reg/.
 *   3. Fill First name, Last name.
 *   4. Open Month / Day / Year dropdowns and pick the option that matches the DOB.
 *   5. Open the Gender dropdown and pick the option.
 *   6. Fill "Mobile number or email" and "Password".
 *   7. Click Submit.
 *
 * All clicks go through `humanClick` (mouse-moved + jittered position from a
 * fresh boundingBox), all typing through `humanType` (per-char varied delay),
 * all waits through `humanWait` — never `.click()`/`.fill()`/`waitForTimeout(N)`
 * directly, per CLAUDE.md.
 *
 * Auto-injected by `injectUserParams`:
 *   userId        ← user._id || user.id   (used for the post-flow status PATCH)
 *   firstName     ← user.firstName
 *   lastName      ← user.lastName
 *   birthdayDate  ← user.birthdayDate  (fallback: user.dob; ISO "YYYY-MM-DD" or "MM/DD/YYYY")
 *   gender        ← user.gender
 *   email         ← user.emails.find(e=>e.selected)?.address || user.emails[0]?.address
 *   password      ← user.facebookPassword
 */

const { humanWait, humanClick, humanType } = require('../utils/humanBehavior');
const { updateProfile } = require('../utils/userApi');

// FB renders the month options with full names ("January", "February"…) on
// the current /reg/ form. If a future variant switches back to 3-letter
// abbreviations, swap to the short form here.
const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

function parseDob(input) {
  if (!input) return null;

  if (typeof input === 'object') {
    const monthName = input.monthName || input.month;
    if (monthName && input.day && input.year) {
      return { monthName, day: String(input.day), year: String(input.year) };
    }
    return null;
  }

  const str = String(input).trim();

  const iso = str.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (iso) {
    return {
      year: iso[1],
      monthName: MONTHS[parseInt(iso[2], 10) - 1],
      day: String(parseInt(iso[3], 10)),
    };
  }

  const us = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (us) {
    return {
      year: us[3],
      monthName: MONTHS[parseInt(us[1], 10) - 1],
      day: String(parseInt(us[2], 10)),
    };
  }

  return null;
}

function titleCase(value) {
  const s = String(value).trim();
  return s ? s.charAt(0).toUpperCase() + s.slice(1).toLowerCase() : '';
}

async function clickHuman(page, locator, label) {
  await locator.waitFor({ state: 'visible', timeout: 20000 });
  await locator.scrollIntoViewIfNeeded().catch(() => {});
  const box = await locator.boundingBox();
  if (!box) throw new Error(`facebook_signup: "${label}" has no bounding box`);
  await humanClick(page, box);
}

async function fillHuman(page, locator, value, label) {
  await locator.waitFor({ state: 'visible', timeout: 20000 });
  await locator.scrollIntoViewIfNeeded().catch(() => {});
  const box = await locator.boundingBox();
  if (!box) throw new Error(`facebook_signup: "${label}" has no bounding box`);
  await humanClick(page, box);
  await humanWait(page, 300, 700);
  await humanType(page, value);
  await humanWait(page, 400, 900);
}

// Open a combobox-style dropdown, then click an option in the popup.
// Each click re-fetches a fresh bounding box right before humanClick — option
// rows render in a portal that can shift by a few pixels between resolution
// and click.
async function selectOption(page, trigger, optionName, label) {
  await clickHuman(page, trigger, `${label} dropdown`);
  await humanWait(page, 600, 1200);

  const option = page.getByRole('option', { name: optionName, exact: true }).first();
  await clickHuman(page, option, `${label} option "${optionName}"`);
  await humanWait(page, 500, 1000);
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
    console.log('  [facebook_signup] Public privacy is already current.');
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
    console.log('  [facebook_signup] Public privacy selected.');
    return;
  }

  throw new Error('facebook_signup: Public privacy did not become current after click');
}

async function selectPublicPrivacyWithRetry(page) {
  const maxAttempts = 3;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      console.log(`  [facebook_signup] Public privacy attempt ${attempt}/${maxAttempts}...`);
      await selectPublicPrivacy(page);
      return;
    } catch (err) {
      if (attempt === maxAttempts) throw err;

      console.warn(`  [facebook_signup] Public privacy attempt ${attempt} failed: ${err.message}`);
      await humanWait(page, 5000, 10000);
    }
  }
}

async function markNeedSetup(userId) {
  if (!userId) {
    console.warn('  [facebook_signup] no userId in params — skipping status PATCH');
    return;
  }

  try {
    await updateProfile(userId, { status: 'Need Setup' });
    console.log(`  [facebook_signup] user ${userId} status -> "Need Setup"`);
  } catch (err) {
    console.warn(`  [facebook_signup] PATCH status failed (non-fatal): ${err.message}`);
  }
}

module.exports = async function facebook_signup(page, params) {
  const userId = (params.userId || '').trim();
  const firstName = (params.firstName || '').trim();
  const lastName = (params.lastName || '').trim();
  const dob = parseDob(params.birthdayDate);
  const genderName = titleCase(params.gender);
  const email = (params.email || '').trim();
  const password = params.password || '';

  if (!firstName) throw new Error('facebook_signup: firstName is required');
  if (!lastName) throw new Error('facebook_signup: lastName is required');
  if (!dob) {
    throw new Error(
      'facebook_signup: birthdayDate is required (ISO "YYYY-MM-DD", "MM/DD/YYYY", or {month, day, year})'
    );
  }
  if (!genderName) throw new Error('facebook_signup: gender is required');
  if (!email) throw new Error('facebook_signup: email is required');
  if (!password) throw new Error('facebook_signup: password is required');

  console.log(`  [facebook_signup] signing up "${firstName} ${lastName}"`);

  const currentUrl = page.url();
  if (!currentUrl.includes('facebook.com')) {
    console.log('  [facebook_signup] not on facebook — navigating...');
    await page.goto('https://www.facebook.com', { waitUntil: 'domcontentloaded' });
    await humanWait(page, 2500, 4000);
  }

  console.log('  [facebook_signup] clicking "Create new account"...');
  await clickHuman(
    page,
    page.locator('a[aria-label="Create new account"]').first(),
    'Create new account'
  );

  await page.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});
  await humanWait(page, 1500, 2500);

  console.log('  [facebook_signup] First name...');
  await fillHuman(
    page,
    page.getByLabel('First name', { exact: true }).first(),
    firstName,
    'First name'
  );

  console.log('  [facebook_signup] Last name / Surname...');
  const lastNameInput = page
    .getByLabel('Last name', { exact: true })
    .or(page.getByLabel('Surname', { exact: true }))
    .first();
  await fillHuman(page, lastNameInput, lastName, 'Last name / Surname');

  console.log(`  [facebook_signup] DOB ${dob.monthName} ${dob.day}, ${dob.year}...`);
  await selectOption(page, page.getByLabel('Select Month').first(), dob.monthName, 'Month');
  await selectOption(page, page.getByLabel('Select Day').first(), dob.day, 'Day');
  await selectOption(page, page.getByLabel('Select Year').first(), dob.year, 'Year');

  console.log(`  [facebook_signup] gender ${genderName}...`);
  await selectOption(page, page.getByText('Select your gender').first(), genderName, 'Gender');

  console.log('  [facebook_signup] email/mobile...');
  await fillHuman(
    page,
    page.getByLabel('Mobile number or email').first(),
    email,
    'Mobile number or email'
  );

  console.log('  [facebook_signup] password...');
  await fillHuman(page, page.getByLabel('Password').first(), password, 'Password');

  await humanWait(page, 1000, 2000);

  console.log('  [facebook_signup] submitting...');
  await clickHuman(page, page.getByText('Submit', { exact: true }).first(), 'Submit');

  await page.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});
  await humanWait(page, 2500, 4500);

  // Wait for the home feed to load. Stable selector per CLAUDE.md: aria-label
  // shifts with notification count ("Home", "Home, 3 new notifications"), but
  // href="/" is constant. Long timeout — FB sometimes runs verification or a
  // welcome interstitial before landing on the feed.
  console.log('  [facebook_signup] waiting for Home button to appear (up to 5 min)...');
  await page
    .locator('a[href="/"][role="link"]')
    .first()
    .waitFor({ state: 'visible', timeout: 300000 });

  console.log('  [facebook_signup] Home button visible — account is logged in.');
  await markNeedSetup(userId);

  // Post-signup: walk the bundled-settings privacy acknowledgment
  // (Public radio → Next → Confirm). 5-10s pauses between each click —
  // the page is short and uniformly fast clicks would look bot-shaped.
  console.log('  [facebook_signup] navigating to /settings/bundled...');
  await page.goto('https://www.facebook.com/settings/bundled', {
    waitUntil: 'domcontentloaded',
  });
  await page.waitForFunction(() => window.location.href.includes('bundled'), null, {
    timeout: 30000,
  });
  await humanWait(page, 5000, 10000);

  // Updated behavior: selectPublicPrivacy skips this step when Public is
  // already marked as the current setting.
  console.log('  [facebook_signup] verifying Public privacy...');
  await selectPublicPrivacyWithRetry(page);
  await humanWait(page, 5000, 10000);

  console.log('  [facebook_signup] clicking Next...');
  await clickHuman(page, page.locator('div[aria-label="Next"]').first(), 'Next');
  await humanWait(page, 5000, 10000);

  console.log('  [facebook_signup] clicking Confirm...');
  await clickHuman(page, page.locator('div[aria-label="Confirm"]').first(), 'Confirm');
  await humanWait(page, 5000, 10000);

  console.log('  [facebook_signup] signup + post-signup confirmation complete.');
};
