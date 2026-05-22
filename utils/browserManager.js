/**
 * Browser connection manager - the only file that knows about Hidemium.
 * Opens profiles via Hidemium API and connects via CDP.
 */

const axios = require('axios');
const crypto = require('crypto');
const { exec } = require('child_process');
const { promisify } = require('util');
const { chromium } = require('playwright');
const { fetchUser } = require('./userApi');
require('dotenv').config();

const execAsync = promisify(exec);

const USER_API_BASE_URL = process.env.USER_API_BASE_URL;

const BROWSER_PROVIDER = (process.env.BROWSER_PROVIDER || 'hidemium').toLowerCase();

// Hidemium API configuration
const API = process.env.HIDEMIUM_API_URL || 'http://127.0.0.1:2222';
const API_TOKEN = process.env.HIDEMIUM_API_TOKEN || 'pMgajBtFminGid3d6Wh0zFu2gPGx3BhUt3KX0S';

const headers = { Authorization: `Bearer ${API_TOKEN}` };

// Multilogin X API configuration
const MLX_SIGNIN_URL = 'https://api.multilogin.com/user/signin';
const MLX_REFRESH_TOKEN_URL = 'https://api.multilogin.com/user/refresh_token';
const MLX_LAUNCHER = 'https://launcher.mlx.yt:45001';
const MLX_API = 'https://api.multilogin.com';
const MLX_PROXY_GEN_URL = 'https://profile-proxy.multilogin.com/v1/proxy/connection_url';
let mlxToken = null;

const OPEN_PROFILE_ATTEMPTS = 3;
const OPEN_PROFILE_RETRY_MS = 5000;

/**
 * Stealth init script. Runs in EVERY page on EVERY new document load — before
 * any site JS executes. Patches the signals that Chromium flips on when a CDP
 * debugger attaches (Playwright over CDP triggers all of these), which is what
 * Facebook's "third-party automation" detector reads.
 *
 * Defined as a string so it's evaluated fresh in each page context, with no
 * closure leaks back to the Node side.
 */
const STEALTH_INIT_SCRIPT = `(() => {
  try {
    // 1. navigator.webdriver — THE signal. CDP attach flips this to true even
    //    when Chrome was launched with --disable-blink-features=AutomationControlled.
    Object.defineProperty(Navigator.prototype, 'webdriver', {
      get: () => false,
      configurable: true,
      enumerable: true,
    });

    // 2. window.chrome — real Chrome has this object populated. Patched Chrome
    //    under CDP can show it as undefined or stripped.
    if (!window.chrome) {
      window.chrome = {};
    }
    if (!window.chrome.runtime) {
      window.chrome.runtime = {
        OnInstalledReason: {},
        OnRestartRequiredReason: {},
        PlatformArch: {},
        PlatformNaclArch: {},
        PlatformOs: {},
        RequestUpdateCheckStatus: {},
      };
    }
    if (!window.chrome.app) {
      window.chrome.app = {
        InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' },
        RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' },
        isInstalled: false,
      };
    }

    // 3. navigator.permissions.query for 'notifications' — well-known
    //    automation tell. Headless/automated Chrome returns 'denied' here when
    //    a real Chrome returns 'default' unless the user changed it.
    if (navigator.permissions && navigator.permissions.query) {
      const originalQuery = navigator.permissions.query.bind(navigator.permissions);
      navigator.permissions.query = (parameters) => {
        if (parameters && parameters.name === 'notifications') {
          return Promise.resolve({ state: Notification.permission, onchange: null });
        }
        return originalQuery(parameters);
      };
    }

    // 4. navigator.plugins / mimeTypes — CDP-attached Chrome can report empty
    //    arrays even when launched normally. Stuff in three plausible plugins
    //    so .length > 0 and the shape matches real Chrome.
    if (navigator.plugins && navigator.plugins.length === 0) {
      const fakePlugin = (name, filename, description) => ({
        name, filename, description, length: 1,
      });
      const plugins = [
        fakePlugin('PDF Viewer', 'internal-pdf-viewer', 'Portable Document Format'),
        fakePlugin('Chrome PDF Viewer', 'internal-pdf-viewer', ''),
        fakePlugin('Chromium PDF Viewer', 'internal-pdf-viewer', ''),
      ];
      Object.defineProperty(navigator, 'plugins', {
        get: () => plugins,
        configurable: true,
      });
    }

    // 5. languages — empty array is a tell. Fall back to en-US,en if blank.
    if (!navigator.languages || navigator.languages.length === 0) {
      Object.defineProperty(navigator, 'languages', {
        get: () => ['en-US', 'en'],
        configurable: true,
      });
    }
  } catch (e) {
    // Never throw — if patching fails, prefer being detected over crashing the page.
  }
})();`;

