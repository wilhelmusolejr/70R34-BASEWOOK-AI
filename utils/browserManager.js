/**
 * Browser connection manager - the ONLY file that knows about Hidemium.
 * Opens profiles via Hidemium API and connects via CDP.
 */

const axios = require('axios');
const { chromium } = require('playwright');
const { fetchUser } = require('./userApi');
require('dotenv').config();

const USER_API_BASE_URL = process.env.USER_API_BASE_URL;

// Hidemium API configuration
const API = 'http://127.0.0.1:2222';
const API_TOKEN = 'pMgajBtFminGid3d6Wh0zFu2gPGx3BhUt3KX0S'; // Edit this: Hidemium Settings > Generate token

const headers = { Authorization: `Bearer ${API_TOKEN}` };

const OPEN_PROFILE_ATTEMPTS = 3;
const OPEN_PROFILE_RETRY_MS = 5000;

const PROXY_BATCH_SIZE = 10;
const MAX_PROXY_BATCHES = 5;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

/**
 * Parse "host:port:user:pass" proxy string into axios proxy config.
 */
function parseProxyString(proxyString) {
  const parts = proxyString.split(':');
  if (parts.length !== 4) {
    throw new Error(`Invalid proxy format. Expected host:port:user:pass, got: "${proxyString}"`);
  }
  const [host, port, username, password] = parts;
  return {
    host,
    port: parseInt(port, 10),
    auth: { username, password },
    protocol: 'http',
  };
}

/**
 * Test a proxy by fetching ipinfo.io through it.
 * Returns the ipinfo JSON if reachable, throws otherwise.
 */
async function testProxy(proxyString) {
  const proxyConfig = parseProxyString(proxyString);

  console.log(`[browserManager] Testing proxy ${proxyConfig.host}:${proxyConfig.port}...`);

  const { data } = await axios.get('https://ipinfo.io/json', {
    proxy: proxyConfig,
    timeout: 20000,
  });

  if (!data || !data.ip) {
    throw new Error(`ipinfo.io returned no IP through proxy`);
  }

  console.log(`[browserManager] Proxy OK — IP ${data.ip} (${data.city || '?'}, ${data.region || '?'}, ${data.country || '?'})`);
  return data;
}

/**
 * Fetch a batch of pending proxies from the user API.
 * Each item is expected to have `_id` and `proxy` (host:port:user:pass).
 */
async function fetchPendingProxies(limit = PROXY_BATCH_SIZE) {
  if (!USER_API_BASE_URL) {
    throw new Error('USER_API_BASE_URL not set — cannot fetch pending proxies');
  }
  const { data } = await axios.get(`${USER_API_BASE_URL}/api/proxies`, {
    params: { status: 'pending', limit },
  });
  if (Array.isArray(data)) return data;
  return data.proxies || data.data || [];
}

/**
 * Update a single proxy's status (e.g. "active" | "dead").
 * Also stamps lastCheckedAt and optionally lastKnownIp so the DB shows
 * when we last hit the proxy and what IP it resolved to.
 * Failures are logged, not thrown — the caller should keep going.
 */
async function updateProxyStatus(proxyId, status, lastKnownIp) {
  if (!USER_API_BASE_URL) return;
  const payload = { status, lastCheckedAt: new Date().toISOString() };
  if (lastKnownIp) payload.lastKnownIp = lastKnownIp;
  try {
    await axios.patch(`${USER_API_BASE_URL}/api/proxies/${proxyId}`, payload);
    console.log(`[browserManager] Proxy ${proxyId} → ${status}${lastKnownIp ? ` (${lastKnownIp})` : ''}`);
  } catch (err) {
    const respBody = err.response?.data ? JSON.stringify(err.response.data) : err.message;
    console.warn(`[browserManager] PATCH proxy status failed (${proxyId} → ${status}): ${respBody}`);
  }
}

/**
 * Append a proxy reference to user.proxies without replacing the existing array.
 * `existingProxies` may be populated objects or raw IDs — both are handled.
 */
