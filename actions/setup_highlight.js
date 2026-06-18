/**
 * setup_highlight — Create a new profile "Highlights" (featured collection)
 * from the user's images.
 *
 * Self-navigates to /me, then walks FB's 6-step highlight-creation flow
 * (selectors captured from real DOM dumps in fix/highlight/):
 *
 *   1. profile            → click the highlights entry: [aria-label="Add
 *                           highlights"] (none yet) OR [aria-label="Edit
 *                           highlights"] (already has some) — either opens the
 *                           same manager
 *   2. highlights dialog  → click [aria-label="Add new"]
 *   3. create dialog      → click [aria-label="Upload photos"]  (→ file chooser)
 *   4. image(s) uploaded  → click [aria-label="Next"]   (enable-gated)
 *   5. title screen       → type title into
 *                           input[aria-label="Edit the current title of the
 *                           featured collection."]  (maxlength 18)
 *   6. finish             → click [aria-label="Save"]  (enable-gated)
 *
 * The "Next" and "Save" buttons follow FB's aria-disabled enable-gate AND the
 * double-render quirk (a hidden aria-disabled="true" decoy + the real enabled
 * one), so both go through clickWhenEnabled(), which picks the visible,
 * non-disabled instance — same pattern as setup_cover's "Save changes".
 *
 * Images: a RANDOM post is pulled from the shared pool (GET /api/posts,
 * country-matched, read-only — NOT assigned to the profile) and its images are
 * SHUFFLED (so the cover/preview differs across profiles that drew the same
 * post), then capped to `count`. An explicit `imageUrls` param overrides (kept
 * in given order). Downloaded to os.tmpdir() and deleted in finally.
 *
 * Title: a random pick from the country-aware pool (utils/highlightTitle.js),
 * unless an explicit `title` param is given.
 */

const https = require('https');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { humanWait, humanClick } = require('../utils/humanBehavior');
const { setOnboarding, fetchRandomPostImages } = require('../utils/userApi');
const { pickHighlightTitle, clampTitle } = require('../utils/highlightTitle');

// Fisher-Yates shuffle — returns a new array, leaves the input untouched.
function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function downloadToTemp(url) {
  return new Promise((resolve, reject) => {
    const ext = path.extname(new URL(url).pathname) || '.jpg';
    const tmpPath = path.join(
      os.tmpdir(),
      `highlight_${Date.now()}_${Math.random().toString(36).slice(2, 8)}${ext}`
    );
    const file = fs.createWriteStream(tmpPath);
    const client = url.startsWith('https') ? https : http;

    client
      .get(url, (res) => {
        if (res.statusCode !== 200) {
          reject(new Error(`Download failed: HTTP ${res.statusCode}`));
          return;
        }
        res.pipe(file);
        file.on('finish', () => file.close(() => resolve(tmpPath)));
      })
      .on('error', (err) => {
        fs.unlink(tmpPath, () => {});
        reject(err);
      });
  });
}

// Click a div[role="button"] by aria-label, handling FB's enable-gate +
// double-render: poll all matches, click the first that is visible AND not
// aria-disabled. Returns true on click, false if none became clickable in time.
async function clickWhenEnabled(page, label, timeoutMs = 30000) {
  const sel = `div[role="button"][aria-label="${label}"]`;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const loc = page.locator(sel);
    const n = await loc.count().catch(() => 0);
    for (let i = 0; i < n; i++) {
      const btn = loc.nth(i);
      const disabled = await btn.getAttribute('aria-disabled').catch(() => null);
      const visible = await btn.isVisible().catch(() => false);
      if (!visible || disabled === 'true') continue;

      await btn.scrollIntoViewIfNeeded().catch(() => {});
      await humanWait(page, 600, 1200);
      const box = await btn.boundingBox().catch(() => null);
      if (box && box.width && box.height) {
        await humanClick(page, box);
      } else {
        await btn.click().catch(() => {});
      }
      return true;
    }
    await page.waitForTimeout(500);
  }
  return false;
}

// After Save, confirm the create dialog actually closed = the highlight
// finalized. Both the title input AND the "Upload photos" button belong to the
// dialog, so once neither is visible the highlight committed. Returns false if
// the dialog is still open after the timeout (Save was a no-op — e.g. images
// hadn't finished uploading). This replaces the old swallowed detach wait that
// logged "created" even when nothing was created.
async function waitDialogClosed(page, timeoutMs = 30000) {
  const sels = [
    'input[aria-label="Edit the current title of the featured collection."]',
    '[aria-label="Upload photos"]',
  ];
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let anyVisible = false;
    for (const s of sels) {
      if (
        await page
          .locator(s)
          .first()
          .isVisible()
          .catch(() => false)
      ) {
        anyVisible = true;
        break;
      }
    }
    if (!anyVisible) return true;
    await page.waitForTimeout(700);
  }
  return false;
}

