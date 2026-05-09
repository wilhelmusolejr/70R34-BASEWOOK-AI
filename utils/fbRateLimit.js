/**
 * Detect + dismiss the FB rate-limit modal:
 *   "You Can't Use This Feature Right Now"
 *
 * FB shows this when an account has tripped its action throttle (too many
 * adds, comments, posts in a window). It blocks further interaction until
 * dismissed; further actions of the same kind in this session will hit the
 * same wall, so callers should stop their loop on detection.
 */

// Apostrophe-free substring of the heading "You Can't Use This Feature Right Now".
// FB sometimes renders the apostrophe as a typographic curly quote (U+2019)
// rather than the straight ASCII one (U+0027), which breaks substring matching
// if we encode the heading literally. The fragment below is unique enough to
// avoid false positives without needing to encode the apostrophe at all.
const RATE_LIMIT_HEADING = 'Use This Feature Right Now';

const DIALOG_SELECTOR = 'div[role="dialog"]';
const OK_BUTTON_SELECTOR = '[role="button"][aria-label="OK"]';

async function detectRateLimit(page, timeoutMs = 1500) {
  try {
    const locator = page.locator(DIALOG_SELECTOR).filter({ hasText: RATE_LIMIT_HEADING }).first();
    await locator.waitFor({ state: 'visible', timeout: timeoutMs });
    return true;
  } catch (_) {
    return false;
  }
}

async function dismissRateLimit(page) {
  try {
    const dialog = page.locator(DIALOG_SELECTOR).filter({ hasText: RATE_LIMIT_HEADING }).first();
    const ok = dialog.locator(OK_BUTTON_SELECTOR).first();
    const visible = await ok.isVisible().catch(() => false);
    if (!visible) return false;
    await ok.click().catch(() => null);
    return true;
  } catch (_) {
    return false;
  }
}

module.exports = { detectRateLimit, dismissRateLimit, RATE_LIMIT_HEADING };
