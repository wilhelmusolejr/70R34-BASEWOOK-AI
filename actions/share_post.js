/**
 * share_post — Share a specific Facebook post by URL.
 * Navigates to the post, then shares with either a hardcoded message
 * or a Claude API-generated one based on post context + user identity.
 */

const { humanWait, humanClick, humanType } = require('../utils/humanBehavior');
const { extractPostContext } = require('../utils/claudeApi');
const { generateMessage } = require('../utils/generateMessage');

module.exports = async function share_post(page, params) {
  const { url, message: staticMessage = '', userIdentity = '', instruction = '' } = params;
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
  const modalShareBtn = await page.waitForSelector('[aria-label="Share now"]', { timeout: 10000 });

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
  console.log('Post shared');

  await humanWait(page, 2000, 3500);
};
