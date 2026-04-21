/**
 * check_ip - Leaf action.
 * Fetches IP info from ipinfo.io using the browser's network stack (so it goes
 * through the profile's proxy, not the host), then POSTs the result to the
 * database so every browser open is recorded.
 *
 * Runs automatically at the start of every browser session via runner.js,
 * and can also be composed as a regular step in tasks.json.
 */

const axios = require('axios');

const IPINFO_URL = 'https://ipinfo.io/json';
const USER_API_BASE_URL = process.env.USER_API_BASE_URL || '';
const IP_LOG_ENDPOINT = process.env.IP_LOG_ENDPOINT || '';

async function fetchIpInfoFromBrowser(page) {
  return page.evaluate(async (url) => {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error(`ipinfo HTTP ${res.status}`);
    return res.json();
  }, IPINFO_URL);
}

function resolveLogEndpoint(userId, override) {
  if (override) return override;
  if (IP_LOG_ENDPOINT) return IP_LOG_ENDPOINT.replace(':userId', userId || '');
  if (USER_API_BASE_URL && userId) return `${USER_API_BASE_URL}/api/profiles/${userId}/ip-records`;
  return '';
}

module.exports = async function check_ip(page, params) {
  const { userId = '', endpoint = '' } = params;

  console.log('  [check_ip] Fetching IP info via browser network...');
  const info = await fetchIpInfoFromBrowser(page);

  console.log(`  [check_ip] IP: ${info.ip} | ${info.city || ''}, ${info.region || ''} ${info.country || ''} | ${info.org || ''}`);

  const target = resolveLogEndpoint(userId, endpoint);
  if (!target) {
    console.warn('  [check_ip] No log endpoint configured (IP_LOG_ENDPOINT / USER_API_BASE_URL + userId) — skipping POST.');
    return info;
  }

  try {
    await axios.post(target, {
      userId,
      recordedAt: new Date().toISOString(),
      ipInfo: info,
    }, { timeout: 15000 });
    console.log(`  [check_ip] Logged to ${target}`);
  } catch (err) {
    console.warn(`  [check_ip] Failed to log IP to ${target}: ${err.message}`);
  }

  return info;
};
