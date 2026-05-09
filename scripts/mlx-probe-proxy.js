/**
 * Probe script — figure out the shape of three Multilogin X endpoints we need
 * to wire up automatic same-location proxy rotation when /start fails with
 * GET_PROXY_CONNECTION_IP_ERROR.
 *
 * Reads ONLY. Does NOT modify the profile or generate billable proxy traffic
 * unless you pass --generate.
 *
 * Usage:
 *   node scripts/mlx-probe-proxy.js <profileId>             # read-only
 *   node scripts/mlx-probe-proxy.js <profileId> --generate  # also test generate-proxy
 *
 * Outputs each response verbatim so we can see exactly which fields exist.
 */

require('dotenv').config();
const axios = require('axios');
const crypto = require('crypto');
const { fetchUser } = require('../utils/userApi');

const MLX_SIGNIN_URL = 'https://api.multilogin.com/user/signin';
const MLX_REFRESH_TOKEN_URL = 'https://api.multilogin.com/user/refresh_token';
const MLX_API = 'https://api.multilogin.com';
const MLX_PROXY_GEN = 'https://profile-proxy.multilogin.com/v1/proxy/connection_url';

let cachedToken = null;

async function signIn() {
  const email = process.env.MULTILOGIN_EMAIL;
  const password = process.env.MULTILOGIN_PASSWORD;
  const workspaceId = process.env.MULTILOGIN_WORKSPACE_ID;
  if (!email || !password || !workspaceId) {
    throw new Error('MULTILOGIN_EMAIL / MULTILOGIN_PASSWORD / MULTILOGIN_WORKSPACE_ID required');
  }

  const md5 = crypto.createHash('md5').update(password).digest('hex');
  const { data: signinData } = await axios.post(MLX_SIGNIN_URL, { email, password: md5 });
  const refreshToken = signinData?.data?.refresh_token;
  if (!refreshToken) throw new Error(`signin: no refresh_token in ${JSON.stringify(signinData)}`);

  const { data: refreshData } = await axios.post(MLX_REFRESH_TOKEN_URL, {
    email,
    workspace_id: workspaceId,
    refresh_token: refreshToken,
  });
  const token = refreshData?.data?.token;
  if (!token) throw new Error(`refresh_token: no token in ${JSON.stringify(refreshData)}`);

  cachedToken = token;
  return token;
}

async function authHeaders() {
  if (!cachedToken) await signIn();
  return { Authorization: `Bearer ${cachedToken}`, Accept: 'application/json' };
}

function dump(label, value) {
  console.log(`\n===== ${label} =====`);
  console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
}

async function probeProfileMetas(profileId) {
  // Documented endpoint shape varies — try the two likeliest forms and dump
  // whichever returns 2xx. Both forms are read-only.
  const attempts = [
    {
      label: 'POST /profile/metas { ids: [...] }',
      run: () =>
        axios.post(
          `${MLX_API}/profile/metas`,
          { ids: [profileId] },
          { headers: { 'Content-Type': 'application/json', ...(authHeaders.cached || {}) } }
        ),
    },
    {
      label: 'POST /profile/metas (with auth header)',
      run: async () =>
        axios.post(
          `${MLX_API}/profile/metas`,
          { ids: [profileId] },
          { headers: { ...(await authHeaders()), 'Content-Type': 'application/json' } }
        ),
    },
    {
      label: 'GET /profile/p/{id} (with auth header)',
      run: async () =>
        axios.get(`${MLX_API}/profile/p/${profileId}`, { headers: await authHeaders() }),
    },
    {
      label: 'GET /profile/{id} (with auth header)',
      run: async () =>
        axios.get(`${MLX_API}/profile/${profileId}`, { headers: await authHeaders() }),
    },
  ];

  for (const a of attempts) {
    try {
      const { status, data } = await a.run();
      dump(`${a.label} — status ${status}`, data);
      return data;
    } catch (err) {
      const status = err.response?.status;
      const body = err.response?.data;
      console.log(`\n----- ${a.label} — FAILED (${status ?? err.code}) -----`);
      console.log(body ? JSON.stringify(body) : err.message);
    }
  }
  console.log('\n[probe] All profile-metas variants failed. Paste the correct endpoint name from Postman docs.');
  return null;
}

async function probeGenerateProxy(country, region, city) {
  const body = {
    country: country || 'us',
    sessionType: 'sticky',
    protocol: 'http',
    IPTTL: 0,
    count: 1,
  };
  if (region) body.region = region;
  if (city) body.city = city;

  // Try unauthenticated first (sample curl had no auth), then with workspace bearer.
  try {
    const { status, data } = await axios.post(MLX_PROXY_GEN, body);
    dump(`POST connection_url (no auth) — status ${status}`, data);
    return data;
  } catch (err) {
    console.log(
      `\n----- connection_url (no auth) FAILED (${err.response?.status ?? err.code}) -----`
    );
    console.log(err.response?.data ? JSON.stringify(err.response.data) : err.message);
  }

  try {
    const { status, data } = await axios.post(MLX_PROXY_GEN, body, {
      headers: await authHeaders(),
    });
    dump(`POST connection_url (workspace bearer) — status ${status}`, data);
    return data;
  } catch (err) {
    console.log(
      `\n----- connection_url (bearer) FAILED (${err.response?.status ?? err.code}) -----`
    );
    console.log(err.response?.data ? JSON.stringify(err.response.data) : err.message);
  }
  return null;
}

