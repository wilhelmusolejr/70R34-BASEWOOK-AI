/**
 * setup_page - Create a Facebook page by filling the page form and submitting it.
 *
 * Params:
 *   pageName        {string} - Page name to create
 *   bio             {string} - Page bio/description
 *   categoryKeyword {string} - Optional category keyword, defaults to first word of pageName
 *   createUrl       {string} - Optional create-page URL
 */

const https = require('https');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { humanWait, humanClick, humanType } = require('../utils/humanBehavior');
const { parseCityState, buildPageAddress } = require('../utils/pageAddressData');

async function stepWait(page) {
  await humanWait(page, 3000, 5000);
}

function downloadToTemp(url, prefix) {
  return new Promise((resolve, reject) => {
    const ext = path.extname(new URL(url).pathname) || '.jpg';
    const tmpPath = path.join(os.tmpdir(), `${prefix}_${Date.now()}${ext}`);
    const file = fs.createWriteStream(tmpPath);
    const client = url.startsWith('https') ? https : http;

    client.get(url, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`Download failed: HTTP ${res.statusCode}`));
        return;
      }
      res.pipe(file);
      file.on('finish', () => file.close(() => resolve(tmpPath)));
    }).on('error', (err) => {
      fs.unlink(tmpPath, () => {});
      reject(err);
    });
  });
}

function getCategoryKeyword(pageName, categoryKeyword) {
  if (categoryKeyword && categoryKeyword.trim()) return categoryKeyword.trim();

  const firstWord = String(pageName || '')
    .trim()
    .split(/\s+/)
    .find(Boolean);

  if (!firstWord) return '';
  return firstWord.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '') || firstWord;
}

async function clickAndReplace(page, locator, value) {
  await locator.scrollIntoViewIfNeeded();
  const box = await locator.boundingBox();
  if (!box) throw new Error('Element has no bounding box');

  await humanClick(page, box);
  await stepWait(page);
  await page.keyboard.press('Control+a');
  await stepWait(page);
  await page.keyboard.press('Delete');
  await stepWait(page);
  await humanType(page, value);
}

async function typeAndSelect(page, locator, value) {
  if (!value) return;
  await clickAndReplace(page, locator, value);
  await stepWait(page);
  await page.keyboard.press('ArrowDown');
  await stepWait(page);
  await page.keyboard.press('Enter');
}

async function getFirstVisibleLocator(locator, errorMessage, timeout = 15000) {
  const start = Date.now();

  while (Date.now() - start < timeout) {
    const count = await locator.count();

    for (let i = 0; i < count; i++) {
      const candidate = locator.nth(i);
      const isVisible = await candidate.isVisible().catch(() => false);
      if (isVisible) return candidate;
    }

    await new Promise(resolve => setTimeout(resolve, 250));
  }

  throw new Error(errorMessage);
}

async function clickLocator(page, locator, errorMessage) {
  const visibleLocator = await getFirstVisibleLocator(locator, errorMessage);
  await visibleLocator.scrollIntoViewIfNeeded();
  const box = await visibleLocator.boundingBox();
  if (!box) throw new Error(errorMessage);

  await humanClick(page, box);
  await stepWait(page);
}

async function uploadImageFromButton(page, buttonLocator, tempPath, label) {
  const button = await getFirstVisibleLocator(buttonLocator, `setup_page: ${label} button has no visible match`);
  await button.scrollIntoViewIfNeeded();

  const [fileChooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    button.click(),
  ]);
  await fileChooser.setFiles(tempPath);
}

