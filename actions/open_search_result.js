/**
 * open_search_result — Navigator action.
 * Picks a profile/page result from the currently-loaded search-results page and
 * clicks into it. After the click the browser is on that profile or page, so
 * child steps (scroll, add_friend, follow, like_posts, ...) operate on it.
 *
 * Two result-link shapes are recognized:
 *   - numeric → a[href*="/profile.php?id="]  (people, freshly-created Pages)
 *   - vanity  → facebook.com/<handle>        (established Pages: /unistrapg,
 *               /Regione.Umbria.official, ...). The Pages filter surfaces mostly
 *               vanity links, which is why a numeric-only match used to time out
 *               on every Pages search that returned well-known Pages.
 *
 * Vanity links are indistinguishable from FB's own chrome (sidebar shortcuts,
 * nav, footer), so they are accepted ONLY inside the search-results container
 * ([role="feed"] / [aria-label="Search results"]). Numeric /profile.php?id=
 * links are accepted anywhere (the original behavior — safe, never chrome).
 *
 * Use as a child of `search`.
 */

const { humanClick, humanWait, scrollToCenter } = require('../utils/humanBehavior');

// First path-segments that are FB product routes, never a Page vanity handle.
const RESERVED_SEGMENTS = [
  'profile.php',
  'marketplace',
  'groups',
  'watch',
  'reel',
  'reels',
  'stories',
  'story.php',
  'events',
  'gaming',
  'games',
  'pages',
  'page',
  'me',
  'friends',
  'bookmarks',
  'notifications',
  'messages',
  'settings',
  'business',
  'ads',
  'help',
  'policies',
  'privacy',
  'login',
  'reg',
  'photo',
  'photo.php',
  'permalink.php',
  'sharer',
  'search',
  'hashtag',
  'public',
  'places',
  'live',
  'fundraisers',
  'jobs',
  'weather',
  'save',
  'offers',
  'today',
  'find-friends',
  'lite',
  'home.php',
  'recover',
];

// FB's empty-search-results state. A zero-result query renders this banner
// INSTEAD of result links — a legitimate outcome, NOT a failure. Covers en-US +
// it phrasings; the `.` in "didn.t" matches both straight and curly apostrophes.
const NO_RESULTS_RE =
  /We didn.t find any results|Try searching for something else|Nessun risultato|Non abbiamo trovato|Prova a cercare/i;

/**
 * Is `href` a clickable search RESULT link?
 *   numeric /profile.php?id=<n>  → always a result (can't be chrome).
 *   single-segment vanity handle → a result only when `allowVanity` (i.e. we're
 *     scoped to the results container, so it can't be a nav/sidebar link).
 *
 * NOTE: the detection waitForFunction below runs an INLINE copy of this logic in
 * the page context — FB's CSP blocks eval, so we can't inject this fn. Keep the
 * two in sync.
 */
function isResultHref(href, allowVanity) {
  if (!href) return false;
  if (/\/profile\.php\?id=\d+/.test(href)) return true;
  if (!allowVanity) return false;
  let path;
  try {
    const u = href.startsWith('http') ? new URL(href) : new URL(href, 'https://www.facebook.com');
    const host = u.hostname.replace(/^www\./, '');
    if (host !== 'facebook.com' && host !== 'web.facebook.com' && host !== 'm.facebook.com') {
      return false;
    }
    path = u.pathname;
  } catch (e) {
    return false;
  }
  const seg = path.replace(/^\/+|\/+$/g, '');
  if (!seg || seg.indexOf('/') !== -1) return false; // homepage "/" or multi-segment route
  if (seg.toLowerCase().endsWith('.php')) return false; // *.php product route
  if (RESERVED_SEGMENTS.indexOf(seg.toLowerCase()) !== -1) return false;
  return /^[a-zA-Z0-9.]{5,}$/.test(seg); // FB usernames: ≥5 chars, [a-z0-9.]
}

// Dedupe key — collapses the photo+name anchor pair and the `?__tn__=`/`&` query
// variants of the same target down to one key (pathname + optional ?id=).
function hrefKey(href) {
  try {
    const u = href.startsWith('http') ? new URL(href) : new URL(href, 'https://www.facebook.com');
    const id = u.searchParams.get('id');
    return u.pathname.replace(/\/+$/, '') + (id ? `?id=${id}` : '');
  } catch (e) {
    return String(href).split('?')[0];
  }
}

