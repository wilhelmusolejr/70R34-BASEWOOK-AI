/**
 * homepage_interaction - Navigate to the BASEWOOK homepage / news feed.
 * Tries clicking the Home nav button first (href="/"); falls back to goto.
 */

const { humanWait, humanClick } = require('../utils/humanBehavior');

module.exports = async function homepageInteraction(page, params) {
  const homeButton = await page.$('a[href="/"][role="link"]');

  if (homeButton) {
    const box = await homeButton.boundingBox();
    if (box) {
      console.log(`  Clicking Home button...`);
      await humanClick(page, box);
      await humanWait(page, 2000, 3500);
      return;
    }
  }

  console.log(`  Home button not found — navigating to homepage directly...`);
  await page.goto('https://www.facebook.com', { waitUntil: 'domcontentloaded' });
  await humanWait(page, 2000, 3500);
};