async function assignProxyToUser(userId, newProxyId, existingProxies = []) {
  if (!USER_API_BASE_URL) return;
  const existingIds = (existingProxies || [])
    .map((p) => (typeof p === 'string' ? p : p?._id))
    .filter(Boolean);
  try {
    await axios.patch(`${USER_API_BASE_URL}/api/profiles/${userId}`, {
      proxies: [...existingIds, newProxyId],
    });
    console.log(`[browserManager] Proxy ${newProxyId} assigned to user ${userId}`);
  } catch (err) {
    const respBody = err.response?.data ? JSON.stringify(err.response.data) : err.message;
    console.warn(`[browserManager] PATCH user proxies failed: ${respBody}`);
  }
}

/**
 * Pull pending proxies in batches of 10, test each via ipinfo.
 * - Working + matches requireCountry → mark "active", assign to user, return
 * - Fails to fetch ipinfo                → mark "dead", continue
 * - Works but wrong country              → leave status as pending, continue
 * Gives up after MAX_PROXY_BATCHES rounds.
 */
async function selectWorkingProxy(userId, existingProxies, { requireCountry = 'US' } = {}) {
  for (let round = 1; round <= MAX_PROXY_BATCHES; round++) {
    const batch = await fetchPendingProxies(PROXY_BATCH_SIZE);
    if (!batch.length) {
      console.log(`[browserManager] No more pending proxies available (round ${round})`);
      break;
    }
    console.log(`[browserManager] Testing ${batch.length} proxies (round ${round}/${MAX_PROXY_BATCHES})`);

    for (const record of batch) {
      const proxyString = record.proxy;
      const proxyId = record._id;

      if (!proxyString || !proxyId) {
        console.warn(`[browserManager] Proxy record missing fields, skipping:`, record);
        continue;
      }

      let ipInfo;
      try {
        ipInfo = await testProxy(proxyString);
      } catch (err) {
        console.warn(`[browserManager] Proxy ${proxyId} dead: ${err.message}`);
        await updateProxyStatus(proxyId, 'dead');
        continue;
      }

      if (requireCountry && ipInfo.country !== requireCountry) {
        console.warn(`[browserManager] Proxy ${proxyId} in ${ipInfo.country} (need ${requireCountry}) — skipping`);
        continue;
      }

      await updateProxyStatus(proxyId, 'active', ipInfo.ip);
      await assignProxyToUser(userId, proxyId, existingProxies);

      return { proxyString, proxyId, ipInfo };
    }
  }

  throw new Error(
    `No working ${requireCountry || ''} proxy found after ${MAX_PROXY_BATCHES} batches of ${PROXY_BATCH_SIZE}`
  );
}

/**
 * Format ipinfo JSON into multiline "key: value" note.
 */
function formatIpInfoNote(info) {
  const fields = ['ip', 'hostname', 'city', 'region', 'country', 'loc', 'org', 'postal', 'timezone'];
  return fields.map((k) => `${k}: ${info[k] ?? ''}`).join('\n');
}

/**
 * Create a Hidemium profile optimized for Facebook multi-account use.
 *
 * Pulls a working proxy from the shared pool (GET /api/proxies?status=pending)
 * in batches of 10, testing each via ipinfo.io. The first reachable + correct-
 * country proxy is marked "active", appended to user.proxies (reference, not
 * replace), and used for the Hidemium profile. Unreachable proxies are marked
 * "dead". Gives up after 5 batches (50 proxies).
 *
 * - Windows 10/11 + Chrome, randomized hardware per profile
 * - Canvas noise (unique per profile), spoofed WebGL/audio/fonts/clientRects
 * - Timezone + geolocation auto-derived from proxy IP by Hidemium
 *
 * @param {string} userId - 3rd party API user ID
 * @param {object} [opts]
 * @param {boolean} [opts.isLocal=true] - local profile (lifetime plan) vs cloud (metered)
 * @param {string} [opts.requireCountry="US"] - 2-letter country, pass null to skip
 * @returns {Promise<{uuid: string, ipInfo: object, body: object, user: object}>}
 */