module.exports = async function open_search_result(page, params) {
  const { pick = 'random' } = params;

  // Wait up to 15s for EITHER a result link (numeric anywhere, vanity inside the
  // results feed) OR FB's no-results banner. Detection runs in-page so the
  // vanity-vs-chrome scoping is evaluated against the live DOM. Resolves to
  // 'results' | 'empty'; neither within 15s → the page never settled into a
  // known search-results state (a real failure) → throw.
  let outcome;
  try {
    const handle = await page.waitForFunction(
      ({ reserved, noResultsSrc }) => {
        const noResultsRe = new RegExp(noResultsSrc, 'i');
        const text = document.body ? document.body.innerText || '' : '';
        if (noResultsRe.test(text)) return 'empty';

        const container =
          document.querySelector('[role="feed"]') ||
          document.querySelector('[aria-label="Search results"]');
        const scope = container || document;
        const allowVanity = !!container;

        // INLINE copy of isResultHref (FB CSP blocks injecting the Node fn).
        const isResult = (href) => {
          if (!href) return false;
          if (/\/profile\.php\?id=\d+/.test(href)) return true;
          if (!allowVanity) return false;
          let path;
          try {
            const u = href.startsWith('http')
              ? new URL(href)
              : new URL(href, 'https://www.facebook.com');
            const host = u.hostname.replace(/^www\./, '');
            if (
              host !== 'facebook.com' &&
              host !== 'web.facebook.com' &&
              host !== 'm.facebook.com'
            ) {
              return false;
            }
            path = u.pathname;
          } catch (e) {
            return false;
          }
          const seg = path.replace(/^\/+|\/+$/g, '');
          if (!seg || seg.indexOf('/') !== -1) return false;
          if (seg.toLowerCase().endsWith('.php')) return false;
          if (reserved.indexOf(seg.toLowerCase()) !== -1) return false;
          return /^[a-zA-Z0-9.]{5,}$/.test(seg);
        };

        const anchors = scope.querySelectorAll('a[href]');
        for (const a of anchors) {
          if (a.getAttribute('aria-hidden') === 'true') continue;
          if (isResult(a.getAttribute('href'))) return 'results';
        }
        return false;
      },
      { reserved: RESERVED_SEGMENTS, noResultsSrc: NO_RESULTS_RE.source },
      { timeout: 15000, polling: 700 }
    );
    outcome = await handle.jsonValue();
  } catch (err) {
    throw new Error(
      'open_search_result: neither result links nor the no-results banner appeared within 15s'
    );
  }

  if (outcome === 'empty') {
    console.log('  [open_search_result] Search returned no results — skipping (not an error).');
    return;
  }

  await humanWait(page, 800, 1500);

  // Re-collect result anchors in Node for clicking. Scope to the results
  // container so vanity handles can't be FB chrome (sidebar/shortcuts).
  const container =
    (await page.$('[role="feed"]')) || (await page.$('[aria-label="Search results"]'));
  const root = container || page;
  const allowVanity = !!container;
  const anchors = await root.$$('a[href]');

  const seen = new Set();
  const candidates = [];
  for (const a of anchors) {
    const ariaHidden = await a.getAttribute('aria-hidden').catch(() => null);
    if (ariaHidden === 'true') continue;
    const href = await a.getAttribute('href').catch(() => null);
    if (!isResultHref(href, allowVanity)) continue;
    const key = hrefKey(href);
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push({ handle: a, href });
  }

  if (!candidates.length) {
    // Race said 'results' but the re-query found none (rare: feed virtualization
    // unmounted them, or a no-results banner rendered late). Treat a now-present
    // banner as a clean skip; otherwise it's a genuine miss.
    const empty = await page
      .getByText(NO_RESULTS_RE)
      .first()
      .count()
      .catch(() => 0);
    if (empty) {
      console.log(
        '  [open_search_result] No links on re-query but no-results banner present — skipping.'
      );
      return;
    }
    throw new Error('open_search_result: no profile/page links found on page');
  }

  let chosen;
  if (pick === 'first' || pick === 0) {
    chosen = candidates[0];
  } else if (typeof pick === 'number' && Number.isInteger(pick) && pick >= 0) {
    chosen = candidates[Math.min(pick, candidates.length - 1)];
  } else {
    chosen = candidates[Math.floor(Math.random() * candidates.length)];
  }

  console.log(
    `  [open_search_result] Picked ${candidates.indexOf(chosen) + 1}/${candidates.length}: ${chosen.href}`
  );

  const viewport = page.viewportSize();
  const vh = (viewport && viewport.height) || 900;
  let box = await scrollToCenter(page, chosen.handle, vh);
  if (!box) box = await chosen.handle.boundingBox();
  if (!box) throw new Error('open_search_result: chosen link has no bounding box after scroll');

  await humanWait(page, 600, 1200);
  await humanClick(page, box);

  try {
    await page.waitForLoadState('domcontentloaded', { timeout: 20000 });
  } catch (err) {
    console.warn(`  [open_search_result] domcontentloaded wait timed out: ${err.message}`);
  }
  await humanWait(page, 2000, 4000);

  console.log(`  [open_search_result] Landed on: ${page.url()}`);
};
