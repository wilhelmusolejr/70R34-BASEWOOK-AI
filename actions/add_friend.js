/**
 * add_friend — Send a friend request on the currently loaded profile page.
 * Must be used as a child step under visit_profile (or any action that
 * navigates to a profile first).
 */

const { humanWait, humanClick } = require('../utils/humanBehavior');

module.exports = async function add_friend(page, params) {
  // Match any "Add Friend <name>" button dynamically
  const addFriendBtn = await page.waitForSelector(
    'div[role="button"][aria-label^="Add Friend"]',
    { timeout: 10000 }
  );

  await addFriendBtn.scrollIntoViewIfNeeded();
  const box = await addFriendBtn.boundingBox();
  await humanWait(page, 800, 1500);
  await humanClick(page, box);

  console.log('Friend request sent');
  await humanWait(page, 1000, 2000);
};
