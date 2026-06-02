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

const fs = require('fs');
const path = require('path');
const { humanWait, humanClick, humanType } = require('../utils/humanBehavior');
const { updateProfile } = require('../utils/userApi');
const { getProfileLogDir } = require('../utils/sessionLog');
const { tryRecover } = require('../utils/recoverers');

async function dumpFailure(page, label) {
  try {
    if (!page) return;
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const safeLabel = String(label || 'failure').replace(/[^a-z0-9_-]+/gi, '_');
    const profileDir = getProfileLogDir();
    const targetDir = profileDir || path.join(process.cwd(), 'logs');
    try { if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true }); } catch (_) {}

    const baseName = `signup-${safeLabel}-${ts}`;
    let url = '(unknown)';
    try { url = page.url(); } catch (_) {}

    try {
      const html = await page.content();
      const htmlPath = path.join(targetDir, `${baseName}.html`);
      fs.writeFileSync(htmlPath, `<!-- url: ${url} -->\n${html}`, 'utf8');
      console.warn(`  [facebook_signup] dumped HTML → ${htmlPath}`);
    } catch (err) {
      console.warn(`  [facebook_signup] HTML dump failed: ${err.message}`);
    }
    try {
      const pngPath = path.join(targetDir, `${baseName}.png`);
      await page.screenshot({ path: pngPath, fullPage: true });
      console.warn(`  [facebook_signup] dumped screenshot → ${pngPath}`);
    } catch (err) {
      console.warn(`  [facebook_signup] screenshot failed: ${err.message}`);
    }
  } catch (err) {
    console.warn(`  [facebook_signup] dumpFailure swallowed: ${err.message}`);
  }
}

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
  try {
    await locator.waitFor({ state: 'visible', timeout: 20000 });
  } catch (err) {
    // Cookie popup may be overlaying the form — dismiss and retry
    await dismissCookieConsent(page);
    await locator.waitFor({ state: 'visible', timeout: 10000 });
  }
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
  try {
    await clickHuman(page, option, `${label} option "${optionName}"`);
  } catch (err) {
    // Cookie popup may be overlaying the form — dismiss and retry
    await dismissCookieConsent(page);
    await clickHuman(page, trigger, `${label} dropdown (retry)`);
    await humanWait(page, 600, 1200);
    await clickHuman(page, option, `${label} option "${optionName}" (retry)`);
  }
  await humanWait(page, 500, 1000);
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

async function dismissCookieConsent(page) {
  try {
    const btn = page.locator('div[aria-label="Allow all cookies"]:not([aria-hidden="true"])').first();
    if (await btn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await btn.click({ force: true });
      console.log('  [facebook_signup] Dismissed cookie consent popup');
      await humanWait(page, 1500, 2500);
    }
  } catch { /* no popup */ }
}