// Click a simple button by aria-label (the non-gated entry steps). humanClick
// when a bbox is available, else a direct locator click as fallback.
async function clickButton(page, label, timeoutMs = 15000) {
  const handle = await page.waitForSelector(`[aria-label="${label}"]`, { timeout: timeoutMs });
  await handle.scrollIntoViewIfNeeded().catch(() => {});
  await humanWait(page, 800, 1500);
  const box = await handle.boundingBox().catch(() => null);
  if (box && box.width && box.height) {
    await humanClick(page, box);
  } else {
    await handle.click();
  }
  return handle;
}

// The highlights entry lives in the Highlights section BELOW the profile
// header, which FB lazy-renders only as it scrolls into view — so a plain
// waitForSelector at the top of /me times out. Mouse-wheel down in increments
// (per anti-detection rules — never window.scrollTo), checking each tick until
// it mounts. `labels` may be a string or array (the entry button is
// "Add highlights" when the profile has none, "Edit highlights" when it already
// has some — we accept either). Returns the matching Locator or null.
async function scrollToFind(page, labels, { maxScrolls = 10 } = {}) {
  const sel = (Array.isArray(labels) ? labels : [labels])
    .map((l) => `[aria-label="${l}"]`)
    .join(', ');
  const loc = page.locator(sel).first();
  for (let i = 0; i < maxScrolls; i++) {
    if (await loc.count().catch(() => 0)) {
      await loc.scrollIntoViewIfNeeded().catch(() => {});
      await humanWait(page, 700, 1300);
      if (await loc.isVisible().catch(() => false)) return loc;
    }
    await page.mouse.wheel(0, 700);
    await humanWait(page, 700, 1300);
  }
  return null;
}

