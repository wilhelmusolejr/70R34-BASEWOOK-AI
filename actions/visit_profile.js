/**
 * visit_profile — Navigate to a Facebook profile by URL.
 * Navigator action — use child steps to act on the profile after loading.
 */

const { humanWait } = require('../utils/humanBehavior');

module.exports = async function visit_profile(page, params) {
  const { url } = params;
  if (!url) throw new Error('visit_profile: url is required');

  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await humanWait(page, 2000, 3500);
};