/**
 * Apply the stealth init script to a browser context and reload any existing
 * page in it. addInitScript only runs on NEW document loads, so we reload the
 * tab the profile opened with — otherwise the patches miss the first
 * navigation FB sees.
 */
async function applyStealthInitScript(context) {
  if (!context) return;
  try {
    await context.addInitScript(STEALTH_INIT_SCRIPT);
  } catch (err) {
    console.warn(`[browserManager] addInitScript failed (non-fatal): ${err.message}`);
    return;
  }

  // Reload the existing page so the patch applies to whatever URL the profile
  // launched on. about:blank doesn't need reloading.
  for (const p of context.pages()) {
    const url = p.url();
    if (!url || url === 'about:blank' || url.startsWith('chrome://')) continue;
    try {
      await p.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
    } catch (err) {
      // Reload can fail mid-navigation; the init script still applies on the
      // next goto.
      console.warn(`[browserManager] Post-attach reload failed (non-fatal): ${err.message}`);
    }
  }
}

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
  const proxyString =
    record.proxy ||
    (record.host && record.port && record.username && record.password
      ? `${record.host}:${record.port}:${record.username}:${record.password}`
      : null);

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

  console.log(
    `[browserManager] Proxy OK - IP ${data.ip} (${data.city || '?'}, ${data.region || '?'}, ${data.country || '?'})`
  );
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
    console.log(
      `[browserManager] Proxy ${proxyId} -> ${status}${lastKnownIp ? ` (${lastKnownIp})` : ''}`
    );
  } catch (err) {
    const respBody = err.response?.data ? JSON.stringify(err.response.data) : err.message;
    console.warn(
      `[browserManager] PATCH proxy status failed (${proxyId} -> ${status}): ${respBody}`
    );
  }
}

/**
 * Append { proxyId, assignedAt } to user.proxies via PATCH.
 * Existing entries are preserved as-is (they already match the embedded shape).
 */
async function assignProxyToUser(userId, proxyId, existingProxies = []) {
  if (!USER_API_BASE_URL) return null;

  const nextEntries = [
    ...(existingProxies || []),
    { proxyId, assignedAt: new Date().toISOString() },
  ];

  try {
    const { data } = await axios.patch(`${USER_API_BASE_URL}/api/profiles/${userId}`, {
      proxies: nextEntries,
    });
    console.log(`[browserManager] Proxy ${proxyId} linked to user ${userId}`);
    return data;
  } catch (err) {
    console.warn(`[browserManager] PATCH user proxies failed: ${formatErrorDetails(err)}`);
    return null;
  }
}

/**
 * Pull pending proxies in batches of 10, already filtered by country.
 * - Working + matches requireCountry -> mark active, assign to user, return
 * - Fails to fetch ipinfo -> mark dead, continue
 * - Works but wrong country -> leave pending, continue
 */
