/**
 * publish_post — Leaf action.
 * Publish a new post (one or more images + optional caption) to the user's
 * own profile timeline.
 *
 * Flow:
 *   1. Land on facebook.com/me (reuse the current page if a composer trigger
 *      is already visible — avoids unnecessary reloads)
 *   2. Click "What's on your mind?" composer trigger
 *   3. Wait for the "Create post" dialog
 *   4. (Optional) Set audience (Public by default)
 *   5. Click "Photo/video" → intercept file chooser → setFiles([tmp1, tmp2, ...])
 *   6. Wait for image previews to render in the dialog
 *   7. Focus the Lexical editor (Create post heading + Tab x3, same as schedule_posts)
 *      and humanType the caption
 *   8. Click "Post"
 *   9. Wait for the dialog to detach (success signal)
 *
 * Selectors are best-effort first draft — FB tweaks this UI often. dumpFailure
 * on any throw writes HTML + full-page PNG to the profile's run-scoped folder
 * so a missed selector surfaces with concrete evidence on the first run.
 *
 * Auto-injected params (see runner.js / injectUserParams):
 *   imageUrls    ← random pick from user.posts[].images
 *   caption      ← matching pick's user.posts[].caption (when params.caption empty)
 *   userIdentity ← user.identityPrompt (for AI-generated fallback)
 */

const fs = require('fs');
const path = require('path');
const { humanWait, humanClick, humanType } = require('../utils/humanBehavior');
const { downloadToTemp } = require('../utils/pageSetupHelpers');
const { generatePostCaption } = require('../utils/generatePostCaption');
const { getProfileLogDir } = require('../utils/sessionLog');
const { setOnboarding } = require('../utils/userApi');

const AUDIENCE_LABELS = {
  public: 'Public',
  friends: 'Friends',
  'only-me': 'Only me',
  onlyme: 'Only me',
};

async function dumpFailure(page, label) {
  try {
    if (!page) return;
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const safeLabel = String(label || 'failure').replace(/[^a-z0-9_-]+/gi, '_');

    const profileDir = getProfileLogDir();
    const targetDir = profileDir || path.join(process.cwd(), 'logs');
    try {
      if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
    } catch (_) {}

    const baseName = `publish_post-${safeLabel}-${ts}`;
    const htmlPath = path.join(targetDir, `${baseName}.html`);
    const pngPath = path.join(targetDir, `${baseName}.png`);

    let url = '(unknown)';
    try {
      url = page.url();
    } catch (_) {}

    try {
      const html = await page.content();
      fs.writeFileSync(htmlPath, `<!-- url: ${url} -->\n${html}`, 'utf8');
      console.warn(`  [publish_post] dumped HTML → ${htmlPath}`);
    } catch (err) {
      console.warn(`  [publish_post] HTML dump failed: ${err.message}`);
    }

    try {
      await page.screenshot({ path: pngPath, fullPage: true });
      console.warn(`  [publish_post] dumped screenshot → ${pngPath}`);
    } catch (err) {
      console.warn(`  [publish_post] screenshot failed: ${err.message}`);
    }
  } catch (err) {
    console.warn(`  [publish_post] dumpFailure swallowed: ${err.message}`);
  }
}

/**
 * "Not now" / "See later" interstitial that FB pops up randomly during the
 * composer flow. Same pattern as schedule_posts' dismissNotNow — loop until
 * the button is gone, short timeout each iteration so we don't burn cooldown.
 */
async function dismissNotNow(page) {
  for (let i = 0; i < 4; i++) {
    try {
      const notNow = page.locator('[aria-label="Not now"]').first();
      await notNow.waitFor({ state: 'visible', timeout: 3000 });
      console.log('  [publish_post] "Not now" modal — dismissing...');
      await humanClick(page, await notNow.boundingBox());
      await humanWait(page, 1500, 2500);
    } catch {
      return;
    }
  }
}

