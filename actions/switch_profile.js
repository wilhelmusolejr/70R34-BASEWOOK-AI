/**
 * switch_profile - Leaf action.
 * Clicks "Your profile" and switches back to the personal user profile from a Page,
 * then cools down briefly. Falls back to "Quick switch profiles" if the named
 * switch button is not visible.
 */

const { humanClick } = require('../utils/humanBehavior');
const { stepWait } = require('../utils/pageSetupHelpers');

module.exports = async function switch_profile(page, params) {
  const { userName = '' } = params;

  console.log('  [switch_profile] Clicking Your profile...');
  const profileBtn = page.locator('[aria-label="Your profile"]').first();
  await profileBtn.waitFor({ state: 'visible', timeout: 15000 });
  await humanClick(page, await profileBtn.boundingBox());
  await stepWait(page);

  let switchBtn = userName
    ? page.locator(`[aria-label="Switch to ${userName}"]`).first()
    : null;
  const switchVisible = switchBtn ? await switchBtn.isVisible().catch(() => false) : false;

  if (!switchVisible) {
    console.log(`  [switch_profile] "Switch to ${userName}" not found — trying Quick switch profiles...`);
    switchBtn = page.locator('[aria-label="Quick switch profiles"]').first();
  }

  console.log(`  [switch_profile] Switching back to: ${userName || '(quick switch)'}`);
  await switchBtn.waitFor({ state: 'visible', timeout: 15000 });
  await humanClick(page, await switchBtn.boundingBox());
  await stepWait(page);

  console.log('  [switch_profile] Cooling down 50s...');
  await page.waitForTimeout(50000);
};
