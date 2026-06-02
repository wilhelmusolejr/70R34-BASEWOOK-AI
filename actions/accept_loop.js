/**
 * accept_loop — Walk the current profile's pending incoming friend requests
 * and accept each one on Facebook + record status=Accepted in the DB.
 *
 * Per iteration:
 *   1. Visit sender.profileUrl
 *   2. Validity check (skip if unavailable)
 *   3. Click "Confirm request" (text-match)
 *   4. PATCH /api/profiles/<currentUserId>/friend-requests/<senderId>
 *        body: { status: "Accepted" }
 *   5. Wait 30-60s
 *
 * Source of truth: a fresh fetchUser(currentUserId) at action start. Walks
 * user.friendRequests where status === 'Pending'. Each entry's
 * senderProfileId is an ObjectId string — we fetchUser(senderId) per
 * iteration to resolve profileUrl + name.
 */

const { humanWait, humanClick } = require('../utils/humanBehavior');
const { fetchUser, updateFriendRequestStatus } = require('../utils/userApi');

const CONFIRM_SELECTOR =
  'xpath=//div[@role="button"][.//span[normalize-space(text())="Confirm request"]]';

async function checkProfileAvailability(page, timeoutMs = 60000) {
  const start = Date.now();
  const friendsLoc = page.locator('a[href*="sk=friends_all"]').first();
  const goneLoc = page.locator('a[aria-label="Go to Feed"]').first();

  while (Date.now() - start < timeoutMs) {
    const [gone, ok] = await Promise.all([
      goneLoc.isVisible().catch(() => false),
      friendsLoc.isVisible().catch(() => false),
    ]);
    if (gone) return 'unavailable';
    if (ok) return 'available';
    await page.waitForTimeout(500);
  }
  return 'unknown';
}

async function pressIfPresent(page, selector) {
  const locator = page.locator(selector).first();
  const has = await locator.count().catch(() => 0);
  if (!has) return false;
  const visible = await locator.isVisible().catch(() => false);
  if (!visible) return false;
  const handle = await locator.elementHandle().catch(() => null);
  if (!handle) return false;

  await handle.scrollIntoViewIfNeeded().catch(() => null);
  await humanWait(page, 1000, 1800);

  const box = await handle.boundingBox().catch(() => null);
  if (!box || !box.width || !box.height) return false;

  await humanClick(page, box);
  await humanWait(page, 1500, 2500);
  return true;
}

/**
 * Pre-action browsing — make a visit look human before we confirm. Glance DOWN
 * the profile for a random 2-10s, then scroll back to the TOP over ~10s (where
 * the Confirm-request button lives, so this also re-frames it for the probe).
 * Mouse-wheel only (never window.scrollTo) per the anti-detection rules.
 * Best-effort — swallows errors so a scroll hiccup never blocks the accept.
 */
async function browseProfileThenTop(page) {
  try {
    // Phase 1 — skim down for a random 2-10s.
    const downDeadline = Date.now() + 2000 + Math.floor(Math.random() * 8001);
    while (Date.now() < downDeadline) {
      await page.mouse.wheel(0, 300 + Math.floor(Math.random() * 300)); // down 300-600
      await humanWait(page, 500, 1100);
    }

    // Phase 2 — scroll back to the top over ~10s. Upward wheel ticks hit the
    // top partway and further ticks are harmless no-ops, so a fixed ~10s window
    // both lands at the top AND keeps the "reading on the way up" duration.
    const upDeadline = Date.now() + 10000;
    while (Date.now() < upDeadline) {
      await page.mouse.wheel(0, -(400 + Math.floor(Math.random() * 300))); // up 400-700
      await humanWait(page, 350, 650);
    }
  } catch (err) {
    console.warn(`[accept_loop] pre-action browse failed (non-fatal): ${err.message}`);
  }
}

