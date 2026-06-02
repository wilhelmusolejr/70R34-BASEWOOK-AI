/**
 * open_search_result — Navigator action.
 * Picks a profile/page link from the currently-loaded search-results page
 * (anchors matching `a[href*="/profile.php?id="]`) and clicks into it.
 * After click, the browser is on that profile or page, so child steps
 * (scroll, add_friend, follow, like_posts, ...) operate on it.
 *
 * Use as a child of `search`.
 */

const { humanClick, humanWait, scrollToCenter } = require('../utils/humanBehavior');

const RESULT_LINK_SELECTOR = 'a[href*="/profile.php?id="]';

// FB's empty-search-results state. A zero-result query (common for obscure
// "{category} in {city}" / "{topic} near me" searches) renders this banner
// INSTEAD of result links — it's a legitimate outcome, NOT a failure. We detect
// it and return cleanly so the runner doesn't burn its 3×retry budget waiting
// for links that will never appear. Covers the en-US + it phrasings seen on
// IT-proxy accounts; the `.` in "didn.t" matches both straight and curly
// apostrophes. A genuinely broken/empty page (neither links nor this banner)
// still throws → dumps → so an unhandled locale can be added later.
const NO_RESULTS_RE =
  /We didn.t find any results|Try searching for something else|Nessun risultato|Non abbiamo trovato|Prova a cercare/i;

module.exports = async function open_search_result(page, params) {
  const { pick = 'random' } = params;

  // Wait for EITHER result links OR the no-results banner — whichever the page
  // renders first wins the race. Both branches resolve (never reject) so the
  // race result is deterministic: 'results' | 'empty' | 'timeout' (= neither
  // appeared within 15s, a real failure).
  const outcome = await Promise.race([
    page
      .locator(RESULT_LINK_SELECTOR)
      .first()
      .waitFor({ state: 'visible', timeout: 15000 })
      .then(
        () => 'results',
        () => 'timeout'
      ),
    page
      .getByText(NO_RESULTS_RE)
      .first()
      .waitFor({ state: 'visible', timeout: 15000 })
      .then(
        () => 'empty',
        () => 'timeout'
      ),
  ]);

  if (outcome === 'empty') {
    console.log('  [open_search_result] Search returned no results — skipping (not an error).');
    return;
  }
  if (outcome === 'timeout') {
    throw new Error(
      'open_search_result: neither result links nor the no-results banner appeared within 15s'
    );
  }

  await humanWait(page, 800, 1500);

  const anchors = await page.$$(RESULT_LINK_SELECTOR);
  if (!anchors.length) {
    // Links vanished between the race resolving and the re-query (rare). Treat
    // a now-visible no-results banner as a clean skip rather than a failure.
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

  // Dedupe by href so we don't re-pick the same target variant (avatar + name anchor pair).
  const seen = new Set();
  const candidates = [];
  for (const a of anchors) {
    const href = await a.getAttribute('href').catch(() => null);
    if (!href) continue;
    const key = href.split('&')[0];
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push({ handle: a, href });
  }

  if (!candidates.length)
    throw new Error('open_search_result: no usable profile links after dedupe');

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