module.exports = async function setup_highlight(page, params = {}) {
  const { country = '', userId = '' } = params;

  // Images: an explicit imageUrls param wins; otherwise pull a RANDOM post from
  // the shared pool (GET /api/posts, country-matched) and use ITS images. This
  // is read-only — the post is NOT assigned/linked to the profile.
  let urls = (Array.isArray(params.imageUrls) ? params.imageUrls : []).filter(Boolean);
  let fromPool = false;
  if (!urls.length) {
    const picked = await fetchRandomPostImages(country);
    if (picked && picked.imageUrls.length) {
      urls = picked.imageUrls;
      fromPool = true;
      console.log(
        `[setup_highlight] Picked random pool post ${picked.post._id} (${urls.length} image(s)).`
      );
    }
  }

  // Shuffle the POOL images so the highlight's cover/preview (FB uses the first
  // uploaded image) varies across profiles that happened to draw the SAME pool
  // post. Shuffling before the cap also makes it a random SUBSET, not just the
  // first N. Explicit imageUrls keep their given order.
  if (fromPool) urls = shuffle(urls);

  // Cap how many of the post's images go into the highlight. Large sets (e.g.
  // a 10-image post) take too long to upload and the highlight fails to
  // finalize, so default to a safe DEFAULT_IMAGE_CAP. `count` overrides it.
  const DEFAULT_IMAGE_CAP = 5;
  const capParam = Number(params.count);
  const cap = Number.isFinite(capParam) && capParam > 0 ? capParam : DEFAULT_IMAGE_CAP;
  urls = urls.slice(0, cap);

  if (!urls.length) {
    console.log(
      '[setup_highlight] No images available (pool empty / no explicit imageUrls) — skipping.'
    );
    return;
  }

  // Title: explicit param wins; otherwise a random pick from the country-aware
  // pool (50% chance of a trailing emoji). Clamp to FB's 18-char input limit
  // (surrogate-safe) — pool titles already fit; this guards explicit overrides.
  const title = clampTitle(
    (params.title && String(params.title).trim()) || pickHighlightTitle(country)
  );

  const tmpPaths = [];
  try {
    for (const u of urls) tmpPaths.push(await downloadToTemp(u));
    console.log(`[setup_highlight] Downloaded ${tmpPaths.length} image(s).`);

    // Fresh /me each attempt — navigation closes any stray modal, so a retry
    // always starts from a clean profile state.
    await page.goto('https://www.facebook.com/me', { waitUntil: 'domcontentloaded' });
    await humanWait(page, 2000, 3500);

    // 1 → 2: open the highlights section, then the create dialog. The entry is
    // below the fold and lazy-rendered — scroll to it. Its label depends on
    // whether the profile already has highlights: "Add highlights" (none yet)
    // vs "Edit highlights" (already has some) — both open the same manager
    // where "Add new" lives.
    console.log('[setup_highlight] Locating highlights entry (scrolling)...');
    const entry = await scrollToFind(page, ['Add highlights', 'Edit highlights']);
    if (!entry) {
      throw new Error(
        'setup_highlight: highlights entry ("Add highlights" / "Edit highlights") not found on profile'
      );
    }
    const entryLabel = await entry.getAttribute('aria-label').catch(() => '');
    console.log(`[setup_highlight] Clicking "${entryLabel || 'highlights entry'}"...`);
    const entryBox = await entry.boundingBox().catch(() => null);
    if (entryBox) await humanClick(page, entryBox);
    else await entry.click();
    await humanWait(page, 1500, 2500);

    console.log('[setup_highlight] Clicking "Add new"...');
    await clickButton(page, 'Add new');
    await humanWait(page, 1500, 2500);

    // 3: Upload photos → intercept the OS file chooser.
    console.log('[setup_highlight] Clicking "Upload photos" + selecting image(s)...');
    const uploadBtn = await page.waitForSelector('[aria-label="Upload photos"]', {
      timeout: 15000,
    });
    const [chooser] = await Promise.all([page.waitForEvent('filechooser'), uploadBtn.click()]);
    await chooser.setFiles(tmpPaths);
    // Wait for the uploads to process — SCALED to the image count. A fixed short
    // wait let "Next" be clicked while a large batch was still uploading, so the
    // highlight never finalized on Save (a 10-image post created nothing).
    const uploadWaitMs = Math.min(35000, 3500 + tmpPaths.length * 1800);
    console.log(
      `[setup_highlight] ${tmpPaths.length} file(s) set, waiting ~${Math.round(uploadWaitMs / 1000)}s for upload to process...`
    );
    await page.waitForTimeout(uploadWaitMs);

    // 4: Next (enabled only once the upload registered).
    console.log('[setup_highlight] Clicking "Next"...');
    const nextOk = await clickWhenEnabled(page, 'Next', 30000);
    if (!nextOk) throw new Error('setup_highlight: "Next" never became enabled after upload');
    await humanWait(page, 1500, 2500);

    // 5: Title. Real <input type="text" maxlength="18"> prefilled "Collection".
    // Focus it DIRECTLY (triple-click selects the existing text) — a bbox
    // humanClick was missing focus, so the clear+type landed nowhere and FB
    // saved the default "Collection". Type with pressSequentially (focuses the
    // locator + emoji-safe), then READ BACK inputValue to confirm it committed;
    // fall back to fill() if it didn't.
    if (title) {
      const titleInput = page
        .locator('input[aria-label="Edit the current title of the featured collection."]')
        .first();
      const present = await titleInput
        .waitFor({ state: 'visible', timeout: 15000 })
        .then(() => true)
        .catch(() => false);
      if (present) {
        await titleInput.scrollIntoViewIfNeeded().catch(() => {});
        await humanWait(page, 400, 800);
        await titleInput.click({ clickCount: 3 }); // focus + select existing "Collection"
        await humanWait(page, 250, 500);
        await titleInput.press('Backspace'); // clear the selection
        await humanWait(page, 200, 400);
        await titleInput.pressSequentially(title, { delay: 70 }); // human-ish, emoji-safe
        await humanWait(page, 400, 800);

        let val = (await titleInput.inputValue().catch(() => '')) || '';
        if (val.trim() !== title.trim()) {
          console.warn(`[setup_highlight] Title readback "${val}" != "${title}" — forcing fill().`);
          await titleInput.fill(title).catch(() => {});
          val = (await titleInput.inputValue().catch(() => '')) || '';
        }
        console.log(`[setup_highlight] Title input value now "${val}".`);
      } else {
        console.warn('[setup_highlight] Title input not found — keeping FB default title.');
      }
    }

    // 6: Save (enable-gated).
    console.log('[setup_highlight] Clicking "Save"...');
    const saveOk = await clickWhenEnabled(page, 'Save', 20000);
    if (!saveOk) throw new Error('setup_highlight: "Save" never became enabled');

    // AUTHORITATIVE success check: the create dialog must close. If it doesn't,
    // Save was a no-op (highlight NOT created) — throw so the runner dumps the
    // page state and retries, rather than logging a false success. No highlight
    // exists yet on this path, so a retry can't duplicate.
    const closed = await waitDialogClosed(page, 30000);
    if (!closed) {
      throw new Error(
        'setup_highlight: create dialog still open after Save — highlight did not finalize (uploads may not have completed)'
      );
    }
    await humanWait(page, 1500, 3000);
    console.log('[setup_highlight] Highlight created (create dialog closed).');

    if (userId) await setOnboarding(userId, 'highlightsSetAt');
  } finally {
    for (const p of tmpPaths) fs.unlink(p, () => {});
  }
};
