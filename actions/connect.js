/**
 * connect — Leaf action.
 * Clicks whichever of Add Friend / Confirm request / Follow / Like are present
 * on the loaded profile or page, in priority order. Only clicks when the target
 * is actually visible + has a bounding box, then verifies the click landed.
 * If none are present, logs and returns — NEVER throws.
 *
 * Add Friend — the owner-only rule (the important bit):
 *   A profile page renders a "People you may know" (PYMK) carousel whose
 *   suggestion cards each carry an aria-label="Add Friend <SuggestedName>"
 *   button — the EXACT same format (capital F + name) as the profile owner's
 *   own header button. Real DOM dumps confirm this: on Alfonso Vitale's profile
 *   the only Add Friend button present was "Add Friend Amedeo Sanna" — a PYMK
 *   suggestion, NOT the owner. So neither aria-label case (capital/lowercase)
 *   nor DOM order distinguishes them; the ONLY reliable signal is the name.
 *   We read the profile owner's name from the page <h1> and click ONLY the
 *   button whose name suffix equals it. No owner-matching button (owner already
 *   friended, or name unreadable) → we click nothing, so we never befriend a
 *   suggested stranger.
 *
 * Confirm request / Follow / Like use has-text XPath (exact inner-span text) —
 * these are header/page actions and [aria-label="Like"] also matches feed post
 * likes, so span text is the stable signal there.
 */

const { humanWait, humanClick } = require('../utils/humanBehavior');
const { detectRateLimit, dismissRateLimit } = require('../utils/fbRateLimit');
const { resolveOwnerAddFriend } = require('../utils/profileOwner');

// Span-text targets (everything except Add Friend). Priority order preserved.
const SPAN_TARGETS = [
  {
    label: 'Confirm request',
    selector: 'xpath=//div[@role="button"][.//span[normalize-space(text())="Confirm request"]]',
  },
  {
    label: 'Follow',
    selector: 'xpath=//div[@role="button"][.//span[normalize-space(text())="Follow"]]',
  },
  {
    label: 'Like',
    selector: 'xpath=//div[@role="button"][.//span[normalize-space(text())="Like"]]',
  },
];

/**
 * Click a target via its Locator, with verification.
 * @param verifyGone async () => boolean — true once the target is gone (click landed).
 */
async function clickTarget(page, label, locator, verifyGone) {
  const visible = await locator.isVisible().catch(() => false);
  if (!visible) {
    console.log(`  [connect] "${label}" not visible — skipping.`);
    return false;
  }

  const handle = await locator.elementHandle().catch(() => null);
  if (!handle) {
    console.log(`  [connect] "${label}" handle unavailable — skipping.`);
    return false;
  }

  await handle.scrollIntoViewIfNeeded().catch(() => null);
  await humanWait(page, 1000, 1800);

  const box = await handle.boundingBox().catch(() => null);
  if (!box || !box.width || !box.height) {
    console.log(`  [connect] "${label}" has no bounding box after scroll — skipping.`);
    return false;
  }

  await humanClick(page, box);
  await humanWait(page, 1500, 2500);

  const gone = await verifyGone().catch(() => false);
  if (!gone) {
    console.log(
      `  [connect] Click on "${label}" did not register (target still present) — skipping.`
    );
    return false;
  }

  console.log(`  [connect] Clicked "${label}".`);
  return true;
}

module.exports = async function connect(page, params) {
  let anyClicked = false;

  // 1) Add Friend — owner only (never a "People you may know" suggestion).
  const log = (m) => console.log(`  [connect] ${m}`);
  const { locator: ownerBtn } = await resolveOwnerAddFriend(page, { log });
  if (ownerBtn) {
    // Verified when no owner-matching Add Friend button remains (FB swaps it to
    // "Cancel request" / "Friends" on success).
    const verifyGone = async () => (await resolveOwnerAddFriend(page)).locator === null;
    if (await clickTarget(page, 'Add Friend', ownerBtn, verifyGone)) anyClicked = true;

    if (await detectRateLimit(page, 1000)) {
      console.warn('  [connect] Rate-limit modal detected — dismissing.');
      await dismissRateLimit(page);
    }
  }

  // 2) Confirm request / Follow / Like — span-text targets.
  for (const target of SPAN_TARGETS) {
    const locator = page.locator(target.selector).first();
    const count = await locator.count().catch(() => 0);
    if (count === 0) {
      console.log(`  [connect] "${target.label}" not present — skipping.`);
      continue;
    }

    const verifyGone = async () =>
      !(await page
        .locator(target.selector)
        .first()
        .isVisible()
        .catch(() => false));

    if (await clickTarget(page, target.label, locator, verifyGone)) anyClicked = true;

    // FB sometimes surfaces the rate-limit modal after a click; dismiss so
    // it doesn't block the remaining target probes in this loop.
    if (await detectRateLimit(page, 1000)) {
      console.warn('  [connect] Rate-limit modal detected — dismissing.');
      await dismissRateLimit(page);
    }
  }

  if (!anyClicked) {
    console.log('  [connect] Nothing clickable (no owner Add Friend / Confirm / Follow / Like).');
  }
};
