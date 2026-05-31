/**
 * backfill-onboarding.js
 *
 * Walks every Active profile's `trackerLog` and stamps missing `onboarding.*`
 * keys based on what's already been completed historically. Use after wiring
 * the onboarding stamps so existing profiles don't appear "not yet done"
 * forever.
 *
 * Detection — a step in the numbered list (SUCCESS or FAIL entry — the list
 * shows COMPLETED steps either way; FAIL just means a later step crashed) is
 * matched against:
 *
 *   setup_privacy         → privacyPublicAt     (first occurrence)
 *   setup_avatar          → profileImageSetAt   (first occurrence)
 *   setup_cover           → coverImageSetAt     (first occurrence)
 *   setup_about           → aboutSetAt          (first occurrence)
 *   marketplace_location  → marketplaceSetAt    (first occurrence)
 *   publish_post          → publishPostAt       (first occurrence)
 *   share_post / share_posts → lastSharedAt     (LATEST occurrence)
 *
 * Tracker dates are YYYY-MM-DD only, so we stamp at noon UTC of that day.
 * The script only sets keys that are currently null/missing — never
 * overwrites a precise stamp with a backfilled day-only one.
 *
 * Usage:
 *   node backfill-onboarding.js            # dry-run, print plan
 *   node backfill-onboarding.js --apply    # actually PATCH
 *   node backfill-onboarding.js --status=Ready --apply   # other status
 */

require('dotenv').config();
const axios = require('axios');
const { setOnboarding } = require('./utils/userApi');

const BASE = process.env.USER_API_BASE_URL;
if (!BASE) {
  console.error('USER_API_BASE_URL not set');
  process.exit(1);
}

const ACTION_TO_KEY = {
  setup_privacy: { key: 'privacyPublicAt', mode: 'first' },
  setup_avatar: { key: 'profileImageSetAt', mode: 'first' },
  setup_cover: { key: 'coverImageSetAt', mode: 'first' },
  setup_about: { key: 'aboutSetAt', mode: 'first' },
  marketplace_location: { key: 'marketplaceSetAt', mode: 'first' },
  publish_post: { key: 'publishPostAt', mode: 'first' },
  share_post: { key: 'lastSharedAt', mode: 'last' },
  share_posts: { key: 'lastSharedAt', mode: 'last' },
};

function parseArgs(argv) {
  const args = argv.slice(2);
  const flags = { apply: false, status: 'Active' };
  for (const a of args) {
    if (a === '--apply') flags.apply = true;
    else if (a.startsWith('--status=')) flags.status = a.slice('--status='.length);
  }
  return flags;
}

function dateToIso(yyyyMmDd) {
  // Tracker dates carry no time, so stamp at noon UTC of that day.
  if (!yyyyMmDd) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(yyyyMmDd));
  if (!m) return null;
  return `${m[1]}-${m[2]}-${m[3]}T12:00:00.000Z`;
}

/**
 * Walk one trackerLog. Return a map {actionType: { first: 'YYYY-MM-DD',
 * last: 'YYYY-MM-DD' }} for every recognized action that appears in any
 * entry's numbered step list.
 */
function detectCompletedActions(trackerLog) {
  const detected = {};
  if (!Array.isArray(trackerLog)) return detected;

  // Sort by date so first/last are deterministic
  const sorted = [...trackerLog].sort((a, b) => String(a.date).localeCompare(String(b.date)));

  for (const entry of sorted) {
    const date = entry.date;
    const note = String(entry.note || '');
    // Pull lines like "1. setup_avatar" or "6. visit_profile - wait - share_posts"
    const stepLines = note
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => /^\d+\.\s/.test(l));

    for (const line of stepLines) {
      // Strip the leading "N. " and split the chain by " - "
      const chain = line
        .replace(/^\d+\.\s+/, '')
        .split(/\s*-\s*/)
        .map((s) => s.trim())
        .filter(Boolean);

      for (const token of chain) {
        // Token might include suffix like "(auto)" — strip and lowercase
        const action = token.replace(/\(.*\)/, '').trim();
        if (ACTION_TO_KEY[action]) {
          if (!detected[action]) detected[action] = { first: date, last: date };
          else {
            if (date < detected[action].first) detected[action].first = date;
            if (date > detected[action].last) detected[action].last = date;
          }
        }
      }
    }
  }

  return detected;
}

/**
 * From detected actions, compute the per-onboarding-key stamps we'd apply.
 * Skips keys whose current onboarding value is already non-null (we never
 * overwrite a real stamp with a backfilled day-only one).
 */
function planStamps(user) {
  const detected = detectCompletedActions(user.trackerLog);
  const current = user.onboarding || {};
  const plan = [];

  for (const [action, { first, last }] of Object.entries(detected)) {
    const { key, mode } = ACTION_TO_KEY[action];
    const date = mode === 'last' ? last : first;
    const iso = dateToIso(date);
    if (!iso) continue;

    // Skip if already stamped (don't downgrade a real ISO to a day-only one).
    // Allow lastSharedAt update if the existing stamp is older than what we'd
    // backfill — but to keep things safe + conservative, we treat ANY non-null
    // existing value as "already set" and skip.
    if (current[key]) continue;

    plan.push({ action, key, date, iso });
  }

  // Dedupe by key (share_post + share_posts both map to lastSharedAt — pick later)
  const byKey = {};
  for (const p of plan) {
    if (!byKey[p.key] || p.iso > byKey[p.key].iso) byKey[p.key] = p;
  }
  return Object.values(byKey);
}

async function fetchProfilesByStatus(status) {
  // limit=500 max per api.md; we have 71 so this is fine
  const { data } = await axios.get(`${BASE}/api/profiles`, {
    params: { status, limit: 500 },
    timeout: 30000,
  });
  const parsed = typeof data === 'string' ? JSON.parse(data) : data;
  return parsed.data || parsed;
}

async function main() {
  const flags = parseArgs(process.argv);
  console.log(`Fetching profiles with status="${flags.status}"...`);
  const profiles = await fetchProfilesByStatus(flags.status);
  console.log(`  → ${profiles.length} profile(s)`);
  console.log(flags.apply ? '\nMODE: APPLY (will PATCH)' : '\nMODE: DRY-RUN (no writes)');
  console.log();

  const summary = { profiles: profiles.length, withPlan: 0, totalStamps: 0, failed: 0 };

  for (const u of profiles) {
    const userId = u._id || u.id;
    const name = [u.firstName, u.lastName].filter(Boolean).join(' ') || userId;

    const plan = planStamps(u);
    if (plan.length === 0) continue;

    summary.withPlan++;
    summary.totalStamps += plan.length;
    console.log(`${name}  (${userId})`);
    for (const p of plan) {
      console.log(`  ${p.key.padEnd(20)} ← ${p.action.padEnd(22)} on ${p.date} → ${p.iso}`);
    }

    if (flags.apply) {
      for (const p of plan) {
        try {
          await setOnboarding(userId, p.key, p.iso);
        } catch (err) {
          console.warn(`  [error] ${p.key}: ${err.message}`);
          summary.failed++;
        }
      }
    }
    console.log();
  }

  console.log('=== Summary ===');
  console.log(`  Profiles scanned:    ${summary.profiles}`);
  console.log(`  With backfill plan:  ${summary.withPlan}`);
  console.log(`  Total stamps:        ${summary.totalStamps}`);
  if (flags.apply) console.log(`  PATCH failures:      ${summary.failed}`);
  if (!flags.apply) console.log('\n  → Re-run with --apply to write.');
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
