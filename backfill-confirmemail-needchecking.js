/**
 * backfill-confirmemail-needchecking.js
 *
 * Scans the run-scoped log folders for profiles that hit FB's email-confirmation
 * gate (confirmemail.php) during a past session and PATCHes them to
 * `status: "Need Checking"`.
 *
 * Why: until the runner learned to detect confirmemail.php OUTSIDE of
 * facebook_signup (see runner.js — ensurePageReady / in-retry / post-step /
 * pre-flight checks setting err.needChecking), an already-logged-in profile
 * that FB redirected to confirmemail.php just soft-failed each step and got
 * logged PARTIAL → folder renamed SUCCESS, never flagged. ~130 such profiles
 * slipped through on 2026-06-02/03. This one-shot backfills them.
 *
 * Detection signal: a forensic HTML dump in the profile folder whose embedded
 * `<!-- url: ... -->` comment points at confirmemail.php. (Going forward the
 * runner aborts + flags these live, so this script is only for the backlog.)
 *
 * Owner-id resolution: the per-profile folder name carries only the first 8
 * chars of the userId, and session.log can mention OTHER profiles' ids (e.g.
 * connect_loop PATCHing visited profiles' friend counts). So we resolve the
 * OWNER id as the full 24-hex id in session.log whose prefix equals the
 * folder's short id — unambiguous and deterministic.
 *
 * Idempotent — skips profiles already at "Need Checking".
 *
 * Usage:
 *   node backfill-confirmemail-needchecking.js                 # dry-run summary
 *   node backfill-confirmemail-needchecking.js --apply         # actually PATCH
 *   node backfill-confirmemail-needchecking.js --logs=logs     # custom logs dir
 *   node backfill-confirmemail-needchecking.js --since=2026-06-02  # only run folders on/after this date
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { fetchUser, updateProfile } = require('./utils/userApi');

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const getArg = (name) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : '';
};
const LOGS_DIR = path.resolve(process.cwd(), getArg('logs') || 'logs');
const SINCE = getArg('since'); // YYYY-MM-DD, compared against the {taskId}-YYYYMMDD-HHmmss suffix

const SHORT_ID_RE = /([0-9a-f]{8})\s*$/i; // trailing 8-hex in the folder name
const FULL_ID_RE = /[0-9a-f]{24}/gi;
const CONFIRMEMAIL_RE = /confirmemail\.php/i;

/**
 * Pull the run folder's date (YYYYMMDD) out of its `{taskId}-YYYYMMDD-HHmmss`
 * name so --since can filter. Returns '' when the name doesn't carry a stamp.
 */
function runFolderDate(name) {
  const m = name.match(/(\d{8})-\d{6}$/);
  return m ? `${m[1].slice(0, 4)}-${m[1].slice(4, 6)}-${m[1].slice(6, 8)}` : '';
}

/** True if any *.html dump in the folder has confirmemail.php in its url comment. */
function folderHitConfirmEmail(profileDir) {
  let entries;
  try {
    entries = fs.readdirSync(profileDir);
  } catch (_) {
    return false;
  }
  for (const entry of entries) {
    if (!entry.toLowerCase().endsWith('.html')) continue;
    try {
      // The embedded `<!-- url: ... -->` comment sits at the very top of every
      // dump, so the first few KB is enough — no need to read multi-MB pages.
      const fd = fs.openSync(path.join(profileDir, entry), 'r');
      const buf = Buffer.alloc(8192);
      const read = fs.readSync(fd, buf, 0, 8192, 0);
      fs.closeSync(fd);
      if (CONFIRMEMAIL_RE.test(buf.slice(0, read).toString('utf8'))) return true;
    } catch (_) {
      // unreadable dump — ignore
    }
  }
  return false;
}

/**
 * Resolve the owner's full 24-hex userId from the folder name + session.log.
 *
 * The folder name carries only an 8-char short id, and Mongo ObjectIds minted
 * in the same second share that prefix — yesterday a whole creation batch
 * collided on 6a13f1d2 (Asia / Giulio / Lucia / Pietro). So a naive
 * `startsWith(shortId)` is ambiguous. Resolution order:
 *
 *   1. tracker / onboarding URL — `/api/profiles/<id>/tracker` and
 *      `/api/profiles/<id>/onboarding/<key>` are ONLY ever called for the
 *      session's own profile (never for visited profiles), so they're the
 *      authoritative owner signal.
 *   2. unique prefix match — exactly one 24-hex id in the log starts with the
 *      folder's short id. Unambiguous, safe.
 *   3. otherwise → unresolved. We refuse to guess when several prefix-colliding
 *      ids appear and there's no tracker/onboarding marker, so we never flag the
 *      WRONG profile. Reported for manual review instead.
 */
