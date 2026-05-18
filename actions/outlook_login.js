/**
 * outlook_login — Leaf action.
 * Sign into outlook.com using the email + password on the user record.
 *
 * Flow:
 *   1. goto outlook.live.com → Microsoft redirects to login.live.com if not signed in
 *   2. If already redirected back to /mail → already signed in, done.
 *   3. Fill email → Next.
 *   4. Fill password → Sign in.
 *   5. Walk post-login prompts (passkey skip, "Stay signed in?", "Protect your account",
 *      generic Not now / Skip setup) until /mail is reached or attempt cap hit.
 *
 * Credentials are auto-injected from the user record by `injectUserParams`:
 *   email    ← user.emails.find(e=>e.selected)?.address || user.emails[0]?.address
 *   password ← user.emailPassword
 *
 * No screenshot / no proxy update / no profile launch — all handled upstream by
 * browserManager.js. Single tab — we navigate in place, never open a popup.
 */

const fs = require('fs');
const path = require('path');
const { humanWait, humanClick, humanType } = require('../utils/humanBehavior');
const { getProfileLogDir } = require('../utils/sessionLog');

const PROMPT_TICKS = 12;
const PROMPT_INTERVAL_MS = 2500;

const SIGNED_IN_URL_HINTS = ['outlook.live.com/mail', 'outlook.office.com/mail'];

// Microsoft-side rejection messages. When any of these are visible, the
// account/password combination is bad — no amount of prompt-walking will fix
// it. Detect and throw a clear, fast error so the runner moves on instead of
// burning the prompt-tick budget. Patterns are matched case-insensitively
// against the rendered page text.
const CREDENTIAL_ERROR_PATTERNS = [
  /that password is incorrect/i,
  /your account or password is incorrect/i,
  /incorrect account or password/i,
  /tried to sign in too many times/i,
  /we couldn't find an account with that username/i,
  /this username may be incorrect/i,
  /sign-in is blocked/i,
  /your account has been locked/i,
  /account has been temporarily blocked/i,
];

/**
 * Check the current page for a Microsoft credential-error message. Returns
 * the matched message string (so the caller can surface it), or null.
 */
async function detectCredentialError(page) {
  for (const pattern of CREDENTIAL_ERROR_PATTERNS) {
    const visible = await page
      .getByText(pattern)
      .first()
      .isVisible({ timeout: 300 })
      .catch(() => false);
    if (visible) return pattern.source.replace(/\\/g, '');
  }
  return null;
}

/**
 * Write the current page's HTML + a PNG screenshot to the profile's run-
 * scoped log folder so failures can be diagnosed without re-running. When
 * called inside a `runInSession` scope, drops into
 * `logs/{taskId}-{ts}/profiles/{name}-{shortId}/`. When called outside one,
 * falls back to `logs/`. Best-effort — swallows its own errors, never throws.
 */
async function dumpFailure(page, label) {
  try {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const safeLabel = String(label || 'failure').replace(/[^a-z0-9_-]+/gi, '_');

    // Prefer the per-profile dir from the run-scoped log layout. Folder name
    // already identifies the profile, so we drop the email/label prefix and
    // just write `outlook-error-{ts}.{html,png}`. Outside a session scope
    // (e.g. dev script), fall back to the flat logs/ dir with the legacy
    // `outlook-{label}-{ts}` filename so dumps don't get overwritten.
    const profileDir = getProfileLogDir();
    const useLegacy = !profileDir;
    const targetDir = profileDir || path.join(process.cwd(), 'logs');
    if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });

    const baseName = useLegacy
      ? `outlook-${safeLabel}-${ts}`
      : `outlook-error-${ts}`;
    const htmlPath = path.join(targetDir, `${baseName}.html`);
    const pngPath = path.join(targetDir, `${baseName}.png`);

    let url = '(unknown)';
    try {
      url = page.url();
    } catch (_) {}

    try {
      const html = await page.content();
      fs.writeFileSync(htmlPath, `<!-- url: ${url} -->\n${html}`, 'utf8');
      console.warn(`  [outlook_login] dumped HTML → ${htmlPath}`);
    } catch (err) {
      console.warn(`  [outlook_login] HTML dump failed: ${err.message}`);
    }

    try {
      await page.screenshot({ path: pngPath, fullPage: true });
      console.warn(`  [outlook_login] dumped screenshot → ${pngPath}`);
    } catch (err) {
      console.warn(`  [outlook_login] screenshot failed: ${err.message}`);
    }
  } catch (err) {
    console.warn(`  [outlook_login] dumpFailure swallowed: ${err.message}`);
  }
}