async function selectWorkingProxy(userId, existingProxies = [], { requireCountry = 'US' } = {}) {
  for (let round = 1; round <= MAX_PROXY_BATCHES; round++) {
    const batch = await fetchPendingProxies(PROXY_BATCH_SIZE, requireCountry);
    if (!batch.length) {
      console.log(`[browserManager] No more pending proxies available (round ${round})`);
      break;
    }

    console.log(
      `[browserManager] Testing ${batch.length} proxies (round ${round}/${MAX_PROXY_BATCHES})`
    );

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
        console.warn(
          `[browserManager] Proxy ${proxyId} in ${ipInfo.country} (need ${requireCountry}) - skipping`
        );
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
 * Format ipinfo JSON into multiline note text.
 */
function formatIpInfoNote(info) {
  const fields = [
    'ip',
    'hostname',
    'city',
    'region',
    'country',
    'loc',
    'org',
    'postal',
    'timezone',
  ];
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
    ({ proxyString: proxy, ipInfo } = await selectWorkingProxy(userId, user.proxies || [], {
      requireCountry,
    }));
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
      console.error(
        '[browserManager] Hidemium response body:',
        JSON.stringify(err.response.data, null, 2)
      );
      throw new Error(`Hidemium ${err.response.status}: ${JSON.stringify(err.response.data)}`);
    }
    throw err;
  }

  // Hidemium docs consistently identify profiles by uuid. For local profiles,
  // some newer endpoints/examples show a local-* browser_uuid, so accept both.
  const browserId = data.browser_uuid || data.uuid || data.data?.browser_uuid || data.data?.uuid;
  if (!browserId) {
    throw new Error(
      `Failed to create profile - no browser ID in response: ${JSON.stringify(data)}`
    );
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
      console.warn(
        '[browserManager] Profile created, but note was not saved. Tell Claude this so the endpoint name can be fixed.'
      );
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
      console.warn(
        `[browserManager] PATCH browsers failed (${status ?? 'no response'}): ${respBody}`
      );
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

      await applyStealthInitScript(context);

      return { browser, context, page, port, profileId: uuid, provider: 'hidemium' };
    } catch (error) {
      lastError = error;
      if (browser) await browser.close().catch(() => {});

      console.error(
        `[browserManager] Open profile failed for ${uuid.slice(-8)} (attempt ${attempt}/${OPEN_PROFILE_ATTEMPTS}): ${error.message}`
      );

      if (attempt >= OPEN_PROFILE_ATTEMPTS) break;

      console.log(`[browserManager] Retrying in ${OPEN_PROFILE_RETRY_MS / 1000}s...`);
      await sleep(OPEN_PROFILE_RETRY_MS);
    }
  }

  throw lastError;
}

/**
 * Sign in to Multilogin and cache the bearer token.
 */
async function mlxSignIn() {
  const email = process.env.MULTILOGIN_EMAIL;
  const password = process.env.MULTILOGIN_PASSWORD;
  const workspaceId = process.env.MULTILOGIN_WORKSPACE_ID;
  if (!email || !password) {
    throw new Error('MULTILOGIN_EMAIL and MULTILOGIN_PASSWORD must be set');
  }
  if (!workspaceId) {
    throw new Error('MULTILOGIN_WORKSPACE_ID must be set');
  }

  const passwordMd5 = crypto.createHash('md5').update(password).digest('hex');

  // Step 1: signin → user token + refresh_token
  const { data: signinData } = await axios.post(MLX_SIGNIN_URL, {
    email,
    password: passwordMd5,
  });
  const userToken = signinData?.data?.token;
  const refreshToken = signinData?.data?.refresh_token;
  if (!userToken || !refreshToken) {
    throw new Error(`Multilogin signin missing token/refresh_token: ${JSON.stringify(signinData)}`);
  }
  console.log('[browserManager] Multilogin signed in');

  // Step 2: refresh into a workspace-scoped bearer (this is what launcher accepts)
  const { data: refreshData } = await axios.post(MLX_REFRESH_TOKEN_URL, {
    email,
    workspace_id: workspaceId,
    refresh_token: refreshToken,
  });
  const wsToken = refreshData?.data?.token;
  if (!wsToken) {
    throw new Error(`Multilogin refresh_token returned no token: ${JSON.stringify(refreshData)}`);
  }
  console.log('[browserManager] Multilogin workspace token obtained');

  mlxToken = wsToken;
  return wsToken;
}

async function mlxAuthHeaders() {
  if (!mlxToken) await mlxSignIn();
  return { Authorization: `Bearer ${mlxToken}`, Accept: 'application/json' };
}

/**
 * Parse country/region/city from an MLX proxy username. Format:
 *   "<id>_<workspace>_multilogin_com-country-us-region-west_virginia-sid-XXX-filter-medium"
 */
