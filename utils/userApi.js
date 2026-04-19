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

module.exports = { fetchUser };