async function createProfile(userId, { isLocal = true, requireCountry = 'US' } = {}) {
  if (!userId) throw new Error('userId is required');

  const user = await fetchUser(userId);
  const firstName = user.firstName;
  const lastName = user.lastName;

  if (!firstName || !lastName) {
    throw new Error(`User ${userId} is missing firstName/lastName`);
  }

  const { proxyString: proxy, ipInfo } = await selectWorkingProxy(
    userId,
    user.proxies || [],
    { requireCountry }
  );

  const [host, port, proxyUser, proxyPass] = proxy.split(':');
  const hidemiumProxy = `HTTP|${host}|${port}|${proxyUser}|${proxyPass}`;

  const note = formatIpInfoNote(ipInfo);

  const body = {
    name: `${firstName} ${lastName}`,
    os: 'win',
    osVersion: pick(['10', '11']),
    browser: 'chrome',
    version: '136',

    canvas: 'noise',
    webGLImage: true,
    webGLMetadata: true,
    audioContext: true,
    clientRectsEnable: true,
    noiseFont: true,

    hardwareConcurrency: pick([4, 8, 12, 16]),
    deviceMemory: pick([4, 8, 16]),
    resolution: pick(['1920x1080', '1366x768', '1536x864', '2560x1440']),

    proxy: hidemiumProxy,
    language: 'en-US',
    StartURL: 'https://www.facebook.com',

    disableAutofillPopup: true,
  };

  const url = `${API}/create-profile-custom?is_local=${isLocal ? 'true' : 'false'}`;

  let data;
  try {
    ({ data } = await axios.post(url, body, { headers }));
  } catch (err) {
    if (err.response) {
      console.error('[browserManager] Hidemium rejected body:', JSON.stringify(body, null, 2));
      console.error('[browserManager] Hidemium response body:', JSON.stringify(err.response.data, null, 2));
      throw new Error(
        `Hidemium ${err.response.status}: ${JSON.stringify(err.response.data)}`
      );
    }
    throw err;
  }

  // create-profile-custom returns the profile object directly on success
  const uuid = data.uuid || data.data?.uuid;
  if (!uuid) {
    throw new Error(`Failed to create profile — no UUID in response: ${JSON.stringify(data)}`);
  }
  console.log(`[browserManager] Profile created: "${body.name}" (${uuid.slice(-8)})`);

  // Note isn't accepted on create-profile-custom — try the update-note endpoint
  try {
    await axios.post(`${API}/update-note`, { uuid, note }, { headers });
    console.log(`[browserManager] Note set for ${uuid.slice(-8)}`);
  } catch (err) {
    const status = err.response?.status;
    const respBody = err.response?.data ? JSON.stringify(err.response.data) : err.message;
    console.warn(`[browserManager] update-note failed (${status ?? 'no response'}): ${respBody}`);
    console.warn('[browserManager] Profile created, but note was not saved. Tell Claude this so the endpoint name can be fixed.');
  }

  // Persist browser back to the user record so tasks.json can find it via userId
  if (!USER_API_BASE_URL) {
    console.warn('[browserManager] USER_API_BASE_URL not set — skipping browsers PATCH');
  } else {
    try {
      await axios.patch(`${USER_API_BASE_URL}/api/profiles/${userId}`, {
        browsers: [{ browserId: uuid, provider: 'hidemium' }],
      });
      console.log(`[browserManager] User ${userId} browsers updated → ${uuid}`);
    } catch (err) {
      const status = err.response?.status;
      const respBody = err.response?.data ? JSON.stringify(err.response.data) : err.message;
      console.warn(`[browserManager] PATCH browsers failed (${status ?? 'no response'}): ${respBody}`);
    }
  }

  return { uuid, ipInfo, body, note, user };
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
  createProfile,
  testProxy,
};
