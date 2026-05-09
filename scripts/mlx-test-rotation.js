/**
 * End-to-end test: try to open Mitchell Kirby's MLX profile. The retry loop
 * should detect GET_PROXY_CONNECTION_IP_ERROR, call rotateMultiloginProxy,
 * and succeed on the next attempt.
 *
 * Closes the browser as soon as it opens — only verifying the start succeeds.
 */

require('dotenv').config();
const { fetchUser } = require('../utils/userApi');
const { closeProfile } = require('../utils/browserManager');

// We need access to openMultiloginProfile — re-require so we can call it
// directly without going through openBrowserForUser's user-fetch indirection.
const browserManager = require('../utils/browserManager');

async function main() {
  const userId = process.argv[2] || '69f8611a497c702fe2921c6a';
  const user = await fetchUser(userId);
  const entry = (user.browsers || []).find(
    (b) => (b.provider || '').toLowerCase() === 'multilogin'
  );
  if (!entry) {
    console.error(`No multilogin entry for user ${userId}`);
    process.exit(1);
  }
  const profileId = entry.browserId;
  console.log(`[test] Profile: ${profileId} (${user.firstName} ${user.lastName})`);

  // openMultiloginProfile isn't exported, so we go through openBrowserForUser
  // — but that adds a launchBrowsers wrapper. Use launchBrowsers directly.
  const sessions = await browserManager.launchBrowsers([userId]);
  const session = sessions[0];

  console.log(`[test] SUCCESS — port ${session.port}, profile open`);

  // Tear down immediately
  await closeProfile(session.profileId, session.browser, session.provider);
  console.log('[test] Closed.');
}

main().catch((err) => {
  console.error('[test] FAILED:', err.message);
  process.exit(1);
});
