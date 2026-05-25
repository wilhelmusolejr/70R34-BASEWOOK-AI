import { readFile } from 'node:fs/promises';
import path from 'node:path';
import 'dotenv/config';
import shared from '../utils/browserManager.js';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const axios = require_('axios');

// Bridge multilogin/.env names → MULTILOGIN_* env names that the shared module reads.
process.env.MULTILOGIN_EMAIL = process.env.MULTILOGIN_EMAIL || process.env.MLX_EMAIL;
process.env.MULTILOGIN_PASSWORD = process.env.MULTILOGIN_PASSWORD || process.env.MLX_PASSWORD;
process.env.MULTILOGIN_WORKSPACE_ID = process.env.MULTILOGIN_WORKSPACE_ID || process.env.WORKSPACE_ID;
process.env.MULTILOGIN_FOLDER_ID = process.env.MULTILOGIN_FOLDER_ID || process.env.FOLDER_ID;

const {
  COUNTRY_REGIONS,
  normalizeCountry,
  isMatchingCountryProxy,
  proxyCountryCode,
  assignCountryProxy,
} = shared;

const API_BASE = process.env.API_BASE ?? process.env.USER_API_BASE_URL ?? 'https://7or34.space';
const MLX_BASE = 'https://api.multilogin.com';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getUser(id) {
  const { data } = await axios.get(`${API_BASE}/api/profiles/${id}`);
  return data;
}

// We still need profile/metas for verification — not exported by the shared
// module. Re-implement with the shared module's auth via a fresh signin call.
import { createHash } from 'node:crypto';
const md5 = (s) => createHash('md5').update(s).digest('hex');

async function getWorkspaceToken() {
  const email = process.env.MULTILOGIN_EMAIL;
  const password = process.env.MULTILOGIN_PASSWORD;
  const workspaceId = process.env.MULTILOGIN_WORKSPACE_ID;
  const { data: signinData } = await axios.post(`${MLX_BASE}/user/signin`, {
    email,
    password: md5(password),
  });
  const userToken = signinData?.data?.token;
  const refreshToken = signinData?.data?.refresh_token;
  const { data: refreshData } = await axios.post(
    `${MLX_BASE}/user/refresh_token`,
    { email, workspace_id: workspaceId, refresh_token: refreshToken },
    { headers: { Authorization: `Bearer ${userToken}` } }
  );
  return refreshData?.data?.token;
}

async function getProfileMetas(token, ids) {
  const { data } = await axios.post(
    `${MLX_BASE}/profile/metas`,
    { ids },
    { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
  );
  return data?.data?.profiles ?? [];
}

function metaProfileId(meta) {
  return meta?.profile_id ?? meta?.id ?? meta?.uuid ?? null;
}

function proxyLabel(proxyObj) {
  if (!proxyObj) return 'no proxy';
  const cc = proxyCountryCode(proxyObj);
  return `${proxyObj.type ?? 'unknown'}://${proxyObj.host ?? '?'}:${proxyObj.port ?? '?'}${cc ? ` (${cc.toLowerCase()})` : ''}`;
}

async function main() {
  const { PROFILES_FILE = 'profiles.json', PROXY_PROTOCOL = 'socks5', PROXY_DELAY_MS = '1500', DRY_RUN, LIMIT } = process.env;

  const missing = ['MULTILOGIN_EMAIL', 'MULTILOGIN_PASSWORD', 'MULTILOGIN_WORKSPACE_ID']
    .filter((k) => !process.env[k]);
  if (missing.length) {
    console.error(`Missing required env values: ${missing.join(', ')}`);
    process.exit(1);
  }

  const dryRun = DRY_RUN === '1' || DRY_RUN === 'true';
  const delayMs = Number(PROXY_DELAY_MS) || 0;
  const limit = Number(LIMIT) > 0 ? Number(LIMIT) : 0;

  const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/(?=[A-Za-z]:)/, ''));
  const file = path.isAbsolute(PROFILES_FILE) ? PROFILES_FILE : path.resolve(here, PROFILES_FILE);
  let entries = JSON.parse(await readFile(file, 'utf8'));
  if (!Array.isArray(entries)) {
    console.error(`${PROFILES_FILE} must contain a JSON array`);
    process.exit(1);
  }
  if (limit > 0) entries = entries.slice(0, limit);

  console.log('Signing in to Multilogin...');
  const token = await getWorkspaceToken();

  // Resolve userId → (fullName, country, mlxIds[])
  const userIds = entries.map((e) => (typeof e === 'string' ? e : e?.id)).filter(Boolean);
  const allMlxIds = [];
  const labelById = new Map();
  const countryById = new Map();
  for (const userId of userIds) {
    let user;
    try {
      user = await getUser(userId);
    } catch (err) {
      console.error(`FAILED to fetch user ${userId}: ${err.message}`);
      continue;
    }
    const fullName = `${user.firstName ?? ''} ${user.lastName ?? ''}`.trim() || userId;
    const country = normalizeCountry(user.country);
    if (!country) {
      console.log(`skip: ${fullName} (${userId}) has no country on user record`);
      continue;
    }
    if (!COUNTRY_REGIONS[country]) {
      console.log(`skip: ${fullName} (${userId}) country=${country} not in COUNTRY_REGIONS map`);
      continue;
    }
    const mlxIds = (user.browsers ?? [])
      .filter((b) => b.provider === 'multilogin' && b.browserId)
      .map((b) => b.browserId);
    if (!mlxIds.length) {
      console.log(`skip: ${fullName} (${userId}) has no multilogin browser`);
      continue;
    }
    for (const id of mlxIds) {
      allMlxIds.push(id);
      labelById.set(id, fullName);
      countryById.set(id, country);
    }
  }

  if (!allMlxIds.length) {
    console.log('No multilogin profiles to process.');
    return;
  }

  console.log(`Fetching metas for ${allMlxIds.length} multilogin profile(s)...`);
  const metas = await getProfileMetas(token, allMlxIds);
  const metaById = new Map();
  for (const m of metas) {
    const id = metaProfileId(m);
    if (id) metaById.set(id, m);
  }

  let updated = 0;
  let skipped = 0;
  let failed = 0;

  for (let i = 0; i < allMlxIds.length; i++) {
    if (i > 0 && delayMs > 0) await sleep(delayMs);

    const profileId = allMlxIds[i];
    const meta = metaById.get(profileId);
    const currentProxy = meta?.parameters?.proxy ?? null;
    const flags = meta?.parameters?.flags ?? {};
    const name = labelById.get(profileId) ?? profileId;
    const expectedCountry = countryById.get(profileId);
    const tag = `${name} [${profileId}] (${expectedCountry})`;

    if (isMatchingCountryProxy(currentProxy, expectedCountry) && flags.proxy_masking === 'custom') {
      console.log(`[${i + 1}/${allMlxIds.length}] skip (already ${expectedCountry}, verified): ${tag}`);
      skipped++;
      continue;
    }

    console.log(`[${i + 1}/${allMlxIds.length}] assigning ${expectedCountry}: ${tag}`);
    if (dryRun) {
      console.log(`    DRY RUN: would assign random ${expectedCountry} region`);
      continue;
    }

    try {
      const { region, proxy } = await assignCountryProxy(profileId, expectedCountry, { protocol: PROXY_PROTOCOL });
      console.log(`    ok -> ${proxyLabel(proxy)} (${region})`);
      updated++;
    } catch (err) {
      console.error(`    FAILED: ${err.message}`);
      failed++;
    }
  }

  console.log(`\nDone. updated=${updated} skipped=${skipped} failed=${failed}${dryRun ? ' (dry run)' : ''}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
