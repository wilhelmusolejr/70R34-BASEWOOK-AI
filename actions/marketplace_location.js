/**
 * marketplace_location — Leaf action.
 * Opens Facebook Marketplace and checks if the location matches the user's
 * assigned city/country. If it doesn't (e.g. still showing the old signup
 * location), updates it. If it already matches, skips.
 *
 * Self-navigates to facebook.com/marketplace/.
 */

const fs = require('fs');
const path = require('path');
const { humanClick, humanWait, humanType } = require('../utils/humanBehavior');
const { getProfileLogDir } = require('../utils/sessionLog');

async function dumpFailure(page, label) {
  try {
    if (!page) return;
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const safeLabel = String(label || 'failure').replace(/[^a-z0-9_-]+/gi, '_');
    const profileDir = getProfileLogDir();
    const targetDir = profileDir || path.join(process.cwd(), 'logs');
    try {
      if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
    } catch (_) {}

    const baseName = `marketplace_location-${safeLabel}-${ts}`;
    const htmlPath = path.join(targetDir, `${baseName}.html`);
    const pngPath = path.join(targetDir, `${baseName}.png`);

    let url = '(unknown)';
    try {
      url = page.url();
    } catch (_) {}

    try {
      const html = await page.content();
      fs.writeFileSync(htmlPath, `<!-- url: ${url} -->\n${html}`, 'utf8');
      console.warn(`  [marketplace_location] dumped HTML → ${htmlPath}`);
    } catch (err) {
      console.warn(`  [marketplace_location] HTML dump failed: ${err.message}`);
    }

    try {
      await page.screenshot({ path: pngPath, fullPage: true });
      console.warn(`  [marketplace_location] dumped screenshot → ${pngPath}`);
    } catch (err) {
      console.warn(`  [marketplace_location] screenshot failed: ${err.message}`);
    }
  } catch (err) {
    console.warn(`  [marketplace_location] dumpFailure swallowed: ${err.message}`);
  }
}

async function isErrorPage(page) {
  const errorText = page.locator('text="Sorry, something went wrong"').first();
  return errorText.isVisible({ timeout: 2000 }).catch(() => false);
}

async function tryReloadErrorPage(page) {
  const reloadBtn = page
    .locator('xpath=//div[@role="button"][.//span[text()="Reload Page"]]')
    .first();
  if (await reloadBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
    console.log('  [marketplace_location] clicking Reload Page...');
    const box = await reloadBtn.boundingBox();
    if (box) {
      await humanClick(page, box);
      await humanWait(page, 4000, 6000);
      return !(await isErrorPage(page));
    }
  }
  return false;
}

async function navigateToMarketplace(page) {
  // Already on Marketplace?
  if (page.url().includes('marketplace') && !(await isErrorPage(page))) return;

  // Make sure we're on Facebook home first
  if (!page.url().includes('facebook.com') || page.url().includes('marketplace')) {
    await page.goto('https://www.facebook.com', { waitUntil: 'domcontentloaded' });
    await humanWait(page, 2000, 4000);
  }

  // Strategy 1: click the Marketplace link in the left sidebar
  const sidebarLink = page
    .locator('xpath=//a[@role="link"][.//span[text()="Marketplace"]]')
    .first();
  if (await sidebarLink.isVisible({ timeout: 5000 }).catch(() => false)) {
    console.log('  [marketplace_location] clicking Marketplace in sidebar...');
    const box = await sidebarLink.boundingBox();
    if (box) {
      await humanClick(page, box);
      await humanWait(page, 3000, 5000);
      if (page.url().includes('marketplace') && !(await isErrorPage(page))) return;
    }
  }

  // Strategy 2: direct navigation (most reliable — the sidebar/menu links
  // are inconsistent across account states and FB renders skeleton loaders
  // in the menu that time out before items appear)
  console.log('  [marketplace_location] navigating to /marketplace/ directly...');
  await page.goto('https://www.facebook.com/marketplace/', {
    waitUntil: 'domcontentloaded',
  });
  await humanWait(page, 3000, 5000);

  // Handle FB crash page — try reload once
  if (await isErrorPage(page)) {
    console.warn('  [marketplace_location] Marketplace crashed ("Sorry, something went wrong")');
    const recovered = await tryReloadErrorPage(page);
    if (!recovered) {
      const err = new Error(
        'marketplace_location: Marketplace unavailable for this account — FB shows error page'
      );
      err.noRetry = true;
      throw err;
    }
    console.log('  [marketplace_location] recovered after reload.');
  }
}

