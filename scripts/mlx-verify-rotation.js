/**
 * Verify rotation pipeline: read metas → rotate → re-read metas → diff.
 * Confirms the partial_update actually persists, and shows what changed.
 */

require('dotenv').config();
const axios = require('axios');
const crypto = require('crypto');
const { fetchUser } = require('../utils/userApi');

const MLX_SIGNIN_URL = 'https://api.multilogin.com/user/signin';
const MLX_REFRESH_TOKEN_URL = 'https://api.multilogin.com/user/refresh_token';
const MLX_API = 'https://api.multilogin.com';
const MLX_PROXY_GEN = 'https://profile-proxy.multilogin.com/v1/proxy/connection_url';

let token = null;

async function signIn() {
  const email = process.env.MULTILOGIN_EMAIL;
  const password = process.env.MULTILOGIN_PASSWORD;
  const workspaceId = process.env.MULTILOGIN_WORKSPACE_ID;
  const md5 = crypto.createHash('md5').update(password).digest('hex');
  const { data: signinData } = await axios.post(MLX_SIGNIN_URL, { email, password: md5 });
  const { data: refreshData } = await axios.post(MLX_REFRESH_TOKEN_URL, {
    email,
    workspace_id: workspaceId,
    refresh_token: signinData.data.refresh_token,
  });
  token = refreshData.data.token;
}

async function authHeaders() {
  if (!token) await signIn();
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

async function readProxy(profileId) {
  const { data } = await axios.post(
    `${MLX_API}/profile/metas`,
    { ids: [profileId] },
    { headers: await authHeaders() }
  );
  return data.data.profiles[0].parameters.proxy;
}

function parseLoc(username) {
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

async function generate({ country, region, city, type }) {
  const protocol = type === 'socks5' ? 'socks5' : 'http';
  const body = { country, sessionType: 'sticky', protocol, IPTTL: 0, count: 1 };
  if (region) body.region = region;
  if (city) body.city = city;
  const { data } = await axios.post(MLX_PROXY_GEN, body, { headers: await authHeaders() });
  return { raw: data, connectionString: data?.data?.[0] };
}

async function applyProxy(profileId, proxyBlock) {
  const { data } = await axios.post(
    `${MLX_API}/profile/partial_update`,
    { profile_id: profileId, parameters: { proxy: proxyBlock } },
    { headers: await authHeaders() }
  );
  return data;
}

function parseConnectionString(s) {
  const parts = s.split(':');
  return {
    host: parts[0],
    port: parseInt(parts[1], 10),
    username: parts[2],
    password: parts.slice(3).join(':'),
  };
}

async function main() {
  const userId = process.argv[2] || '69f8611a497c702fe2921c6a';
  const user = await fetchUser(userId);
  const profileId = user.browsers.find((b) => b.provider === 'multilogin').browserId;
  console.log(`Profile: ${profileId} (${user.firstName} ${user.lastName})`);

  await signIn();

  // 1. Read current
  const before = await readProxy(profileId);
  console.log('\n=== BEFORE ===');
  console.log(JSON.stringify(before, null, 2));
  const loc = parseLoc(before.username);
  console.log('Parsed location:', loc);

  // 2. Generate (try with region first)
  console.log('\n=== GENERATE (region=' + (loc.region || 'none') + ') ===');
  const gen1 = await generate({ ...loc, type: before.type });
  console.log('Response:', JSON.stringify(gen1.raw, null, 2));
  const next = parseConnectionString(gen1.connectionString);
  console.log('Parsed new proxy:', next);

  // 3. Apply
  console.log('\n=== APPLY ===');
  const newProxyBlock = {
    host: next.host,
    port: next.port,
    username: next.username,
    password: next.password,
    type: before.type,
    save_traffic: false,
  };
  const applyResp = await applyProxy(profileId, newProxyBlock);
  console.log('partial_update response:', JSON.stringify(applyResp, null, 2));

  // 4. Re-read
  await new Promise((r) => setTimeout(r, 2000));
  const after = await readProxy(profileId);
  console.log('\n=== AFTER ===');
  console.log(JSON.stringify(after, null, 2));

  console.log('\n=== DIFF ===');
  console.log('username changed:', before.username !== after.username);
  console.log('host changed    :', before.host !== after.host);
  console.log('port changed    :', before.port !== after.port);
  console.log('password changed:', before.password !== after.password);

  // 5. Try a quick connectivity test through the new proxy
  console.log('\n=== TEST NEW PROXY (curl-style ipinfo through the new proxy) ===');
  try {
    const proxyType = after.type === 'socks5' ? 'socks5' : 'http';
    if (proxyType === 'http') {
      const HttpsProxyAgent = require('https-proxy-agent').HttpsProxyAgent;
      const agent = new HttpsProxyAgent(
        `http://${after.username}:${after.password}@${after.host}:${after.port}`
      );
      const { data } = await axios.get('https://ipinfo.io/json', { httpsAgent: agent, timeout: 15000 });
      console.log('ipinfo through new proxy:', data);
    } else {
      console.log('SOCKS5 — skipping direct test (need socks-proxy-agent). Trust generate output.');
    }
  } catch (err) {
    console.log('Direct proxy test failed:', err.message);
  }
}

main().catch((err) => {
  console.error('FATAL:', err.message);
  if (err.response) console.error('  body:', JSON.stringify(err.response.data));
  process.exit(1);
});
