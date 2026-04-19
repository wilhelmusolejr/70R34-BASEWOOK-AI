/**
 * setup_avatar — Upload a profile picture from a URL.
 * Self-navigates to /me, goes through the profile picture actions flow,
 * uploads the image, and saves with an optional description.
 */

const https = require('https');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { humanWait, humanClick, humanType } = require('../utils/humanBehavior');

function downloadToTemp(url) {
  return new Promise((resolve, reject) => {
    const ext = path.extname(new URL(url).pathname) || '.jpg';
    const tmpPath = path.join(os.tmpdir(), `avatar_${Date.now()}${ext}`);
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

async function goToOwnProfile(page) {
  console.log('Navigating to own profile...');
  await page.goto('https://www.facebook.com/me', { waitUntil: 'domcontentloaded' });
  await humanWait(page, 2000, 3500);
}

module.exports = async function setup_avatar(page, params) {
  const { photoUrl, description = '' } = params;
  if (!photoUrl) throw new Error('setup_avatar: photoUrl is required');

  console.log('Downloading avatar image...');
  const tmpPath = await downloadToTemp(photoUrl);
  console.log(`Image saved to ${tmpPath}`);

  try {
    // 1. Navigate to own profile
    await goToOwnProfile(page);

    // 2. Click "Profile picture actions" button
    const actionsBtn = await page.waitForSelector('[aria-label="Profile picture actions"]', { timeout: 10000 });
    await actionsBtn.scrollIntoViewIfNeeded();
    const actionsBox = await actionsBtn.boundingBox();
    await humanClick(page, actionsBox);
    await humanWait(page, 1000, 2000);

    // 3. Click "Choose profile picture" in the dropdown
    const choosePicBtn = await page.waitForSelector(
      'xpath=//div[@role="menuitem"][.//span[text()="Choose profile picture"]]',
      { timeout: 5000 }
    );
    const choosePicBox = await choosePicBtn.boundingBox();
    await humanClick(page, choosePicBox);
    await humanWait(page, 1000, 2000);

    // 4. Click "Upload photo" — intercept the OS file chooser it triggers
    const uploadBtn = await page.waitForSelector('[aria-label="Upload photo"]', { timeout: 8000 });
    const [fileChooser] = await Promise.all([
      page.waitForEvent('filechooser'),
      uploadBtn.click()
    ]);
    await fileChooser.setFiles(tmpPath);
    console.log('File input set, waiting for upload...');

    // 6. Wait for upload to complete — try reposition text first, fall back to Save button appearing
    const uploadReady = await page.waitForSelector(
      'xpath=//span[text()="Drag or use arrow keys to reposition image"]',
      { timeout: 30000 }
    ).then(() => 'reposition').catch(() => null);

    if (!uploadReady) {
      console.log('Reposition text not found — waiting for Save button as fallback...');
      await page.waitForSelector('div[aria-label="Save"][role="button"]', { timeout: 15000 });
    }
    console.log('Image uploaded, ready to save...');
    await humanWait(page, 1000, 2000);

    // 7. Type description if provided
    if (description) {
      const descTextarea = await page.waitForSelector(
        'xpath=//label[.//span[text()="Description"]]//textarea',
        { timeout: 5000 }
      );
      await descTextarea.scrollIntoViewIfNeeded();
      const descBox = await descTextarea.boundingBox();
      await humanClick(page, descBox);
      await humanWait(page, 500, 1000);
      await humanType(page, description);
      await humanWait(page, 500, 1000);
    }

    // 8. Click Save
    const saveBtn = await page.waitForSelector(
      'div[aria-label="Save"][role="button"]',
      { timeout: 8000 }
    );
    const saveBox = await saveBtn.boundingBox();
    await humanWait(page, 800, 1500);
    await humanClick(page, saveBox);
    console.log('Save clicked');

    // 9. Wait for modal to close
    await page.waitForSelector(
      'xpath=//span[text()="Drag or use arrow keys to reposition image"]',
      { state: 'detached', timeout: 15000 }
    ).catch(() => {});

    await humanWait(page, 2000, 3500);
    console.log('Avatar upload complete');

  } finally {
    fs.unlink(tmpPath, () => {});
  }
};