async function setAudience(page, audience) {
  if (!audience || audience === 'skip') return;
  const targetLabel = AUDIENCE_LABELS[String(audience).toLowerCase()] || 'Public';

  try {
    const audienceBtn = page.locator('[aria-label="Audience selector"]').first();
    await audienceBtn.waitFor({ state: 'visible', timeout: 3000 });
    await humanClick(page, await audienceBtn.boundingBox());
    await humanWait(page, 1000, 2000);

    // FB renders the option as either a radio or a menuitem depending on the
    // surface (modal vs popover). Union both.
    const opt = page
      .locator(
        [
          `[role="radio"]:has-text("${targetLabel}")`,
          `[role="menuitemradio"]:has-text("${targetLabel}")`,
          `div[role="button"]:has-text("${targetLabel}")`,
        ].join(', ')
      )
      .first();
    await opt.waitFor({ state: 'visible', timeout: 5000 });
    await humanClick(page, await opt.boundingBox());
    await humanWait(page, 800, 1500);

    const doneBtn = page.locator('div[role="button"]:has-text("Done")').first();
    const doneVisible = await doneBtn.isVisible({ timeout: 2000 }).catch(() => false);
    if (doneVisible) {
      await humanClick(page, await doneBtn.boundingBox());
      await humanWait(page, 800, 1500);
    }
    console.log(`  [publish_post] Audience set to ${targetLabel}`);
  } catch (err) {
    // Audience widget moved or not present — don't fail the whole post over it.
    console.warn(
      `  [publish_post] Could not set audience to ${targetLabel} (non-fatal): ${err.message}`
    );
  }
}

