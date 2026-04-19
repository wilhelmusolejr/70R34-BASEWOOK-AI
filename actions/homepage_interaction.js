/**
 * homepage_interaction - Navigate to the BASEWOOK homepage / news feed.
 * Always does a fresh goto so the feed reloads cleanly regardless of current page.
 */

const { humanWait } = require('../utils/humanBehavior');

module.exports = async function homepageInteraction(page, params) {
  console.log(`  Navigating to homepage...`);
  await page.goto('https://www.facebook.com', { waitUntil: 'domcontentloaded' });

  await humanWait(page, 2000, 3500);
};
