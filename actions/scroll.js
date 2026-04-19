/**
 * scroll - Scroll the current page with human-like behavior
 *
 * Leaf action. Uses mouse.wheel() per CLAUDE.md conventions.
 * NEVER uses window.scrollTo or element.scrollIntoView.
 *
 * @param {object} params
 * @param {number} params.duration - Seconds to scroll (default: 10)
 * @param {string} params.direction - 'down' or 'up' (default: 'down')
 */

const { humanDelay } = require('../utils/humanBehavior');

module.exports = async function scroll(page, params) {
  const duration = params.duration ?? 10;
  const direction = params.direction ?? 'down';

  const startTime = Date.now();
  const endTime = startTime + duration * 1000;

  console.log(`  Scrolling ${direction} for ${duration}s...`);

  while (Date.now() < endTime) {
    // Random scroll amount: 300-700 pixels (human-like variation)
    const scrollAmount = humanDelay(300, 700);
    const delta = direction === 'down' ? scrollAmount : -scrollAmount;

    await page.mouse.wheel(0, delta);

    // Random pause between scrolls (human-like)
    await page.waitForTimeout(humanDelay(400, 1200));

    // Occasionally pause longer (like reading something)
    if (Math.random() < 0.15) {
      await page.waitForTimeout(humanDelay(800, 2000));
    }
  }

  console.log(`  Scroll complete (${duration}s)`);
};
