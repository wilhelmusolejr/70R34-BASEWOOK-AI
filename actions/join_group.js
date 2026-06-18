/**
 * join_group — Leaf action.
 *
 * Joins ONE Facebook Group from the Discover list. Flow mirrors the create_page
 * menu navigation, but lands on Groups → Discover (NOT the "Create" section).
 *
 * Flow (numbering from fix/group/ DOM dumps):
 *   1. Facebook menu → "Groups" link (href /groups/, NOT /groups/?category=create)
 *   2. "Discover" tab → /groups/discover/   (suggested groups to join)
 *   3. Press exactly ONE div[aria-label="Join group, <Name>"] card
 *   4. If the "unusual activity / confirm your identity" modal appears → flag
 *      the profile Need Checking (err.needChecking) and abort.
 *   5. Verify via "Groups you've joined" list (/groups/joins/): stamp
 *      groupJoinedAt only when count > 0; otherwise skip to the next action.
 *
 * Onboarding: stamps `groupJoinedAt` only when the joined-list shows > 0 groups.
 * Typical task guard (no chance — runs once, gated by the stamp + age):
 *   { "type": "join_group",
 *     "guard": { "ifOnboardingMissing": "groupJoinedAt", "minAccountAgeDays": 7 } }
 */

const { humanWait, humanClick, scrollToCenter } = require('../utils/humanBehavior');
const { stepWait, clickLocator } = require('../utils/pageSetupHelpers');
const { setOnboarding } = require('../utils/userApi');

const JOIN_SELECTOR = '[aria-label^="Join group, "]';
const DISCOVER_URL = 'https://www.facebook.com/groups/discover/';
const JOINS_URL = 'https://www.facebook.com/groups/joins/?nav_source=tab&ordering=viewer_added';

// After pressing Join, a flagged account gets an "unusual activity" modal
// ("Certain actions have been restricted due to unusual activity." / "Open
// Facebook on your mobile device to confirm your identity"). This is an
// account-level restriction → flag the profile Need Checking. Match either
// stable phrase. (Learned from fix/group/Facebook_group_fail_to_join.mhtml.)
const UNUSUAL_ACTIVITY_RE =
  /restricted due to unusual activity|confirm your identity/i;

// Detect the unusual-activity restriction modal on the current page.
async function isUnusualActivityBlocked(page) {
  return await page
    .getByText(UNUSUAL_ACTIVITY_RE)
    .first()
    .isVisible()
    .catch(() => false);
}

// Read the names off every currently-rendered "Join group, <Name>" button.
async function joinButtonNames(page) {
  const els = page.locator(JOIN_SELECTOR);
  const c = await els.count().catch(() => 0);
  const names = [];
  for (let i = 0; i < c; i++) {
    const a = (await els.nth(i).getAttribute('aria-label').catch(() => '')) || '';
    const nm = a.replace(/^Join group,\s*/i, '').trim();
    if (nm) names.push(nm);
  }
  return names;
}

// Navigate to the Discover list — menu-driven (human-like), with goto fallbacks.
async function goToDiscover(page) {
  await page.goto('https://www.facebook.com', { waitUntil: 'domcontentloaded' });
  await stepWait(page);

  let onGroups = false;
  try {
    console.log('  [join_group] Opening Facebook menu...');
    await clickLocator(
      page,
      page.locator('div[aria-label="Facebook menu"]'),
      'join_group: Facebook menu button has no bounding box'
    );
    console.log('  [join_group] Opening Groups (not under Create)...');
    await clickLocator(
      page,
      page.locator('xpath=//a[@role="link"]//span[text()="Groups"]'),
      'join_group: Groups link has no bounding box'
    );
    onGroups = true;
  } catch (err) {
    console.warn(`  [join_group] Menu nav failed (${err.message}) — going to /groups/ directly.`);
    await page.goto('https://www.facebook.com/groups/', { waitUntil: 'domcontentloaded' });
  }
  await stepWait(page);

  // Discover tab — fall back to direct nav.
  try {
    console.log('  [join_group] Opening Discover...');
    await clickLocator(
      page,
      page.locator('xpath=//a[@role="link"]//span[text()="Discover"]'),
      'join_group: Discover link has no bounding box'
    );
  } catch (err) {
    console.warn(`  [join_group] Discover click failed (${err.message}) — going to ${DISCOVER_URL}`);
    await page.goto(DISCOVER_URL, { waitUntil: 'domcontentloaded' });
  }
  await stepWait(page);
  void onGroups;
}