function resolveOwnerId(profileDir, folderName) {
  const shortMatch = folderName.match(SHORT_ID_RE);
  const shortId = shortMatch ? shortMatch[1].toLowerCase() : '';

  let log = '';
  try {
    log = fs.readFileSync(path.join(profileDir, 'session.log'), 'utf8');
  } catch (_) {
    /* no session.log */
  }

  // 1. Authoritative owner marker.
  const ownerUrl = log.match(/\/api\/profiles\/([0-9a-f]{24})\/(?:tracker|onboarding)/i);
  if (ownerUrl) return ownerUrl[1].toLowerCase();

  // 2. Unique prefix match (only when exactly one id collides on the short id).
  if (shortId) {
    const ids = [...new Set((log.match(FULL_ID_RE) || []).map((s) => s.toLowerCase()))];
    const matches = ids.filter((id) => id.startsWith(shortId));
    if (matches.length === 1) return matches[0];
  }

  // 3. Ambiguous / no signal — caller marks it unresolved.
  return shortId ? `(unresolved:${shortId})` : '';
}

async function main() {
  if (!fs.existsSync(LOGS_DIR)) {
    console.error(`Logs dir not found: ${LOGS_DIR}`);
    process.exit(1);
  }

  console.log(`Scanning ${LOGS_DIR}${SINCE ? ` (since ${SINCE})` : ''}`);
  console.log(APPLY ? 'Mode: APPLY (will PATCH)\n' : 'Mode: DRY-RUN (no writes — pass --apply)\n');

  // userId -> { name, folders: Set, resolved: bool }
  const hits = new Map();
  const unresolved = []; // { folder, runFolder }

  const runFolders = fs.readdirSync(LOGS_DIR).filter((n) => {
    const full = path.join(LOGS_DIR, n);
    try {
      if (!fs.statSync(full).isDirectory()) return false;
    } catch (_) {
      return false;
    }
    if (SINCE) {
      const d = runFolderDate(n);
      if (d && d < SINCE) return false;
    }
    return true;
  });

  for (const runFolder of runFolders) {
    const profilesDir = path.join(LOGS_DIR, runFolder, 'profiles');
    let profileFolders;
    try {
      profileFolders = fs.readdirSync(profilesDir);
    } catch (_) {
      continue; // run folder without a profiles/ subdir
    }
    for (const folderName of profileFolders) {
      const profileDir = path.join(profilesDir, folderName);
      try {
        if (!fs.statSync(profileDir).isDirectory()) continue;
      } catch (_) {
        continue;
      }
      if (!folderHitConfirmEmail(profileDir)) continue;

      const ownerId = resolveOwnerId(profileDir, folderName);
      if (!/^[0-9a-f]{24}$/i.test(ownerId)) {
        unresolved.push({ folder: folderName, runFolder, ownerId });
        continue;
      }
      if (!hits.has(ownerId)) hits.set(ownerId, { folders: new Set(), name: '' });
      hits.get(ownerId).folders.add(`${runFolder}/${folderName}`);
    }
  }

  console.log(`Found ${hits.size} unique profile(s) that hit confirmemail.php.`);
  if (unresolved.length) {
    console.log(`\n${unresolved.length} folder(s) could NOT be resolved to a full userId:`);
    for (const u of unresolved) console.log(`  - ${u.runFolder}/${u.folder} (${u.ownerId || 'no id'})`);
  }
  if (hits.size === 0) {
    console.log('\nNothing to do.');
    return;
  }

  let patched = 0;
  let alreadyFlagged = 0;
  let failed = 0;

  console.log('');
  for (const [userId, info] of hits) {
    let currentStatus = '(unknown)';
    let name = '';
    try {
      const user = await fetchUser(userId);
      currentStatus = user?.status || '(none)';
      name = [user?.firstName, user?.lastName].filter(Boolean).join(' ');
    } catch (err) {
      console.warn(`  ! fetchUser(${userId}) failed: ${err.message} — will still attempt PATCH`);
    }

    const label = `${name || '(name?)'} [${userId}] status=${currentStatus}`;

    if (currentStatus === 'Need Checking') {
      console.log(`  = ${label} — already Need Checking, skipping`);
      alreadyFlagged++;
      continue;
    }

    if (!APPLY) {
      console.log(`  ~ ${label} -> Need Checking (dry-run)`);
      patched++;
      continue;
    }

    try {
      await updateProfile(userId, { status: 'Need Checking' });
      console.log(`  ✓ ${label} -> Need Checking`);
      patched++;
    } catch (err) {
      console.warn(`  ✗ ${label} — PATCH failed: ${err.message}`);
      failed++;
    }
  }

  console.log('\n--- Summary ---');
  console.log(`Hit confirmemail.php : ${hits.size}`);
  console.log(`Already Need Checking: ${alreadyFlagged}`);
  console.log(APPLY ? `Patched              : ${patched}` : `Would patch          : ${patched}`);
  if (failed) console.log(`PATCH failures       : ${failed}`);
  if (unresolved.length) console.log(`Unresolved folders   : ${unresolved.length}`);
  if (!APPLY) console.log('\nDry-run only. Re-run with --apply to write the changes.');
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