async function findLocationElement(page) {
  // Strategy 1: div with aria-label="Location: <city>, Within <N> km"
  // This is the clickable location element in the Marketplace left sidebar.
  const ariaLocation = page.locator('div[aria-label^="Location:"]').first();
  if (await ariaLocation.isVisible({ timeout: 5000 }).catch(() => false)) {
    return { el: ariaLocation, type: 'aria' };
  }

  // Strategy 2: the "Location" label's sibling — a link below the label text
  const labelSibling = page
    .locator(
      'xpath=//span[text()="Location"]/ancestor::div[1]/following-sibling::div//a[@role="link"]'
    )
    .first();
  if (await labelSibling.isVisible({ timeout: 3000 }).catch(() => false)) {
    return { el: labelSibling, type: 'link' };
  }

  // Strategy 3: any clickable element containing the km/mi distance text
  const distanceEl = page
    .locator(
      'xpath=//span[contains(text(),"km") or contains(text(),"mi")]/ancestor::*[self::a or self::div[@role="button"] or self::div[@role="link"]][1]'
    )
    .first();
  if (await distanceEl.isVisible({ timeout: 3000 }).catch(() => false)) {
    return { el: distanceEl, type: 'distance' };
  }

  return null;
}

async function readCurrentLocationText(page) {
  // Strategy 1: read from the aria-label attribute (most reliable)
  // Format: "Location: Tiwi, Albay, Philippines, Within 65 km"
  const ariaEl = page.locator('div[aria-label^="Location:"]').first();
  if (await ariaEl.isVisible({ timeout: 5000 }).catch(() => false)) {
    const label = await ariaEl.getAttribute('aria-label').catch(() => '');
    if (label) return label.replace(/^Location:\s*/i, '').trim();
  }

  // Strategy 2: read innerText from the location area
  const textEl = page
    .locator('xpath=//span[contains(text(),"km") or contains(text(),"mi")]/..')
    .first();
  if (await textEl.isVisible({ timeout: 3000 }).catch(() => false)) {
    const text = await textEl.innerText().catch(() => '');
    if (text.trim()) return text.trim();
  }

  return '';
}

function locationMatches(currentText, city, country) {
  if (!currentText) return false;
  const lower = currentText.toLowerCase();

  // Check city name (first part before comma)
  if (city) {
    const cityName = city.split(',')[0].trim().toLowerCase();
    if (cityName && lower.includes(cityName)) return true;
  }

  // Check country-specific keywords
  const countryLower = (country || '').toLowerCase();
  if (countryLower === 'it' || countryLower === 'italy' || countryLower === 'italia') {
    const italianCities = [
      'roma',
      'milano',
      'napoli',
      'torino',
      'firenze',
      'bologna',
      'palermo',
      'genova',
      'bari',
      'catania',
      'verona',
      'venezia',
      'padova',
      'brescia',
      'parma',
    ];
    if (italianCities.some((c) => lower.includes(c))) return true;
    if (lower.includes('italy') || lower.includes('italia')) return true;
  }

  if (countryLower === 'us' || countryLower === 'usa' || countryLower === 'united states') {
    if (city) {
      const parts = city.split(',').map((p) => p.trim().toLowerCase());
      if (parts.some((p) => p && lower.includes(p))) return true;
    }
  }

  return false;
}

const PH_KEYWORDS = [
  'philippines',
  'manila',
  'cebu',
  'davao',
  'quezon',
  'makati',
  'taguig',
  'pasig',
  'caloocan',
  'zamboanga',
  'antipolo',
  'tiwi',
  'albay',
  'legazpi',
  'iloilo',
  'bacolod',
  'cagayan',
  'butuan',
  'general santos',
  'lapu-lapu',
];

function looksLikePhilippines(text) {
  if (!text) return false;
  const lower = text.toLowerCase();
  return PH_KEYWORDS.some((kw) => lower.includes(kw));
}

async function readLocationInputValue(dialog) {
  const input = dialog.locator('input[aria-label="Location"][role="combobox"]').first();
  if (!(await input.isVisible({ timeout: 3000 }).catch(() => false))) return '';
  return (await input.getAttribute('value').catch(() => '')) || '';
}