function parseMlxProxyLocation(username) {
  const out = {};
  if (typeof username !== 'string') return out;
  const parts = username.split('-');
  for (let i = 0; i < parts.length - 1; i++) {
    if (parts[i] === 'country' && !out.country) out.country = parts[i + 1];
    else if (parts[i] === 'region' && !out.region) out.region = parts[i + 1];
    else if (parts[i] === 'city' && !out.city) out.city = parts[i + 1];
  }
  return out;
}

async function fetchMlxProfileProxy(profileId) {
  const { data } = await axios.post(
    `${MLX_API}/profile/metas`,
    { ids: [profileId] },
    { headers: { ...(await mlxAuthHeaders()), 'Content-Type': 'application/json' } }
  );
  const profile = data?.data?.profiles?.[0];
  if (!profile) throw new Error(`MLX metas returned no profile for ${profileId}`);
  return profile.parameters?.proxy || null;
}

async function generateMlxProxy({ country, region, city, type }) {
  const protocol = type === 'socks5' ? 'socks5' : 'http';
  const body = {
    country: country || 'us',
    sessionType: 'sticky',
    protocol,
    IPTTL: 0,
    count: 1,
  };
  if (region) body.region = region;
  if (city) body.city = city;

  const { data } = await axios.post(MLX_PROXY_GEN_URL, body, {
    headers: { ...(await mlxAuthHeaders()), 'Content-Type': 'application/json' },
  });
  const connectionString = Array.isArray(data?.data) ? data.data[0] : data?.data;
  if (typeof connectionString !== 'string') {
    throw new Error(`generate-proxy: unexpected response ${JSON.stringify(data)}`);
  }

  // "host:port:username:password" — password may contain ':' so join the tail
  const parts = connectionString.split(':');
  if (parts.length < 4) throw new Error(`generate-proxy: bad string "${connectionString}"`);
  const [host, portStr, username, ...passParts] = parts;
  const port = parseInt(portStr, 10);
  if (!Number.isFinite(port)) throw new Error(`generate-proxy: bad port in "${connectionString}"`);

  return {
    host,
    port,
    username,
    password: passParts.join(':'),
    type: protocol,
    save_traffic: false,
  };
}

async function applyMlxProxy(profileId, proxyBlock) {
  // MLX partial_update accepts the request as `parameters.proxy` but silently
  // no-ops it. The flat top-level `proxy` shape is the one that actually
  // persists. Confirmed by reading metas before/after.
  await axios.post(
    `${MLX_API}/profile/partial_update`,
    { profile_id: profileId, proxy: proxyBlock },
    { headers: { ...(await mlxAuthHeaders()), 'Content-Type': 'application/json' } }
  );
}

/**
 * Recover from GET_PROXY_CONNECTION_IP_ERROR: read the profile's bound proxy,
 * generate a new one in the same country/region (and city, if any), and write
 * it back to the profile. Same-region — IP rotates, location stays.
 */
async function rotateMultiloginProxy(profileId) {
  const current = await fetchMlxProfileProxy(profileId);
  if (!current) throw new Error(`No proxy on profile ${profileId}`);

  const loc = parseMlxProxyLocation(current.username);
  console.log(
    `[browserManager] Rotating proxy ${profileId.slice(-8)} — country=${loc.country || '?'} region=${loc.region || '?'} city=${loc.city || '?'} type=${current.type}`
  );

  const next = await generateMlxProxy({ ...loc, type: current.type });
  await applyMlxProxy(profileId, next);
  console.log(
    `[browserManager] Profile ${profileId.slice(-8)} proxy swapped (new sid via ${next.host}:${next.port})`
  );
  return next;
}

/**
 * Wait for the local CDP socket to accept a connection. MLX reports the port
 * before the agent has fully bound it, so the first connect can ECONNREFUSED.
 */
async function connectCdpWithRetry(endpoint, attempts = 6, intervalMs = 1000) {
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await chromium.connectOverCDP(endpoint);
    } catch (err) {
      lastErr = err;
      if (i >= attempts) break;
      await sleep(intervalMs);
    }
  }
  throw lastErr;
}

/**
 * Open a single Multilogin X profile via launcher API and connect via CDP.
 */
