/**
 * scroll - Scroll the current page with human-like behavior
 *
 * Leaf action. Uses mouse.wheel() per CLAUDE.md conventions.
 * NEVER uses window.scrollTo or element.scrollIntoView.
 *
 * @param {object} params
 * @param {number} params.duration - Fixed seconds to scroll. Wins over min/max.
 * @param {number} params.min      - Lower bound (seconds) for random duration.
 * @param {number} params.max      - Upper bound (seconds) for random duration.
 * @param {string} params.direction - 'down' or 'up' (default: 'down')
 *
 * Resolution: duration > min/max range > default 10.
 */

const { humanDelay } = require('../utils/humanBehavior');

function resolveDuration(params) {
  if (typeof params.duration === 'number') return params.duration;
  const hasMin = typeof params.min === 'number';
  const hasMax = typeof params.max === 'number';
  if (hasMin && hasMax) {
    const lo = Math.min(params.min, params.max);
    const hi = Math.max(params.min, params.max);
    return lo + Math.random() * (hi - lo);
  }
  return 10;
}

module.exports = async function scroll(page, params) {
  const duration = resolveDuration(params);
  const direction = params.direction ?? 'down';

  const startTime = Date.now();
  const endTime = startTime + duration * 1000;

  console.log(`  Scrolling ${direction} for ${duration.toFixed(1)}s...`);

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

  console.log(`  Scroll complete (${duration.toFixed(1)}s)`);
};
