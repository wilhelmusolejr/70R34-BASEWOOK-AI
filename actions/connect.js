/**
 * connect — Leaf action.
 * Clicks whichever of Add Friend / Follow / Like are present on the loaded
 * profile or page. Walks all three in priority order and clicks every one
 * that is visible. If none are visible, logs and returns — NEVER throws, so
 * it's safe to compose under open_search_result or visit_profile where the
 * available buttons vary by target type.
 *
 * Selector notes:
 *   - Add Friend: aria-label starts with "Add Friend" (dynamic name suffix,
 *     e.g. "Add Friend Joan Blasiro") or the lowercase-f variant used on
 *     inline search-result cards.
 *   - Follow:     aria-label="Follow" exact (already-followed buttons become
 *                 "Following" so the exact match won't re-click).
 *   - Like:       aria-label="Like" exact (already-liked Pages become "Liked"
 *                 so the exact match won't re-click).
 */

const { humanWait, humanClick, scrollToCenter } = require('../utils/humanBehavior');

const ADD_FRIEND_SELECTOR =
  'div[role="button"][aria-label^="Add Friend"], ' +
  'div[role="button"][aria-label="Add friend"]';
const FOLLOW_SELECTOR = '[aria-label="Follow"]';
const LIKE_SELECTOR = '[aria-label="Like"]';

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
  const targets = [
    { label: 'Add Friend', locator: page.locator(ADD_FRIEND_SELECTOR).first() },
    { label: 'Follow', locator: page.locator(FOLLOW_SELECTOR).first() },
    { label: 'Like', locator: page.locator(LIKE_SELECTOR).first() },
  ];

  let anyClicked = false;
  for (const { label, locator } of targets) {
    const clicked = await clickIfPresent(page, locator, label);
    if (clicked) anyClicked = true;
  }

  if (!anyClicked) {
    console.log('  [connect] No Add Friend / Follow / Like button visible — skipping.');
  }
};
