/**
 * switch_profile - Leaf action.
 *
 * Opens the "Your profile" menu and switches to a chosen profile — either the
 * personal Facebook user OR the Page — based on `params.target`:
 *   target="user" (default) → switch to the personal profile
 *   target="page"           → switch to the Page
 *
 * The ONLY reliable anchor is the user's real name (firstName lastName from the
 * data). The Page name is NOT used — `linkedPage.pageName` drifts out of sync
 * with what FB actually shows. Instead the Page is identified as "the profile
 * that is NOT the user" (normally there are just two profiles).
 *
 * How it decides (from real DOM dumps in fix/Quick Profile/):
 *   - The "Your profile" dropdown is a div[role="dialog"][aria-label="Your profile"].
 *   - The CURRENT profile is the first item (with a checkmark) and has NO
 *     "Switch to" button.
 *   - Every OTHER profile renders a clickable div[aria-label="Switch to <Name>"].
 *   So the set of "Switch to X" buttons == all profiles EXCEPT the current one.
 *
 *   target="user" → click the button whose name MATCHES the user's name.
 *   target="page" → click the button whose name does NOT match the user's name.
 *   No such button (target already current) → clean no-op.
 *
 * User-name matching is diacritic-insensitive + whitespace/case-normalized so
 * accented Italian names match reliably.
 */

const { humanClick, humanWait } = require('../utils/humanBehavior');
const { stepWait } = require('../utils/pageSetupHelpers');

