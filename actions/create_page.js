/**
 * create_page - Navigator action.
 * Creates a Facebook Page: fills form fields, uploads profile + cover, advances through
 * Steps 2-5, and lands on the new Page URL (facebook.com/profile.php?id=*).
 *
 * Child steps (e.g. schedule_posts, switch_profile) run on the newly created page.
 */

const fs = require('fs');
const { humanClick } = require('../utils/humanBehavior');
const { parseCityState, buildPageAddress } = require('../utils/pageAddressData');
const {
  stepWait,
  downloadToTemp,
  clickAndReplace,
  typeAndSelect,
  clickLocator,
  uploadImageFromButton,
} = require('../utils/pageSetupHelpers');

function getCategoryKeyword(pageName, categoryKeyword) {
  if (categoryKeyword && categoryKeyword.trim()) return categoryKeyword.trim();

  const firstWord = String(pageName || '')
    .trim()
    .split(/\s+/)
    .find(Boolean);

  if (!firstWord) return '';
  return firstWord.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '') || firstWord;
}

async function waitForCreateDialog(page) {
  const dialog = page.locator('xpath=//div[@role="dialog"][.//h2[contains(., "Create")]]').first();
  await dialog.waitFor({ state: 'visible', timeout: 15000 });
  await stepWait(page);
  return dialog;
}