function getScheduleDate(dayOffset) {
  const d = new Date();
  d.setDate(d.getDate() + dayOffset);
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${months[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}

async function waitForCreateDialog(page) {
  const dialog = page.locator('xpath=//div[@role="dialog"][.//h2[contains(., "Create")]]').first();
  await dialog.waitFor({ state: 'visible', timeout: 15000 });
  await stepWait(page);
  return dialog;
}

module.exports = async function setup_page(page, params) {
  const {
    pageName,
    bio = '',
    email = '',
    streetAddress = '',
    city = '',
    state = '',
    zipCode = '',
    profilePhotoUrl = '',
    coverPhotoUrl = '',
    categoryKeyword = '',
    createUrl = 'https://www.facebook.com/pages/create',
    posts = [],
    userName = '',
  } = params;

  if (!pageName) throw new Error('setup_page: pageName is required');

  const categoryText = getCategoryKeyword(pageName, categoryKeyword);
  if (!categoryText) throw new Error('setup_page: could not derive category keyword from pageName');
  const parsedCity = parseCityState(city);
  const address = buildPageAddress({ city, state, zipCode });
  const emailValue = String(email || '').trim();
  const streetValue = String(streetAddress || address.streetAddress || '').trim();
  const cityValue = parsedCity.cityName || address.cityName || '';
  let profileTempPath = '';
  let coverTempPath = '';

  try {
    if (profilePhotoUrl) {
      console.log('  [setup_page] Downloading page profile image...');
      profileTempPath = await downloadToTemp(profilePhotoUrl, 'page_profile');
    }

    if (coverPhotoUrl) {
      console.log('  [setup_page] Downloading page cover image...');
      coverTempPath = await downloadToTemp(coverPhotoUrl, 'page_cover');
    }

    console.log(`  [setup_page] Opening Facebook...`);
    await page.goto('https://www.facebook.com', { waitUntil: 'domcontentloaded' });
    await stepWait(page);

    console.log('  [setup_page] Opening Facebook menu...');
    await clickLocator(
      page,
      page.locator('div[aria-label="Facebook menu"]'),
      'setup_page: Facebook menu button has no bounding box'
    );

    console.log('  [setup_page] Opening Pages...');
    await clickLocator(
      page,
      page.locator('xpath=//a[@role="link"]//span[text()="Pages"]'),
      'setup_page: Pages link has no bounding box'
    );

    console.log('  [setup_page] Opening Create Page...');
    await clickLocator(
      page,
      page.locator('[aria-label="Create Page"]'),
      'setup_page: Create Page button has no bounding box'
    );

    console.log('  [setup_page] Waiting for create modal...');
    await waitForCreateDialog(page);

    console.log('  [setup_page] Selecting Public Page...');
    const publicPageOption = page.locator('label:has-text("Public Page")').first();
    const publicPageVisible = await publicPageOption.isVisible().catch(() => false);

    if (publicPageVisible) {
      await clickLocator(page, publicPageOption, 'setup_page: Public Page option has no bounding box');
    } else {
      await clickLocator(
        page,
        page.locator('xpath=//label[.//span[text()="Public Page"]]'),
        'setup_page: Public Page option has no bounding box'
      );
    }

    console.log('  [setup_page] Moving to next step...');
    await clickLocator(
      page,
      page.locator('div[aria-label="Next"]'),
      'setup_page: Next button has no bounding box'
    );

    console.log('  [setup_page] Opening page setup form...');
    await clickLocator(
      page,
      page.locator('a[aria-label="Get started"]'),
      'setup_page: Get started link has no bounding box'
    );

    const pageNameInput = page.locator('label:has-text("Page name (required)") input').first();
    await pageNameInput.waitFor({ state: 'visible', timeout: 15000 });
    console.log(`  [setup_page] Filling page name: ${pageName}`);
    await clickAndReplace(page, pageNameInput, pageName);
    await stepWait(page);

    const categoryInput = page.locator('input[aria-label="Category (required)"]').first();
    await categoryInput.waitFor({ state: 'visible', timeout: 15000 });
    console.log(`  [setup_page] Filling category from keyword: ${categoryText}`);
    await clickAndReplace(page, categoryInput, categoryText);
    await stepWait(page);
    await page.keyboard.press('ArrowDown');
    await stepWait(page);
    await page.keyboard.press('Enter');
    await stepWait(page);

    if (bio) {
      const bioInput = page.locator(`xpath=//span[contains(text(), "Bio")]/following::textarea[1]`).first();
      await bioInput.waitFor({ state: 'visible', timeout: 15000 });
      console.log('  [setup_page] Filling bio...');
      await clickAndReplace(page, bioInput, bio);
      await stepWait(page);
    }

    console.log('  [setup_page] Advancing to contact/location section...');
    await clickLocator(
      page,
      page.locator('div[aria-label="Create Page"][role="button"]'),
      'setup_page: Create Page (advance) button has no bounding box'
    );
    await stepWait(page);

    if (emailValue) {
      const emailInput = page.locator('label:has-text("Email") input').first();
      await emailInput.waitFor({ state: 'visible', timeout: 15000 });
      console.log(`  [setup_page] Filling email: ${emailValue}`);
      await clickAndReplace(page, emailInput, emailValue);
      await stepWait(page);
    }

    if (streetValue) {
      const addressInput = page.locator('label:has-text("Address") input').first();
      await addressInput.waitFor({ state: 'visible', timeout: 15000 });
      console.log(`  [setup_page] Filling street address: ${streetValue}`);
      await clickAndReplace(page, addressInput, streetValue);
      await stepWait(page);
    }

    if (cityValue) {
      const stateHalf = address.stateName
        ? address.stateName.slice(0, Math.ceil(address.stateName.length / 2))
        : '';
      const cityTypeText = stateHalf ? `${cityValue}, ${stateHalf}` : cityValue;
      const cityInput = page.locator('input[aria-label="City/town"]').first();
      await cityInput.waitFor({ state: 'visible', timeout: 15000 });
      console.log(`  [setup_page] Filling city/town: ${cityTypeText}`);
      await typeAndSelect(page, cityInput, cityTypeText);
      await stepWait(page);
    }

    if (address.zipCode) {
      const zipInput = page.locator('label:has-text("ZIP code") input').first();
      await zipInput.waitFor({ state: 'visible', timeout: 15000 });
      console.log(`  [setup_page] Filling ZIP code: ${address.zipCode}`);
      await clickAndReplace(page, zipInput, address.zipCode);
      await stepWait(page);
    }

    const hoursOptions = [
      'input[type="radio"][value="NO_HOURS_AVAILABLE"]',
      'input[type="radio"][value="ALWAYS_OPEN"]',
    ];
    const chosenHoursSelector = hoursOptions[Math.floor(Math.random() * hoursOptions.length)];
    console.log(`  [setup_page] Selecting hours option: ${chosenHoursSelector}`);
    await clickLocator(
      page,
      page.locator(chosenHoursSelector),
      'setup_page: Hours option has no visible match'
    );
    await stepWait(page);

    console.log('  [setup_page] Moving to next page section...');
    await clickLocator(
      page,
      page.locator('[aria-label="Next"]'),
      'setup_page: Next button has no visible match'
    );
    await stepWait(page);

    if (profileTempPath) {
      console.log('  [setup_page] Uploading page profile picture...');
      await uploadImageFromButton(
        page,
        page.locator('div[role="button"]:has-text("Add profile picture")'),
        profileTempPath,
        'Add profile picture'
      );
      await stepWait(page);
    }

    if (coverTempPath) {
      console.log('  [setup_page] Uploading page cover photo...');
      await uploadImageFromButton(
        page,
        page.locator('div[role="button"]:has-text("Add cover photo")'),
        coverTempPath,
        'Add cover photo'
      );
      await stepWait(page);
    }

    if (profileTempPath || coverTempPath) {
      console.log('  [setup_page] Waiting 30s for page images to finish processing...');
      await page.waitForTimeout(30000);
    }

    // Step 2 → Next
    console.log('  [setup_page] Step 2 → Next...');
    await clickLocator(
      page,
      page.locator('[aria-label="Next"]'),
      'setup_page: Step 2 Next button has no visible match'
    );
    await stepWait(page);

    // Step 3: Connect WhatsApp → Skip
    console.log('  [setup_page] Step 3 → Skip (WhatsApp)...');
    await clickLocator(
      page,
      page.locator('[aria-label="Skip"]'),
      'setup_page: Skip button has no visible match'
    );
    await stepWait(page);

    // Step 4: Build Page audience → Next
    console.log('  [setup_page] Step 4 → Next (Build audience)...');
    await clickLocator(
      page,
      page.locator('[aria-label="Next"]'),
      'setup_page: Step 4 Next button has no visible match'
    );
    await stepWait(page);

    // Step 5: Stay informed → Done
    console.log('  [setup_page] Step 5 → Done...');
    await clickLocator(
      page,
      page.locator('[aria-label="Done"]'),
      'setup_page: Done button has no visible match'
    );
    await stepWait(page);

    // Confirm page was created — URL should change to /profile.php?id=*
    console.log('  [setup_page] Waiting for page creation URL confirmation...');
    try {
      await page.waitForURL('**/profile.php?id=**', { timeout: 30000 });
      console.log('  [setup_page] Page creation confirmed — URL changed to page profile.');
    } catch {
      console.warn('  [setup_page] URL did not change to profile.php within 30s — page may still be loading.');
    }

    // Dismiss cookies popup if it appears after page creation
    try {
      const cookiesBtn = page.locator('div[aria-label="Allow all cookies"]').first();
      await cookiesBtn.waitFor({ state: 'visible', timeout: 5000 });
      console.log('  [setup_page] Cookies popup detected — dismissing...');
      await humanClick(page, await cookiesBtn.boundingBox());
      await stepWait(page);
    } catch {
      // no cookies popup — continue
    }

    // ── Post scheduling (best-effort, never rethrows to avoid duplicate page creation) ──

    if (posts.length) {
      async function dismissNotNow() {
        let dismissed = false;
        while (true) {
          try {
            const notNow = page.locator('[aria-label="Not now"]').first();
            await notNow.waitFor({ state: 'visible', timeout: 4000 });
            console.log('  [setup_page] "Not now" modal detected — dismissing...');
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
            console.log(`  [setup_page] "Not now" found (attempt ${attempt}/3) — dismissing...`);
            await humanClick(page, await notNow.boundingBox());
            break;
          } catch {
            console.log(`  [setup_page] "Not now" not found (attempt ${attempt}/3)`);
          }
        }
        const pauseMs = 30000 + Math.random() * 30000;
        console.log(`  [setup_page] Waiting ${(pauseMs / 1000).toFixed(1)}s before next post...`);
        await page.waitForTimeout(pauseMs);
      }

      async function schedulePost(content, dayOffset) {
        const scheduleDate = getScheduleDate(dayOffset);
        console.log(`  [setup_page] Scheduling post (day +${dayOffset}, date: ${scheduleDate}): "${content.slice(0, 40)}..."`);

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

        await clickLocator(page, page.locator('[aria-label="Next"]'), 'setup_page: Post Next button not found');
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

        await handleAfterSchedule();
      }

      // Retry up to 3 times with page reload on each failure. Never throws.
      async function schedulePostWithRetry(content, dayOffset) {
        const MAX_ATTEMPTS = 3;
        for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
          try {
            await dismissNotNow();
            await schedulePost(content, dayOffset);
            return;
          } catch (err) {
            console.warn(`  [setup_page] Post ${dayOffset} attempt ${attempt}/${MAX_ATTEMPTS} failed: ${err.message}`);
            if (attempt < MAX_ATTEMPTS) {
              console.log('  [setup_page] Reloading page before retry...');
              await page.reload({ waitUntil: 'domcontentloaded' });
              await humanWait(page, 3000, 5000);
            } else {
              console.warn(`  [setup_page] Post ${dayOffset} failed after ${MAX_ATTEMPTS} attempts — skipping.`);
            }
          }
        }
      }

      try {
        console.log(`  [setup_page] Scheduling ${posts.length} post(s)...`);
        for (let i = 0; i < posts.length; i++) {
          await schedulePostWithRetry(posts[i].post, i + 1);
          console.log(`  [setup_page] Post ${i + 1}/${posts.length} processed.`);
        }
        console.log('  [setup_page] All posts processed.');
      } catch (postsErr) {
        console.warn('  [setup_page] Posts loop error:', postsErr.message);
      }
    }

    // ── Wrap-up: always switch back to personal profile ──
    try {
      console.log('  [setup_page] Clicking Your profile...');
      const profileBtn = page.locator('[aria-label="Your profile"]').first();
      await profileBtn.waitFor({ state: 'visible', timeout: 15000 });
      await humanClick(page, await profileBtn.boundingBox());
      await stepWait(page);

      let switchBtn = page.locator(`[aria-label="Switch to ${userName}"]`).first();
      const switchVisible = await switchBtn.isVisible().catch(() => false);
      if (!switchVisible) {
        console.log(`  [setup_page] "Switch to ${userName}" not found — trying Quick switch profiles...`);
        switchBtn = page.locator('[aria-label="Quick switch profiles"]').first();
      }
      console.log(`  [setup_page] Switching back to: ${userName}`);
      await switchBtn.waitFor({ state: 'visible', timeout: 15000 });
      await humanClick(page, await switchBtn.boundingBox());
      await stepWait(page);

      console.log('  [setup_page] Cooling down 50s...');
      await page.waitForTimeout(50000);
    } catch (wrapupErr) {
      console.warn('  [setup_page] Wrap-up failed:', wrapupErr.message);
    }

  } finally {
    if (profileTempPath) fs.unlink(profileTempPath, () => {});
    if (coverTempPath) fs.unlink(coverTempPath, () => {});
  }
};
