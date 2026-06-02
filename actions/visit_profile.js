/**
 * visit_profile — Navigate to a Facebook profile/page by URL.
 * Navigator action — use child steps to act on the target after loading.
 *
 * Params:
 *   url     {string} — direct URL (wins when provided)
 *   pool    {string} — pick a random URL from a named pool:
 *                      "friends" → config/friend_targets.json
 *                      "sharers" → API fetch by country (GET /api/sharers/by-country/:country)
 *                      "users"   → live DB fetch (Active profiles with profileUrl)
 *   country {string} — user's country code (auto-injected); used by "sharers" pool
 *
 * Missing/removed targets: FB serves a "This content isn't available right
 * now" card (profile removed / restricted / broken link) with no feed — so a
 * child connect/like/share then finds 0 of everything and flails for ~70s on a
 * dead page. For pool visits we detect that card and re-pick a different target
 * (bounded) so the bot lands on a live page instead.
 */

const { humanWait } = require('../utils/humanBehavior');
const { fetchActiveProfiles, fetchSharerUrls, deleteSharerByUrl } = require('../utils/userApi');

const STATIC_POOLS = {
  friends: require('../config/friend_targets.json'),
};

const USERS_POOL_LIMIT = 5;

// FB's "content unavailable" card heading. `.` matches both the straight and
// curly apostrophe in "isn't"; Italian variant included for IT-proxy accounts.
const UNAVAILABLE_RE =
  /This content isn.t available right now|contenuto non .{0,3} al momento disponibile|Questo contenuto non/i;

async function resolvePool(pool, country) {
  if (STATIC_POOLS[pool]) return STATIC_POOLS[pool];
  if (pool === 'sharers') {
    if (!country) throw new Error('visit_profile: country is required for "sharers" pool');
    const urls = await fetchSharerUrls(country);
    return urls;
  }
  if (pool === 'users') {
    const profiles = await fetchActiveProfiles(USERS_POOL_LIMIT);
    return profiles.map((p) => p.profileUrl).filter(Boolean);
  }
  throw new Error(`visit_profile: unknown pool "${pool}" (valid: friends, sharers, users)`);
}

/**
 * Is the page currently showing FB's "content isn't available" card? Instant
 * check (no auto-wait) — the caller has already settled the page after goto,
 * so the current DOM state is authoritative and we don't pay a timeout on the
 * common healthy-page case.
 */
async function isContentUnavailable(page) {
  return page
    .getByText(UNAVAILABLE_RE)
    .first()
    .isVisible()
    .catch(() => false);
}

async function gotoSettled(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await humanWait(page, 2000, 3500);
}

module.exports = async function visit_profile(page, params) {
  const { url, pool, country } = params;

  // Explicit URL wins. Single shot — re-picking makes no sense for a specific
  // target. If it's a dead page, warn (so it's not silent) and proceed; the
  // children will no-op rather than the runner retrying the same dead URL 3×.
  if (url) {
    await gotoSettled(page, url);
    if (await isContentUnavailable(page)) {
      console.warn(`  [visit_profile] "${url}" shows "content isn't available" (removed/restricted).`);
    }
    return;
  }

  if (!pool) throw new Error('visit_profile: url or pool is required');

  const list = await resolvePool(pool, country);
  if (!list.length) throw new Error(`visit_profile: pool "${pool}" returned no valid URLs`);

  // Try random picks until we land on a live page. Bounded so a pool that's
  // mostly dead can't loop forever; tried-set avoids re-picking the same dead
  // URL. Landing on a live page returns immediately.
  const maxPicks = Math.min(4, list.length);
  const tried = new Set();

  for (let i = 0; i < maxPicks; i++) {
    let pick;
    do {
      pick = list[Math.floor(Math.random() * list.length)];
    } while (tried.has(pick) && tried.size < list.length);
    tried.add(pick);

    console.log(`  [visit_profile] Random from "${pool}": ${pick}`);
    await gotoSettled(page, pick);

    if (!(await isContentUnavailable(page))) return; // live page — done

    console.warn(
      `  [visit_profile] "${pick}" shows "content isn't available" — trying another target (${i + 1}/${maxPicks}).`
    );

    // Prune the dead link so it stops getting picked. ONLY for the sharers
    // pool — those are curated link records we own. NEVER for "users" (real
    // profiles — a transient unavailable must not delete the person) or
    // "friends" (a static JSON file, not API-backed).
    if (pool === 'sharers') {
      await deleteSharerByUrl(pick, country);
    }
  }

  // Every pick was a dead page. Leave the session where it is and return —
  // children will find nothing, but that's a single clean no-op, not a retry
  // storm. The pool likely has stale entries worth pruning upstream.
  console.warn(
    `  [visit_profile] ${maxPicks} "${pool}" target(s) all unavailable — proceeding on last page.`
  );
};
