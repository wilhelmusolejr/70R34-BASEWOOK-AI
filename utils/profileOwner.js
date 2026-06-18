/**
 * profileOwner — shared helper for targeting the OWNER's "Add Friend" button on
 * a loaded Facebook profile page, never a "People you may know" (PYMK)
 * suggestion card.
 *
 * Why this is needed: real DOM dumps proved the owner header button and the PYMK
 * suggestion cards render the IDENTICAL aria-label="Add Friend <Name>" format
 * (capital F + the person's name). On Alfonso Vitale's profile the ONLY Add
 * Friend button present was "Add Friend Amedeo Sanna" — a suggestion, not the
 * owner. So neither the aria-label case (capital/lowercase) nor DOM order can
 * distinguish them; the ONLY reliable signal is the name. We read the profile
 * owner's name from the page <h1> and keep ONLY the button whose name suffix
 * equals it. No owner-matching button → click nothing (never befriend a
 * suggested stranger).
 *
 * Shared by actions/connect.js and actions/connect_loop.js so the owner-only
 * rule can't drift between the two.
 */

// Normalize a display name for comparison: collapse all whitespace (incl.
// non-breaking spaces, which JS \s already covers) and lowercase.
function normName(s) {
  return String(s || '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

// Read the profile owner's display name from the page <h1>. FB renders the
// profile owner's name as the page's primary <h1>. Returns '' if unreadable.
async function getProfileOwnerName(page) {
  try {
    const h1 = page.locator('h1').first();
    if (!(await h1.count().catch(() => 0))) return '';
    const txt = await h1.innerText({ timeout: 3000 }).catch(() => '');
    return normName(txt);
  } catch (_) {
    return '';
  }
}

/**
 * Resolve the OWNER's Add Friend button on the loaded profile.
 *
 * @param {import('playwright').Page} page
 * @param {{ log?: (msg: string) => void }} [opts] - optional logger for skip reasons
 * @returns {Promise<{ locator: import('playwright').Locator | null, owner: string }>}
 *   locator: the owner's Add Friend button, or null when none matches the owner
 *            (owner already friended, name unreadable, or only suggestions present).
 *   owner:   the resolved owner name ('' when the <h1> was unreadable).
 */
async function resolveOwnerAddFriend(page, opts = {}) {
  const log = typeof opts.log === 'function' ? opts.log : () => {};
  const owner = await getProfileOwnerName(page);
  if (!owner) {
    log(
      'Could not read profile owner name from <h1> — skipping Add Friend (avoids adding a suggested person).'
    );
    return { locator: null, owner: '' };
  }

  const all = page.locator('div[role="button"][aria-label^="Add Friend "]');
  const n = await all.count().catch(() => 0);
  for (let i = 0; i < n; i++) {
    const btn = all.nth(i);
    const label = (await btn.getAttribute('aria-label').catch(() => '')) || '';
    const name = normName(label.replace(/^Add Friend\s+/i, ''));
    if (name && name === owner) return { locator: btn, owner };
  }

  if (n > 0) {
    log(
      `${n} "Add Friend" button(s) present but none match the profile owner "${owner}" — these belong to suggestions; skipping Add Friend.`
    );
  } else {
    log('No "Add Friend" button present — skipping.');
  }
  return { locator: null, owner };
}

module.exports = { normName, getProfileOwnerName, resolveOwnerAddFriend };
