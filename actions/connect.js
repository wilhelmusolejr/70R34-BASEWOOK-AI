/**
 * connect — Leaf action.
 * Clicks whichever of "Add Friend" / "Follow" is present on the loaded page.
 * Profiles usually show "Add Friend" (+ often "Follow"); Pages show "Follow".
 * If neither is visible, logs and returns — NEVER throws, so it's safe to
 * compose under open_search_result or visit_profile where button presence
 * varies by target.
 */

const { humanWait, humanClick, scrollToCenter } = require('../utils/humanBehavior');

const ADD_FRIEND_SELECTOR =
  'div[role="button"][aria-label^="Add Friend"], ' +
  'div[role="button"][aria-label="Add friend"]';
const FOLLOW_SELECTOR = '[aria-label="Follow"]';

async function clickIfPresent(page, locator, label) {
  const visible = await locator.isVisible().catch(() => false);
  if (!visible) return false;

  const handle = await locator.elementHandle().catch(() => null);
  if (handle) {
    const viewport = page.viewportSize();
    if (viewport && viewport.height) {
      await scrollToCenter(page, handle, viewport.height);
    }
  }

  await humanWait(page, 800, 1500);
  const box = await locator.boundingBox().catch(() => null);
  if (!box) {
    console.log(`  [connect] "${label}" had no bounding box — skipping.`);
    return false;
  }

  await humanClick(page, box);
  console.log(`  [connect] Clicked "${label}".`);
  await humanWait(page, 1000, 2000);
  return true;
}

module.exports = async function connect(page, params) {
  const both = params.both !== false;

  const addFriend = page.locator(ADD_FRIEND_SELECTOR).first();
  const follow = page.locator(FOLLOW_SELECTOR).first();

  const clickedFriend = await clickIfPresent(page, addFriend, 'Add Friend');

  let clickedFollow = false;
  if (both || !clickedFriend) {
    clickedFollow = await clickIfPresent(page, follow, 'Follow');
  }

  if (!clickedFriend && !clickedFollow) {
    console.log('  [connect] No Add Friend / Follow button visible — skipping.');
  }
};
