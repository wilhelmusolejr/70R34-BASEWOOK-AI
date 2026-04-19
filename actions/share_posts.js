/**
 * share_posts - Share posts from the current page with an optional message.
 *
 * Flow: find post → scroll to it → click share → wait for modal →
 *       extract context → call API → type message → Share now
 *
 * @param {object} params
 * @param {number} params.count        - Number of posts to share (default: 1)
 * @param {string} params.message      - Static message (skips API generation if set)
 * @param {string} params.userIdentity - Who the account is (for API generation)
 */

const { humanWait, humanType, humanDelay, scrollToCenter } = require('../utils/humanBehavior');
const { generateMessage } = require('../utils/generateMessage');

module.exports = async function sharePosts(page, params) {
  const targetCount = params.count ?? 1;
  const staticMessage = params.message ?? '';
  const userIdentity = params.userIdentity ?? '';
  const useApi = !staticMessage && !!userIdentity;

  const viewport = page.viewportSize();
  const viewportHeight = viewport?.height ?? 800;

  const sharedPositions = new Set();
  let shared = 0;
  let noNewPostsStreak = 0;
  const MAX_STREAK = 5;

  console.log(`  Target: share ${targetCount} post(s) (randomized)`);

  while (shared < targetCount && noNewPostsStreak < MAX_STREAK) {
    // Query all virtualized posts currently in DOM
    const allPosts = await page.$$('div[aria-posinset]');

    // Filter: has share button + not already processed
    const candidates = [];
    for (const post of allPosts) {
      const posInSet = await post.getAttribute('aria-posinset').catch(() => null);
      if (!posInSet || sharedPositions.has(posInSet)) continue;
      const shareBtn = await post.$('[aria-label="Send this to friends or post it on your profile."]');
      if (shareBtn) candidates.push({ post, posInSet });
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
      // Scroll post into center of viewport using mouse.wheel
      const box = await scrollToCenter(page, post, viewportHeight);
      if (!box) {
        sharedPositions.add(posInSet);
        continue;
      }

      await humanWait(page, 800, 1500);

      // Get fresh share button — use direct .click() (small target, humanClick offset misses)
      const shareBtn = await post.$('[aria-label="Send this to friends or post it on your profile."]');
      if (!shareBtn) {
        sharedPositions.add(posInSet);
        continue;
      }

      await shareBtn.click();
      await humanWait(page, 1500, 2500);

      // Wait for share modal — if it doesn't load, skip this post
      const modalShareBtn = await page.waitForSelector('[aria-label="Share now"]', { timeout: 8000 })
        .catch(() => null);

      if (!modalShareBtn) {
        console.log(`  Post ${shared + 1}: modal didn't load, skipping`);
        await page.keyboard.press('Escape').catch(() => {});
        sharedPositions.add(posInSet);
        continue;
      }

      // Modal is open — now extract context and generate message
      const postContext = await post.evaluate(el => {
        const textEl = el.querySelector('[data-ad-rendering-role="story_message"] [dir="auto"]');
        const postText = textEl ? textEl.innerText.trim() : '';

        const imgEl = el.querySelector('img[data-imgperflogname="feedImage"]');
        const imageAlt = imgEl ? imgEl.getAttribute('alt') : '';

        const subEl = el.querySelector('[data-ad-rendering-role="description"]');
        const subText = subEl ? subEl.innerText.trim() : '';

        return [postText, subText, imageAlt ? `[Image: ${imageAlt}]` : ''].filter(Boolean).join('\n');
      });

      console.log(`  Post ${shared + 1}: context: "${postContext}"`);

      let message = staticMessage;
      if (useApi) {
        message = await generateMessage(userIdentity, postContext);
      }

      // Type message into share dialog if we have one
      if (message) {
        const textInput = await page.$('[aria-placeholder="Say something about this..."]');
        if (textInput) {
          await textInput.click();
          await humanWait(page, 300, 600);
          await humanType(page, message);
          await humanWait(page, 600, 1200);
        }
      }

      // Click "Share now"
      const shareBtnBox = await modalShareBtn.boundingBox();
      if (!shareBtnBox) {
        await page.keyboard.press('Escape').catch(() => {});
        sharedPositions.add(posInSet);
        continue;
      }

      await modalShareBtn.click();
      sharedPositions.add(posInSet);
      shared++;
      console.log(`  Shared post ${shared}/${targetCount}`);

      await humanWait(page, 2000, 3500);

      // Scroll down to load more posts
      await page.mouse.wheel(0, humanDelay(300, 500));
      await humanWait(page, 600, 1200);

    } catch (err) {
      console.log(`  Post ${shared + 1}: error - ${err.message}`);
      await page.keyboard.press('Escape').catch(() => {});
      sharedPositions.add(posInSet);
      await humanWait(page, 400, 700);
    }
  }

  if (noNewPostsStreak >= MAX_STREAK) {
    console.log(`  Stopped early — no new posts found after ${MAX_STREAK} scroll attempts`);
  }

  console.log(`  Share complete: ${shared}/${targetCount} posts shared`);
};