function isSignedInUrl(url) {
  return SIGNED_IN_URL_HINTS.some((hint) => url.includes(hint));
}

async function clickIfVisible(page, selector, timeout = 1000) {
  try {
    const loc = page.locator(selector).first();
    const visible = await loc.isVisible({ timeout }).catch(() => false);
    if (!visible) return false;
    const box = await loc.boundingBox().catch(() => null);
    if (!box) return false;
    await humanClick(page, box);
    return true;
  } catch (_) {
    return false;
  }
}

async function fillFormInput(page, selector, value, timeout = 20000) {
  await page.waitForSelector(selector, { timeout });
  const loc = page.locator(selector).first();
  await loc.scrollIntoViewIfNeeded().catch(() => {});
  const box = await loc.boundingBox();
  if (!box) throw new Error(`outlook_login: ${selector} has no bounding box`);
  await humanClick(page, box);
  await humanWait(page, 300, 700);
  await humanType(page, value);
  await humanWait(page, 400, 900);
}

/**
 * Walk every post-login prompt Microsoft can throw at us until we land on
 * the inbox (or run out of attempts). Each tick checks URL → in-page prompts
 * in priority order. We never call Escape blindly — that can dismiss the
 * password panel mid-render and lose us the form.
 */
async function walkPostLoginPrompts(page) {
  for (let i = 0; i < PROMPT_TICKS; i++) {
    await humanWait(page, PROMPT_INTERVAL_MS, PROMPT_INTERVAL_MS + 1000);

    const url = page.url();
    console.log(`  [outlook_login] tick ${i + 1}/${PROMPT_TICKS} url=${url.slice(0, 90)}`);

    // ── Hard failure signal — Microsoft rejected creds ───────────────
    // Stop ticking immediately; no prompt will appear to fix this.
    const credErr = await detectCredentialError(page);
    if (credErr) {
      const err = new Error(`outlook_login: credentials rejected (${credErr})`);
      err.credentialsRejected = true;
      err.noRetry = true;
      throw err;
    }

    // ── Success signals — terminate immediately ────────────────────────
    if (isSignedInUrl(url)) return true;

    // Microsoft sometimes lands the session on microsoft.com after sign-in
    // (consumer accounts). That's a signed-in state — bail and let caller
    // navigate to the inbox.
    if (
      url.includes('microsoft.com') &&
      !url.includes('login') &&
      !url.includes('account')
    ) {
      console.log('  [outlook_login] landed on microsoft.com — signed in.');
      return true;
    }

    // ── Unified prompt scan ─────────────────────────────────────────────
    // Each tick runs every detector in priority order. The first one that
    // matches and successfully clicks wins this tick — we then loop.
    //
    // ORDER MATTERS — most specific first:
    //   1. KMSI ("Stay signed in?")  → success signal, click Yes → next tick lands on /mail
    //   2. Passkey / FIDO            → must run BEFORE generic primary-button matches,
    //                                   because /fido/create reuses #idSIButton9 as "Next"
    //                                   (which would *enroll* the passkey instead of skip).
    //   3. Protect-account           → "Help us protect your account" interstitial
    //   4. Generic dismiss           → any leftover Not now / Skip / Cancel button
    let acted = null;

    // 1. KMSI — detect by the page's header text, NOT by #idSIButton9 alone.
    //    Other Microsoft pages (FIDO, account-pickers) reuse that ID, so
    //    matching it without the header check causes us to click Next on the
    //    wrong page and burn the rest of the prompt budget on FIDO enrollment.
    const onKmsi = await page
      .locator("text=Stay signed in?")
      .first()
      .isVisible({ timeout: 500 })
      .catch(() => false);
    if (onKmsi) {
      for (const sel of ["button:has-text('Yes')", '#idSIButton9']) {
        if (await clickIfVisible(page, sel, 800)) {
          console.log(`  [outlook_login] KMSI → Yes (${sel})`);
          acted = 'kmsi';
          break;
        }
      }
    }

    // 2. Passkey / FIDO enrollment — Skip for now (NOT Next/primary).
    if (!acted && (url.includes('fido') || url.includes('passkey'))) {
      const passkeyDismiss = [
        "a:has-text('Skip for now')",
        "button:has-text('Skip for now')",
        "button:has-text('Maybe later')",
        '#idBtn_Back',
        "button[data-testid='secondaryButton']",
        "button:has-text('Cancel')",
      ];
      for (const sel of passkeyDismiss) {
        if (await clickIfVisible(page, sel, 800)) {
          console.log(`  [outlook_login] passkey → skip (${sel})`);
          acted = 'passkey';
          break;
        }
      }
    }

    // 3. Protect-your-account interstitial (proofs/Add).
    if (!acted) {
      if (await clickIfVisible(page, "a:has-text('Skip for now')", 600)) {
        console.log('  [outlook_login] protect-account → skip');
        acted = 'protect';
      }
    }

    // 4. Generic fallback — any visible dismiss-shaped control.
    if (!acted) {
      const fallbacks = [
        "a:has-text('Not now')",
        "button:has-text('Not now')",
        "a:has-text('Skip setup')",
        "button:has-text('Skip setup')",
        'a[id="iCancel"]',
        'button[id="iCancel"]',
        '#idBtn_Back',
      ];
      for (const sel of fallbacks) {
        if (await clickIfVisible(page, sel, 400)) {
          console.log(`  [outlook_login] fallback dismiss (${sel})`);
          acted = 'fallback';
          break;
        }
      }
    }

    if (!acted) {
      console.log('  [outlook_login] no prompts visible this tick — waiting for next.');
    }
  }

  return isSignedInUrl(page.url());
}

