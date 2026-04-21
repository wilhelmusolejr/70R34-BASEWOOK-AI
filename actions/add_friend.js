/**
 * add_friend — Send a friend request. Works on:
 *   - a dedicated profile page (button is "Add Friend <name>", capital F)
 *   - an inline search-result card (button is "Add friend", lowercase f)
 * Picks whichever variant is visible first.
 */

const { humanWait, humanClick, scrollToCenter } = require('../utils/humanBehavior');

module.exports = async function add_friend(page, params) {
  const combined = page.locator(
    'div[role="button"][aria-label^="Add Friend"], ' +
    'div[role="button"][aria-label="Add friend"]'
  ).first();

  await combined.waitFor({ state: 'visible', timeout: 10000 });

  const handle = await combined.elementHandle();
  if (handle) {
    const viewport = page.viewportSize();
    if (viewport && viewport.height) {
      await scrollToCenter(page, handle, viewport.height);
    }
  }

  await humanWait(page, 800, 1500);
  const box = await combined.boundingBox();
  if (!box) throw new Error('add_friend: Add Friend button has no bounding box');
  await humanClick(page, box);

  console.log('  [add_friend] Friend request sent.');
  await humanWait(page, 1000, 2000);
};
