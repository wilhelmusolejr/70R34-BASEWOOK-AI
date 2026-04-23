/**
 * visit_profile — Navigate to a Facebook profile/page by URL.
 * Navigator action — use child steps to act on the target after loading.
 *
 * Params:
 *   url  {string} — direct URL (wins when provided)
 *   pool {string} — pick a random URL from a named pool:
 *                   "friends" → config/friend_targets.json
 *                   "sharers" → config/share_sources.json
 *                   "users"   → live DB fetch (Active profiles with profileUrl)
 */

const { humanWait } = require('../utils/humanBehavior');
const { fetchActiveProfileUrls } = require('../utils/userApi');

const STATIC_POOLS = {
  friends: require('../config/friend_targets.json'),
  sharers: require('../config/share_sources.json')
};

const USERS_POOL_LIMIT = 5;

async function resolvePool(pool) {
  if (STATIC_POOLS[pool]) return STATIC_POOLS[pool];
  if (pool === 'users') return await fetchActiveProfileUrls(USERS_POOL_LIMIT);
  throw new Error(`visit_profile: unknown pool "${pool}" (valid: friends, sharers, users)`);
}

module.exports = async function visit_profile(page, params) {
  let { url, pool } = params;

  if (!url && pool) {
    const list = await resolvePool(pool);
    if (!list.length) throw new Error(`visit_profile: pool "${pool}" returned no valid URLs`);
    url = list[Math.floor(Math.random() * list.length)];
    console.log(`  [visit_profile] Random from "${pool}": ${url}`);
  }

  if (!url) throw new Error('visit_profile: url or pool is required');

  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await humanWait(page, 2000, 3500);
};
