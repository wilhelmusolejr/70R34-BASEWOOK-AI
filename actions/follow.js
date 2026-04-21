/**
 * follow — Leaf action.
 * Clicks the Follow button on whatever page is currently loaded. The selector
 * is the same on profiles, pages, and inline inside search-result cards.
 */

const { humanWait, humanClick, scrollToCenter } = require('../utils/humanBehavior');

module.exports = async function follow(page, params) {
  const followBtn = page.locator('[aria-label="Follow"]').first();
  await followBtn.waitFor({ state: 'visible', timeout: 10000 });

  const handle = await followBtn.elementHandle();
  if (handle) {
    const viewport = page.viewportSize();
    if (viewport && viewport.height) {
      await scrollToCenter(page, handle, viewport.height);
    }
  }

  await humanWait(page, 800, 1500);
  const box = await followBtn.boundingBox();
  if (!box) throw new Error('follow: Follow button has no bounding box');
  await humanClick(page, box);

  console.log('  [follow] Followed.');
  await humanWait(page, 1000, 2000);
};
