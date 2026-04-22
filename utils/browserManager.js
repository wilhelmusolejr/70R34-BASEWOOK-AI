/**
 * Browser connection manager - the only file that knows about Hidemium.
 * Opens profiles via Hidemium API and connects via CDP.
 */

const axios = require('axios');
const { chromium } = require('playwright');
const { fetchUser } = require('./userApi');
require('dotenv').config();

const USER_API_BASE_URL = process.env.USER_API_BASE_URL;

// Hidemium API configuration
const API = 'http://127.0.0.1:2222';
const API_TOKEN = 'pMgajBtFminGid3d6Wh0zFu2gPGx3BhUt3KX0S';

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

function normalizeProxyRecord(record) {
  if (!record || typeof record !== 'object') {
    return { proxyId: null, proxyString: null };
  }

  const proxyId = record._id || record.id || null;
  const proxyString = record.proxy || (
    record.host && record.port && record.username && record.password
      ? `${record.host}:${record.port}:${record.username}:${record.password}`
      : null
  );

  return { proxyId, proxyString };
}

function formatErrorDetails(err) {
  if (!err) return 'Unknown error';

  const parts = [];
  if (err.code) parts.push(`code=${err.code}`);
  if (err.message) parts.push(`message=${err.message}`);

  const status = err.response?.status;
  if (status) parts.push(`status=${status}`);

  const responseData = err.response?.data;
  if (responseData !== undefined) {
    try {
      parts.push(`response=${JSON.stringify(responseData)}`);
    } catch (_) {
      parts.push(`response=${String(responseData)}`);
    }
  }

  if (err.cause?.code) parts.push(`causeCode=${err.cause.code}`);
  if (err.cause?.message) parts.push(`causeMessage=${err.cause.message}`);

  return parts.join(' | ') || String(err);
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

  console.log(`[browserManager] ipinfo raw response: ${JSON.stringify(data)}`);

  if (!data || !data.ip) {
    throw new Error('ipinfo.io returned no IP through proxy');
  }

  console.log(`[browserManager] Proxy OK - IP ${data.ip} (${data.city || '?'}, ${data.region || '?'}, ${data.country || '?'})`);
  return data;
}

/**
 * Fetch pending proxies from the user API.
 * Supports either:
 * - { _id, proxy }
 * - { id, host, port, username, password }
 */
async function fetchPendingProxies(limit = PROXY_BATCH_SIZE, country) {
  if (!USER_API_BASE_URL) {
    throw new Error('USER_API_BASE_URL not set - cannot fetch pending proxies');
  }

  const { data } = await axios.get(`${USER_API_BASE_URL}/api/proxies`, {
    params: {
      status: 'pending',
      limit,
      ...(country ? { country } : {}),
    },
  });

  if (Array.isArray(data)) return data;
  return data.proxies || data.data || [];
}

/**
 * Update a single proxy's status.
 */
async function updateProxyStatus(proxyId, status, lastKnownIp) {
  if (!USER_API_BASE_URL) return;

  const payload = { status, lastCheckedAt: new Date().toISOString() };
  if (lastKnownIp) payload.lastKnownIp = lastKnownIp;

  try {
    await axios.patch(`${USER_API_BASE_URL}/api/proxies/${proxyId}`, payload);
    console.log(`[browserManager] Proxy ${proxyId} -> ${status}${lastKnownIp ? ` (${lastKnownIp})` : ''}`);
  } catch (err) {
    const respBody = err.response?.data ? JSON.stringify(err.response.data) : err.message;
    console.warn(`[browserManager] PATCH proxy status failed (${proxyId} -> ${status}): ${respBody}`);
  }
}

/**
 * Attach a proxy to a user via the dedicated endpoint.
 * Backend is expected to append a proxy reference onto user.proxies.
 */
async function assignProxyToUser(userId, proxyString, ipInfo = {}) {
  if (!USER_API_BASE_URL) return null;

  const [host, port, username, password] = proxyString.split(':');
  const payload = {
    host,
    port: parseInt(port, 10),
    username,
    password,
    protocol: 'http',
    status: 'active',
  };

  if (ipInfo.country) payload.country = ipInfo.country;
  if (ipInfo.city) payload.city = ipInfo.city;

  try {
    const { data } = await axios.post(
      `${USER_API_BASE_URL}/api/profiles/${userId}/proxies`,
      payload
    );
    console.log(`[browserManager] Proxy ${host}:${port} attached to user ${userId}`);
    return data;
  } catch (err) {
    console.warn(`[browserManager] POST attach proxy failed: ${formatErrorDetails(err)}`);
    return null;
  }
}

/**
 * Pull pending proxies in batches of 10, already filtered by country.
 * - Working + matches requireCountry -> mark active, assign to user, return
 * - Fails to fetch ipinfo -> mark dead, continue
 * - Works but wrong country -> leave pending, continue
 */
