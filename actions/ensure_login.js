/**
 * ensure_login — Leaf action.
 *
 * "Re-login" strategy chosen by the operator: instead of fighting login forms
 * (which appear in many shapes — inline, header, modal, /login redirect),
 * navigate straight to FB's registration page with the login entry point and
 * re-run the signup form fill. FB treats this as a re-auth path; on success
 * the home feed loads and the home href appears, exactly like a fresh signup.
 *
 *   Entry URL: https://web.facebook.com/reg/?entry_point=login&next=
 *
 * Detection (`isLoggedOut`):
 *   1. URL match — /login or login.php in the current URL
 *   2. Password field visible — input[name="pass"] (handles the inline login
 *      surfaces that don't redirect)
 *   3. Profile probe (optional, when caller passes `profileProbeUrl`):
 *      navigate to a known profile URL; if FB rewrites to /people/... or
 *      /pfbid... then the session is browsing as guest → logged out.
 *      The runner passes `user.profileUrl` as the probe target.
 *
 * Auto-injected by `injectUserParams`: all the signup params (firstName,
 * lastName, birthdayDate, gender, email, password). The runner also auto-
 * invokes this handler at session start when isLoggedOut() returns true, so
 * it rarely needs to appear in tasks.json explicitly.
 */

const { humanWait } = require('../utils/humanBehavior');
const facebook_signup = require('./facebook_signup');

const REG_LOGIN_URL = 'https://web.facebook.com/reg/?entry_point=login&next=';

/**
 * Cheap, non-destructive checks: URL pattern + visible password field.
 * Either one is sufficient to flag the session as logged out.
 */
async function quickLoggedOutChecks(page) {
  try {
    const url = page.url();
    if (/\/login(\/|\?|$)|login\.php/i.test(url)) return true;
  } catch (_) {
    // page disposed — caller handles
  }

  const passVisible = await page
    .locator('input[name="pass"]')
    .first()
    .isVisible({ timeout: 1500 })
    .catch(() => false);
  return passVisible;
}

/**
 * Probe a known profile URL. If FB rewrites it to a guest-facing /people/
 * or /pfbid path, the session has no auth cookie. This catches the "soft
 * logged out" case where the landing page doesn't show a login form but
 * the session can't see authenticated content.
 *
 * Destructive — leaves the page on whatever URL the navigation lands on.
 * Caller can navigate back if needed.
 */
async function probeWithProfileUrl(page, profileProbeUrl) {
  try {
    await page.goto(profileProbeUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await humanWait(page, 1500, 2500);
    const finalUrl = page.url();
    if (/\/people\/|pfbid/i.test(finalUrl)) {
      console.log(`  [ensure_login] profile probe → ${finalUrl} (guest view) → logged out`);
      return true;
    }
    return false;
  } catch (err) {
    console.warn(`  [ensure_login] profile probe failed (non-fatal): ${err.message}`);
    return false;
  }
}

/**
 * Combined check. Quick non-destructive signals first; profile probe only
 * if the quick signals say "looks logged in" AND caller provided a probe URL.
 */
async function isLoggedOut(page, options = {}) {
  if (await quickLoggedOutChecks(page)) return true;
  if (options.profileProbeUrl) {
    return await probeWithProfileUrl(page, options.profileProbeUrl);
  }
  return false;
}

module.exports = async function ensure_login(page, params) {
  if (!params.firstName) throw new Error('ensure_login: firstName is required');
  if (!params.lastName) throw new Error('ensure_login: lastName is required');
  if (!params.email) throw new Error('ensure_login: email is required');
  if (!params.password) throw new Error('ensure_login: password is required');

  console.log(`  [ensure_login] navigating to reg/login entry: ${REG_LOGIN_URL}`);
  await page.goto(REG_LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await humanWait(page, 2500, 4000);

  // Delegate to facebook_signup. The signup handler detects we're already on
  // /reg/ and skips its own facebook.com nav + "Create new account" click.
  // skipPostSetup=true → return as soon as the home href appears, no
  // /settings/bundled walk, no status PATCH (this is re-login, not signup).
  await facebook_signup(page, { ...params, skipPostSetup: true });

  console.log('  [ensure_login] re-login confirmed via home href.');
};

module.exports.isLoggedOut = isLoggedOut;
