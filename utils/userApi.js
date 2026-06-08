/**
 * Fetch user profile data from the 3rd party API.
 */

const axios = require('axios');
require('dotenv').config();

const BASE_URL = process.env.USER_API_BASE_URL;

/**
 * Fetch a single user by their API ID.
 *
 * @param {string} userId
 * @returns {Promise<Object>} User object from the API
 */
async function fetchUser(userId) {
  if (!BASE_URL) throw new Error('USER_API_BASE_URL is not set in .env');

  const { data } = await axios.get(`${BASE_URL}/api/profiles/${userId}`);

  const parsed = typeof data === 'string' ? JSON.parse(data) : data;
  return parsed.data || parsed;
}

/**
 * Fetch N random profiles per matching status ("Active" or "Need Setup") and
 * return a merged, deduped list of full user objects. Profiles with empty
 * profileUrl are filtered out. Two parallel queries — server filter syntax
 * doesn't matter.
 *
 * @param {number} limit — rows requested per status (default 5; merged list up to 2×limit)
 * @returns {Promise<Object[]>} — list of user objects (each has _id, profileUrl, etc.)
 */
async function fetchActiveProfiles(limit = 5, country = '') {
  if (!BASE_URL) throw new Error('USER_API_BASE_URL is not set in .env');

  const STATUSES = ['Active', 'Need Setup'];

  const responses = await Promise.allSettled(
    STATUSES.map((status) => {
      const params = { status, limit, random: 1 };
      if (country) params.country = String(country).toUpperCase();
      return axios.get(`${BASE_URL}/api/profiles`, { params });
    })
  );

  const seen = new Set();
  const profiles = [];

  for (const r of responses) {
    if (r.status !== 'fulfilled') {
      console.warn(`[userApi] fetch profiles failed: ${r.reason?.message || r.reason}`);
      continue;
    }
    const parsed = typeof r.value.data === 'string' ? JSON.parse(r.value.data) : r.value.data;
    const list = parsed.data || parsed;
    if (!Array.isArray(list)) continue;

    for (const u of list) {
      const url = u && u.profileUrl;
      if (typeof url !== 'string' || url.trim().length === 0) continue;
      const key = u._id || u.id || url;
      if (seen.has(key)) continue;
      seen.add(key);
      profiles.push(u);
    }
  }

  return profiles;
}

/**
 * Generic PATCH on a profile record. Keeps any field updates in one place
 * so callers can record state (friend count, status, page URL, etc.) without
 * each carrying axios + base-url plumbing.
 *
 * @param {string} userId
 * @param {Object} patch — body to PATCH
 */
async function updateProfile(userId, patch) {
  if (!BASE_URL) throw new Error('USER_API_BASE_URL is not set in .env');
  if (!userId) throw new Error('updateProfile: userId is required');
  await axios.patch(`${BASE_URL}/api/profiles/${userId}`, patch, { timeout: 10000 });
}

/**
 * Record an outgoing friend-request: the sender pressed "Add friend" on the
 * receiver's profile and FB did not throw a rate-limit modal. Backend
 * defaults status to "Pending".
 *
 * @param {string} receiverId — the visited profile's _id (URL :id)
 * @param {string} senderId   — the actor's _id (body.senderProfileId)
 */
async function recordFriendRequest(receiverId, senderId) {
  if (!BASE_URL) throw new Error('USER_API_BASE_URL is not set in .env');
  if (!receiverId || !senderId) throw new Error('recordFriendRequest: both ids required');
  await axios.post(
    `${BASE_URL}/api/profiles/${receiverId}/friend-requests`,
    { senderProfileId: senderId },
    { timeout: 10000 }
  );
}

/**
 * Update an existing friend-request record's status.
 *
 * @param {string} receiverId
 * @param {string} senderId
 * @param {string} status — e.g. "Pending" / "Accepted" / "Declined"
 */
async function updateFriendRequestStatus(receiverId, senderId, status) {
  if (!BASE_URL) throw new Error('USER_API_BASE_URL is not set in .env');
  if (!receiverId || !senderId) {
    throw new Error('updateFriendRequestStatus: both ids required');
  }
  await axios.patch(
    `${BASE_URL}/api/profiles/${receiverId}/friend-requests/${senderId}`,
    { status },
    { timeout: 10000 }
  );
}

