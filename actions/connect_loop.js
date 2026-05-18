/**
 * connect_loop — Visit random profiles from a pool and run the connect flow:
 *   1. Visit URL, verify profile is reachable (race friends-link vs Go-to-Feed).
 *   2. PATCH friend count on the visited user (skip if selector missing).
 *   3. Action button check (priority order, exactly one fires per profile):
 *        a. "Add friend"      → click + check rate-limit + POST friend-request
 *        b. "Cancel request"  → already sent, sync record (POST → 409 → PATCH Pending)
 *        c. "Confirm request" → click only, NOT counted, no POST
 *        else                 → log and skip
 *   4. Random wait between iterations (default 60-80s).
 *
 * Stop conditions:
 *   - successCount >= count       (Add friend presses, NOT Confirm request)
 *   - rate-limit modal detected   (dismiss + stop loop, no POST for that press)
 *   - attempts >= maxAttempts     (safety cap)
 *   - pool returned no targets
 *
 * Trust model: a click is reported as "pressed" as soon as humanClick fires.
 * The rate-limit modal is the only failure signal — there's no DOM-state
 * verification, since FB's DOM updates are slow and were producing false
 * "click did not register" reports.
 */

const { humanWait, humanClick } = require('../utils/humanBehavior');
const {
  fetchActiveProfiles,
  updateProfile,
  recordFriendRequest,
  updateFriendRequestStatus,
} = require('../utils/userApi');
const { detectRateLimit, dismissRateLimit } = require('../utils/fbRateLimit');

const STATIC_POOLS = {
  friends: require('../config/friend_targets.json'),
  sharers: require('../config/share_sources.json'),
};

const ADD_FRIEND_SELECTOR =
  'xpath=//div[@role="button"][.//span[normalize-space(text())="Add friend"]]';
const CONFIRM_SELECTOR =
  'xpath=//div[@role="button"][.//span[normalize-space(text())="Confirm request"]]';
const CANCEL_REQUEST_SELECTOR =
  'xpath=//div[@role="button"][.//span[normalize-space(text())="Cancel request"]]';

async function pickTarget(pool, { maxFriends } = {}) {
  if (STATIC_POOLS[pool]) {
    const list = STATIC_POOLS[pool];
    if (!list.length) return null;
    return { profileUrl: list[Math.floor(Math.random() * list.length)] };
  }
  if (pool === 'users') {
    const profiles = await fetchActiveProfiles(5);
    const eligible =
      typeof maxFriends === 'number'
        ? profiles.filter((p) => p.friends == null || p.friends < maxFriends)
        : profiles;
    if (!eligible.length) return null;
    const u = eligible[Math.floor(Math.random() * eligible.length)];
    const name = `${u.firstName || ''} ${u.lastName || ''}`.trim();
    return { profileUrl: u.profileUrl, userId: u._id || u.id || '', name };
  }
  throw new Error(`connect_loop: unknown pool "${pool}" (valid: friends, sharers, users)`);
}

function parseFriendCount(text) {
  if (!text) return null;
  const cleaned = String(text).replace(/,/g, '').trim();
  const match = cleaned.match(/([\d.]+)\s*([KMB])?/i);
  if (!match) return null;
  const num = parseFloat(match[1]);
  if (isNaN(num)) return null;
  const suffix = (match[2] || '').toUpperCase();
  const mult =
    suffix === 'K' ? 1000 : suffix === 'M' ? 1_000_000 : suffix === 'B' ? 1_000_000_000 : 1;
  return Math.round(num * mult);
}

async function readFriendCount(page) {
  try {
    const link = page.locator('a[href*="sk=friends_all"]').first();
    const has = await link.count().catch(() => 0);
    if (!has) return null;
    const strong = link.locator('strong').first();
    const text = await strong.textContent().catch(() => '');
    return parseFriendCount(text);
  } catch (_) {
    return null;
  }
}

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

/**
 * Press a button matching `selector` if it's visible. Returns true if the
 * click was dispatched. No DOM-state verification afterwards — caller should
 * use detectRateLimit for failure detection.
 */
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

async function isVisible(page, selector) {
  const loc = page.locator(selector).first();
  const has = await loc.count().catch(() => 0);
  if (!has) return false;
  return loc.isVisible().catch(() => false);
}

async function syncExistingFriendRequest(receiverId, senderId) {
  try {
    await recordFriendRequest(receiverId, senderId);
    console.log(`[connect_loop] POST friend-request ok: ${senderId} → ${receiverId}.`);
    return;
  } catch (err) {
    const status = err.response?.status;
    if (status !== 409) {
      const body = err.response?.data;
      console.warn(
        `[connect_loop] POST friend-request failed (${status || 'no-status'}): ${err.message}` +
          (body ? ` | ${JSON.stringify(body)}` : '')
      );
      return;
    }
    console.log(`[connect_loop] POST friend-request → 409 duplicate, will PATCH to Pending.`);
  }

  try {
    await updateFriendRequestStatus(receiverId, senderId, 'Pending');
    console.log(`[connect_loop] PATCH friend-request status=Pending ok: ${senderId} → ${receiverId}.`);
  } catch (err) {
    const status = err.response?.status;
    const body = err.response?.data;
    console.warn(
      `[connect_loop] PATCH friend-request failed (${status || 'no-status'}): ${err.message}` +
        (body ? ` | ${JSON.stringify(body)}` : '')
    );
  }
}

