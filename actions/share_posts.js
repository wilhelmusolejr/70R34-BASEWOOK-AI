/**
 * share_posts - Share posts on the current page.
 *
 * Concept: query share buttons directly, take any that are currently visible
 * in the viewport, pick one at random, click it. No post-container indirection,
 * works the same in feed/Page timelines and across browser providers.
 *
 * @param {object} params
 * @param {number} params.count        - Number of posts to share (default: 1)
 * @param {string} params.message      - Static message (skips API generation)
 * @param {string} params.userIdentity - Persona for API-generated message
 */

const { humanWait, humanType, humanDelay } = require('../utils/humanBehavior');
const { generateMessage } = require('../utils/generateMessage');
const { resolveCount } = require('../utils/randomCount');
const { setOnboarding } = require('../utils/userApi');

// Anchor on FB's own marker `<div data-ad-rendering-role="share_button">` —
// stable across feed/Page timelines and locale-independent. We then walk up
// to the parent role=button to click. The aria-label variants are kept as
// a fallback for older DOM revisions.
const SHARE_BTN_SELECTOR = [
  'div[role="button"]:has([data-ad-rendering-role="share_button"])',
  '[aria-label="Send this to friends or post it on your profile."]',
  'div[role="button"][aria-label="Share"]',
].join(', ');

module.exports = async function sharePosts(page, params) {
  const targetCount = resolveCount(params, 1);

  if (targetCount === 0) {
    console.log(`  Share skipped: count rolled 0 (min=${params.min}, max=${params.max})`);
    return;
  }

  const staticMessage = params.message ?? '';
  const userIdentity = params.userIdentity ?? '';
  const userId = params.userId ?? '';
  const useApi = !staticMessage && !!userIdentity;

  const vp = page.viewportSize() || { width: 1280, height: 800 };
  const usedKeys = new Set();
  let shared = 0;
  let attempts = 0;
  const MAX_ATTEMPTS = 10;

  console.log(`  Target: share ${targetCount} post(s) (any visible)`);

  while (shared < targetCount && attempts < MAX_ATTEMPTS) {
    const buttons = await page.$$(SHARE_BTN_SELECTOR);
    const candidates = [];

    for (const btn of buttons) {
      const box = await btn.boundingBox().catch(() => null);
      if (!box || box.width === 0 || box.height === 0) continue;
      const key = `${Math.round(box.x)},${Math.round(box.y)}`;
      if (usedKeys.has(key)) continue;
      candidates.push({ btn, box, key });
    }

    console.log(
      `  Attempt ${attempts + 1}: ${buttons.length} share button(s) total, ${candidates.length} clickable`
    );

    if (candidates.length === 0) {
      await page.mouse.wheel(0, humanDelay(400, 700));
      await humanWait(page, 800, 1500);
      attempts++;
      continue;
    }

    const { btn, key } = candidates[Math.floor(Math.random() * candidates.length)];

    try {
      // Scroll into view (works on Page headers, doesn't trigger feed virtualization)
      await btn.scrollIntoViewIfNeeded().catch(() => {});
      await humanWait(page, 600, 1000);

      // force:true bypasses Playwright's actionability check that the overlay
      // <div data-visualcompletion="ignore"> covering the button would fail.
      await btn.click({ force: true });
      await humanWait(page, 1500, 2500);

      const modalShareBtn = await page
        .waitForSelector('[aria-label="Share now"]', { timeout: 8000 })
        .catch(() => null);

      if (!modalShareBtn) {
        console.log(`  Post ${shared + 1}: modal didn't open, skipping`);
        await page.keyboard.press('Escape').catch(() => {});
        usedKeys.add(key);
        attempts++;
        continue;
      }

      // Walk up from the share button to find a post container, then extract
      // text/image from multiple known shapes. The closest('[aria-posinset]')
      // approach fails on Page timelines / Multilogin Chrome, so we fall back
      // to walking up looking for any ancestor that actually holds the post
      // body (story_message or comet preview message).
      const postContext = await btn
        .evaluate((el) => {
          const TEXT_MARKERS = [
            '[data-ad-rendering-role="story_message"]',
            '[data-ad-comet-preview="message"]',
          ];

          let parent =
            el.closest('[aria-posinset]') ||
            el.closest('[role="article"]') ||
            el.closest('[data-pagelet*="FeedUnit"]') ||
            el.closest('[data-pagelet*="TimelineFeedUnit"]');

          if (!parent) {
            let cur = el.parentElement;
            while (cur && cur !== document.body) {
              if (TEXT_MARKERS.some((m) => cur.querySelector(m))) {
                parent = cur;
                break;
              }
              cur = cur.parentElement;
            }
          }
          if (!parent) return '';

          // Text — try the marker[dir="auto"] children first, then the marker
          // root, then any [dir="auto"] in the container as last resort.
          let postText = '';
          for (const sel of TEXT_MARKERS) {
            const dir = parent.querySelector(`${sel} [dir="auto"]`);
            if (dir && dir.innerText.trim()) {
              postText = dir.innerText.trim();
              break;
            }
            const root = parent.querySelector(sel);
            if (root && root.innerText.trim()) {
              postText = root.innerText.trim();
              break;
            }
          }
          if (!postText) {
            const fallback = parent.querySelector('[dir="auto"]');
            if (fallback) postText = fallback.innerText.trim();
          }

          const imgEl =
            parent.querySelector('img[data-imgperflogname="feedImage"]') ||
            parent.querySelector('img[alt]:not([alt=""])');
          const imageAlt = imgEl ? imgEl.getAttribute('alt') : '';

          const subEl = parent.querySelector('[data-ad-rendering-role="description"]');
          const subText = subEl ? subEl.innerText.trim() : '';

          return [postText, subText, imageAlt ? `[Image: ${imageAlt}]` : '']
            .filter(Boolean)
            .join('\n');
        })
        .catch(() => '');

      console.log(`  Post ${shared + 1}: context: "${postContext}"`);

      let message = staticMessage;
      if (useApi) message = await generateMessage(userIdentity, postContext);

      if (message) {
        const textInput = await page.$('[aria-placeholder="Say something about this..."]');
        if (textInput) {
          await textInput.click();
          await humanWait(page, 300, 600);
          await humanType(page, message);
          await humanWait(page, 600, 1200);
        }
      }

      const shareBtnBox = await modalShareBtn.boundingBox();
      if (!shareBtnBox) {
        await page.keyboard.press('Escape').catch(() => {});
        usedKeys.add(key);
        attempts++;
        continue;
      }

      await modalShareBtn.click();
      usedKeys.add(key);
      shared++;
      attempts = 0;
      console.log(`  Shared post ${shared}/${targetCount}`);

      await humanWait(page, 2000, 3500);
      await page.mouse.wheel(0, humanDelay(300, 500));
      await humanWait(page, 600, 1200);
    } catch (err) {
      console.log(`  Post ${shared + 1}: error - ${err.message}`);
      await page.keyboard.press('Escape').catch(() => {});
      usedKeys.add(key);
      attempts++;
      await humanWait(page, 400, 700);
    }
  }

  console.log(`  Share complete: ${shared}/${targetCount} posts shared`);

  if (shared > 0 && userId) await setOnboarding(userId, 'lastSharedAt');
};