/**
 * Stamp a single onboarding step's timestamp on a profile. Atomic — sets
 * one key on profile.onboarding.<key>. Pass `null`/`""`/`undefined` to clear.
 *
 * Valid keys (server ONBOARDING_KEYS — a wrong key 400s "Unknown onboarding key"):
 *   privacyPublicAt, profileImageSetAt, coverImageSetAt, aboutSetAt,
 *   marketplaceSetAt, groupJoinedAt, highlightsSetAt, publishPostAt,
 *   pageSetAt, recoveryEmailSetAt, lastSharedAt
 *   (note: the page-setup stamp is `pageSetAt`, NOT `pageSetupAt`)
 *
 * Best-effort: logs warnings on failure but never throws — a transient
 * onboarding-PATCH hiccup must NOT fail the action that succeeded.
 *
 * @param {string} userId
 * @param {string} key — one of the onboarding keys
 * @param {string|Date|null} [value=new Date()] — ISO string / Date / null to clear
 */
async function setOnboarding(userId, key, value = new Date()) {
  if (!BASE_URL) {
    console.warn('  [onboarding] USER_API_BASE_URL not set — skipping PATCH');
    return;
  }
  if (!userId) {
    console.warn(`  [onboarding] no userId — skipping ${key} PATCH`);
    return;
  }
  if (!key) {
    console.warn('  [onboarding] no key — skipping PATCH');
    return;
  }

  let isoValue = value;
  if (value instanceof Date) isoValue = value.toISOString();
  else if (value && typeof value !== 'string') isoValue = String(value);

  try {
    await axios.patch(
      `${BASE_URL}/api/profiles/${userId}/onboarding/${key}`,
      { value: isoValue },
      { timeout: 10000 }
    );
    console.log(`  [onboarding] stamped ${key} = ${isoValue || 'cleared'}`);
  } catch (err) {
    const status = err.response?.status;
    const detail = err.response?.data?.message || err.message;
    console.warn(`  [onboarding] PATCH ${key} failed (${status || 'no-status'}): ${detail}`);
  }
}

/**
 * Fetch ALL profiles matching a status — for dynamic task population
 * (`profilesFromStatus` in task config). Returns the full populated profile
 * records, not just ids, so callers can do downstream filtering (e.g.
 * cooldown gate on onboarding.lastSharedAt) without a second round-trip.
 *
 * Server caps `limit` at 500; we pass 500 explicitly. If a status ever grows
 * past 500 profiles the call will need pagination (server doesn't currently
 * support `skip` on /profiles, only on /proxies).
 *
 * @param {string} status — must be one of the server's PROFILE_STATUSES
 *                          (Available, Need Setup, Pending Profile, Active,
 *                          Flagged, Banned, Ready, Delivered). Invalid → 400.
 * @returns {Promise<Object[]>} full profile records
 */
async function fetchProfilesByStatus(status) {
  if (!BASE_URL) throw new Error('USER_API_BASE_URL is not set in .env');
  if (!status || typeof status !== 'string') {
    throw new Error('fetchProfilesByStatus: status (string) is required');
  }
  const { data } = await axios.get(`${BASE_URL}/api/profiles`, {
    params: { status, limit: 500 },
    timeout: 30000,
  });
  const parsed = typeof data === 'string' ? JSON.parse(data) : data;
  const list = parsed.data || parsed;
  if (!Array.isArray(list)) {
    throw new Error(
      `fetchProfilesByStatus: expected array, got ${typeof list} — body: ${JSON.stringify(parsed).slice(0, 200)}`
    );
  }
  return list;
}

async function fetchSharerUrls(country) {
  if (!BASE_URL) throw new Error('USER_API_BASE_URL is not set in .env');
  if (!country) throw new Error('fetchSharerUrls: country is required');
  const { data } = await axios.get(
    `${BASE_URL}/api/sharers/by-country/${encodeURIComponent(country.toUpperCase())}`,
    { timeout: 15000 }
  );
  const parsed = typeof data === 'string' ? JSON.parse(data) : data;
  return parsed.urls || [];
}

