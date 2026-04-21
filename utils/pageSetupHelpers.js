/**
 * Shared helpers for the Facebook page-setup action family:
 * create_page, schedule_posts, switch_profile.
 */

const https = require('https');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { humanWait, humanClick, humanType } = require('./humanBehavior');

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

async function clickLocator(page, locator, errorMessage) {
  const visibleLocator = await getFirstVisibleLocator(locator, errorMessage);
  await visibleLocator.scrollIntoViewIfNeeded();
  const box = await visibleLocator.boundingBox();
  if (!box) throw new Error(errorMessage);

  await humanClick(page, box);
  await stepWait(page);
}

async function uploadImageFromButton(page, buttonLocator, tempPath, label) {
  const button = await getFirstVisibleLocator(buttonLocator, `${label} button has no visible match`);
  await button.scrollIntoViewIfNeeded();

  const [fileChooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    button.click(),
  ]);
  await fileChooser.setFiles(tempPath);
}

module.exports = {
  stepWait,
  downloadToTemp,
  getFirstVisibleLocator,
  clickAndReplace,
  typeAndSelect,
  clickLocator,
  uploadImageFromButton,
};
