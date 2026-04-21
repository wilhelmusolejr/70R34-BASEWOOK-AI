/**
 * open_search_result — Navigator action.
 * Picks a profile/page link from the currently-loaded search-results page
 * (anchors matching `a[href*="/profile.php?id="]`) and clicks into it.
 * After click, the browser is on that profile or page, so child steps
 * (scroll, add_friend, follow, like_posts, ...) operate on it.
 *
 * Use as a child of `search`.
 */

const { humanClick, humanWait, scrollToCenter } = require('../utils/humanBehavior');

const RESULT_LINK_SELECTOR = 'a[href*="/profile.php?id="]';

module.exports = async function open_search_result(page, params) {
  const { pick = 'random' } = params;

  await page.waitForSelector(RESULT_LINK_SELECTOR, { timeout: 15000 });
  await humanWait(page, 800, 1500);

  const anchors = await page.$$(RESULT_LINK_SELECTOR);
  if (!anchors.length) throw new Error('open_search_result: no profile/page links found on page');

  // Dedupe by href so we don't re-pick the same target variant (avatar + name anchor pair).
  const seen = new Set();
  const candidates = [];
  for (const a of anchors) {
    const href = await a.getAttribute('href').catch(() => null);
    if (!href) continue;
    const key = href.split('&')[0];
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push({ handle: a, href });
  }

  if (!candidates.length) throw new Error('open_search_result: no usable profile links after dedupe');

  let chosen;
  if (pick === 'first' || pick === 0) {
    chosen = candidates[0];
  } else if (typeof pick === 'number' && Number.isInteger(pick) && pick >= 0) {
    chosen = candidates[Math.min(pick, candidates.length - 1)];
  } else {
    chosen = candidates[Math.floor(Math.random() * candidates.length)];
  }

  console.log(`  [open_search_result] Picked ${candidates.indexOf(chosen) + 1}/${candidates.length}: ${chosen.href}`);

  const viewport = page.viewportSize();
  const vh = (viewport && viewport.height) || 900;
  let box = await scrollToCenter(page, chosen.handle, vh);
  if (!box) box = await chosen.handle.boundingBox();
  if (!box) throw new Error('open_search_result: chosen link has no bounding box after scroll');

  await humanWait(page, 600, 1200);
  await humanClick(page, box);

  try {
    await page.waitForLoadState('domcontentloaded', { timeout: 20000 });
  } catch (err) {
    console.warn(`  [open_search_result] domcontentloaded wait timed out: ${err.message}`);
  }
  await humanWait(page, 2000, 4000);

  console.log(`  [open_search_result] Landed on: ${page.url()}`);
};
