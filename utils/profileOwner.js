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

// Strip a trailing parenthetical from a normalized name, e.g.
// "giorgia castelli (gior)" -> "giorgia castelli". FB renders the profile
// owner's "Other names" nickname (set by setup_about's setOtherName with
// "Show at top of profile" ticked) INSIDE the og:title / document.title as
// "<Name> (<Nickname>)". The Add Friend button's aria-label, however, only
// ever carries the bare "<Name>". So an exact og:title-vs-button comparison
// fails for every profile that has an Other-names nickname shown at top —
// the bot then skips the add as if the button were a PYMK suggestion. We
// compare against BOTH the full name and this base form.
function baseName(s) {
  return normName(String(s || '').replace(/\s*\([^)]*\)\s*$/, ''));
}

// Does a button's name suffix identify the profile owner? True when it equals
// the owner's full read name OR the owner name with a trailing parenthetical
// nickname stripped. A PYMK suggestion carries a DIFFERENT person's name, so
// it still never matches either form — the owner-only guarantee is preserved.
function ownerNameMatches(buttonName, owner) {
  if (!buttonName) return false;
  if (buttonName === owner) return true;
  if (buttonName === baseName(owner)) return true;
  return false;
}

// Page-chrome words that can appear as an <h1> on a FB profile page but are
// NOT the profile owner's name (accessibility / nav landmarks). The first <h1>
// in DOM order is frequently one of these (observed "Notifications"), so a
// plain `h1:first` read mis-identified the owner as e.g. "notifications" and
// then never matched the real Add Friend button.
const CHROME_HEADINGS = new Set([
  'notifications',
  'facebook',
  'menu',
  'search',
  'search results',
  'messenger',
  'create',
  'your profile',
]);

// Read the profile owner's display name. Strategy (most reliable first):
//   1. og:title meta — FB sets this to the profile owner's full name on a
//      profile page; it's never page chrome.
//   2. document.title — "<Name> | Facebook" / "(N) <Name> | Facebook".
//   3. first VISIBLE <h1> whose text isn't a known chrome heading.
// Returns '' if none yields a usable name.
async function getProfileOwnerName(page) {
  // 1. og:title meta
  try {
    const og =
      (await page
        .locator('meta[property="og:title"]')
        .first()
        .getAttribute('content', { timeout: 2000 })
        .catch(() => '')) || '';
    const ogName = normName(og);
    if (ogName && !CHROME_HEADINGS.has(ogName)) return ogName;
  } catch (_) {}

  // 2. document title — strip a leading "(N) " unread count and a trailing
  //    " | Facebook" / " - Facebook" suffix.
  try {
    let title = (await page.title().catch(() => '')) || '';
    // Strip a leading unread-count badge: "(7) " or "(20+) " (FB caps the
    // display at "20+", whose "+" the old \d+ pattern missed).
    title = title
      .replace(/^\(\d+\+?\)\s*/, '')
      .replace(/\s*[|\-–—]\s*facebook.*$/i, '');
    const tName = normName(title);
    if (tName && !CHROME_HEADINGS.has(tName)) return tName;
  } catch (_) {}

  // 3. first visible, non-chrome <h1>
  try {
    const h1s = page.locator('h1');
    const n = await h1s.count().catch(() => 0);
    for (let i = 0; i < n; i++) {
      const h1 = h1s.nth(i);
      if (!(await h1.isVisible().catch(() => false))) continue;
      const txt = normName(await h1.innerText({ timeout: 2000 }).catch(() => ''));
      if (txt && !CHROME_HEADINGS.has(txt)) return txt;
    }
  } catch (_) {}

  return '';
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
    if (ownerNameMatches(name, owner)) return { locator: btn, owner };
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
