/**
 * setup_cover — Upload a cover photo from a URL.
 * Self-navigates to /me and goes through the cover photo upload flow.
 */

const https = require('https');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { humanWait, humanClick } = require('../utils/humanBehavior');

function downloadToTemp(url) {
  return new Promise((resolve, reject) => {
    const ext = path.extname(new URL(url).pathname) || '.jpg';
    const tmpPath = path.join(os.tmpdir(), `cover_${Date.now()}${ext}`);
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

module.exports = async function setup_cover(page, params) {
  const { photoUrl } = params;
  if (!photoUrl) throw new Error('setup_cover: photoUrl is required');

  console.log('Downloading cover image...');
  const tmpPath = await downloadToTemp(photoUrl);
  console.log(`Image saved to ${tmpPath}`);

  try {
    // 1. Navigate to own profile
    console.log('Navigating to own profile...');
    await page.goto('https://www.facebook.com/me', { waitUntil: 'domcontentloaded' });
    await humanWait(page, 2000, 3500);

    // 2. Click "Add cover photo" button
    const coverBtn = await page.waitForSelector('[aria-label="Add cover photo"]', { timeout: 10000 });
    await coverBtn.scrollIntoViewIfNeeded();
    await humanWait(page, 500, 1000);
    await coverBtn.click();
    await humanWait(page, 1500, 2500);

    // 3. Click "Upload photo" menuitem
    const uploadMenuItem = await page.waitForSelector(
      'xpath=//div[@role="menuitem"][.//span[text()="Upload photo"]]',
      { timeout: 8000 }
    );
    const [fileChooser] = await Promise.all([
      page.waitForEvent('filechooser'),
      uploadMenuItem.click()
    ]);
    await fileChooser.setFiles(tmpPath);
    console.log('File input set, waiting for save button...');

    // 4. Poll until a "Save changes" button exists and is not aria-disabled
    // (FB renders 2 matching elements — querySelector handles this cleanly)
    console.log('Waiting for Save changes to become enabled...');
    await page.waitForFunction(() => {
      const btns = Array.from(document.querySelectorAll('[aria-label="Save changes"]'));
      return btns.some(btn => btn.getAttribute('aria-disabled') !== 'true');
    }, { timeout: 45000 });

    const saveBtn = await page.evaluateHandle(() =>
      Array.from(document.querySelectorAll('[aria-label="Save changes"]'))
        .find(btn => btn.getAttribute('aria-disabled') !== 'true')
    );
    await humanWait(page, 1500, 2500);
    await saveBtn.click();
    console.log('Save changes clicked');

    // 5. Wait for save to complete
    await page.waitForFunction(() =>
      !document.querySelector('[aria-label="Save changes"]'),
      { timeout: 15000 }
    ).catch(() => {});

    await humanWait(page, 2000, 3500);
    console.log('Cover photo upload complete');

  } finally {
    fs.unlink(tmpPath, () => {});
  }
};
