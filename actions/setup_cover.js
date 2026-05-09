/**
 * setup_cover — Upload a cover photo from a URL (robust version)
 */

const https = require('https');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { humanWait } = require('../utils/humanBehavior');

function downloadToTemp(url) {
  return new Promise((resolve, reject) => {
    const ext = path.extname(new URL(url).pathname) || '.jpg';
    const tmpPath = path.join(os.tmpdir(), `cover_${Date.now()}${ext}`);
    const file = fs.createWriteStream(tmpPath);
    const client = url.startsWith('https') ? https : http;

    client
      .get(url, (res) => {
        if (res.statusCode !== 200) {
          reject(new Error(`Download failed: HTTP ${res.statusCode}`));
          return;
        }
        res.pipe(file);
        file.on('finish', () => file.close(() => resolve(tmpPath)));
      })
      .on('error', (err) => {
        fs.unlink(tmpPath, () => {});
        reject(err);
      });
  });
}

module.exports = async function setup_cover(page, params) {
  const { photoUrl } = params;
  if (!photoUrl) throw new Error('setup_cover: photoUrl is required');

  console.log('Downloading cover image...');
  const tmpPath = await downloadToTemp(photoUrl);
  console.log(`Image saved to ${tmpPath}`);

  try {
    // =========================================================
    // 1. Go to profile
    // =========================================================
    console.log('Navigating to own profile...');
    await page.goto('https://www.facebook.com/me', {
      waitUntil: 'domcontentloaded',
    });

    await humanWait(page, 2500, 4000);

    // =========================================================
    // 2. Click "Add/Edit cover photo"
    // =========================================================
    const coverBtn = page
      .locator('[aria-label*="cover photo"]')
      .filter({ has: page.locator(':visible') })
      .first();

    console.log('Waiting for cover button...');
    await coverBtn.waitFor({ state: 'visible', timeout: 15000 });

    await humanWait(page, 800, 1500);
    await coverBtn.click();

    // =========================================================
    // 3. Click "Upload photo"
    // =========================================================
    const uploadBtn = page.locator('//div[@role="menuitem"][.//span[text()="Upload photo"]]');

    console.log('Waiting for upload option...');
    await uploadBtn.waitFor({ state: 'visible', timeout: 10000 });

    const [fileChooser] = await Promise.all([page.waitForEvent('filechooser'), uploadBtn.click()]);

    await fileChooser.setFiles(tmpPath);
    console.log('File selected');

    // =========================================================
    // 4. Wait for Save button to be usable
    // =========================================================
    console.log('Waiting for Save changes button...');

    await page.waitForFunction(
      () => {
        const btns = Array.from(document.querySelectorAll('[aria-label="Save changes"]'));
        return btns.some(
          (btn) =>
            btn.offsetParent !== null && // visible
            btn.getAttribute('aria-disabled') !== 'true'
        );
      },
      { timeout: 45000 }
    );

    // =========================================================
    // 5. Click correct Save button (VERY IMPORTANT LOGIC)
    // =========================================================
    const saveButtons = page.locator('[aria-label="Save changes"]');
    const count = await saveButtons.count();

    console.log(`Found ${count} Save buttons`);

    let clicked = false;

    for (let i = count - 1; i >= 0; i--) {
      const btn = saveButtons.nth(i);

      if ((await btn.isVisible()) && (await btn.isEnabled())) {
        console.log(`Clicking Save button #${i}`);
        await humanWait(page, 1500, 2500);
        await btn.click();
        clicked = true;
        break;
      }
    }

    if (!clicked) {
      throw new Error('No clickable Save changes button found');
    }

    // =========================================================
    // 6. Wait for save to complete
    // =========================================================
    console.log('Waiting for save to complete...');

    await page
      .waitForFunction(
        () => {
          return !document.querySelector('[aria-label="Save changes"]');
        },
        { timeout: 20000 }
      )
      .catch(() => {});

    await humanWait(page, 3000, 5000);

    console.log('✅ Cover photo upload complete');
  } finally {
    fs.unlink(tmpPath, () => {});
  }
};
