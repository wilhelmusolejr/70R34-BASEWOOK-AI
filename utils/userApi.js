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
async function fetchActiveProfiles(limit = 5) {
  if (!BASE_URL) throw new Error('USER_API_BASE_URL is not set in .env');

  const STATUSES = ['Active', 'Need Setup'];

  const responses = await Promise.allSettled(
    STATUSES.map((status) =>
      axios.get(`${BASE_URL}/api/profiles`, {
        params: { status, limit, random: 1 },
      })
    )
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

module.exports = {
  fetchUser,
  fetchActiveProfiles,
  updateProfile,
  recordFriendRequest,
  updateFriendRequestStatus,
};
