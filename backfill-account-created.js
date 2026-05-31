/**
 * backfill-account-created.js
 *
 * For profiles that have completed at least one FB-side onboarding step but
 * have an empty `accountCreated` field, stamp `accountCreated` with the
 * EARLIEST known FB-side timestamp. Idempotent — never touches profiles
 * that already have `accountCreated` set.
 *
 * Why: facebook_signup now stamps `accountCreated` on home-feed landing
 * (idempotent — won't overwrite). But every profile created before that
 * change has an empty `accountCreated`, which breaks `minAccountAgeDays`
 * guards across the fleet. This script fills the gap.
 *
 * Source-timestamp priority (earliest wins):
 *   1. user.onboarding.privacyPublicAt
 *   2. user.onboarding.aboutSetAt
 *   3. user.onboarding.profileImageSetAt
 *   4. user.onboarding.coverImageSetAt
 *   5. user.onboarding.lastSharedAt
 *   6. user.createdAt (DB record creation — last resort)
 *
 * Without any of those, the profile is skipped — there's no signal that
 * an FB account actually exists.
 *
 * Usage:
 *   node backfill-account-created.js            # dry-run summary
 *   node backfill-account-created.js --apply    # actually PATCH the records
 *   node backfill-account-created.js --apply --status=Active  # limit by status
 */

require('dotenv').config();
const { fetchProfilesByStatus, updateProfile } = require('./utils/userApi');

const DEFAULT_STATUSES = ['Active', 'Need Setup', 'Need Checking', 'Ready', 'Delivered'];

function pickEarliestStamp(user) {
  const candidates = [
    user?.onboarding?.privacyPublicAt,
    user?.onboarding?.aboutSetAt,
    user?.onboarding?.profileImageSetAt,
    user?.onboarding?.coverImageSetAt,
    user?.onboarding?.lastSharedAt,
    user?.createdAt,
  ]
    .filter((v) => typeof v === 'string' && v.trim())
    .map((v) => Date.parse(v))
    .filter((t) => Number.isFinite(t) && t > 0);
  if (!candidates.length) return null;
  return new Date(Math.min(...candidates));
}

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const statusArg = args.find((a) => a.startsWith('--status='));
  const statuses = statusArg ? [statusArg.slice('--status='.length)] : DEFAULT_STATUSES;

  console.log(`backfill-account-created: ${apply ? 'APPLY' : 'DRY RUN'}, statuses=${statuses.join(',')}`);

  let scanned = 0;
  let alreadySet = 0;
  let noSignal = 0;
  const plans = [];

  for (const status of statuses) {
    let profiles;
    try {
      profiles = await fetchProfilesByStatus(status);
    } catch (err) {
      console.warn(`  status=${status}: fetch failed: ${err.message}`);
      continue;
    }
    console.log(`  status=${status}: ${profiles.length} profile(s) fetched`);

    for (const u of profiles) {
      scanned++;
      if (u.accountCreated && String(u.accountCreated).trim()) {
        alreadySet++;
        continue;
      }
      const stamp = pickEarliestStamp(u);
      if (!stamp) {
        noSignal++;
        continue;
      }
      plans.push({
        userId: u._id || u.id,
        name: `${u.firstName || ''} ${u.lastName || ''}`.trim() || '?',
        status: u.status,
        accountCreated: stamp.toISOString(),
      });
    }
  }

  console.log('');
  console.log(`Profiles scanned:           ${scanned}`);
  console.log(`Already has accountCreated: ${alreadySet}`);
  console.log(`No FB-signal — skipping:    ${noSignal}`);
  console.log(`Planned backfills:          ${plans.length}`);

  if (plans.length === 0) {
    console.log('Nothing to do.');
    return;
  }

  if (!apply) {
    console.log('\nFirst 20 planned backfills:');
    plans.slice(0, 20).forEach((p) => {
      console.log(`  ${p.userId}  ${p.name.padEnd(28)}  ${p.status.padEnd(14)}  → ${p.accountCreated}`);
    });
    console.log('\nRe-run with --apply to write.');
    return;
  }

  console.log('\nApplying...');
  let ok = 0;
  let fail = 0;
  for (const p of plans) {
    try {
      await updateProfile(p.userId, { accountCreated: p.accountCreated });
      ok++;
      console.log(`  ✓ ${p.userId} ${p.name} → ${p.accountCreated}`);
    } catch (err) {
      fail++;
      console.warn(`  ✗ ${p.userId} ${p.name}: ${err.message}`);
    }
  }
  console.log(`\nDone — ok=${ok} fail=${fail}`);
}

main().catch((err) => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
