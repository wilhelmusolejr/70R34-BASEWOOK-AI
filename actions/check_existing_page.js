/**
 * check_existing_page - read-only leaf action.
 *
 * Temporary backfill: detect whether this profile ALREADY manages a Facebook
 * Page and, if so, PATCH the user record's `pageUrl`. It NEVER creates a Page.
 *
 * Use case: many profiles already have a Page FB-side that was never recorded
 * in the DB `pageUrl` (created out-of-band, or a prior create_page run whose
 * post-create PATCH never landed). This walks the account's "Pages you manage"
 * listing and back-fills the URL so the cheap DB-level duplicate-Page guard
 * (createPageGate) will short-circuit future create_page runs.
 *
 * Reuses the exact same detection + persistence helpers as create_page
 * (`findExistingManagedPageUrl`, `persistPageUrl`) so the two never drift.
 *
 * Compose into a task and run with the normal runner so it inherits browser
 * open, auto re-login, checkpoint handling, concurrency, and state-resume:
 *
 *   { "type": "check_existing_page" }
 *
 * Auto-injected params (runner.js injectUserParams): `userId`, `pageUrl`.
 */

const { findExistingManagedPageUrl, persistPageUrl } = require('./create_page');
const { setOnboarding } = require('../utils/userApi');

module.exports = async function check_existing_page(page, params) {
  const { userId = '', pageUrl = '' } = params;

  // Already recorded in the DB → nothing to back-fill. Skip the FB navigation
  // entirely (pass an explicit "pageUrl": "" in the step params to force a
  // re-check on an already-recorded profile).
  if (String(pageUrl).trim()) {
    console.log(`  [check_existing_page] pageUrl already set (${pageUrl}) — skipping check.`);
    return;
  }

  const existingPageUrl = await findExistingManagedPageUrl(page);

  if (!existingPageUrl) {
    console.log(
      '  [check_existing_page] No existing Page found for this profile — nothing to back-fill.'
    );
    return;
  }

  console.log(
    `  [check_existing_page] Found existing Page (${existingPageUrl}) — back-filling user.pageUrl.`
  );
  await persistPageUrl(userId, existingPageUrl);
  // Stamp pageSetAt too — a Page demonstrably exists FB-side, so the page-setup
  // cooldown gate should treat this profile as "already attempted/created".
  if (userId) await setOnboarding(userId, 'pageSetAt');
};