module.exports = async function create_page(page, params) {
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
  } = params;

  if (!pageName) throw new Error('create_page: pageName is required');

  const categoryText = getCategoryKeyword(pageName, categoryKeyword);
  if (!categoryText) throw new Error('create_page: could not derive category keyword from pageName');
  const parsedCity = parseCityState(city);
  const address = buildPageAddress({ city, state, zipCode });
  const emailValue = String(email || '').trim();
  const streetValue = String(streetAddress || address.streetAddress || '').trim();
  const cityValue = parsedCity.cityName || address.cityName || '';

  console.log('  [create_page] Resolved address fields:');
  console.log(`    email       : ${emailValue || '(empty)'}`);
  console.log(`    street      : ${streetValue || '(empty)'}`);
  console.log(`    city        : ${cityValue || '(empty)'}`);
  console.log(`    state       : ${address.stateName || '(empty)'}`);
  console.log(`    zip         : ${address.zipCode || '(empty)'}`);

  let profileTempPath = '';
  let coverTempPath = '';

  try {
    if (profilePhotoUrl) {
      console.log('  [create_page] Downloading page profile image...');
      profileTempPath = await downloadToTemp(profilePhotoUrl, 'page_profile');
    }

    if (coverPhotoUrl) {
      console.log('  [create_page] Downloading page cover image...');
      coverTempPath = await downloadToTemp(coverPhotoUrl, 'page_cover');
    }

    console.log('  [create_page] Opening Facebook...');
    await page.goto('https://www.facebook.com', { waitUntil: 'domcontentloaded' });
    await stepWait(page);

    console.log('  [create_page] Opening Facebook menu...');
    await clickLocator(
      page,
      page.locator('div[aria-label="Facebook menu"]'),
      'create_page: Facebook menu button has no bounding box'
    );

    console.log('  [create_page] Opening Pages...');
    await clickLocator(
      page,
      page.locator('xpath=//a[@role="link"]//span[text()="Pages"]'),
      'create_page: Pages link has no bounding box'
    );

    console.log('  [create_page] Opening Create Page...');
    await clickLocator(
      page,
      page.locator('[aria-label="Create Page"]'),
      'create_page: Create Page button has no bounding box'
    );

    console.log('  [create_page] Waiting for create modal...');
    await waitForCreateDialog(page);

    console.log('  [create_page] Selecting Public Page...');
    const publicPageOption = page.locator('label:has-text("Public Page")').first();
    const publicPageVisible = await publicPageOption.isVisible().catch(() => false);

    if (publicPageVisible) {
      await clickLocator(page, publicPageOption, 'create_page: Public Page option has no bounding box');
    } else {
      await clickLocator(
        page,
        page.locator('xpath=//label[.//span[text()="Public Page"]]'),
        'create_page: Public Page option has no bounding box'
      );
    }

    console.log('  [create_page] Moving to next step...');
    await clickLocator(
      page,
      page.locator('div[aria-label="Next"]'),
      'create_page: Next button has no bounding box'
    );

    console.log('  [create_page] Opening page setup form...');
    await clickLocator(
      page,
      page.locator('a[aria-label="Get started"]'),
      'create_page: Get started link has no bounding box'
    );

    const pageNameInput = page.locator('label:has-text("Page name (required)") input').first();
    await pageNameInput.waitFor({ state: 'visible', timeout: 15000 });
    console.log(`  [create_page] Filling page name: ${pageName}`);
    await clickAndReplace(page, pageNameInput, pageName);
    await stepWait(page);

    const categoryInput = page.locator('input[aria-label="Category (required)"]').first();
    await categoryInput.waitFor({ state: 'visible', timeout: 15000 });
    console.log(`  [create_page] Filling category from keyword: ${categoryText}`);
    await clickAndReplace(page, categoryInput, categoryText);
    await stepWait(page);
    await page.keyboard.press('ArrowDown');
    await stepWait(page);
    await page.keyboard.press('Enter');
    await stepWait(page);

    if (bio) {
      const bioInput = page.locator(`xpath=//span[contains(text(), "Bio")]/following::textarea[1]`).first();
      await bioInput.waitFor({ state: 'visible', timeout: 15000 });
      console.log('  [create_page] Filling bio...');
      await clickAndReplace(page, bioInput, bio);
      await stepWait(page);
    }

    console.log('  [create_page] Advancing to contact/location section...');
    await clickLocator(
      page,
      page.locator('div[aria-label="Create Page"][role="button"]'),
      'create_page: Create Page (advance) button has no bounding box'
    );
    await stepWait(page);

    if (emailValue) {
      const emailInput = page.locator('label:has-text("Email") input').first();
      await emailInput.waitFor({ state: 'visible', timeout: 15000 });
      console.log(`  [create_page] Filling email: ${emailValue}`);
      await clickAndReplace(page, emailInput, emailValue);
      await stepWait(page);
    }

    if (streetValue) {
      const addressInput = page.locator('label:has-text("Address") input').first();
      await addressInput.waitFor({ state: 'visible', timeout: 15000 });
      console.log(`  [create_page] Filling street address: ${streetValue}`);
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
      console.log(`  [create_page] Filling city/town: ${cityTypeText}`);
      await typeAndSelect(page, cityInput, cityTypeText);
      await stepWait(page);
    }

    if (address.zipCode) {
      const zipInput = page.locator('label:has-text("ZIP code") input').first();
      await zipInput.waitFor({ state: 'visible', timeout: 15000 });
      console.log(`  [create_page] Filling ZIP code: ${address.zipCode}`);
      await clickAndReplace(page, zipInput, address.zipCode);
      await stepWait(page);
    }

    const hoursOptions = [
      'input[type="radio"][value="NO_HOURS_AVAILABLE"]',
      'input[type="radio"][value="ALWAYS_OPEN"]',
    ];
    const chosenHoursSelector = hoursOptions[Math.floor(Math.random() * hoursOptions.length)];
    console.log(`  [create_page] Selecting hours option: ${chosenHoursSelector}`);
    await clickLocator(
      page,
      page.locator(chosenHoursSelector),
      'create_page: Hours option has no visible match'
    );
    await stepWait(page);

    console.log('  [create_page] Moving to next page section...');
    await clickLocator(
      page,
      page.locator('[aria-label="Next"]'),
      'create_page: Next button has no visible match'
    );
    await stepWait(page);

    if (profileTempPath) {
      console.log('  [create_page] Uploading page profile picture...');
      await uploadImageFromButton(
        page,
        page.locator('div[role="button"]:has-text("Add profile picture")'),
        profileTempPath,
        'Add profile picture'
      );
      await stepWait(page);
    }

    if (coverTempPath) {
      console.log('  [create_page] Uploading page cover photo...');
      await uploadImageFromButton(
        page,
        page.locator('div[role="button"]:has-text("Add cover photo")'),
        coverTempPath,
        'Add cover photo'
      );
      await stepWait(page);
    }

    if (profileTempPath || coverTempPath) {
      console.log('  [create_page] Waiting 30s for page images to finish processing...');
      await page.waitForTimeout(30000);
    }

    console.log('  [create_page] Step 2 → Next...');
    await clickLocator(
      page,
      page.locator('[aria-label="Next"]'),
      'create_page: Step 2 Next button has no visible match'
    );
    await stepWait(page);

    console.log('  [create_page] Step 3 → Skip (WhatsApp)...');
    await clickLocator(
      page,
      page.locator('[aria-label="Skip"]'),
      'create_page: Skip button has no visible match'
    );
    await stepWait(page);

    console.log('  [create_page] Step 4 → Next (Build audience)...');
    await clickLocator(
      page,
      page.locator('[aria-label="Next"]'),
      'create_page: Step 4 Next button has no visible match'
    );
    await stepWait(page);

    console.log('  [create_page] Step 5 → Done...');
    await clickLocator(
      page,
      page.locator('[aria-label="Done"]'),
      'create_page: Done button has no visible match'
    );
    await stepWait(page);

    console.log('  [create_page] Waiting for page creation URL confirmation...');
    try {
      await page.waitForURL('**/profile.php?id=**', { timeout: 30000 });
      console.log('  [create_page] Page creation confirmed — URL changed to page profile.');
    } catch {
      console.warn('  [create_page] URL did not change to profile.php within 30s — page may still be loading.');
    }

    try {
      const cookiesBtn = page.locator('div[aria-label="Allow all cookies"]').first();
      await cookiesBtn.waitFor({ state: 'visible', timeout: 5000 });
      console.log('  [create_page] Cookies popup detected — dismissing...');
      await humanClick(page, await cookiesBtn.boundingBox());
      await stepWait(page);
    } catch {
      // no cookies popup — continue
    }
  } finally {
    if (profileTempPath) fs.unlink(profileTempPath, () => {});
    if (coverTempPath) fs.unlink(coverTempPath, () => {});
  }
};
