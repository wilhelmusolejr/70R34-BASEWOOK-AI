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
 * Fetch N random Active profiles from the DB and return their profileUrls
 * (empty/null profileUrls filtered out).
 *
 * @param {number} limit — how many rows to request from the API (default 5)
 * @returns {Promise<string[]>} — list of valid profileUrl strings
 */
async function fetchActiveProfileUrls(limit = 5) {
  if (!BASE_URL) throw new Error('USER_API_BASE_URL is not set in .env');

  const { data } = await axios.get(`${BASE_URL}/api/profiles`, {
    params: { status: 'Active', limit, random: 1 }
  });

  const parsed = typeof data === 'string' ? JSON.parse(data) : data;
  const list = parsed.data || parsed;

  return (Array.isArray(list) ? list : [])
    .map(u => u && u.profileUrl)
    .filter(u => typeof u === 'string' && u.trim().length > 0);
}

module.exports = { fetchUser, fetchActiveProfileUrls };