async function updateLocationAuto(page) {
  const dialog = page
    .locator('xpath=//div[@role="dialog"][.//span[text()="Change location"]]')
    .first();
  await dialog.waitFor({ state: 'visible', timeout: 15000 });

  // Save the old location value before clicking the picker
  const oldValue = await readLocationInputValue(dialog);
  console.log(`  [marketplace_location] old location value: "${oldValue}"`);

  // Grant geolocation permission so the browser popup auto-accepts
  try {
    const context = page.context();
    await context.grantPermissions(['geolocation'], { origin: 'https://www.facebook.com' });
    console.log('  [marketplace_location] granted geolocation permission via Playwright');
  } catch (err) {
    console.warn(`  [marketplace_location] grantPermissions failed: ${err.message} — trying CDP`);
    try {
      const cdp = await page.context().newCDPSession(page);
      await cdp.send('Browser.grantPermissions', {
        permissions: ['geolocation'],
        origin: 'https://www.facebook.com',
      });
      console.log('  [marketplace_location] granted geolocation permission via CDP');
    } catch (cdpErr) {
      console.warn(`  [marketplace_location] CDP grantPermissions also failed: ${cdpErr.message}`);
    }
  }

  // Click the geolocation picker button
  const grabber = dialog
    .locator('div[aria-label="Marketplace geolocation picker"][role="button"]')
    .first();
  if (!(await grabber.isVisible({ timeout: 5000 }).catch(() => false))) {
    await dumpFailure(page, 'no-location-grabber');
    throw new Error('marketplace_location: could not find geolocation picker button in dialog');
  }

  console.log('  [marketplace_location] clicking geolocation picker...');
  const grabberBox = await grabber.boundingBox();
  if (grabberBox) {
    await humanClick(page, grabberBox);
  } else {
    await grabber.click();
  }

  // Poll the location input until the value changes from the old one.
  // Geolocation can take time — permission popup + API resolve + map update.
  const POLL_INTERVAL_MS = 2000;
  const MAX_POLLS = 15; // 30s max wait
  let newValue = oldValue;
  console.log('  [marketplace_location] waiting for location to change...');

  for (let i = 0; i < MAX_POLLS; i++) {
    await humanWait(page, POLL_INTERVAL_MS, POLL_INTERVAL_MS + 500);
    newValue = await readLocationInputValue(dialog);

    if (newValue && newValue !== oldValue) {
      console.log(
        `  [marketplace_location] location changed: "${oldValue}" → "${newValue}" (poll ${i + 1})`
      );
      break;
    }

    // Check if dialog is still open (might have closed due to error)
    if (!(await dialog.isVisible().catch(() => false))) {
      throw new Error(
        'marketplace_location: dialog closed unexpectedly while waiting for geolocation'
      );
    }

    if (i % 5 === 4) {
      console.log(
        `  [marketplace_location] still waiting... (poll ${i + 1}/${MAX_POLLS}, value="${newValue}")`
      );
    }
  }

  // Guard: did the location actually change?
  if (newValue === oldValue) {
    await dumpFailure(page, 'geolocation-unchanged');
    throw new Error(
      `marketplace_location: geolocation did not change the location (still "${oldValue}"). Permission popup may not have been accepted.`
    );
  }

  // Guard: did it resolve to a Philippines location? That means the proxy
  // geolocation returned the old signup location, not the Italian proxy.
  if (looksLikePhilippines(newValue)) {
    await dumpFailure(page, 'geolocation-still-philippines');
    throw new Error(
      `marketplace_location: geolocation resolved to Philippines ("${newValue}") — proxy may not be routing correctly.`
    );
  }

  console.log(`  [marketplace_location] geolocation resolved to: "${newValue}"`);

  // Click Apply
  const applyBtn = dialog.locator('div[aria-label="Apply"][role="button"]').first();
  if (await applyBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
    const box = await applyBtn.boundingBox();
    if (box) {
      await humanClick(page, box);
      console.log('  [marketplace_location] clicked Apply.');
      await humanWait(page, 4000, 6000);
      return;
    }
  }

  console.warn('  [marketplace_location] no Apply button found — selection may auto-apply.');
}