module.exports = async function publish_post(page, params) {
  const {
    imageUrls = [],
    caption = '',
    postCaption = '',
    captionSource = 'ai',
    userIdentity = '',
    postContext = '',
    audience = 'public',
    userId = '',
  } = params || {};

  if (!Array.isArray(imageUrls) || imageUrls.length === 0) {
    throw new Error(
      'publish_post: imageUrls is required (set explicitly, or populate user.posts[].images on the user record)'
    );
  }

  // Caption priority:
  //   1. explicit `caption` param wins (lets a task hardcode test text)
  //   2. captionSource="post" → use the picked entry's caption (auto-injected
  //      as `postCaption` from user.posts[].caption by injectUserParams)
  //   3. captionSource="ai" (default) → AI-generated via generatePostCaption
  //      (userIdentity + postContext). Uses system_prompt_post.txt, falls back
  //      to the 50-reasons list when postContext is vague. Returns '' on
  //      API failure or SKIP.
  //   4. empty (post goes captionless)
  let resolvedCaption = String(caption || '').trim();

  if (!resolvedCaption && captionSource === 'post') {
    resolvedCaption = String(postCaption || '').trim();
    if (resolvedCaption) {
      console.log(`  [publish_post] Using captionSource=post (from user.posts[].caption)`);
    } else {
      console.warn(
        `  [publish_post] captionSource=post but no caption on the picked entry — posting captionless`
      );
    }
  }

  if (!resolvedCaption && captionSource === 'ai' && userIdentity) {
    try {
      resolvedCaption = (await generatePostCaption(userIdentity, postContext)) || '';
    } catch (err) {
      console.warn(`  [publish_post] caption generation failed (non-fatal): ${err.message}`);
      resolvedCaption = '';
    }
  }

  console.log(
    `  [publish_post] Downloading ${imageUrls.length} image(s)... caption="${resolvedCaption.slice(0, 60)}${resolvedCaption.length > 60 ? '…' : ''}"`
  );
  const tmpPaths = [];
  try {
    for (let i = 0; i < imageUrls.length; i++) {
      tmpPaths.push(await downloadToTemp(imageUrls[i], `post_${i}`));
    }
  } catch (err) {
    // Clean up any partial downloads before re-throwing.
    for (const p of tmpPaths) fs.unlink(p, () => {});
    throw err;
  }

  try {
    // 1. Always navigate to facebook.com/me first. /me deterministically
    // mounts the composer's hidden <input type="file" multiple> as part of
    // the profile-page composer surface. Going elsewhere first (home feed,
    // a stale tab, /settings) introduces layout variance we've already
    // burned iterations on — /me is the known-good landing page.
    //
    // We deliberately SKIP every click-to-open step (the "What's on your
    // mind?" composer trigger and the "Photo/video" button). Both have
    // failure modes:
    //   - The "What's on your mind?" textbox/button has page-wide selector
    //     ambiguity and on /me-inline only focuses the textbox rather than
    //     opening a modal.
    //   - The "Photo/video" button on /me-inline triggers a NATIVE file
    //     chooser (not a modal). Playwright auto-cancels the native
    //     chooser when no waitForEvent listener is attached, so the modal
    //     never materializes.
    //
    // setInputFiles directly on the hidden input fires FB's React change
    // handler, which opens the Create post modal with previews loaded. We
    // skip the visible-UI dance entirely and let the input drive the modal
    // open. Simpler and immune to composer-trigger variance.
    console.log('  [publish_post] Navigating to /me...');
    await page.goto('https://www.facebook.com/me', { waitUntil: 'domcontentloaded' });
    await humanWait(page, 2500, 4000);

    const fileInput = page.locator('input[type="file"][multiple][accept*="image"]').first();

    // 2. Set files on the hidden input. Fires FB's React change handler
    // which auto-opens the Create post modal with previews loaded.
    await fileInput.waitFor({ state: 'attached', timeout: 20000 });
    await fileInput.setInputFiles(tmpPaths);
    console.log(
      `  [publish_post] Uploaded ${tmpPaths.length} file(s) — waiting for composer dialog...`
    );

    // 3. Wait for the Create post dialog to open in reaction to the file
    // input change. Bumped to 30s to cover slower image-processing rounds.
    const dialog = page.locator('div[role="dialog"][aria-label="Create post"]').first();
    await dialog.waitFor({ state: 'visible', timeout: 30000 });
    await humanWait(page, 1500, 2500);

    await dismissNotNow(page);

    // 4. Audience (best-effort)
    await setAudience(page, audience);
    console.log(`  [publish_post] Dialog open, previews loading...`);

    // 6. Wait for the previews to render. FB shows an <img> with non-empty
    // alt inside the dialog once the upload settles.
    await page
      .locator('div[role="dialog"][aria-label="Create post"] img[alt]')
      .first()
      .waitFor({ state: 'visible', timeout: 45000 })
      .catch(() => {
        console.warn("  [publish_post] Preview img didn't appear in 45s — proceeding anyway");
      });
    await humanWait(page, 2500, 4000);

    // 7. Caption (only if non-empty). **Must scope to the dialog** — FB
    // pre-renders ~4 hidden `data-lexical-editor="true"` instances elsewhere
    // on the page (Stories composer, Marketplace search, etc.). A
    // page-level `.first()` grabs whichever is first in DOM order, which is
    // usually NOT the active composer. Playwright then auto-scrolls the
    // page to the off-screen target to click it (causing the screen jump),
    // focus lands on the wrong editor, humanType writes into nowhere
    // useful. Scoping to the dialog guarantees the right textbox.
    if (resolvedCaption) {
      const textbox = dialog.locator('div[role="textbox"][data-lexical-editor="true"]').first();
      await textbox.waitFor({ state: 'visible', timeout: 10000 });

      await textbox.click();
      await humanWait(page, 500, 1000);
      await textbox.focus().catch(() => {});
      await humanWait(page, 300, 700);

      await humanType(page, resolvedCaption);
      await humanWait(page, 1500, 2500);
    }

    // 8. Click Post
    const postBtn = page
      .locator(
        ['div[role="button"][aria-label="Post"]', 'div[aria-label="Post"][role="button"]'].join(
          ', '
        )
      )
      .first();
    await postBtn.waitFor({ state: 'visible', timeout: 15000 });
    await humanClick(page, await postBtn.boundingBox());
    console.log('  [publish_post] Post clicked — waiting for dialog to close...');

    // 9. Dialog detach is the success signal. FB occasionally pops a confirm
    // overlay; the detach wait subsumes both cases (overlay → real close).
    await dialog.waitFor({ state: 'detached', timeout: 60000 }).catch(() => {
      console.warn(
        "  [publish_post] Create post dialog didn't detach in 60s — post may still have succeeded"
      );
    });
    await humanWait(page, 3000, 5000);

    console.log('  [publish_post] Done.');

    if (userId) await setOnboarding(userId, 'publishPostAt');
  } catch (err) {
    await dumpFailure(page, `error-${imageUrls.length}img`);
    throw err;
  } finally {
    for (const p of tmpPaths) fs.unlink(p, () => {});
  }
};
