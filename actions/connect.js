/**
 * connect — Leaf action.
 * Clicks whichever of Add Friend / Follow / Like are present on the loaded
 * profile or page. Walks all three in priority order and only clicks when
 * the target is actually visible + has a bounding box, then verifies the
 * click landed by re-checking that the same text-labelled button is gone.
 * If none are present, logs and returns — NEVER throws.
 *
 * Uses has-text XPath (exact inner-span text) instead of aria-label because
 * FB's aria-labels vary: "Add Friend Joan Blasiro" vs "Add friend", and
 * [aria-label="Like"] also matches feed post likes. Span text is the stable
 * signal for the actual button we want.
 */

const { humanWait, humanClick, scrollToCenter } = require('../utils/humanBehavior');

const TARGETS = [
  {
    label: 'Add Friend',
    selector: 'xpath=//div[@role="button"][.//span[normalize-space(text())="Add friend"]]',
  },
  {
    label: 'Follow',
    selector: 'xpath=//div[@role="button"][.//span[normalize-space(text())="Follow"]]',
  },
  {
    label: 'Like',
    selector: 'xpath=//div[@role="button"][.//span[normalize-space(text())="Like"]]',
  },
];

async function tryClick(page, target) {
  const locator = page.locator(target.selector).first();

  const count = await locator.count().catch(() => 0);
  if (count === 0) {
    console.log(`  [connect] "${target.label}" not present — skipping.`);
    return false;
  }

  const visible = await locator.isVisible().catch(() => false);
  if (!visible) {
    console.log(`  [connect] "${target.label}" not visible — skipping.`);
    return false;
  }

  const handle = await locator.elementHandle().catch(() => null);
  if (!handle) {
    console.log(`  [connect] "${target.label}" handle unavailable — skipping.`);
    return false;
  }

  const viewport = page.viewportSize();
  const viewportHeight = viewport && viewport.height ? viewport.height : 800;
  await scrollToCenter(page, handle, viewportHeight);
  await humanWait(page, 1200, 2000);

  const box = await handle.boundingBox().catch(() => null);
  if (!box || !box.width || !box.height) {
    console.log(`  [connect] "${target.label}" has no bounding box after scroll — skipping.`);
    return false;
  }

  await humanClick(page, box);
  await humanWait(page, 1500, 2500);

  const stillVisible = await page
    .locator(target.selector)
    .first()
    .isVisible()
    .catch(() => false);
  if (stillVisible) {
    console.log(`  [connect] Click on "${target.label}" did not register (button still visible) — skipping.`);
    return false;
  }

  console.log(`  [connect] Clicked "${target.label}".`);
  return true;
}

module.exports = async function connect(page, params) {
  let anyClicked = false;
  for (const target of TARGETS) {
    const clicked = await tryClick(page, target);
    if (clicked) anyClicked = true;
  }

  if (!anyClicked) {
    console.log('  [connect] Nothing clickable (no Add Friend / Follow / Like found).');
  }
};