module.exports = async function facebook_signup(page, params) {
  const userId = (params.userId || '').trim();
  const firstName = (params.firstName || '').trim();
  const lastName = (params.lastName || '').trim();
  const dob = parseDob(params.birthdayDate);
  const genderName = titleCase(params.gender);
  const email = (params.email || '').trim();
  const password = params.password || '';
  const skipPostSetup = !!params.skipPostSetup;

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

  // If already on the /reg/ page (e.g. ensure_login navigated us directly to
  // /reg/?entry_point=login&next=), skip the facebook.com → "Create new
  // account" click. Form is already showing.
  const currentUrl = page.url();
  if (/\/reg(\/|\?|$)/i.test(currentUrl)) {
    console.log('  [facebook_signup] already on /reg/ — skipping nav + Create-new-account click.');
    await humanWait(page, 1500, 2500);
  } else {
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
  }

  await dismissCookieConsent(page);

  try {
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
  } catch (err) {
    await dumpFailure(page, `error-${firstName || 'unknown'}`);
    throw err;
  }

  await page.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});
  await humanWait(page, 2500, 4500);

  // Wait for the home feed to load. Stable selector per CLAUDE.md: aria-label
  // shifts with notification count ("Home", "Home, 3 new notifications"), but
  // href="/" is constant. Long timeout — FB sometimes runs verification or a
  // welcome interstitial before landing on the feed.
  console.log('  [facebook_signup] waiting for Home button to appear (up to 5 min)...');
  // Poll for the home button instead of one big waitFor — so we can fire the
  // recovery chain (EU cookie consent, soft checkpoint, etc.) when FB
  // intercepts mid-redirect. A single 5-minute waitFor would just sit on the
  // /privacy/consent/ screen until the timeout fires.
  const home = page.locator('a[href="/"][role="link"]').first();
  const deadline = Date.now() + 300000;
  let recoveredOnce = false;
  while (true) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new Error('facebook_signup: Home button never appeared (5 min timeout)');
    }

    // Fast-fail on the email-confirmation interstitial. After signup FB often
    // redirects to confirmemail.php demanding a code emailed to the account —
    // the Home button can NEVER appear there, so polling the full 5 minutes is
    // pure waste. Surface the specific cause (so triage doesn't have to open the
    // dump) and mark noRetry (a retry just re-lands on the same page). The
    // account WAS created; it's just gated behind email verification we don't
    // solve yet.
    let currentUrl = '';
    try {
      currentUrl = page.url();
    } catch (_) {}
    if (currentUrl.includes('confirmemail.php')) {
      const err = new Error(
        'facebook_signup: email confirmation required (confirmemail.php) — account created but FB wants an emailed code'
      );
      err.noRetry = true;
      // Flag for manual review — the account exists but is gated behind an
      // emailed code we don't enter yet. runBrowser PATCHes status="Need
      // Checking" on this flag (both the per-step and ensure_login paths).
      err.needChecking = true;
      throw err;
    }

    const pollMs = Math.min(15000, remaining);
    const visible = await home
      .waitFor({ state: 'visible', timeout: pollMs })
      .then(() => true)
      .catch(() => false);
    if (visible) break;

    // tryRecover returns { recovered, unfixable } — destructure it. The old
    // code did `const recovered = await tryRecover(...)` and tested the whole
    // object, which is always truthy (so it logged "[object Object]" and
    // ignored the unfixable signal). Honor unfixable: a consent flow we can't
    // clear during signup should abort fast, not poll for 5 minutes.
    const { recovered, unfixable } = await tryRecover(page, {
      stepType: 'facebook_signup:home-wait',
    });
    if (unfixable) {
      const err = new Error(
        `facebook_signup: blocked by "${unfixable}" during home-wait — cannot continue`
      );
      err.noRetry = true;
      throw err;
    }
    if (recovered) {
      console.log(`  [facebook_signup] recovery "${recovered}" fired — re-polling home button`);
      recoveredOnce = true;
    }
  }

  if (recoveredOnce) {
    console.log('  [facebook_signup] Home button visible (after recovery) — account is logged in.');
  } else {
    console.log('  [facebook_signup] Home button visible — account is logged in.');
  }

  // Stamp accountCreated on the user record the first time an FB session
  // confirms via home-feed landing. Idempotent — `params.accountCreated`
  // carries the current DB value (injected by `injectUserParams`); if it's
  // already non-empty we never overwrite. Covers both the fresh-signup
  // path (facebook_signup as a top-level step) AND the re-login path
  // (ensure_login → facebook_signup with skipPostSetup) so any FB-side
  // confirmation tracks the account's first-seen time. Best-effort —
  // PATCH errors are warned, never thrown.
  if (!params.accountCreated && userId) {
    try {
      await updateProfile(userId, { accountCreated: new Date().toISOString() });
      console.log('  [facebook_signup] stamped user.accountCreated');
    } catch (err) {
      console.warn(`  [facebook_signup] accountCreated PATCH failed: ${err.message}`);
    }
  }

  // Re-login mode: ensure_login uses this handler purely as a "fill the reg
  // form and confirm we land on the home feed" routine. Skip the status PATCH
  // and the post-signup /settings/bundled walk so we don't disturb an existing
  // account's setup state.
  if (skipPostSetup) {
    console.log('  [facebook_signup] skipPostSetup=true — returning after home href.');
    return;
  }

  await markNeedSetup(userId);

  console.log('  [facebook_signup] signup complete. Chain setup_privacy as a next step for bundled-settings walkthrough.');
};