/**
 * Delete a sharer record by its URL. The by-country endpoint only returns
 * URLs (no _id), and DELETE /api/sharers/:id needs the Mongo id — so we list
 * the sharers (narrowed by country when given), match the URL, and delete by
 * the resolved id. Best-effort: returns true on delete, false otherwise, and
 * never throws (a pruning hiccup must not break the visit that triggered it).
 *
 * Used to prune dead sharer links when visit_profile lands on FB's
 * "content isn't available" card for a sharers-pool target.
 */
async function deleteSharerByUrl(url, country = '') {
  if (!BASE_URL || !url) return false;
  const norm = (u) =>
    String(u || '')
      .trim()
      .replace(/\/+$/, '')
      .toLowerCase();
  try {
    const listUrl = country
      ? `${BASE_URL}/api/sharers?country=${encodeURIComponent(String(country).toUpperCase())}`
      : `${BASE_URL}/api/sharers`;
    const { data } = await axios.get(listUrl, { timeout: 15000 });
    const list = Array.isArray(data) ? data : data.sharers || data.items || data.data || [];
    const target = norm(url);
    const match = list.find((s) => norm(s.url) === target);
    if (!match) {
      console.warn(`  [sharers] No DB record matched ${url} — nothing to delete.`);
      return false;
    }
    const id = match.id || match._id;
    if (!id) return false;
    await axios.delete(`${BASE_URL}/api/sharers/${id}`, { timeout: 15000 });
    console.log(`  [sharers] Deleted dead sharer ${id} (${url}).`);
    return true;
  } catch (err) {
    console.warn(`  [sharers] deleteSharerByUrl failed for ${url}: ${err.message}`);
    return false;
  }
}

/**
 * Claim a Page blueprint from the online pool for a profile that has none.
 *
 * POST /api/pages/auto-assign { profileId, country } — the backend:
 *   1. 404 if the profile doesn't exist.
 *   2. 409 if the profile already has a page (profile.pageId set OR pageUrl
 *      non-empty) — its own duplicate guard.
 *   3. resolves a country per the `country` MODE (see below), picks the oldest
 *      unowned page for it, links it (Page.linkedIdentities + Profile.pageId),
 *      and returns the populated page.
 *   4. 404 if no unowned page is available for the resolved country.
 *   5. 400 if `country` isn't one of the accepted modes.
 *
 * `country` is a MODE selector, NOT a literal code to pass through:
 *   - "profile" (server default if omitted) — only pages matching the profile's
 *     own country (IT profile → IT page only).
 *   - "random" — prefer the profile's country; if none available, any country.
 *   - "US" / "IT" — strictly that country regardless of the profile.
 * Passed through verbatim (NOT uppercased): keyword modes are lowercase,
 * country codes uppercase — the server validates and 400s on anything else.
 *
 * Best-effort by design: 409 (already owned) and 404 (none available) are NOT
 * failures — they mean "no provisioning happened," so we return null and let
 * the create_page gate skip as before. Network / unexpected errors (incl. a 400
 * bad-mode config error) are logged and also return null — claiming a page must
 * never block or fail the run.
 *
 * @param {string} profileId — the profile's _id
 * @param {string} [countryMode='random'] — "profile" | "random" | "US" | "IT"
 * @returns {Promise<Object|null>} the populated page (formatPage shape) or null
 */
async function autoAssignPage(profileId, countryMode = 'random') {
  if (!BASE_URL) throw new Error('USER_API_BASE_URL is not set in .env');
  if (!profileId) {
    console.warn('  [pages] autoAssignPage: no profileId — skipping');
    return null;
  }

  const body = { profileId };
  if (countryMode && String(countryMode).trim()) body.country = String(countryMode).trim();

  try {
    const { data } = await axios.post(`${BASE_URL}/api/pages/auto-assign`, body, {
      timeout: 15000,
    });
    const parsed = typeof data === 'string' ? JSON.parse(data) : data;
    return parsed.data || parsed;
  } catch (err) {
    const status = err.response?.status;
    const detail = err.response?.data?.message || err.message;
    if (status === 409) {
      console.log(`  [pages] auto-assign refused (409 already has a page): ${detail}`);
    } else if (status === 404) {
      console.log(`  [pages] auto-assign found no unowned page available (404): ${detail}`);
    } else if (status === 400) {
      console.warn(`  [pages] auto-assign rejected mode "${body.country}" (400): ${detail}`);
    } else {
      console.warn(`  [pages] auto-assign failed (${status || 'no-status'}): ${detail}`);
    }
    return null;
  }
}

