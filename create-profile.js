/**
 * Create a Hidemium profile for a user by ID.
 *
 * Usage:
 *   node create-profile.js <userId> [userId2] [userId3] ...
 *
 * For each userId:
 *   - Fetches the user from the API (firstName, lastName, proxy.proxy_new)
 *   - Tries to validate a proxy via ipinfo.io (must be reachable + US)
 *   - Creates a Hidemium profile with FB-optimized settings
 *
 * Failed profiles are logged and skipped - other IDs keep running.
 */

require('dotenv').config();
const { createProfile } = require('./utils/browserManager');

async function main() {
  const userIds = process.argv.slice(2);

  if (userIds.length === 0) {
    console.error('Usage: node create-profile.js <userId> [userId2] ...');
    process.exit(1);
  }

  const results = [];

  for (const userId of userIds) {
    console.log(`\n=== ${userId} ===`);
    try {
      const { uuid, ipInfo, body } = await createProfile(userId);
      console.log(`  OK UUID: ${uuid}`);
      console.log(`  OK Name: ${body.name}`);
      if (ipInfo) {
        console.log(`  OK IP:   ${ipInfo.ip} (${ipInfo.city}, ${ipInfo.region}, ${ipInfo.country})`);
      } else {
        console.log('  OK IP:   none (profile created without proxy)');
      }
      results.push({ userId, uuid, ok: true });
    } catch (err) {
      console.error(`  FAIL ${err.message}`);
      results.push({ userId, ok: false, error: err.message });
    }
  }

  console.log('\n=== Summary ===');
  const ok = results.filter((r) => r.ok).length;
  const failed = results.length - ok;
  console.log(`Created: ${ok}  |  Failed: ${failed}`);
  if (failed) process.exit(1);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