module.exports = async function outlook_login(page, params) {
  const email = (params.email || '').trim();
  const password = params.password || '';

  if (!email) throw new Error('outlook_login: email is required');
  if (!password) throw new Error('outlook_login: password is required');

  console.log(`  [outlook_login] signing in as ${email}`);

  try {
    // prompt=select_account forces the email-entry form even when a cached
    // account exists, so we never land on the microsoft.com marketing page.
    const LOGIN_URL =
      'https://outlook.live.com/mail/?prompt=select_account&deeplink=mail%2F%3FbO%3D2&bO=2';
    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded' });
    await humanWait(page, 2500, 4000);

    let currentUrl = page.url();
    console.log(`  [outlook_login] landed on ${currentUrl.slice(0, 90)}`);

    if (isSignedInUrl(currentUrl)) {
      console.log('  [outlook_login] already signed in.');
      return;
    }

    // Some flows show a "Pick an account" tile when a stale account is cached.
    // The email entry field (#i0116) is NOT visible until "Use another account"
    // is clicked, so this MUST run before the waitForSelector below — otherwise
    // we burn the full 60s timeout waiting for a hidden input.
    await clickIfVisible(
      page,
      "div[data-test-id='use-another-account-link'], a:has-text('Use another account'), button:has-text('Use another account')",
      3000
    );

    // Wait for the email input to actually render (Microsoft's redirect chain
    // takes a few hops; networkidle is unreliable). 60s — covers slow proxies.
    console.log('  [outlook_login] waiting for email input...');
    await page.waitForSelector('#i0116', { timeout: 60000, state: 'visible' });

    // Email
    await fillFormInput(page, '#i0116', email);
    await page.click('#idSIButton9');
    await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
    await humanWait(page, 1500, 2500);

    // Password
    await fillFormInput(page, "input[name='passwd']", password);
    await page.click("button[data-testid='primaryButton'], #idSIButton9");
    await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
    await humanWait(page, 1500, 2500);

    // Fast-fail on credential rejection — Microsoft's "incorrect password"
    // banner appears within ~1s of submit. Catching it here avoids the full
    // walkPostLoginPrompts tick budget (~30s) for a known-dead state.
    const earlyCredErr = await detectCredentialError(page);
    if (earlyCredErr) {
      const err = new Error(`outlook_login: credentials rejected (${earlyCredErr})`);
      err.credentialsRejected = true;
      err.noRetry = true;
      throw err;
    }

    const reached = await walkPostLoginPrompts(page);
    if (!reached) {
      throw new Error(`outlook_login: could not reach inbox (last url: ${page.url()})`);
    }

    // If we landed on microsoft.com, force-navigate to the inbox so subsequent
    // steps run in the expected context.
    if (!isSignedInUrl(page.url())) {
      console.log('  [outlook_login] navigating to inbox...');
      await page.goto('https://outlook.live.com/mail/', { waitUntil: 'domcontentloaded' });
      await humanWait(page, 3000, 5000);
    }

    console.log('  [outlook_login] login complete.');
  } catch (err) {
    // Forensics: dump page state before propagating. dumpFailure swallows its
    // own errors so a dump-on-dump failure can't mask the original.
    await dumpFailure(page, `error-${email.split('@')[0]}`);
    throw err;
  }
};