// Lowercase, strip diacritics, collapse whitespace — robust name comparison.
function normName(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

// Open the "Your profile" menu and read both:
//   - currentName: the ACTIVE profile (the dropdown's first row is an
//     <a href=".../me/"> wrapping the current profile's avatar + name — true
//     whether logged in as the user OR the page).
//   - options: every "Switch to X" button (the profiles you can switch TO).
// The dialog can render before its list lazy-mounts, so poll briefly.
async function openMenuAndRead(page) {
  const profileBtn = page.locator('[aria-label="Your profile"]').first();
  await profileBtn.waitFor({ state: 'visible', timeout: 15000 });
  await humanClick(page, await profileBtn.boundingBox());
  await stepWait(page);

  const dialog = page.locator('div[role="dialog"][aria-label="Your profile"]').first();
  await dialog.waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
  const dialogVisible = await dialog.isVisible().catch(() => false);
  const scope = dialogVisible ? dialog : page;

  // Current/active profile = the first row, an anchor to /me/.
  // NOTE: innerText()/getAttribute() inherit the page default timeout (60s).
  // Right after a profile switch the page is reloading and this element keeps
  // detaching, so an unbounded innerText() can block the full 60s PER iteration
  // — ×12 that's ~12 minutes of hang (observed in the logs). Cap each read at
  // 1.5s so the whole poll loop is bounded to ~18s worst case.
  const currentLoc = scope.locator('a[href$="/me/"]').first();
  let currentName = '';
  for (let i = 0; i < 12; i++) {
    currentName = (await currentLoc.innerText({ timeout: 1500 }).catch(() => ''))
      .replace(/\s+/g, ' ')
      .trim();
    if (currentName) break;
    await page.waitForTimeout(500);
  }

  // Switchable profiles (everyone except current).
  const switchBtns = scope.locator('[aria-label^="Switch to "]');
  const count = await switchBtns.count().catch(() => 0);
  const options = [];
  for (let i = 0; i < count; i++) {
    const btn = switchBtns.nth(i);
    const aria = (await btn.getAttribute('aria-label', { timeout: 1500 }).catch(() => '')) || '';
    const name = aria.replace(/^Switch to\s+/i, '').trim();
    if (name) options.push({ btn, name });
  }
  return { currentName, options };
}

module.exports = async function switch_profile(page, params) {
  const { target = 'user', userName = '', cooldownSeconds } = params;
  // Anti-detection pacing after a real switch. Configurable via cooldownSeconds
  // (the task already brackets this step with its own wait steps, so the old
  // flat 45-55s was redundant overhead). Default trimmed to 15-25s.
  const cooldownLo = Number.isFinite(cooldownSeconds) ? cooldownSeconds * 1000 : 15000;
  const cooldownHi = Number.isFinite(cooldownSeconds) ? cooldownSeconds * 1000 : 25000;

  const wantPage = String(target).trim().toLowerCase() === 'page';
  const label = wantPage ? 'page' : 'user';

  if (!userName) {
    console.warn(
      '  [switch_profile] No userName provided — cannot tell the user profile apart from the Page. Skipping.'
    );
    return;
  }

  console.log(`  [switch_profile] Target=${label} (user name="${userName}").`);

  // matchesUser: does a name belong to the personal user (vs the page)?
  const matchesUser = (name) =>
    normName(name) === normName(userName) ||
    normName(name).includes(normName(userName)) ||
    normName(userName).includes(normName(name));
  // Is the CURRENT (active) profile already the target?
  //   target=user → current name IS the user. target=page → current is NOT.
  const isOnTarget = (currentName) =>
    wantPage ? !matchesUser(currentName) : matchesUser(currentName);

  // Always start from the home page — the "Your profile" menu is reliably
  // present there, regardless of where a prior step left the session.
  await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded' });
  await stepWait(page);

  // Read the current/active profile from the dropdown's first row.
  let { currentName, options } = await openMenuAndRead(page);
  console.log(
    `  [switch_profile] Active profile = "${currentName || '(unknown)'}"; switchable: ${options.map((o) => `"${o.name}"`).join(', ') || '(none)'}`
  );

  if (currentName && isOnTarget(currentName)) {
    console.log(`  [switch_profile] Already on ${label} ("${currentName}") — no switch needed.`);
    await page.keyboard.press('Escape').catch(() => {});
    await stepWait(page);
    return;
  }

  // Not on the target → press the OTHER profile's "Switch to" button, then
  // re-open the dropdown and confirm the active profile is now the target.
  let switched = false;
  for (let attempt = 1; attempt <= 2 && !switched; attempt++) {
    // Pick the switch option for the target: user → the option matching the
    // user name; page → the non-user option.
    const opt = wantPage
      ? options.find((o) => !matchesUser(o.name))
      : options.find((o) => matchesUser(o.name));
    if (!opt) {
      console.warn(`  [switch_profile] No "Switch to" option for ${label} found (attempt ${attempt}).`);
      await page.keyboard.press('Escape').catch(() => {});
      break;
    }

    console.log(`  [switch_profile] Switching to "${opt.name}" (attempt ${attempt})...`);
    await opt.btn.waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
    const box = await opt.btn.boundingBox().catch(() => null);
    if (box) await humanClick(page, box);
    await stepWait(page);

    // Switching reloads the session as the new profile — let it settle.
    await humanWait(page, 5000, 8000);

    // Validate: re-open the dropdown and re-read the active profile.
    const after = await openMenuAndRead(page);
    await page.keyboard.press('Escape').catch(() => {});
    if (after.currentName && isOnTarget(after.currentName)) {
      switched = true;
      console.log(`  [switch_profile] Switch confirmed — active profile = "${after.currentName}".`);
    } else {
      console.warn(
        `  [switch_profile] Switch NOT confirmed (active still "${after.currentName || 'unknown'}") — attempt ${attempt}.`
      );
      options = after.options; // refresh handles for the retry
    }
  }

  if (!switched) {
    console.warn(
      `  [switch_profile] Could NOT confirm switch to ${label} after attempts — proceeding anyway.`
    );
  }

  const cdLabel = Math.round(((cooldownLo + cooldownHi) / 2 / 1000) * 10) / 10;
  console.log(`  [switch_profile] Cooling down ~${cdLabel}s...`);
  await humanWait(page, cooldownLo, cooldownHi);
};
