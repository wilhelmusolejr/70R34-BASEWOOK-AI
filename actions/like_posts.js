/**
 * like_posts - Like posts on the current page.
 *
 * Concept: query Like buttons directly, take any that are currently visible
 * in the viewport, pick one at random, click it. No post-container indirection.
 *
 * @param {object} params
 * @param {number} params.count - Number of posts to like (default: 2)
 */

const { humanWait, humanClick, humanDelay } = require('../utils/humanBehavior');

const LIKE_BTN_SELECTOR = 'div[role="button"][aria-label="Like"]';

module.exports = async function likePosts(page, params) {
  const targetCount = params.count ?? 2;

  const vp = page.viewportSize() || { width: 1280, height: 800 };
  const usedKeys = new Set();
  let liked = 0;
  let attempts = 0;
  const MAX_ATTEMPTS = 10;

  console.log(`  Target: like ${targetCount} post(s) (any visible)`);

  while (liked < targetCount && attempts < MAX_ATTEMPTS) {
    const buttons = await page.$$(LIKE_BTN_SELECTOR);
    const inView = [];

    for (const btn of buttons) {
      const box = await btn.boundingBox().catch(() => null);
      if (!box || box.width === 0 || box.height === 0) continue;
      const visible =
        box.y + box.height > 0 && box.y < vp.height && box.x + box.width > 0 && box.x < vp.width;
      if (!visible) continue;
      const key = `${Math.round(box.x)},${Math.round(box.y)}`;
      if (usedKeys.has(key)) continue;
      inView.push({ btn, box, key });
    }

    if (inView.length === 0) {
      // Nothing visible — scroll a bit and try again
      await page.mouse.wheel(0, humanDelay(400, 700));
      await humanWait(page, 800, 1500);
      attempts++;
      continue;
    }

    const { btn, box, key } = inView[Math.floor(Math.random() * inView.length)];

    try {
      // Reading pause
      await humanWait(page, 800, 1500);

      // Re-fetch box right before click
      const liveBox = await btn.boundingBox().catch(() => box);
      await humanClick(page, liveBox);

      // Wait for FB to register the like
      await humanWait(page, 2000, 3000);

      usedKeys.add(key);
      liked++;
      attempts = 0;
      console.log(`  Liked post ${liked}/${targetCount}`);

      // Pause between likes
      if (liked < targetCount) {
        const pause = 5000 + Math.random() * 5000;
        console.log(`  Pausing ${(pause / 1000).toFixed(1)}s before next like...`);
        await page.waitForTimeout(pause);
      }

      // Small scroll to expose new posts
      await page.mouse.wheel(0, humanDelay(300, 500));
      await humanWait(page, 600, 1200);
    } catch (err) {
      console.log(`  Post skipped (${err.message})`);
      usedKeys.add(key);
      attempts++;
    }
  }

  console.log(`  Like complete: ${liked}/${targetCount} posts liked`);
};
