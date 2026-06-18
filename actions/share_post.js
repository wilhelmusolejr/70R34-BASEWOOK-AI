/**
 * share_post — Share a specific Facebook post by URL.
 * Navigates to the post, then shares with either a hardcoded message
 * or a Claude API-generated one based on post context + user identity.
 */

const { humanWait, humanClick, humanType } = require('../utils/humanBehavior');
const { extractPostContext } = require('../utils/claudeApi');
const { generateMessage } = require('../utils/generateMessage');
const { setOnboarding } = require('../utils/userApi');

// FB blocks resharing for flagged accounts with a "You're temporarily restricted
// from resharing posts until <date>..." message inside the still-open share
// modal. The date is dynamic, so match only the stable leading phrase.
// (Learned from fix/Facebook_restrict_to_Share.mhtml.)
const RESTRICTION_RE = /temporarily restricted from resharing/i;
const SHARE_RESULT_TIMEOUT_MS = 30000;
const SHARE_NOW_SELECTOR = '[aria-label="Share now"]';

module.exports = async function share_post(page, params) {
  const {
    url,
    message: staticMessage = '',
    userIdentity = '',
    instruction = '',
    userId = '',
  } = params;
  if (!url) throw new Error('share_post: url is required');

  const useApi = !staticMessage && !!userIdentity;

  // 1. Navigate to the post
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await humanWait(page, 2000, 3500);

  // 2. Extract post context and generate message if using API
  let message = staticMessage;
  if (useApi) {
    const postContext = await extractPostContext(page);
    message = await generateMessage(userIdentity, postContext);
    console.log(`  Generated message: "${message}"`);
  }

  // 3. Click the share button
  const shareBtn = await page.waitForSelector(
    '[aria-label="Send this to friends or post it on your profile."]',
    { timeout: 10000 }
  );
  const shareBox = await shareBtn.boundingBox();
  await humanWait(page, 800, 1500);
  await humanClick(page, shareBox);
  await humanWait(page, 1500, 2500);

  // 4. Wait for share modal
  const modalShareBtn = await page.waitForSelector(SHARE_NOW_SELECTOR, { timeout: 10000 });

  // 5. Type message if provided
  if (message) {
    const textInput = await page.$('[aria-placeholder="Say something about this..."]');
    if (textInput) {
      const inputBox = await textInput.boundingBox();
      if (inputBox) {
        await humanClick(page, inputBox);
        await humanWait(page, 300, 600);
        await humanType(page, message);
        await humanWait(page, 600, 1200);
      }
    }
  }

  // 6. Click "Share now"
  const shareBtnBox = await modalShareBtn.boundingBox();
  await humanClick(page, shareBtnBox);
  console.log('  [share_post] Share clicked — waiting for modal to close...');

  // 7. Validate the outcome instead of assuming success. Poll up to 30s for:
  //   - restricted: "temporarily restricted from resharing" appears (modal
  //                 stays open) → flagged account, don't stamp.
  //   - shared:     the "Share now" button disappears (modal closed) → success.
  //   - stuck:      neither within 30s → don't hang; dismiss and move on.
  const restrictionLoc = page.getByText(RESTRICTION_RE).first();
  const deadline = Date.now() + SHARE_RESULT_TIMEOUT_MS;
  let outcome = 'stuck';
  while (Date.now() < deadline) {
    if (await restrictionLoc.isVisible().catch(() => false)) {
      outcome = 'restricted';
      break;
    }
    const stillOpen = await page
      .locator(SHARE_NOW_SELECTOR)
      .first()
      .isVisible()
      .catch(() => false);
    if (!stillOpen) {
      outcome = 'shared';
      break;
    }
    await new Promise((r) => setTimeout(r, 500));
  }

  if (outcome === 'restricted') {
    const msg = (await restrictionLoc.innerText().catch(() => ''))
      .replace(/\s+/g, ' ')
      .trim();
    console.warn(
      `  [share_post] TEMPORARILY RESTRICTED from resharing — ${msg || '(message text unavailable)'}`
    );
    await page.keyboard.press('Escape').catch(() => {});
    return; // not shared — leave lastSharedAt unstamped
  }

  if (outcome === 'stuck') {
    console.warn(
      "  [share_post] share modal didn't close in 30s and no restriction shown — dismissing and moving on"
    );
    await page.keyboard.press('Escape').catch(() => {});
    return; // not confirmed — don't stamp
  }

  console.log('  [share_post] Post shared');
  await humanWait(page, 2000, 3500);

  if (userId) await setOnboarding(userId, 'lastSharedAt');
};
