/**
 * schedule_posts - Leaf action.
 * Schedules posts on the currently loaded Facebook Page — one post per day starting
 * tomorrow. Assumes the browser is already on a Page profile (use as a child of
 * create_page, or run on a Page the account already owns).
 *
 * Errors in individual posts are logged, not rethrown, so a single failure doesn't
 * kill the rest of the loop.
 */

const { humanWait, humanClick, humanType } = require('../utils/humanBehavior');
const { stepWait, clickLocator } = require('../utils/pageSetupHelpers');

function getScheduleDate(dayOffset) {
  const d = new Date();
  d.setDate(d.getDate() + dayOffset);
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${months[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}

module.exports = async function schedule_posts(page, params) {
  const { posts = [] } = params;

  if (!Array.isArray(posts) || posts.length === 0) {
    console.log('  [schedule_posts] No posts provided — skipping.');
    return;
  }

  async function dismissNotNow() {
    while (true) {
      try {
        const notNow = page.locator('[aria-label="Not now"]').first();
        await notNow.waitFor({ state: 'visible', timeout: 4000 });
        console.log('  [schedule_posts] "Not now" modal detected — dismissing...');
        await humanClick(page, await notNow.boundingBox());
        await humanWait(page, 5000, 8000);
      } catch {
        break;
      }
    }
  }

  async function handleAfterSchedule() {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const notNow = page.locator('[aria-label="Not now"]').first();
        await notNow.waitFor({ state: 'visible', timeout: 5000 });
        console.log(`  [schedule_posts] "Not now" found (attempt ${attempt}/3) — dismissing...`);
        await humanClick(page, await notNow.boundingBox());
        break;
      } catch {
        console.log(`  [schedule_posts] "Not now" not found (attempt ${attempt}/3)`);
      }
    }
    const pauseMs = 30000 + Math.random() * 30000;
    console.log(`  [schedule_posts] Waiting ${(pauseMs / 1000).toFixed(1)}s before next post...`);
    await page.waitForTimeout(pauseMs);
  }

  async function schedulePost(content, dayOffset) {
    const scheduleDate = getScheduleDate(dayOffset);
    console.log(`  [schedule_posts] Scheduling post (day +${dayOffset}, date: ${scheduleDate}): "${content.slice(0, 40)}..."`);

    const whatInput = page.locator('div[role="button"]:has-text("What\'s on your mind?")').first();
    await whatInput.waitFor({ state: 'visible', timeout: 15000 });
    await humanClick(page, await whatInput.boundingBox());
    await stepWait(page);

    await dismissNotNow();

    await page.locator('div[role="dialog"][aria-label="Create post"]').first().waitFor({ state: 'visible', timeout: 15000 });
    await stepWait(page);

    const textbox = page.locator('div[role="textbox"][data-lexical-editor="true"]').first();
    await textbox.waitFor({ state: 'visible', timeout: 10000 });
    await page.locator('span:has-text("Create post")').first().click();
    await page.waitForTimeout(1000);
    await page.keyboard.press('Tab');
    await page.waitForTimeout(1000);
    await page.keyboard.press('Tab');
    await page.waitForTimeout(1000);
    await page.keyboard.press('Tab');
    await page.waitForTimeout(1000);
    await page.keyboard.type(content, { delay: 80 });
    await stepWait(page);

    await page.locator('span:has-text("Create post")').first().click();
    await stepWait(page);

    await clickLocator(page, page.locator('[aria-label="Next"]'), 'schedule_posts: Post Next button not found');
    await stepWait(page);

    const schedOpt = page.locator('xpath=//span[contains(text(), "Scheduling options")]').first();
    await schedOpt.waitFor({ state: 'visible', timeout: 10000 });
    await humanClick(page, await schedOpt.boundingBox());
    await stepWait(page);

    await page.locator('div[role="button"]:has-text("Schedule for later")').waitFor({ state: 'visible', timeout: 10000 });
    await stepWait(page);

    const dateInput = page.locator('div:has(span[aria-label="Open Date Picker"]) input[type="text"]').first();
    await dateInput.waitFor({ state: 'visible', timeout: 10000 });
    await dateInput.scrollIntoViewIfNeeded();
    await humanClick(page, await dateInput.boundingBox());
    await page.keyboard.press('Control+a');
    await humanType(page, scheduleDate);
    await stepWait(page);

    for (let i = 0; i < 4; i++) {
      await page.keyboard.press('Tab');
      await page.waitForTimeout(1000);
    }

    const schedLater = page.locator('div[role="button"][aria-label="Schedule for later"]').first();
    await schedLater.waitFor({ state: 'visible', timeout: 10000 });
    await humanClick(page, await schedLater.boundingBox());
    await stepWait(page);

    const schedBtn = page.locator('[aria-label="Schedule"]').first();
    await schedBtn.waitFor({ state: 'visible', timeout: 10000 });
    await humanClick(page, await schedBtn.boundingBox());
    await stepWait(page);

    try {
      const confirmBtn = page.locator('div[role="button"]:has-text("Publish Original Post")').first();
      await confirmBtn.waitFor({ state: 'visible', timeout: 5000 });
      console.log('  [schedule_posts] Post-schedule confirmation modal detected — clicking...');
      await humanClick(page, await confirmBtn.boundingBox());
      await stepWait(page);
    } catch {
      // no confirmation modal — continue
    }

    await handleAfterSchedule();
  }

  async function schedulePostWithRetry(content, dayOffset) {
    const MAX_ATTEMPTS = 3;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        await dismissNotNow();
        await schedulePost(content, dayOffset);
        return;
      } catch (err) {
        console.warn(`  [schedule_posts] Post ${dayOffset} attempt ${attempt}/${MAX_ATTEMPTS} failed: ${err.message}`);
        if (attempt < MAX_ATTEMPTS) {
          console.log('  [schedule_posts] Reloading page before retry...');
          await page.reload({ waitUntil: 'domcontentloaded' });
          await humanWait(page, 3000, 5000);
        } else {
          console.warn(`  [schedule_posts] Post ${dayOffset} failed after ${MAX_ATTEMPTS} attempts — skipping.`);
        }
      }
    }
  }

  console.log(`  [schedule_posts] Scheduling ${posts.length} post(s)...`);
  for (let i = 0; i < posts.length; i++) {
    await schedulePostWithRetry(posts[i].post, i + 1);
    console.log(`  [schedule_posts] Post ${i + 1}/${posts.length} processed.`);
  }
  console.log('  [schedule_posts] All posts processed.');
};