module.exports = async function accept_loop(page, params = {}) {
  const userId = params.userId || '';
  const waitMin = Number(params.waitMin ?? 30);
  const waitMax = Number(params.waitMax ?? 60);

  if (!userId) {
    console.warn('[accept_loop] No userId — cannot fetch pending requests, skipping.');
    return;
  }

  let user;
  try {
    user = await fetchUser(userId);
  } catch (err) {
    console.warn(`[accept_loop] fetchUser failed: ${err.message} — skipping.`);
    return;
  }

  const allRequests = Array.isArray(user.friendRequests) ? user.friendRequests : [];
  const pending = allRequests.filter((r) => r && r.status === 'Pending');

  console.log(
    `[accept_loop] target=${pending.length} pending request(s) wait=${waitMin}-${waitMax}s receiver=${userId}`
  );

  if (!pending.length) {
    console.log('[accept_loop] No pending requests — nothing to do.');
    return;
  }

  let acceptedCount = 0;

  for (let i = 0; i < pending.length; i++) {
    const req = pending[i];
    const idx = `${i + 1}/${pending.length}`;

    // senderProfileId is the ObjectId (sometimes returned populated, usually
    // not). Normalize to a plain id string.
    const raw = req.senderProfileId;
    const senderId = typeof raw === 'string' ? raw : raw?.id || raw?._id || '';

    if (!senderId) {
      console.warn(`[accept_loop] (${idx}) Missing senderProfileId — skipping.`);
      continue;
    }

    // Resolve sender's profile URL + display name
    let senderUrl = '';
    let senderName = '';
    try {
      const sender = await fetchUser(senderId);
      senderUrl = sender.profileUrl || '';
      senderName = `${sender.firstName || ''} ${sender.lastName || ''}`.trim();
    } catch (err) {
      console.warn(`[accept_loop] (${idx}) fetchUser(${senderId}) failed: ${err.message} — skipping.`);
      continue;
    }

    if (!senderUrl) {
      console.warn(`[accept_loop] (${idx}) Sender ${senderId} has no profileUrl — skipping.`);
      continue;
    }

    const visitLabel = senderName ? `${senderName} — ${senderUrl}` : senderUrl;
    console.log(`[accept_loop] (${idx}) Visiting ${visitLabel}`);

    try {
      await page.goto(senderUrl, { waitUntil: 'domcontentloaded' });
      await humanWait(page, 2500, 4000);
    } catch (err) {
      console.warn(`[accept_loop] goto failed: ${err.message} — skipping.`);
      await humanWait(page, waitMin * 1000, waitMax * 1000);
      continue;
    }

    // Random 10-30s timeout (was a fixed 60s). When the friends-link /
    // Go-to-Feed markers don't render (locale/variant), the check used to wait
    // the full 60s before returning "unknown" and proceeding anyway. 10-30s
    // catches a normal render and avoids a uniform timing fingerprint.
    console.log(`[accept_loop] Checking profile availability...`);
    const availability = await checkProfileAvailability(
      page,
      10000 + Math.floor(Math.random() * 20001)
    );
    if (availability === 'unavailable') {
      console.log(`[accept_loop] Profile UNAVAILABLE — skipping (no click, no PATCH).`);
      await humanWait(page, waitMin * 1000, waitMax * 1000);
      continue;
    }
    console.log(`[accept_loop] Profile available (${availability}).`);

    // Human-like pre-action browse: skim down ~2-10s, back to top ~10s.
    console.log(`[accept_loop] Browsing profile before action (skim down, back to top)...`);
    await browseProfileThenTop(page);

    console.log(`[accept_loop] Probing "Confirm request" button...`);
    const clicked = await pressIfPresent(page, CONFIRM_SELECTOR);
    if (!clicked) {
      console.warn(
        `[accept_loop] "Confirm request" not visible/clickable on ${senderUrl} — skipping (no PATCH).`
      );
      await humanWait(page, waitMin * 1000, waitMax * 1000);
      continue;
    }
    console.log(`[accept_loop] "Confirm request" clicked.`);

    try {
      await updateFriendRequestStatus(userId, senderId, 'Accepted');
      acceptedCount++;
      console.log(
        `[accept_loop] PATCH status=Accepted ok: ${senderId} → ${userId}. (${acceptedCount}/${pending.length})`
      );
    } catch (err) {
      const status = err.response?.status;
      const body = err.response?.data;
      console.warn(
        `[accept_loop] PATCH status failed (${status || 'no-status'}): ${err.message}` +
          (body ? ` | ${JSON.stringify(body)}` : '')
      );
    }

    if (i < pending.length - 1) {
      console.log(`[accept_loop] Waiting ${waitMin}-${waitMax}s before next iteration...`);
      await humanWait(page, waitMin * 1000, waitMax * 1000);
    }
  }

  console.log(`[accept_loop] Done. Accepted ${acceptedCount}/${pending.length}.`);
};
