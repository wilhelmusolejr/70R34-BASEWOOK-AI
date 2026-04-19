/**
 * Human-like behavior utilities for automation.
 * Use these in all action handlers to avoid detection.
 */

/**
 * Human-like random delay (gaussian-ish distribution, not uniform).
 * Weighted toward middle values - more natural timing.
 *
 * @param {number} min - Minimum delay in ms
 * @param {number} max - Maximum delay in ms
 * @returns {number} Delay value in ms
 */
function humanDelay(min, max) {
  const range = max - min;
  const r1 = Math.random();
  const r2 = Math.random();
  const gaussian = (r1 + r2) / 2;
  return min + range * gaussian;
}

/**
 * Wait with human-like delay.
 *
 * @param {object} page - Playwright page
 * @param {number} min - Minimum delay in ms
 * @param {number} max - Maximum delay in ms
 */
async function humanWait(page, min, max) {
  await page.waitForTimeout(humanDelay(min, max));
}

/**
 * Get slightly randomized click position (not dead center).
 * Clicks within center 60% of the element.
 *
 * @param {object} box - Bounding box {x, y, width, height}
 * @returns {{x: number, y: number}} Click coordinates
 */
function humanClickPosition(box) {
  const offsetRangeX = box.width * 0.3;
  const offsetRangeY = box.height * 0.3;

  const x = box.x + box.width / 2 + (Math.random() - 0.5) * offsetRangeX;
  const y = box.y + box.height / 2 + (Math.random() - 0.5) * offsetRangeY;

  return { x, y };
}

/**
 * Move mouse smoothly to target position with ease-out curve.
 *
 * @param {object} page - Playwright page
 * @param {number} targetX - Target X coordinate
 * @param {number} targetY - Target Y coordinate
 */
async function humanMouseMove(page, targetX, targetY) {
  // Start from approximate previous position (or offset from target)
  const startX = targetX - 50 - Math.random() * 100;
  const startY = targetY - 30 - Math.random() * 60;

  const steps = 5 + Math.floor(Math.random() * 5);

  for (let i = 1; i <= steps; i++) {
    const progress = i / steps;
    // Ease-out curve for natural movement
    const eased = 1 - Math.pow(1 - progress, 2);

    const currentX = startX + (targetX - startX) * eased;
    const currentY = startY + (targetY - startY) * eased;

    await page.mouse.move(currentX, currentY);
    await page.waitForTimeout(10 + Math.random() * 20);
  }
}

/**
 * Human-like click: move to target, hover briefly, then click.
 *
 * @param {object} page - Playwright page
 * @param {object} box - Bounding box of element to click
 */
async function humanClick(page, box) {
  const { x, y } = humanClickPosition(box);

  await humanMouseMove(page, x, y);
  await page.waitForTimeout(humanDelay(100, 300)); // Hover pause
  await page.mouse.click(x, y);
}

/**
 * Human-like typing with varied delay per character.
 * Longer pauses after punctuation/spaces.
 *
 * @param {object} page - Playwright page
 * @param {string} text - Text to type
 */
async function humanType(page, text) {
  for (const char of text) {
    await page.keyboard.type(char);

    // Longer pause after punctuation/space
    const charDelay = /[.,!?\s]/.test(char)
      ? humanDelay(100, 250)
      : humanDelay(40, 120);

    await page.waitForTimeout(charDelay);
  }
}

/**
 * Scroll element into center of viewport using mouse.wheel().
 * Returns updated bounding box.
 *
 * @param {object} page - Playwright page
 * @param {object} element - Playwright element handle
 * @param {number} viewportHeight - Viewport height
 * @returns {Promise<object|null>} Updated bounding box or null if lost
 */
async function scrollToCenter(page, element, viewportHeight) {
  const targetY = viewportHeight / 2;

  for (let attempt = 0; attempt < 10; attempt++) {
    const box = await element.boundingBox();
    if (!box) return null;

    const elementCenterY = box.y + box.height / 2;

    // Check if centered (within tolerance)
    if (elementCenterY > 150 && elementCenterY < viewportHeight - 150) {
      return box;
    }

    const scrollAmount = elementCenterY - targetY;
    const scrollStep = Math.min(Math.abs(scrollAmount), 200) * Math.sign(scrollAmount);

    await page.mouse.wheel(0, scrollStep);
    await page.waitForTimeout(humanDelay(200, 400));
  }

  return await element.boundingBox();
}

module.exports = {
  humanDelay,
  humanWait,
  humanClickPosition,
  humanMouseMove,
  humanClick,
  humanType,
  scrollToCenter
};
