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

const { createMultiloginProfile } = shared;

const API_BASE = process.env.API_BASE ?? process.env.USER_API_BASE_URL ?? 'https://7or34.space';

async function getUser(id) {
  const { data } = await axios.get(`${API_BASE}/api/profiles/${id}`);
  return data;
}

async function patchUserBrowsers(id, browsers) {
  await axios.patch(`${API_BASE}/api/profiles/${id}`, { browsers });
}

async function main() {
  const { PROFILES_FILE = 'profiles.json', CREATE_DELAY_MS = '2000' } = process.env;

  const delayMs = Number(CREATE_DELAY_MS) || 0;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const missing = ['MULTILOGIN_EMAIL', 'MULTILOGIN_PASSWORD', 'MULTILOGIN_WORKSPACE_ID', 'MULTILOGIN_FOLDER_ID']
    .filter((k) => !process.env[k]);
  if (missing.length) {
    console.error(`Missing required env values: ${missing.join(', ')}`);
    process.exit(1);
  }

  // Resolve PROFILES_FILE relative to this script, so the script works from
  // any CWD (the original behavior required `cd multilogin/` first).
  const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/(?=[A-Za-z]:)/, ''));
  const file = path.isAbsolute(PROFILES_FILE) ? PROFILES_FILE : path.resolve(here, PROFILES_FILE);
  const entries = JSON.parse(await readFile(file, 'utf8'));
  if (!Array.isArray(entries)) {
    console.error(`${PROFILES_FILE} must contain a JSON array`);
    process.exit(1);
  }

  for (let i = 0; i < entries.length; i++) {
    if (i > 0 && delayMs > 0) await sleep(delayMs);

    const entry = entries[i];
    const id = typeof entry === 'string' ? entry : entry?.id;
    if (!id) {
      console.log(`[${i + 1}] skipped: missing id -> ${JSON.stringify(entry)}`);
      continue;
    }

    let user;
    try {
      user = await getUser(id);
    } catch (err) {
      console.error(`[${i + 1}/${entries.length}] FAILED to fetch user ${id}: ${err.message}`);
      continue;
    }

    const fullName = `${user.firstName ?? ''} ${user.lastName ?? ''}`.trim();
    if (!fullName) {
      console.log(`[${i + 1}/${entries.length}] skipped: user ${id} has no firstName/lastName`);
      continue;
    }

    if ((user.browsers ?? []).some((b) => b.provider === 'multilogin')) {
      console.log(`[${i + 1}/${entries.length}] skipped: ${fullName} (${id}) already has a multilogin browser`);
      continue;
    }

    console.log(`[${i + 1}/${entries.length}] Creating profile: ${fullName} [id=${id}]`);
    let profileId;
    try {
      profileId = await createMultiloginProfile(user);
    } catch (err) {
      console.error(`    FAILED to create multilogin profile: ${err.message}`);
      continue;
    }
    console.log(`    ok -> ${profileId}`);

    const nextBrowsers = [...(user.browsers ?? []), { browserId: profileId, provider: 'multilogin' }];
    try {
      await patchUserBrowsers(id, nextBrowsers);
      console.log(`    assigned to user ${id}`);
    } catch (err) {
      console.error(`    FAILED to assign browser to user ${id}: ${err.message}`);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
