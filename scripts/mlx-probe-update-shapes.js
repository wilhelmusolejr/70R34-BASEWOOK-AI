/**
 * Probe more body shapes for the partial_update endpoint to find which one
 * actually persists a proxy change. Each variant generates a fresh SID, sends
 * the update, then re-reads the profile and checks if the SID changed.
 */

require('dotenv').config();
const axios = require('axios');
const crypto = require('crypto');
const { fetchUser } = require('../utils/userApi');

const MLX_API = 'https://api.multilogin.com';
const MLX_PROXY_GEN = 'https://profile-proxy.multilogin.com/v1/proxy/connection_url';
let token = null;

async function signIn() {
  const md5 = crypto.createHash('md5').update(process.env.MULTILOGIN_PASSWORD).digest('hex');
  const { data: s } = await axios.post('https://api.multilogin.com/user/signin', {
    email: process.env.MULTILOGIN_EMAIL,
    password: md5,
  });
  const { data: r } = await axios.post('https://api.multilogin.com/user/refresh_token', {
    email: process.env.MULTILOGIN_EMAIL,
    workspace_id: process.env.MULTILOGIN_WORKSPACE_ID,
    refresh_token: s.data.refresh_token,
  });
  token = r.data.token;
}
const H = () => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' });

async function readProxy(profileId) {
  const { data } = await axios.post(`${MLX_API}/profile/metas`, { ids: [profileId] }, { headers: H() });
  return data.data.profiles[0].parameters.proxy;
}

async function generateFreshProxy(country, region, type) {
  const protocol = type === 'socks5' ? 'socks5' : 'http';
  const body = { country, sessionType: 'sticky', protocol, IPTTL: 0, count: 1 };
  if (region) body.region = region;
  const { data } = await axios.post(MLX_PROXY_GEN, body, { headers: H() });
  const s = data.data[0];
  const parts = s.split(':');
  return {
    host: parts[0],
    port: parseInt(parts[1], 10),
    username: parts[2],
    password: parts.slice(3).join(':'),
    type: protocol,
    save_traffic: false,
  };
}

function sidOf(username) {
  const m = username && username.match(/-sid-([^-]+)/);
  return m ? m[1] : null;
}

async function tryUpdate(profileId, baseLoc, baseType, label, body) {
  const before = await readProxy(profileId);
  const beforeSid = sidOf(before.username);

  // Generate a fresh proxy each variant so we know if the update applied
  const fresh = await generateFreshProxy(baseLoc.country, baseLoc.region, baseType);

  // Replace any "<<PROXY>>" placeholder in body with the fresh proxy block
  const bodyResolved = JSON.parse(
    JSON.stringify(body).replace(/"<<PROXY>>"/g, JSON.stringify(fresh))
  );

  console.log(`\n--- ${label} ---`);
  console.log('  beforeSid:', beforeSid);
  console.log('  newSidExpected:', sidOf(fresh.username));

  let updateResp;
  try {
    updateResp = await axios.post(`${MLX_API}/profile/partial_update`, bodyResolved, { headers: H() });
  } catch (err) {
    console.log('  REQUEST FAILED:', err.response?.status, JSON.stringify(err.response?.data || err.message));
    return false;
  }
  console.log('  apiResp:', JSON.stringify(updateResp.data?.status));

  await new Promise((r) => setTimeout(r, 1500));
  const after = await readProxy(profileId);
  const afterSid = sidOf(after.username);
  const changed = beforeSid !== afterSid;
  console.log('  afterSid :', afterSid, '— changed:', changed);
  return changed;
}

async function main() {
  const userId = process.argv[2] || '69f8611a497c702fe2921c6a';
  const user = await fetchUser(userId);
  const profileId = user.browsers.find((b) => b.provider === 'multilogin').browserId;
  console.log(`Profile: ${profileId} (${user.firstName} ${user.lastName})`);

  await signIn();
  const baseProxy = await readProxy(profileId);
  const baseLoc = { country: 'us', region: 'west_virginia' };
  const baseType = baseProxy.type;

  const variants = [
    {
      label: 'A: { profile_id, parameters: { proxy } }',
      body: { profile_id: profileId, parameters: { proxy: '<<PROXY>>' } },
    },
    {
      label: 'B: { profile_id, proxy }',
      body: { profile_id: profileId, proxy: '<<PROXY>>' },
    },
    {
      label: 'C: { profile_id, payload: { parameters: { proxy } } }',
      body: { profile_id: profileId, payload: { parameters: { proxy: '<<PROXY>>' } } },
    },
    {
      label: 'D: { profile_id, parameters: { proxy }, parameter_set: "proxy" }',
      body: { profile_id: profileId, parameters: { proxy: '<<PROXY>>' }, parameter_set: 'proxy' },
    },
    {
      label: 'E: parameters with full flags + proxy',
      body: {
        profile_id: profileId,
        parameters: {
          proxy: '<<PROXY>>',
          flags: { proxy_masking: 'custom' },
        },
      },
    },
  ];

  for (const v of variants) {
    const ok = await tryUpdate(profileId, baseLoc, baseType, v.label, v.body);
    if (ok) {
      console.log(`\n>>> WINNER: ${v.label}`);
      return;
    }
  }
  console.log('\n>>> No variant changed the proxy. partial_update may not support proxy edits.');
}

main().catch((err) => {
  console.error('FATAL:', err.message);
  if (err.response) console.error('  body:', JSON.stringify(err.response.data));
  process.exit(1);
});