async function openMultiloginProfile(profileId) {
  const folderId = process.env.MULTILOGIN_FOLDER_ID;
  if (!folderId) throw new Error('MULTILOGIN_FOLDER_ID is required');

  const startUrl = `${MLX_LAUNCHER}/api/v2/profile/f/${folderId}/p/${profileId}/start?automation_type=playwright&headless_mode=false`;

  let lastError;

  for (let attempt = 1; attempt <= OPEN_PROFILE_ATTEMPTS; attempt++) {
    let browser;

    try {
      let resp;
      try {
        resp = await axios.get(startUrl, { headers: await mlxAuthHeaders() });
      } catch (err) {
        if (err.response?.status === 401) {
          console.log('[browserManager] Multilogin token expired, re-signing in');
          await mlxSignIn();
          resp = await axios.get(startUrl, { headers: await mlxAuthHeaders() });
        } else {
          throw err;
        }
      }

      const port = resp.data?.data?.port;
      if (!port) throw new Error(`Multilogin start returned no port: ${JSON.stringify(resp.data)}`);

      console.log(`[browserManager] MLX profile ${profileId.slice(-8)} opened on port ${port}`);

      // The MLX agent reports the port before the CDP socket is fully accepting
      // connections. Retry connectOverCDP a few times to bridge the race.
      browser = await connectCdpWithRetry(`http://127.0.0.1:${port}`);

      const context = browser.contexts()[0];
      if (!context) throw new Error('No browser context available after connecting');

      let page = context.pages()[0];
      if (!page) page = await context.newPage();

      await applyStealthInitScript(context);

      return { browser, context, page, port, profileId, provider: 'multilogin' };
    } catch (error) {
      lastError = error;
      if (browser) await browser.close().catch(() => {});

      console.error(
        `[browserManager] Open MLX profile failed for ${profileId.slice(-8)} (attempt ${attempt}/${OPEN_PROFILE_ATTEMPTS}): ${formatErrorDetails(error)}`
      );

      if (attempt >= OPEN_PROFILE_ATTEMPTS) break;

      // MLX couldn't reach the bound proxy IP — rotate to a new IP in the
      // same region before the next attempt. Retrying with the same dead IP
      // can't succeed.
      const errCode = error.response?.data?.status?.error_code;
      if (errCode === 'GET_PROXY_CONNECTION_IP_ERROR') {
        try {
          await rotateMultiloginProxy(profileId);
        } catch (rotateErr) {
          console.error(
            `[browserManager] Proxy rotation failed for ${profileId.slice(-8)}: ${formatErrorDetails(rotateErr)}`
          );
        }
      }

      // Best-effort cleanup: if /start succeeded server-side, the profile is
      // still running. Stop it so the next attempt can start cleanly without
      // hitting PROFILE_ALREADY_RUNNING.
      try {
        await axios.get(`${MLX_LAUNCHER}/api/v1/profile/stop/p/${profileId}`, {
          headers: await mlxAuthHeaders(),
        });
      } catch (_) {
        // Ignore — if it wasn't running, stop returns 4xx; that's fine.
      }

      console.log(`[browserManager] Retrying in ${OPEN_PROFILE_RETRY_MS / 1000}s...`);
      await sleep(OPEN_PROFILE_RETRY_MS);
    }
  }

  throw lastError;
}

/**
 * Open a browser for a given userId, dispatching by BROWSER_PROVIDER.
 */
async function openBrowserForUser(userId) {
  const user = await fetchUser(userId);

  if (!user.browsers || user.browsers.length === 0) {
    throw new Error(
      `User ${userId} (${user.firstName} ${user.lastName}) has no browsers configured`
    );
  }

  const entry = user.browsers.find(
    (b) => (b.provider || 'hidemium').toLowerCase() === BROWSER_PROVIDER
  );

  if (!entry) {
    throw new Error(
      `User ${userId} (${user.firstName} ${user.lastName}) has no "${BROWSER_PROVIDER}" browser entry`
    );
  }

  const { browserId } = entry;

  console.log(
    `[browserManager] Opening browser for ${user.firstName} ${user.lastName} (${BROWSER_PROVIDER}: ${browserId.slice(-8)})`
  );

  let session;
  if (BROWSER_PROVIDER === 'multilogin') {
    session = await openMultiloginProfile(browserId);
  } else if (BROWSER_PROVIDER === 'hidemium') {
    session = await openProfile(browserId);
  } else {
    throw new Error(`Unsupported BROWSER_PROVIDER: "${BROWSER_PROVIDER}"`);
  }

  return { ...session, user };
}

