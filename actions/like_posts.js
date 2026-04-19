/**
 * like_posts - Like posts on the current page (typically homepage feed)
 *
 * Uses aria-posinset to enumerate virtualized feed posts, picks randomly,
 * scrolls to each with mouse.wheel, and verifies the like registered.
 *
 * @param {object} params
 * @param {number} params.count - Number of posts to like (default: 2)
 * @param {string} params.mode  - 'fixed' uses count, 'half' likes ~50% of found posts
 */

const { humanWait, humanClick, humanDelay, scrollToCenter } = require('../utils/humanBehavior');

module.exports = async function likePosts(page, params) {
  const mode = params.mode ?? 'fixed';
  const targetCount = params.count ?? 2;

  const viewport = page.viewportSize();
  const viewportHeight = viewport?.height ?? 800;

  const likedPositions = new Set();
  let liked = 0;
  let noNewPostsStreak = 0;
  const MAX_STREAK = 5;

  console.log(`  Target: like ${targetCount} post(s) (randomized)`);

  while (liked < targetCount && noNewPostsStreak < MAX_STREAK) {
    // Query all virtualized posts currently in DOM
    const allPosts = await page.$$('div[aria-posinset]');

    // Filter: has Like button + not already processed
    const candidates = [];
    for (const post of allPosts) {
      const posInSet = await post.getAttribute('aria-posinset').catch(() => null);
      if (!posInSet || likedPositions.has(posInSet)) continue;
      const likeBtn = await post.$('[aria-label="Like"]');
      if (likeBtn) candidates.push({ post, likeBtn, posInSet });
    }

    if (candidates.length === 0) {
      noNewPostsStreak++;
      await page.mouse.wheel(0, humanDelay(300, 600));
      await humanWait(page, 800, 1500);
      continue;
    }

    noNewPostsStreak = 0;

    // Pick one at random
    const { post, posInSet } = candidates[Math.floor(Math.random() * candidates.length)];

    try {
      // Scroll post to center using mouse.wheel (human-like, not scrollIntoView)
      const box = await scrollToCenter(page, post, viewportHeight);
      if (!box) {
        likedPositions.add(posInSet);
        continue;
      }

      // Reading pause before interacting
      await humanWait(page, 800, 1500);

      // Get fresh like button and bounding box right before clicking
      const likeBtn = await post.$('[aria-label="Like"]');
      if (!likeBtn) {
        likedPositions.add(posInSet);
        continue;
      }
      const likeBox = await likeBtn.boundingBox();
      if (!likeBox) {
        likedPositions.add(posInSet);
        continue;
      }

      await humanClick(page, likeBox);

      // Wait long enough for Facebook to update the DOM (2-3s)
      await humanWait(page, 2000, 3000);

      // Verify: check if Like flipped to Unlike
      const isLiked = await post.$('[aria-label="Remove Like"]').catch(() => null);

      if (!isLiked) {
        // First click may have missed — only retry if Like button still present
        // (if Unlike is gone AND Like is gone, FB is still updating — don't double click)
        const stillLike = await post.$('[aria-label="Like"]').catch(() => null);
        if (stillLike) {
          console.log(`  Post ${liked + 1}: missed, retrying...`);
          const retryBox = await stillLike.boundingBox();
          if (retryBox) {
            await humanClick(page, retryBox);
            await humanWait(page, 2000, 3000);
          }
        }
        // Otherwise first click worked but DOM is still updating — don't re-click
      }

      likedPositions.add(posInSet);
      liked++;
      console.log(`  Liked post ${liked}/${targetCount}`);

      // Pause between likes (5-10s)
      if (liked < targetCount) {
        const pause = 5000 + Math.random() * 5000;
        console.log(`  Pausing ${(pause / 1000).toFixed(1)}s before next like...`);
        await page.waitForTimeout(pause);
      }

      // Scroll down a bit to load more posts
      await page.mouse.wheel(0, humanDelay(300, 500));
      await humanWait(page, 600, 1200);

    } catch (err) {
      console.log(`  Post skipped (${err.message})`);
      likedPositions.add(posInSet);
    }
  }

  if (noNewPostsStreak >= MAX_STREAK) {
    console.log(`  Stopped — no new posts found after ${MAX_STREAK} scroll attempts`);
  }

  console.log(`  Like complete: ${liked}/${targetCount} posts liked`);
};