async function updateLocation(page, city) {
  // The "Change location" dialog has a Location field that shows the current
  // city as a static div. Clicking it activates an input (combobox). We need
  // to scope to the Change location dialog specifically — FB has multiple
  // hidden dialogs (e.g. Notifications) that match div[role="dialog"].
  const dialog = page
    .locator('xpath=//div[@role="dialog"][.//span[text()="Change location"]]')
    .first();
  await dialog.waitFor({ state: 'visible', timeout: 15000 });

  // Click the Location field text inside the dialog to activate the input.
  // The field shows "Tiwi, Albay, Philippines" as a static span — clicking
  // it morphs the field into an editable combobox input.
  const locationText = dialog
    .locator('xpath=.//span[text()="Location"]/ancestor::div[contains(@class,"x1i10hfl")][1]')
    .first();
  if (await locationText.isVisible({ timeout: 5000 }).catch(() => false)) {
    console.log('  [marketplace_location] clicking Location field to activate input...');
    await locationText.click();
    await humanWait(page, 1000, 2000);
  }

  // Now look for the combobox input inside the dialog
  let input = dialog.locator('input[role="combobox"]').first();
  if (!(await input.isVisible({ timeout: 5000 }).catch(() => false))) {
    input = dialog.locator('input[type="text"]').first();
  }

  if (!(await input.isVisible({ timeout: 5000 }).catch(() => false))) {
    throw new Error('marketplace_location: could not find location input field in dialog');
  }

  // Clear existing text and type the new city
  await input.click({ clickCount: 3 });
  await humanWait(page, 300, 500);
  await page.keyboard.press('Backspace');
  await humanWait(page, 500, 800);

  const cityName = city.split(',')[0].trim();
  console.log(`  [marketplace_location] typing "${cityName}"...`);
  await humanType(page, cityName);
  await humanWait(page, 2500, 4000);

  // Pick from the suggestion dropdown — can render inside or outside dialog
  const suggestionSelectors = [
    'ul[role="listbox"] li',
    'div[role="listbox"] div[role="option"]',
    'xpath=//ul[@role="listbox"]//li[1]',
  ];

  let picked = false;
  for (const sel of suggestionSelectors) {
    try {
      // Check page-level first — FB often renders dropdowns in a portal
      const option = page.locator(sel).first();
      if (await option.isVisible({ timeout: 5000 }).catch(() => false)) {
        const box = await option.boundingBox();
        if (box) {
          console.log('  [marketplace_location] clicking suggestion...');
          await humanClick(page, box);
          picked = true;
          break;
        }
      }
    } catch (_) {}
  }

  if (!picked) {
    console.warn('  [marketplace_location] no suggestion found — trying ArrowDown + Enter');
    await page.keyboard.press('ArrowDown');
    await humanWait(page, 500, 800);
    await page.keyboard.press('Enter');
  }

  await humanWait(page, 2000, 3000);

  // Click Apply button
  const applyBtn = dialog
    .locator('xpath=.//div[@role="button"][.//span[text()="Apply" or text()="Applica"]]')
    .first();
  if (await applyBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
    const box = await applyBtn.boundingBox();
    if (box) {
      await humanClick(page, box);
      console.log('  [marketplace_location] clicked Apply.');
      await humanWait(page, 4000, 6000);
      return;
    }
  }

  console.warn('  [marketplace_location] no Apply button found — selection may auto-apply.');
}

module.exports = async function marketplace_location(page, params) {
  const { city = '', country = '', mode = 'auto' } = params;

  if (mode === 'manual' && !city) {
    console.warn('  [marketplace_location] no city set on user record — skipping.');
    return;
  }

  try {
    console.log(`  [marketplace_location] mode=${mode}, navigating to Marketplace...`);
    await navigateToMarketplace(page);

    // Read current location
    const currentText = await readCurrentLocationText(page);
    console.log(`  [marketplace_location] current location text: "${currentText}"`);

    if (mode === 'manual' && locationMatches(currentText, city, country)) {
      console.log(`  [marketplace_location] location already matches "${city}" — skipping update.`);
      return;
    }

    console.log(
      mode === 'auto'
        ? '  [marketplace_location] using browser geolocation to update...'
        : `  [marketplace_location] location mismatch — updating to "${city}"...`
    );

    // Click the location element to open the Change location dialog
    const locationEl = await findLocationElement(page);
    if (!locationEl) {
      throw new Error('marketplace_location: could not find location element on Marketplace page');
    }

    const box = await locationEl.el.boundingBox();
    if (box) {
      await humanClick(page, box);
    } else {
      await locationEl.el.click();
    }
    await humanWait(page, 2000, 3500);

    // Update the location using the selected mode
    if (mode === 'auto') {
      await updateLocationAuto(page);
    } else {
      await updateLocation(page, city);
    }

    // Verify — reload marketplace so the sidebar aria-label refreshes
    console.log('  [marketplace_location] reloading marketplace to verify...');
    await page.goto('https://www.facebook.com/marketplace/', {
      waitUntil: 'domcontentloaded',
    });
    await humanWait(page, 3000, 5000);
    const updatedText = await readCurrentLocationText(page);
    console.log(`  [marketplace_location] updated location text: "${updatedText}"`);

    if (mode === 'manual' && locationMatches(updatedText, city, country)) {
      console.log('  [marketplace_location] location updated successfully.');
    } else if (mode === 'auto' && updatedText && !locationMatches(updatedText, '', '')) {
      console.log(`  [marketplace_location] auto location set to: "${updatedText}"`);
    } else {
      console.warn(
        `  [marketplace_location] could not verify update — text: "${updatedText}". May need manual check.`
      );
    }
  } catch (err) {
    await dumpFailure(page, `error-${(city || 'auto').replace(/[^a-z0-9]+/gi, '_')}`);
    throw err;
  }
};