const BROWSER_CLOSE_TIMEOUT_MS = 10000;
const STOP_REQUEST_TIMEOUT_MS = 15000;
const STOP_RETRY_ATTEMPTS = 3;
const STOP_RETRY_WAIT_MS = 2000;

/**
 * Close a Playwright browser with a hard timeout. CDP sockets can hang when
 * the underlying agent (Hidemium / MLX) is unresponsive; without this, the
 * whole task waits forever. Returns whether the timeout fired — the caller
 * uses that to decide whether to reap a leaked chromium process.
 */
async function closeBrowserWithTimeout(browser, profileId) {
  if (!browser) return { timedOut: false };
  let timedOut = false;
  let timerId = null;
  const timeout = new Promise((resolve) => {
    timerId = setTimeout(() => {
      timedOut = true;
      console.warn(
        `[browserManager] browser.close() timed out after ${BROWSER_CLOSE_TIMEOUT_MS}ms for ${profileId.slice(-8)} — abandoning CDP connection`
      );
      resolve();
    }, BROWSER_CLOSE_TIMEOUT_MS);
  });
  try {
    await Promise.race([browser.close().catch(() => {}), timeout]);
  } finally {
    // Clear when close resolved first — without this the timer fires later and
    // logs a spurious "timed out" warning AFTER the profile already closed
    // cleanly, leaks a 10s active handle each call, and was confusing to read.
    if (timerId) clearTimeout(timerId);
  }
  return { timedOut };
}

/**
 * Windows-only: find the PID of the process listening on a TCP port via
 * `netstat -ano`. Returns null on non-Windows, on parse failure, or when no
 * LISTENING socket on that port exists.
 */
async function findListeningPidOnPort(port) {
  if (process.platform !== 'win32' || !port) return null;
  try {
    const { stdout } = await execAsync('netstat -ano -p TCP');
    for (const line of stdout.split(/\r?\n/)) {
      const cols = line.trim().split(/\s+/);
      // Format: "TCP <local> <foreign> LISTENING <pid>"
      if (cols.length < 5 || cols[0] !== 'TCP' || cols[3] !== 'LISTENING') continue;
      const localPort = cols[1].split(':').pop();
      if (localPort !== String(port)) continue;
      const pid = parseInt(cols[4], 10);
      if (Number.isFinite(pid) && pid > 0) return pid;
    }
  } catch (err) {
    console.warn(`[browserManager] netstat lookup failed: ${err.message}`);
  }
  return null;
}

async function getProcessName(pid) {
  if (process.platform !== 'win32' || !pid) return null;
  try {
    const { stdout } = await execAsync(`tasklist /FI "PID eq ${pid}" /NH /FO CSV`);
    const first = stdout.trim().split(/\r?\n/)[0];
    const m = first && first.match(/^"([^"]+)"/);
    return m ? m[1] : null;
  } catch (_) {
    return null;
  }
}

/**
 * When `browser.close()` times out, the MLX/Hidemium agent may also fail to
 * actually terminate the chromium process — over hours of runtime those
 * orphans accumulate and eventually OOM-kill the bot. This reaper looks up
 * the PID listening on the abandoned CDP port and force-kills it.
 *
 * Safety checks before kill: process must exist on the port, must not be
 * this Node process, and its name must contain "chrom" (so we never kill
 * the MLX agent / node / unrelated listeners).
 */
