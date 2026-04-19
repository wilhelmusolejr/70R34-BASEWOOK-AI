/**
 * Browser connection manager - the ONLY file that knows about Hidemium.
 * Opens profiles via Hidemium API and connects via CDP.
 */

const axios = require('axios');
const { chromium } = require('playwright');
const { fetchUser } = require('./userApi');

// Hidemium API configuration
const API = 'http://127.0.0.1:2222';
const API_TOKEN = 'pMgajBtFminGid3d6Wh0zFu2gPGx3BhUt3KX0S'; // Edit this: Hidemium Settings > Generate token

const headers = { Authorization: `Bearer ${API_TOKEN}` };

const OPEN_PROFILE_ATTEMPTS = 3;
const OPEN_PROFILE_RETRY_MS = 5000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Open a single Hidemium profile via API and connect via CDP.
 *
 * @param {string} uuid - Hidemium profile UUID
 * @returns {Promise<{browser, context, page, port, profileId}>}
 */
async function openProfile(uuid) {
  let lastError;

  for (let attempt = 1; attempt <= OPEN_PROFILE_ATTEMPTS; attempt++) {
    let browser;

    try {
      const { data } = await axios.get(`${API}/openProfile?uuid=${uuid}`, { headers });

      if (data.status !== 'successfully') {
        throw new Error(`Failed to open ${uuid}: ${JSON.stringify(data)}`);
      }

      const port = data.data.remote_port;
      console.log(`[browserManager] Profile ${uuid.slice(-8)} opened on port ${port}`);

      browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);

      const context = browser.contexts()[0];
      if (!context) throw new Error('No browser context available after connecting');

      let page = context.pages()[0];
      if (!page) page = await context.newPage();

      return { browser, context, page, port, profileId: uuid };

    } catch (error) {
      lastError = error;
      if (browser) await browser.close().catch(() => {});

      console.error(`[browserManager] Open profile failed for ${uuid.slice(-8)} (attempt ${attempt}/${OPEN_PROFILE_ATTEMPTS}): ${error.message}`);

      if (attempt >= OPEN_PROFILE_ATTEMPTS) break;

      console.log(`[browserManager] Retrying in ${OPEN_PROFILE_RETRY_MS / 1000}s...`);
      await sleep(OPEN_PROFILE_RETRY_MS);
    }
  }

  throw lastError;
}

/**
 * Open a browser for a given userId.
 * Fetches the user from the API, resolves provider + browsers[0], connects.
 *
 * @param {string} userId - 3rd party API user ID
 * @returns {Promise<{browser, context, page, port, profileId, user}>}
 */
async function openBrowserForUser(userId) {
  const user = await fetchUser(userId);

  if (!user.browsers || user.browsers.length === 0) {
    throw new Error(`User ${userId} (${user.firstName} ${user.lastName}) has no browsers configured`);
  }

  const { browserId, provider } = user.browsers[0];
  const resolvedProvider = provider || 'hidemium';

  if (resolvedProvider !== 'hidemium') {
    throw new Error(`Unsupported browser provider: "${resolvedProvider}"`);
  }

  console.log(`[browserManager] Opening browser for ${user.firstName} ${user.lastName} (${resolvedProvider}: ${browserId.slice(-8)})`);

  const session = await openProfile(browserId);
  return { ...session, user };
}

/**
 * Close a Hidemium profile.
 *
 * @param {string} uuid - Profile UUID
 * @param {object} browser - Playwright browser instance (optional)
 */
async function closeProfile(uuid, browser) {
  if (browser) await browser.close().catch(() => {});
  await axios.get(`${API}/closeProfile?uuid=${uuid}`, { headers }).catch(() => {});
  console.log(`[browserManager] Profile ${uuid.slice(-8)} closed`);
}

/**
 * Open browsers for an explicit list of userIds.
 * Fetches each user from the API, resolves their browser, connects.
 *
 * @param {string[]} userIds - Array of 3rd party API user IDs
 * @returns {Promise<Array<{browser, context, page, port, profileId, user}>>}
 */
async function launchBrowsers(userIds) {
  const connections = await Promise.allSettled(
    userIds.map((userId) => openBrowserForUser(userId))
  );

  const successful = [];
  for (let i = 0; i < connections.length; i++) {
    const result = connections[i];
    if (result.status === 'fulfilled') {
      successful.push(result.value);
    } else {
      const err = result.reason;
      console.error(`[browserManager] Failed for userId ${userIds[i]}:`);
      console.error(`  message : ${err.message || '(none)'}`);
      if (err.response) {
        console.error(`  API status : ${err.response.status}`);
        console.error(`  API body   :`, err.response.data);
      }
      console.error(`  stack   :`, err.stack);
    }
  }

  if (successful.length === 0) {
    throw new Error('Could not connect to any profiles. Make sure Hidemium is running and API token is correct.');
  }

  return successful;
}

/**
 * Close all browser sessions.
 *
 * @param {Array<{browser, profileId}>} sessions
 */
async function closeBrowsers(sessions) {
  await Promise.allSettled(
    sessions.map((session) => closeProfile(session.profileId, session.browser))
  );
}

module.exports = {
  openProfile,
  closeProfile,
  launchBrowsers,
  closeBrowsers,
};
