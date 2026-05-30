/**
 * update_name_notes.js — Rename MLX profiles + rewrite their notes from the
 * linked user record fetched off the online platform (USER_API_BASE_URL).
 *
 * Input: paste user IDs into `multilogin/ids.txt`, one per line (# = comment).
 *        Or pass them as CLI args: node multilogin/update_name_notes.js <id> ...
 *
 * For each user _id:
 *   1. fetch the user record from the platform
 *   2. resolve the linked multilogin profile (browsers[].provider==='multilogin')
 *   3. partial_update the MLX profile with:
 *        name  = "FirstName LastName - WALMART"
 *        notes = credential block (see buildNotes)
 */

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Bridge legacy multilogin/.env short names to canonical names.
const MLX_EMAIL = process.env.MULTILOGIN_EMAIL || process.env.MLX_EMAIL;
const MLX_PASSWORD = process.env.MULTILOGIN_PASSWORD || process.env.MLX_PASSWORD;
const WORKSPACE_ID = process.env.MULTILOGIN_WORKSPACE_ID || process.env.WORKSPACE_ID;
const MLX_BASE = 'https://api.multilogin.com';
const USER_API_BASE_URL =
  process.env.USER_API_BASE_URL || process.env.API_BASE || 'https://7or34.space';

// Suffix appended to every profile name.
const NAME_SUFFIX = 'WALMART';

const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');

async function mlxSignIn() {
  const res = await fetch(`${MLX_BASE}/user/signin`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: MLX_EMAIL, password: md5(MLX_PASSWORD) }),
  });
  if (!res.ok) throw new Error(`signin failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  const userToken = data?.data?.token;
  const refreshToken = data?.data?.refresh_token;
  const wsRes = await fetch(`${MLX_BASE}/user/refresh_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${userToken}` },
    body: JSON.stringify({
      email: MLX_EMAIL,
      workspace_id: WORKSPACE_ID,
      refresh_token: refreshToken,
    }),
  });
  if (!wsRes.ok) throw new Error(`refresh_token failed: ${wsRes.status} ${await wsRes.text()}`);
  const wsData = await wsRes.json();
  const token = wsData?.data?.token;
  if (!token) throw new Error('no workspace token');
  return token;
}

async function fetchUser(userId) {
  const res = await fetch(`${USER_API_BASE_URL}/api/profiles/${userId}`);
  if (!res.ok) throw new Error(`fetchUser ${userId} failed: ${res.status}`);
  return res.json();
}

function pickEmail(user) {
  const emails = user.emails || [];
  return (emails.find((e) => e.selected)?.address || emails[0]?.address || '').trim();
}

function buildName(user) {
  const full = `${user.firstName || ''} ${user.lastName || ''}`.trim();
  return `${full} - ${NAME_SUFFIX}`;
}

// Pull the numeric FB id out of a profileUrl like
// https://www.facebook.com/profile.php?id=61588764737169
function fbNumericId(user) {
  const m = String(user.profileUrl || '').match(/[?&]id=(\d+)/);
  return m ? m[1] : '';
}

// Recovery email = local part of the selected email + @fviainboxes.com
// e.g. test123@outlook.com -> test123@fviainboxes.com
const RECOVERY_DOMAIN = 'fviainboxes.com';
function recoveryEmail(email) {
  const local = (email || '').split('@')[0];
  return local ? `${local}@${RECOVERY_DOMAIN}` : '';
}

const esc = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Credential block written to the MLX "notes" field. MLX's notes field is an
// HTML rich-text editor — line breaks only render when each field is its own
// <p> paragraph (a plain \n / \r\n collapses to a space). Matches the format
// MLX saved when Patrick Doyle's note was edited by hand in the UI.
function buildNotes(user) {
  const email = pickEmail(user);
  const rows = [
    ['FB', fbNumericId(user)],
    ['Pass', user.facebookPassword || ''],
    ['EMAIL', email],
    ['EMAIL PASS', user.emailPassword || ''],
    ['RECOVERY', recoveryEmail(email)],
    ['RECOVERY PASS', ''],
    ['2FA', ''],
  ];
  return rows.map(([k, v]) => `<p>${k}: ${esc(v)}</p>`).join('');
}

async function updateProfile(token, profileId, name, notes) {
  const res = await fetch(`${MLX_BASE}/profile/partial_update`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ profile_id: profileId, name, notes }),
  });
  if (!res.ok) throw new Error(`partial_update failed: ${res.status} ${await res.text()}`);
  return res.json();
}

function resolveUserIds() {
  const args = process.argv.slice(2).filter((a) => a && !a.startsWith('--'));
  if (args.length) return args;
  const idsPath = path.resolve(__dirname, 'ids.txt');
  if (!fs.existsSync(idsPath)) return [];
  return fs
    .readFileSync(idsPath, 'utf8')
    .split(/\r?\n/)
    .map((l) => l.replace(/#.*$/, '').trim()) // strip inline + full-line comments
    .filter(Boolean);
}

async function main() {
  const userIds = resolveUserIds();
  if (!userIds.length) {
    console.error('No user IDs. Paste them into multilogin/ids.txt (one per line).');
    process.exit(1);
  }

  const dryRun = process.argv.includes('--dry-run');
  const token = dryRun ? null : await mlxSignIn();
  console.log(`${dryRun ? '[DRY RUN] ' : ''}Updating ${userIds.length} profile(s)...\n`);

  let ok = 0;
  for (const userId of userIds) {
    try {
      const user = await fetchUser(userId);
      const entry = (user.browsers || []).find((b) => b.provider === 'multilogin');
      if (!entry) {
        console.warn(`  ${userId}: no multilogin browser entry — skip`);
        continue;
      }
      const name = buildName(user);
      const notes = buildNotes(user);

      if (dryRun) {
        console.log(`  ${userId} -> ${entry.browserId}`);
        console.log(`    name:  ${name}`);
        console.log(`    notes:\n${notes.replace(/^/gm, '      ')}\n`);
        ok++;
        continue;
      }

      await updateProfile(token, entry.browserId, name, notes);
      console.log(`  ${userId}: "${name}"`);
      ok++;
    } catch (err) {
      console.warn(`  ${userId}: ${err.message}`);
    }
  }

  console.log(`\nDone. ${ok}/${userIds.length} ${dryRun ? 'previewed' : 'updated'}.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
