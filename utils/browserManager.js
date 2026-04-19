/**
 * Browser connection manager - the ONLY file that knows about Hidemium.
 * Opens profiles via Hidemium API and connects via CDP.
 */

const axios = require("axios");
const { chromium } = require("playwright");
const profiles = require("../config/profiles.json");

// Hidemium API configuration
const API = "http://127.0.0.1:2222";
const API_TOKEN = "pMgajBtFminGid3d6Wh0zFu2gPGx3BhUt3KX0S"; // Edit this: Hidemium Settings > Generate token

const headers = { Authorization: `Bearer ${API_TOKEN}` };

const OPEN_PROFILE_ATTEMPTS = 3;
const OPEN_PROFILE_RETRY_MS = 5000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Open a single Hidemium profile via API and connect via CDP.
 *
 * @param {string} uuid - Profile UUID
 * @returns {Promise<{browser, context, page, port, profileId}>}
 */
async function openProfile(uuid) {
  let lastError;

  for (let attempt = 1; attempt <= OPEN_PROFILE_ATTEMPTS; attempt++) {
    let browser;

    try {
      const { data } = await axios.get(`${API}/openProfile?uuid=${uuid}`, {
        headers,
      });

      if (data.status !== "successfully") {
        throw new Error(`Failed to open ${uuid}: ${JSON.stringify(data)}`);
      }

      const port = data.data.remote_port;
      console.log(
        `[browserManager] Profile ${uuid.slice(-8)} opened on port ${port}`,
      );

      browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);

      // Get existing context or use first one
      const context = browser.contexts()[0];
      if (!context) {
        throw new Error("No browser context available after connecting");
      }

      // Get existing page or create one
      let page = context.pages()[0];
      if (!page) {
        page = await context.newPage();
      }

      return {
        browser,
        context,
        page,
        port,
        profileId: uuid,
      };
    } catch (error) {
      lastError = error;

      if (browser) {
        await browser.close().catch(() => {});
      }

      console.error(
        `[browserManager] Open profile failed for ${uuid.slice(-8)} (attempt ${attempt}/${OPEN_PROFILE_ATTEMPTS}): ${error.message}`,
      );

      if (attempt >= OPEN_PROFILE_ATTEMPTS) {
        break;
      }

      console.log(
        `[browserManager] Retrying in ${OPEN_PROFILE_RETRY_MS / 1000}s...`,
      );
      await sleep(OPEN_PROFILE_RETRY_MS);
    }
  }

  throw lastError;
}

/**
 * Close a Hidemium profile.
 *
 * @param {string} uuid - Profile UUID
 * @param {object} browser - Playwright browser instance (optional)
 */
async function closeProfile(uuid, browser) {
  if (browser) {
    await browser.close().catch(() => {});
  }
  await axios
    .get(`${API}/closeProfile?uuid=${uuid}`, { headers })
    .catch(() => {});
  console.log(`[browserManager] Profile ${uuid.slice(-8)} closed`);
}

/**
 * List all profiles from Hidemium API.
 *
 * @returns {Promise<Array>}
 */
async function listProfiles() {
  const { data } = await axios.get(`${API}/profiles`, { headers });
  return data.data || [];
}

/**
 * Open `count` Hidemium profiles and return connected browser instances.
 * Uses profiles from config/profiles.json.
 *
 * @param {number} count - Number of browsers to open
 * @returns {Promise<Array<{browser, context, page, port, profileId}>>}
 */
async function launchBrowsers(count) {
  const availableProfiles = profiles.slice(0, count);

  if (availableProfiles.length < count) {
    console.warn(
      `[browserManager] Requested ${count} browsers but only ${availableProfiles.length} profiles configured`,
    );
  }

  const connections = await Promise.allSettled(
    availableProfiles.map((profile) => openProfile(profile.id)),
  );

  // Filter successful connections
  const successful = [];
  for (let i = 0; i < connections.length; i++) {
    const result = connections[i];
    if (result.status === "fulfilled") {
      successful.push(result.value);
    } else {
      console.error(
        `[browserManager] Failed to connect to profile ${availableProfiles[i].id}:`,
        result.reason.message,
      );
    }
  }

  if (successful.length === 0) {
    throw new Error(
      "Could not connect to any Hidemium profiles. Make sure Hidemium is running and API token is correct.",
    );
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
    sessions.map((session) => closeProfile(session.profileId, session.browser)),
  );
}

module.exports = {
  openProfile,
  closeProfile,
  listProfiles,
  launchBrowsers,
  closeBrowsers,
};
