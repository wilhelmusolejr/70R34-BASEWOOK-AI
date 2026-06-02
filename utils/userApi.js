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
 * Valid keys (see server/src/models/Profile.js):
 *   privacyPublicAt, profileImageSetAt, coverImageSetAt, aboutSetAt,
 *   marketplaceSetAt, groupJoinedAt, highlightsSetAt, publishPostAt,
 *   recoveryEmailSetAt, lastSharedAt
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

module.exports = {
  fetchUser,
  fetchActiveProfiles,
  fetchProfilesByStatus,
  updateProfile,
  recordFriendRequest,
  updateFriendRequestStatus,
  fetchSharerUrls,
  deleteSharerByUrl,
  setOnboarding,
};
