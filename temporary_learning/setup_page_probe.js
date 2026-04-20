require('dotenv').config();

function getScheduleDate(dayOffset) {
  const d = new Date();
  d.setDate(d.getDate() + dayOffset);
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${months[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}

module.exports = async function setupPageProbe(page, helpers) {
  const { user, humanWait, humanClick, humanType } = helpers;

  async function stepWait() {
    await humanWait(page, 2000, 4000);
  }

  async function dismissNotNow() {
    let dismissed = false;
    // loop in case multiple "Not now" modals appear back to back
    while (true) {
      try {
        const notNow = page.locator('[aria-label="Not now"]').first();
        await notNow.waitFor({ state: 'visible', timeout: 4000 });
        console.log('[probe] "Not now" modal detected — dismissing...');
        await humanClick(page, await notNow.boundingBox());
        await humanWait(page, 5000, 8000);
        dismissed = true;
      } catch {
        break;
      }
    }
    return dismissed;
  }

  async function handleAfterSchedule() {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const notNow = page.locator('[aria-label="Not now"]').first();
        await notNow.waitFor({ state: 'visible', timeout: 5000 });
        console.log(`[probe] "Not now" found (attempt ${attempt}/3) — dismissing...`);
        await humanClick(page, await notNow.boundingBox());
        break;
      } catch {
        console.log(`[probe] "Not now" not found (attempt ${attempt}/3)`);
      }
    }
    const pauseMs = 30000 + Math.random() * 30000;
    console.log(`[probe] Waiting ${(pauseMs / 1000).toFixed(1)}s before next post...`);
    await page.waitForTimeout(pauseMs);
  }

  async function schedulePost(content, dayOffset) {
    const scheduleDate = getScheduleDate(dayOffset);
    console.log(`[probe] Scheduling post (day +${dayOffset}, date: ${scheduleDate}): "${content.slice(0, 40)}..."`);

    // 1. Click "What's on your mind?"
    const whatInput = page.locator('div[role="button"]:has-text("What\'s on your mind?")').first();
    await whatInput.waitFor({ state: 'visible', timeout: 15000 });
    await humanClick(page, await whatInput.boundingBox());
    await stepWait();

    // dismiss any modal that may appear between click and dialog load
    await dismissNotNow();

    // 2. Wait for create post modal
    await page.locator('div[role="dialog"][aria-label="Create post"]').first().waitFor({ state: 'visible', timeout: 15000 });
    await stepWait();

    // 3. Type into Lexical editor
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
    await stepWait();

    // 4. Click Next
    const nextBtn = page.locator('[aria-label="Next"]').first();
    await nextBtn.waitFor({ state: 'visible', timeout: 10000 });
    await humanClick(page, await nextBtn.boundingBox());
    await stepWait();

    // 5. Click Scheduling options
    const schedOpt = page.locator('xpath=//span[contains(text(), "Scheduling options")]').first();
    await schedOpt.waitFor({ state: 'visible', timeout: 10000 });
    await humanClick(page, await schedOpt.boundingBox());
    await stepWait();

    // 6. Wait for Schedule for later to appear
    await page.locator('div[role="button"]:has-text("Schedule for later")').waitFor({ state: 'visible', timeout: 10000 });
    await stepWait();

    // 7. Fill date input
    const dateInput = page.locator('div:has(span[aria-label="Open Date Picker"]) input[type="text"]').first();
    await dateInput.waitFor({ state: 'visible', timeout: 10000 });
    await dateInput.scrollIntoViewIfNeeded();
    await humanClick(page, await dateInput.boundingBox());
    await page.keyboard.press('Control+a');
    await humanType(page, scheduleDate);
    await stepWait();

    // 8. Tab 4 times then click Schedule for later
    for (let i = 0; i < 4; i++) {
      await page.keyboard.press('Tab');
      await page.waitForTimeout(1000);
    }
    const schedLater = page.locator('div[role="button"][aria-label="Schedule for later"]').first();
    await schedLater.waitFor({ state: 'visible', timeout: 10000 });
    await humanClick(page, await schedLater.boundingBox());
    await stepWait();

    // 9. Click Schedule
    const schedBtn = page.locator('[aria-label="Schedule"]').first();
    await schedBtn.waitFor({ state: 'visible', timeout: 10000 });
    await humanClick(page, await schedBtn.boundingBox());
    await stepWait();

    // handle "Not now" modal (up to 3 checks) then wait 30-60s
    await handleAfterSchedule();
  }

  async function schedulePostWithRetry(content, dayOffset) {
    await dismissNotNow();
    try {
      await schedulePost(content, dayOffset);
    } catch (err) {
      const dismissed = await dismissNotNow();
      if (dismissed) {
        console.log('[probe] Waiting 30s before retrying...');
        await page.waitForTimeout(30000);
        console.log('[probe] Retrying...');
        await schedulePost(content, dayOffset);
      } else {
        throw err;
      }
    }
  }

  const posts = Array.isArray(user.linkedPage?.posts) ? user.linkedPage.posts : [];
  if (!posts.length) {
    console.log('[probe] No posts found in user.linkedPage.posts — nothing to schedule.');
    return;
  }

  console.log(`[probe] Found ${posts.length} post(s) to schedule.`);

  for (let i = 0; i < posts.length; i++) {
    const content = posts[i].post;
    const dayOffset = i + 1; // post 0 = today+1, post 1 = today+2, etc.
    await schedulePostWithRetry(content, dayOffset);
    console.log(`[probe] Post ${i + 1}/${posts.length} scheduled.`);
  }

  console.log('[probe] All posts scheduled successfully.');
};