async function reapOrphanChromium(port, profileId) {
  if (!port || process.platform !== 'win32') return false;
  const pid = await findListeningPidOnPort(port);
  if (!pid) return false;
  if (pid === process.pid) {
    console.warn(
      `[browserManager] Reap aborted — PID ${pid} on port ${port} is this Node process`
    );
    return false;
  }
  const name = (await getProcessName(pid)) || '';
  if (!/chrom/i.test(name)) {
    console.warn(
      `[browserManager] Reap aborted — PID ${pid} on port ${port} is "${name}", not chromium`
    );
    return false;
  }
  try {
    await execAsync(`taskkill /F /PID ${pid}`);
    console.warn(
      `[browserManager] Reaped orphan ${name} PID ${pid} on port ${port} for ${profileId.slice(-8)}`
    );
    return true;
  } catch (err) {
    console.warn(
      `[browserManager] Reap failed for ${name} PID ${pid} on port ${port}: ${err.message}`
    );
    return false;
  }
}

async function stopMultiloginProfile(profileId) {
  const url = `${MLX_LAUNCHER}/api/v1/profile/stop/p/${profileId}`;
  let lastError;

  for (let attempt = 1; attempt <= STOP_RETRY_ATTEMPTS; attempt++) {
    try {
      await axios.get(url, {
        headers: await mlxAuthHeaders(),
        timeout: STOP_REQUEST_TIMEOUT_MS,
      });
      return true;
    } catch (err) {
      lastError = err;

      if (err.response?.status === 401) {
        console.log('[browserManager] MLX stop got 401, re-signing in');
        try {
          await mlxSignIn();
        } catch (signInErr) {
          console.warn(
            `[browserManager] MLX re-signin during stop failed: ${formatErrorDetails(signInErr)}`
          );
        }
      }

      console.warn(
        `[browserManager] MLX stop failed for ${profileId.slice(-8)} (attempt ${attempt}/${STOP_RETRY_ATTEMPTS}): ${formatErrorDetails(err)}`
      );

      if (attempt < STOP_RETRY_ATTEMPTS) await sleep(STOP_RETRY_WAIT_MS);
    }
  }

  console.error(
    `[browserManager] MLX stop gave up for ${profileId.slice(-8)} — profile may still be running on the agent. Last error: ${formatErrorDetails(lastError)}`
  );
  return false;
}

async function stopHidemiumProfile(profileId) {
  try {
    await axios.get(`${API}/closeProfile?uuid=${profileId}`, {
      headers,
      timeout: STOP_REQUEST_TIMEOUT_MS,
    });
    return true;
  } catch (err) {
    console.warn(
      `[browserManager] Hidemium close failed for ${profileId.slice(-8)}: ${formatErrorDetails(err)}`
    );
    return false;
  }
}

/**
 * Close a profile, dispatching by provider stored on the session.
 *
 * `port` is optional. When provided AND `browser.close()` times out, we
 * additionally reap the orphan chromium process listening on that CDP port
 * — prevents long-running tasks from accumulating leaked browsers when
 * the MLX/Hidemium agent fails to actually terminate chromium.
 */
async function closeProfile(profileId, browser, provider, port) {
  const { timedOut } = await closeBrowserWithTimeout(browser, profileId);

  const resolvedProvider = (provider || BROWSER_PROVIDER || 'hidemium').toLowerCase();

  const stopped =
    resolvedProvider === 'multilogin'
      ? await stopMultiloginProfile(profileId)
      : await stopHidemiumProfile(profileId);

  if (timedOut) {
    await reapOrphanChromium(port, profileId);
  }

  if (stopped) {
    console.log(`[browserManager] Profile ${profileId.slice(-8)} closed (${resolvedProvider})`);
  } else {
    console.error(
      `[browserManager] Profile ${profileId.slice(-8)} CLOSE FAILED (${resolvedProvider}) — likely leaked, check ${resolvedProvider === 'multilogin' ? 'MLX dashboard' : 'Hidemium app'} and kill manually if needed`
    );
  }
}

/**
 * Open browsers for an explicit list of userIds.
 */
async function launchBrowsers(userIds) {
  const connections = await Promise.allSettled(userIds.map((userId) => openBrowserForUser(userId)));

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
    throw new Error(
      'Could not connect to any profiles. Make sure Hidemium is running and API token is correct.'
    );
  }

  return successful;
}

/**
 * Close all browser sessions.
 */
async function closeBrowsers(sessions) {
  await Promise.allSettled(
    sessions.map((session) =>
      closeProfile(session.profileId, session.browser, session.provider, session.port)
    )
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
