/**
 * visit_profile — Navigate to a Facebook profile by URL.
 * Navigator action — use child steps to act on the profile after loading.
 *
 * Params:
 *   url    {string} — direct profile URL
 *   random {bool}   — pick a random URL from config/friend_targets.json instead
 */

const { humanWait } = require('../utils/humanBehavior');
const friendTargets = require('../config/friend_targets.json');

module.exports = async function visit_profile(page, params) {
  let { url, random } = params;

  if (random) {
    if (!friendTargets.length) throw new Error('visit_profile: friend_targets.json is empty');
    url = friendTargets[Math.floor(Math.random() * friendTargets.length)];
    console.log(`  [visit_profile] Random target: ${url}`);
  }

  if (!url) throw new Error('visit_profile: url is required (or set random: true)');

  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await humanWait(page, 2000, 3500);
};