async function selectWorkingProxy(userId, { requireCountry = 'US' } = {}) {
  for (let round = 1; round <= MAX_PROXY_BATCHES; round++) {
    const batch = await fetchPendingProxies(PROXY_BATCH_SIZE, requireCountry);
    if (!batch.length) {
      console.log(`[browserManager] No more pending proxies available (round ${round})`);
      break;
    }

    console.log(`[browserManager] Testing ${batch.length} proxies (round ${round}/${MAX_PROXY_BATCHES})`);

    for (const record of batch) {
      const { proxyString, proxyId } = normalizeProxyRecord(record);

      if (!proxyString || !proxyId) {
        console.warn('[browserManager] Proxy record missing fields, skipping:', record);
        continue;
      }

      let ipInfo;
      try {
        ipInfo = await testProxy(proxyString);
      } catch (err) {
        console.warn(`[browserManager] Proxy ${proxyId} test failed: ${formatErrorDetails(err)}`);
        await updateProxyStatus(proxyId, 'dead');
        continue;
      }

      if (requireCountry && ipInfo.country !== requireCountry) {
        console.warn(`[browserManager] Proxy ${proxyId} in ${ipInfo.country} (need ${requireCountry}) - skipping`);
        continue;
      }

      await updateProxyStatus(proxyId, 'active', ipInfo.ip);
      await assignProxyToUser(userId, proxyString, ipInfo);

      return { proxyString, proxyId, ipInfo };
    }
  }

  throw new Error(
    `No working ${requireCountry || ''} proxy found after ${MAX_PROXY_BATCHES} batches of ${PROXY_BATCH_SIZE}`
  );
}

/**
 * Format ipinfo JSON into multiline note text.
 */
function formatIpInfoNote(info) {
  const fields = ['ip', 'hostname', 'city', 'region', 'country', 'loc', 'org', 'postal', 'timezone'];
  return fields.map((key) => `${key}: ${info[key] ?? ''}`).join('\n');
}

/**
 * Create a Hidemium profile optimized for Facebook multi-account use.
 */
async function createProfile(userId, { isLocal = true, requireCountry = 'US' } = {}) {
  if (!userId) throw new Error('userId is required');

  const user = await fetchUser(userId);
  const firstName = user.firstName;
  const lastName = user.lastName;

  if (!firstName || !lastName) {
    throw new Error(`User ${userId} is missing firstName/lastName`);
  }

  let proxy = null;
  let ipInfo = null;

  try {
    ({ proxyString: proxy, ipInfo } = await selectWorkingProxy(userId, { requireCountry }));
  } catch (err) {
    console.warn(`[browserManager] Proceeding without proxy: ${err.message}`);
  }

  const note = ipInfo ? formatIpInfoNote(ipInfo) : '';

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
    language: 'en-US',
    StartURL: 'https://outlook.com',
    disableAutofillPopup: true,
  };

  if (proxy) {
    const [host, port, proxyUser, proxyPass] = proxy.split(':');
    body.proxy = `HTTP|${host}|${port}|${proxyUser}|${proxyPass}`;
  } else {
    console.log('[browserManager] Creating profile with empty proxy settings');
  }

  const url = `${API}/create-profile-custom?is_local=${isLocal ? 'true' : 'false'}`;

  let data;
  try {
    ({ data } = await axios.post(url, body, { headers }));
  } catch (err) {
    if (err.response) {
      console.error('[browserManager] Hidemium rejected body:', JSON.stringify(body, null, 2));
      console.error('[browserManager] Hidemium response body:', JSON.stringify(err.response.data, null, 2));
      throw new Error(`Hidemium ${err.response.status}: ${JSON.stringify(err.response.data)}`);
    }
    throw err;
  }

  // Hidemium docs consistently identify profiles by uuid. For local profiles,
  // some newer endpoints/examples show a local-* browser_uuid, so accept both.
  const browserId = data.browser_uuid || data.uuid || data.data?.browser_uuid || data.data?.uuid;
  if (!browserId) {
    throw new Error(`Failed to create profile - no browser ID in response: ${JSON.stringify(data)}`);
  }
  console.log(`[browserManager] Profile created: "${body.name}" (${browserId.slice(-8)})`);

  if (note) {
    try {
      await axios.post(`${API}/update-note`, { uuid: browserId, note }, { headers });
      console.log(`[browserManager] Note set for ${browserId.slice(-8)}`);
    } catch (err) {
      const status = err.response?.status;
      const respBody = err.response?.data ? JSON.stringify(err.response.data) : err.message;
      console.warn(`[browserManager] update-note failed (${status ?? 'no response'}): ${respBody}`);
      console.warn('[browserManager] Profile created, but note was not saved. Tell Claude this so the endpoint name can be fixed.');
    }
  } else {
    console.log('[browserManager] Skipping proxy note because no working proxy info was collected');
  }

  if (!USER_API_BASE_URL) {
    console.warn('[browserManager] USER_API_BASE_URL not set - skipping browsers PATCH');
  } else {
    try {
      await axios.patch(`${USER_API_BASE_URL}/api/profiles/${userId}`, {
        browsers: [{ browserId, provider: 'hidemium' }],
      });
      console.log(`[browserManager] User ${userId} browsers updated -> ${browserId}`);
    } catch (err) {
      const status = err.response?.status;
      const respBody = err.response?.data ? JSON.stringify(err.response.data) : err.message;
      console.warn(`[browserManager] PATCH browsers failed (${status ?? 'no response'}): ${respBody}`);
    }
  }

  return { uuid: browserId, browserId, ipInfo, body, note, user };
}

/**
 * Open a single Hidemium profile via API and connect via CDP.
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
 */
async function closeProfile(uuid, browser) {
  if (browser) await browser.close().catch(() => {});
  await axios.get(`${API}/closeProfile?uuid=${uuid}`, { headers }).catch(() => {});
  console.log(`[browserManager] Profile ${uuid.slice(-8)} closed`);
}

/**
 * Open browsers for an explicit list of userIds.
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
        console.error('  API body   :', err.response.data);
      }
      console.error('  stack   :', err.stack);
    }
  }

  if (successful.length === 0) {
    throw new Error('Could not connect to any profiles. Make sure Hidemium is running and API token is correct.');
  }

  return successful;
}

/**
 * Close all browser sessions.
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