async function resolveProfileId(idArg) {
  // Accept either a full profileId UUID, or a userId (24-char hex Mongo id) we
  // can resolve via fetchUser → user.browsers (multilogin entry).
  if (!idArg) return null;
  if (idArg.includes('-')) return idArg; // looks like a UUID already

  console.log(`[probe] Treating arg as userId, fetching user record…`);
  const user = await fetchUser(idArg);
  const entry = (user.browsers || []).find(
    (b) => (b.provider || '').toLowerCase() === 'multilogin'
  );
  if (!entry) {
    throw new Error(
      `User ${idArg} (${user.firstName} ${user.lastName}) has no multilogin browser entry`
    );
  }
  console.log(
    `[probe] Resolved userId → profileId ${entry.browserId} (${user.firstName} ${user.lastName})`
  );
  return entry.browserId;
}

async function probeUpdateEndpoint(profileId, proxyBlock) {
  // Safe probe: re-writes the SAME proxy back. We only want the response code
  // to discover which endpoint shape MLX accepts. If the endpoint is wrong,
  // the proxy is unchanged.
  const variants = [
    {
      label: 'PATCH /profile/{id} { parameters: { proxy } }',
      run: async () =>
        axios.patch(
          `${MLX_API}/profile/${profileId}`,
          { parameters: { proxy: proxyBlock } },
          { headers: { ...(await authHeaders()), 'Content-Type': 'application/json' } }
        ),
    },
    {
      label: 'POST /profile/{id} { parameters: { proxy } }',
      run: async () =>
        axios.post(
          `${MLX_API}/profile/${profileId}`,
          { parameters: { proxy: proxyBlock } },
          { headers: { ...(await authHeaders()), 'Content-Type': 'application/json' } }
        ),
    },
    {
      label: 'PUT /profile/{id} { parameters: { proxy } }',
      run: async () =>
        axios.put(
          `${MLX_API}/profile/${profileId}`,
          { parameters: { proxy: proxyBlock } },
          { headers: { ...(await authHeaders()), 'Content-Type': 'application/json' } }
        ),
    },
    {
      label: 'PATCH /profile/p/{id} { parameters: { proxy } }',
      run: async () =>
        axios.patch(
          `${MLX_API}/profile/p/${profileId}`,
          { parameters: { proxy: proxyBlock } },
          { headers: { ...(await authHeaders()), 'Content-Type': 'application/json' } }
        ),
    },
    {
      label: 'POST /profile/partial_update { profile_id, parameters: { proxy } }',
      run: async () =>
        axios.post(
          `${MLX_API}/profile/partial_update`,
          { profile_id: profileId, parameters: { proxy: proxyBlock } },
          { headers: { ...(await authHeaders()), 'Content-Type': 'application/json' } }
        ),
    },
    {
      label: 'POST /profile/partial_update { profile_id, proxy }',
      run: async () =>
        axios.post(
          `${MLX_API}/profile/partial_update`,
          { profile_id: profileId, proxy: proxyBlock },
          { headers: { ...(await authHeaders()), 'Content-Type': 'application/json' } }
        ),
    },
  ];

  for (const v of variants) {
    try {
      const { status, data } = await v.run();
      dump(`${v.label} — status ${status}`, data);
      if (status >= 200 && status < 300) {
        console.log(`\n[probe] WINNER: ${v.label}`);
        return v.label;
      }
    } catch (err) {
      const status = err.response?.status;
      const body = err.response?.data;
      console.log(`\n----- ${v.label} — FAILED (${status ?? err.code}) -----`);
      if (typeof body === 'string') {
        console.log(body.slice(0, 200));
      } else if (body) {
        console.log(JSON.stringify(body).slice(0, 400));
      } else {
        console.log(err.message);
      }
    }
  }
  console.log('\n[probe] All profile-update variants failed.');
  return null;
}

async function main() {
  const idArg = process.argv[2];
  const doGenerate = process.argv.includes('--generate');
  const doUpdate = process.argv.includes('--probe-update');

  if (!idArg) {
    console.error('Usage: node scripts/mlx-probe-proxy.js <profileId|userId> [--generate]');
    process.exit(1);
  }

  const profileId = await resolveProfileId(idArg);
  console.log(`[probe] Profile: ${profileId}`);
  console.log(`[probe] Generate proxy step: ${doGenerate ? 'YES' : 'NO (read-only)'}`);

  await signIn();
  console.log('[probe] Workspace bearer obtained');

  const meta = await probeProfileMetas(profileId);

  // Try to surface country/region/city from whatever the metas response shape was.
  if (meta) {
    const stringified = JSON.stringify(meta);
    const found = {
      hasCountry: /country/i.test(stringified),
      hasRegion: /region/i.test(stringified),
      hasCity: /city/i.test(stringified),
      hasProxy: /proxy/i.test(stringified),
    };
    dump('Field presence in metas response', found);
  }

  if (doGenerate) {
    // Hard-coded US for the probe — we just want to see the response shape +
    // whether auth is needed. Not actually applying it to the profile.
    await probeGenerateProxy('us', null, null);
  } else {
    console.log('\n[probe] Skipping generate-proxy step. Re-run with --generate to test it.');
  }

  if (doUpdate) {
    const proxyBlock = meta?.data?.profiles?.[0]?.parameters?.proxy;
    if (!proxyBlock) {
      console.log('\n[probe] Cannot --probe-update: no proxy block in metas response.');
    } else {
      console.log('\n[probe] Probing profile-update endpoints with SAME proxy (no-op write)…');
      await probeUpdateEndpoint(profileId, proxyBlock);
    }
  } else {
    console.log('\n[probe] Skipping profile-update probe. Re-run with --probe-update to test it.');
  }

  console.log('\n[probe] Done. Paste this entire output back so we can wire the recovery path.');
}

main().catch((err) => {
  console.error('[probe] Fatal:', err.message);
  if (err.response) {
    console.error('  status:', err.response.status);
    console.error('  body  :', JSON.stringify(err.response.data));
  }
  process.exit(1);
});