// Count how many groups the account has joined (cross-check). Best-effort.
// On /groups/joins/?ordering=viewer_added the main list is groups you're a
// member of; entries that you can still "Join" are NOT in that membership set,
// so a joined group is a /groups/<id> link WITHOUT a sibling "Join group" button.
async function countJoinedGroups(page) {
  try {
    await page.goto(JOINS_URL, { waitUntil: 'domcontentloaded' });
    await stepWait(page);
    const count = await page.evaluate(() => {
      const links = Array.from(
        document.querySelectorAll('a[href*="/groups/"]')
      );
      const ids = new Set();
      for (const a of links) {
        const m = a.getAttribute('href').match(/\/groups\/(\d+)/);
        if (!m) continue;
        // Skip cards that still offer a "Join group" button (= a suggestion).
        const card = a.closest('[role="listitem"]') || a.parentElement;
        if (card && card.querySelector('[aria-label^="Join group, "]')) continue;
        ids.add(m[1]);
      }
      return ids.size;
    });
    return count;
  } catch (err) {
    console.warn(`  [join_group] Joined-list check failed: ${err.message}`);
    return -1; // unknown
  }
}

module.exports = async function join_group(page, params) {
  const userId = params.userId || '';

  await goToDiscover(page);

  // Wait for the Discover list to render at least one Join button.
  try {
    await page.locator(JOIN_SELECTOR).first().waitFor({ state: 'visible', timeout: 30000 });
  } catch (err) {
    throw new Error('join_group: no "Join group" cards appeared on the Discover page');
  }

  const viewport = page.viewportSize();
  const vh = (viewport && viewport.height) || 900;

  // Press EXACTLY ONE "Join group" button — the first clickable candidate.
  const names = await joinButtonNames(page);
  const target = names[0];
  if (!target) {
    console.warn('  [join_group] No joinable groups in view — skipping.');
    return;
  }
  const btn = page.locator(JOIN_SELECTOR).first();
  const handle = await btn.elementHandle().catch(() => null);
  if (handle) await scrollToCenter(page, handle, vh).catch(() => {});
  await humanWait(page, 800, 1600);
  const box = await btn.boundingBox().catch(() => null);
  if (!box) {
    console.warn('  [join_group] Join button had no bounding box — skipping.');
    return;
  }

  console.log(`  [join_group] Joining "${target}"...`);
  await humanClick(page, box);
  await humanWait(page, 2000, 3500);

  // Account-level block: FB shows the "unusual activity / confirm your identity"
  // modal on flagged accounts. Flag the profile Need Checking and abort — the
  // runner handles err.needChecking (status PATCH + skips remaining steps).
  if (await isUnusualActivityBlocked(page)) {
    console.warn(
      '  [join_group] BLOCKED: "Certain actions have been restricted due to unusual activity" — flagging Need Checking.'
    );
    const err = new Error(
      'join_group: account restricted (unusual activity — confirm identity on mobile)'
    );
    err.needChecking = true;
    err.noRetry = true;
    throw err;
  }

  // Authoritative check: did the group actually show up in "Groups you've
  // joined"? Press one, then verify via the joined list. If it's still 0
  // (nothing joined, or a pending private-group request), skip to the next
  // action without stamping — the profile retries next run.
  const joinedCount = await countJoinedGroups(page);

  if (joinedCount > 0) {
    console.log(`  [join_group] Verified: account is in ${joinedCount} group(s) — stamping.`);
    if (userId) await setOnboarding(userId, 'groupJoinedAt');
  } else {
    // 0 (nothing showed up / pending request) OR -1 (count check failed) → the
    // join isn't confirmed in the list, so skip to the next action WITHOUT
    // stamping; the profile retries on a later run.
    console.warn(
      `  [join_group] Group did not appear in "Groups you've joined" (count=${joinedCount}) — NOT stamping; skipping to next action.`
    );
  }

  console.log('  [join_group] Done.');
};