/**
 * Fetch page-set stats for a given local day from the dashboard endpoint.
 * Counts profiles whose `onboarding.pageSetAt` was stamped that day, split into
 * `passed` (has a non-empty pageUrl) vs `failed` (no pageUrl) — the same rule as
 * the Dashboard's "Set Page · last 7 days" chart. Powers the create_page
 * daily-failure circuit breaker.
 *
 * @param {string} date — YYYY-MM-DD (the local day to count)
 * @param {number} [tzOffset] — minutes, JS getTimezoneOffset() convention
 *   (UTC+8 → -480). Aligns the server's day boundary with local time; omit for
 *   UTC boundaries.
 * @returns {Promise<{date:string, passed:number, failed:number, total:number}>}
 */
async function fetchPageSetStats(date, tzOffset) {
  if (!BASE_URL) throw new Error('USER_API_BASE_URL is not set in .env');

  const params = { date };
  if (Number.isFinite(tzOffset)) params.tzOffset = tzOffset;

  const { data } = await axios.get(`${BASE_URL}/api/profiles/page-set-stats`, {
    params,
    timeout: 15000,
  });
  const parsed = typeof data === 'string' ? JSON.parse(data) : data;
  const out = parsed.data || parsed;
  return {
    date: out.date || date,
    passed: Number(out.passed) || 0,
    failed: Number(out.failed) || 0,
    total: Number(out.total) || 0,
  };
}

/**
 * Auto-assign the newest unowned post matching the profile's country to a
 * profile (US profiles also match country-less posts). Server picks + links
 * the post and returns it populated. Used by publish_post to obtain a post to
 * publish when the profile doesn't already own one.
 *
 * @param {string} profileId
 * @returns {Promise<{status:'assigned'|'owns'|'none'|'error', post?:Object, detail?:string}>}
 *   - 'assigned' (200) — `post` is the newly assigned post
 *   - 'owns'     (409, "already owns a post") — profile already has a post → publish that
 *   - 'none'     (409, "no matching unassigned post") — nothing to assign → skip
 *   - 'error'    (400/404/other) — skip
 */
async function autoAssignPostToProfile(profileId) {
  if (!BASE_URL) throw new Error('USER_API_BASE_URL is not set in .env');
  if (!profileId) {
    console.warn('  [posts] autoAssignPostToProfile: no profileId — skipping');
    return { status: 'error', detail: 'no profileId' };
  }

  try {
    const { data } = await axios.post(
      `${BASE_URL}/api/posts/auto-assign-to-profile`,
      { profileId },
      { timeout: 15000 }
    );
    const parsed = typeof data === 'string' ? JSON.parse(data) : data;
    return { status: 'assigned', post: parsed.data || parsed };
  } catch (err) {
    const code = err.response?.status;
    const detail = err.response?.data?.message || err.message;
    if (code === 409) {
      // 409 covers two cases — distinguish by message so the caller can tell
      // "profile already has a post to publish" (continue) from "nothing to
      // assign for this country" (skip).
      if (/already|owns/i.test(detail)) {
        console.log(`  [posts] auto-assign: profile already owns a post (409): ${detail}`);
        return { status: 'owns', detail };
      }
      console.log(`  [posts] auto-assign: no unassigned post available (409): ${detail}`);
      return { status: 'none', detail };
    }
    if (code === 404) {
      console.warn(`  [posts] auto-assign: profile not found (404): ${detail}`);
    } else if (code === 400) {
      console.warn(`  [posts] auto-assign: invalid profile id (400): ${detail}`);
    } else {
      console.warn(`  [posts] auto-assign failed (${code || 'no-status'}): ${detail}`);
    }
    return { status: 'error', detail };
  }
}

module.exports = {
  fetchUser,
  autoAssignPage,
  autoAssignPostToProfile,
  fetchPageSetStats,
  fetchActiveProfiles,
  fetchProfilesByStatus,
  updateProfile,
  recordFriendRequest,
  updateFriendRequestStatus,
  fetchSharerUrls,
  deleteSharerByUrl,
  setOnboarding,
};
