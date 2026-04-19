/**
 * homepage_interaction - Navigate to Facebook homepage / news feed
 *
 * Navigator action (container) with no params.
 * - If not on facebook.com, navigates there
 * - If already on facebook.com, clicks the Home button via bounding-box
 */

const { humanWait, humanClick } = require('../utils/humanBehavior');

module.exports = async function homepageInteraction(page, params) {
  const currentUrl = page.url();
  let hostname = '';

  try {
    hostname = new URL(currentUrl).hostname;
  } catch {
    // Invalid URL (e.g., about:blank) - treat as not on Facebook
  }

  const isOnFacebook = hostname.includes('facebook.com');

  if (!isOnFacebook) {
    console.log(`  Not on Facebook, navigating to homepage...`);
    await page.goto('https://www.facebook.com', { waitUntil: 'domcontentloaded' });
  } else {
    console.log(`  Already on Facebook, clicking Home button...`);

    // Try primary selector first
    let homeButton = await page.$('[aria-label="Home"]');

    // Fallback selector
    if (!homeButton) {
      homeButton = await page.$('[role="link"][aria-label*="Home"]');
    }

    if (!homeButton) {
      throw new Error(
        'Could not find Home button. Selectors attempted: ' +
        '[aria-label="Home"], [role="link"][aria-label*="Home"]. ' +
        'Facebook may have updated their DOM.'
      );
    }

    const box = await homeButton.boundingBox();
    if (!box) {
      throw new Error('Home button found but has no bounding box (may be hidden)');
    }

    // Human-like click
    await humanClick(page, box);
  }

  // Wait for feed to render with human-like randomness
  const waitTime = 2000 + Math.random() * 1500;
  console.log(`  Waiting ${Math.round(waitTime)}ms for feed to render...`);
  await page.waitForTimeout(waitTime);
};