module.exports = async function connect_loop(page, params = {}) {
  const pool = params.pool || 'users';
  const targetCount = Number(params.count ?? 7);
  const maxAttempts = Number(params.maxAttempts ?? targetCount * 3);
  const waitMin = Number(params.waitMin ?? 30);
  const waitMax = Number(params.waitMax ?? 60);
  const senderId = params.userId || '';
  const maxFriends = params.maxFriends != null ? Number(params.maxFriends) : 30;
  const skipIfFriendsAbove =
    params.skipIfFriendsAbove != null ? Number(params.skipIfFriendsAbove) : null;

  let successCount = 0;
  let attempts = 0;
  let stopReason = '';

  console.log(
    `[connect_loop] target=${targetCount} pool="${pool}" maxAttempts=${maxAttempts} wait=${waitMin}-${waitMax}s sender=${senderId || '(none)'} maxFriends=${maxFriends}` +
      (skipIfFriendsAbove != null ? ` skipIfFriendsAbove=${skipIfFriendsAbove}` : '')
  );

  // ── Sender-side skip check ───────────────────────────────────────────────
  // When skipIfFriendsAbove is set, navigate to /me, read this account's
  // current friend count, opportunistically PATCH it back (the sender's own
  // friends count is otherwise only updated when ANOTHER bot visits this
  // profile, so it goes stale), and skip the whole loop if the threshold is
  // exceeded. Lets daily-engage tasks stop friend-adding once an account has
  // filled out its initial social graph without the caller having to know
  // the count up front.
  if (skipIfFriendsAbove != null) {
    try {
      console.log(`[connect_loop] Pre-check: navigating to /me to read sender friend count...`);
      await page.goto('https://www.facebook.com/me', { waitUntil: 'domcontentloaded' });
      await humanWait(page, 2000, 3500);

      const currentFriends = await readFriendCount(page);
      if (currentFriends == null) {
        console.log(
          `[connect_loop] Could not read sender friend count from /me — proceeding with connect_loop.`
        );
      } else {
        console.log(`[connect_loop] Sender friends=${currentFriends}.`);
        if (senderId) {
          try {
            await updateProfile(senderId, { friends: currentFriends });
            console.log(
              `[connect_loop] PATCHed self friends=${currentFriends} on user ${senderId}.`
            );
          } catch (err) {
            console.warn(`[connect_loop] PATCH self friends failed: ${err.message}`);
          }
        }
        if (currentFriends > skipIfFriendsAbove) {
          console.log(
            `[connect_loop] Sender friends=${currentFriends} > ${skipIfFriendsAbove} — skipping action.`
          );
          return;
        }
      }
    } catch (err) {
      console.warn(
        `[connect_loop] Pre-check failed (${err.message}) — proceeding with connect_loop anyway.`
      );
    }
  }

  while (successCount < targetCount && attempts < maxAttempts) {
    attempts++;

    // ── 1. Pick + visit ───────────────────────────────────────────────
    let target;
    try {
      target = await pickTarget(pool, { maxFriends });
    } catch (err) {
      console.warn(`[connect_loop] pickTarget failed: ${err.message} — stopping.`);
      stopReason = 'pool error';
      break;
    }
    if (!target) {
      console.log(
        `[connect_loop] Pool "${pool}" had no eligible target (maxFriends=${maxFriends}) — stopping.`
      );
      stopReason = 'empty pool';
      break;
    }

    const visitLabel = target.name
      ? `${target.name} — ${target.profileUrl}`
      : target.profileUrl;
    console.log(`[connect_loop] (${attempts}/${maxAttempts}) Visiting ${visitLabel}`);

    try {
      await page.goto(target.profileUrl, { waitUntil: 'domcontentloaded' });
      await humanWait(page, 2500, 4000);
    } catch (err) {
      console.warn(`[connect_loop] goto failed: ${err.message} — skipping.`);
      await humanWait(page, waitMin * 1000, waitMax * 1000);
      continue;
    }

    // ── 2. Validity check ─────────────────────────────────────────────
    console.log(`[connect_loop] Checking profile availability...`);
    const availability = await checkProfileAvailability(page, 60000);
    if (availability === 'unavailable') {
      console.log(`[connect_loop] Profile UNAVAILABLE (deleted/banned/restricted) — skipping.`);
      await humanWait(page, waitMin * 1000, waitMax * 1000);
      continue;
    }
    console.log(`[connect_loop] Profile available (${availability}).`);

    // ── 3. Friend count PATCH ─────────────────────────────────────────
    if (target.userId) {
      const friends = await readFriendCount(page);
      if (friends !== null) {
        try {
          await updateProfile(target.userId, { friends });
          console.log(`[connect_loop] PATCHed friends=${friends} on user ${target.userId}.`);
        } catch (err) {
          console.warn(
            `[connect_loop] PATCH friends failed for ${target.userId}: ${err.message}`
          );
        }
      } else {
        console.log(`[connect_loop] Friend count selector not found — skip PATCH.`);
      }
    }

    // ── 4. Action button check, in priority order ────────────────────
    console.log(`[connect_loop] Probing action buttons...`);

    // 4a. Add friend
    const hasAddFriend = await isVisible(page, ADD_FRIEND_SELECTOR);
    console.log(`[connect_loop]   Add friend visible? ${hasAddFriend}`);
    if (hasAddFriend) {
      console.log(`[connect_loop] Clicking "Add friend"...`);
      const clicked = await pressIfPresent(page, ADD_FRIEND_SELECTOR);
      if (!clicked) {
        console.warn(`[connect_loop] "Add friend" click could not fire (no bbox/handle) — skipping.`);
        await humanWait(page, waitMin * 1000, waitMax * 1000);
        continue;
      }

      // Rate-limit check
      const limited = await detectRateLimit(page, 2500);
      if (limited) {
        console.warn(
          `[connect_loop] Rate-limit modal detected after Add friend — dismissing, NOT posting record, stopping loop.`
        );
        await dismissRateLimit(page);
        stopReason = 'rate-limited';
        break;
      }
      console.log(`[connect_loop] No rate-limit modal — press accepted.`);

      successCount++;
      console.log(`[connect_loop] "Add friend" pressed ${successCount}/${targetCount}.`);

      if (senderId && target.userId) {
        try {
          await recordFriendRequest(target.userId, senderId);
          console.log(
            `[connect_loop] POST friend-request ok: ${senderId} → ${target.userId}.`
          );
        } catch (err) {
          const status = err.response?.status;
          const body = err.response?.data;
          console.warn(
            `[connect_loop] POST friend-request failed (${status || 'no-status'}): ${err.message}` +
              (body ? ` | ${JSON.stringify(body)}` : '')
          );
        }
      } else {
        console.log(
          `[connect_loop] Skipping POST friend-request (senderId=${senderId || 'empty'}, receiverId=${target.userId || 'empty'}).`
        );
      }

      if (successCount >= targetCount) {
        stopReason = 'target reached';
        break;
      }
      console.log(`[connect_loop] Waiting ${waitMin}-${waitMax}s before next iteration...`);
      await humanWait(page, waitMin * 1000, waitMax * 1000);
      continue;
    }

    // 4b. Cancel request — already sent previously, sync record
    const hasCancel = await isVisible(page, CANCEL_REQUEST_SELECTOR);
    console.log(`[connect_loop]   Cancel request visible? ${hasCancel}`);
    if (hasCancel) {
      console.log(`[connect_loop] "Cancel request" present — already sent previously, syncing record.`);
      if (senderId && target.userId) {
        await syncExistingFriendRequest(target.userId, senderId);
      } else {
        console.log(
          `[connect_loop] Skipping sync (senderId=${senderId || 'empty'}, receiverId=${target.userId || 'empty'}).`
        );
      }
      console.log(`[connect_loop] Waiting ${waitMin}-${waitMax}s before next iteration...`);
      await humanWait(page, waitMin * 1000, waitMax * 1000);
      continue;
    }

    // 4c. Confirm request — accept incoming, NOT counted, no POST
    const hasConfirm = await isVisible(page, CONFIRM_SELECTOR);
    console.log(`[connect_loop]   Confirm request visible? ${hasConfirm}`);
    if (hasConfirm) {
      console.log(`[connect_loop] Clicking "Confirm request" (not counted toward target)...`);
      const clicked = await pressIfPresent(page, CONFIRM_SELECTOR);
      if (clicked) {
        console.log(`[connect_loop] "Confirm request" pressed.`);
      } else {
        console.warn(`[connect_loop] "Confirm request" click could not fire.`);
      }
      console.log(`[connect_loop] Waiting ${waitMin}-${waitMax}s before next iteration...`);
      await humanWait(page, waitMin * 1000, waitMax * 1000);
      continue;
    }

    // 4d. Nothing actionable
    console.log(`[connect_loop] No actionable button found on this profile — skipping.`);
    console.log(`[connect_loop] Waiting ${waitMin}-${waitMax}s before next iteration...`);
    await humanWait(page, waitMin * 1000, waitMax * 1000);
  }

  if (!stopReason) {
    stopReason = attempts >= maxAttempts ? 'max attempts reached' : 'completed';
  }

  console.log(
    `[connect_loop] Done. Pressed ${successCount}/${targetCount} in ${attempts} attempt(s). Reason: ${stopReason}.`
  );
};
