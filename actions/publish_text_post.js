/**
 * publish_text_post — Leaf action.
 *
 * Publishes a TEXT-ONLY status to the user's own timeline. Unlike publish_post
 * (image-driven, opened via the hidden file input), there is no image, so the
 * composer is opened by clicking the "What's on your mind?" trigger.
 *
 * Text source: a random TOPIC seed (utils/postTopics.pickPostTopic) is fed,
 * together with the user's identity, to generateTopicPost (Gemini), which writes
 * a short humanoid status in the user's voice. The system prompt lives in
 * prompts/random_topic_post.txt. An explicit `caption` param overrides the AI.
 *
 * Flow:
 *   1. goto facebook.com  → click "What's on your mind?" composer trigger
 *   2. wait for div[role="dialog"][aria-label="Create post"]
 *   3. (best-effort) set audience to Public
 *   4. type the caption into the dialog's Lexical textbox
 *   5. click Post → wait for the dialog to detach (success signal)
 *
 * No onboarding stamp — this action is meant to fire repeatedly, gated only by
 * a `chance` roll in the task JSON (not a one-time guard).
 *
 * Auto-injected params (runner.js / injectUserParams):
 *   userIdentity ← user.identityPrompt
 *   city / work  ← grounding for the topic + caption
 *   userId       ← failure-dump label only
 */

const fs = require('fs');
const path = require('path');
const { humanWait, humanClick, humanType } = require('../utils/humanBehavior');
const { generateTopicPost } = require('../utils/generatePostCaption');
const { pickPostTopic } = require('../utils/postTopics');
const { getProfileLogDir } = require('../utils/sessionLog');

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
    const baseName = `publish_text_post-${safeLabel}-${ts}`;
    let url = '(unknown)';
    try {
      url = page.url();
    } catch (_) {}
    try {
      const html = await page.content();
      fs.writeFileSync(path.join(targetDir, `${baseName}.html`), `<!-- url: ${url} -->\n${html}`, 'utf8');
      console.warn(`  [publish_text_post] dumped HTML → ${baseName}.html`);
    } catch (err) {
      console.warn(`  [publish_text_post] HTML dump failed: ${err.message}`);
    }
    try {
      await page.screenshot({ path: path.join(targetDir, `${baseName}.png`), fullPage: true });
    } catch (err) {
      console.warn(`  [publish_text_post] screenshot failed: ${err.message}`);
    }
  } catch (err) {
    console.warn(`  [publish_text_post] dumpFailure swallowed: ${err.message}`);
  }
}

async function dismissNotNow(page) {
  for (let i = 0; i < 4; i++) {
    try {
      const notNow = page.locator('[aria-label="Not now"]').first();
      await notNow.waitFor({ state: 'visible', timeout: 3000 });
      console.log('  [publish_text_post] "Not now" modal — dismissing...');
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
    if (await doneBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await humanClick(page, await doneBtn.boundingBox());
      await humanWait(page, 800, 1500);
    }
    console.log(`  [publish_text_post] Audience set to ${targetLabel}`);
  } catch (err) {
    console.warn(`  [publish_text_post] Could not set audience (non-fatal): ${err.message}`);
  }
}

module.exports = async function publish_text_post(page, params) {
  const {
    caption = '',
    userIdentity = '',
    city = '',
    work = '',
    hometown = '',
    audience = 'public',
    userId = '',
  } = params;

  // 1. Resolve the caption: explicit param wins, else topic → AI.
  let resolvedCaption = String(caption || '').trim();
  if (!resolvedCaption) {
    const topic = pickPostTopic({ city, work, hometown });
    console.log(`  [publish_text_post] topic: "${topic}"`);
    resolvedCaption = (await generateTopicPost(userIdentity, topic, { city, work })) || '';
  }
  if (!resolvedCaption) {
    // Text-only post with no text is pointless — skip cleanly (retriable).
    throw new Error('publish_text_post: could not produce caption text (AI returned empty)');
  }

  try {
    // 2. Open the composer. Home feed renders "What's on your mind?" as a
    // button. Clicking it opens the editable composer — sometimes a "Create
    // post" modal, sometimes the INLINE composer expanded in place. Both mount
    // a single contenteditable role=textbox with an "on your mind" placeholder,
    // so we target the EDITABLE textbox directly rather than requiring a dialog
    // (the inline variant has no role=dialog — confirmed via failure dump).
    console.log('  [publish_text_post] Opening composer...');
    await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded' });
    await humanWait(page, 2500, 4000);

    const trigger = page
      .locator(
        [
          'div[role="button"]:has-text("on your mind")',
          '[aria-label*="on your mind"]',
        ].join(', ')
      )
      .first();
    await trigger.waitFor({ state: 'visible', timeout: 30000 });
    await humanClick(page, await trigger.boundingBox());

    // The active composer textbox — the only contenteditable=true textbox with
    // an "on your mind" placeholder (FB's other hidden Lexical editors are not
    // contenteditable, so this stays unambiguous across modal/inline).
    const textbox = page
      .locator('div[role="textbox"][contenteditable="true"][aria-placeholder*="mind"]')
      .first();
    const ready = await textbox
      .waitFor({ state: 'visible', timeout: 20000 })
      .then(() => true)
      .catch(() => false);
    if (!ready) {
      throw new Error('publish_text_post: composer textbox did not open');
    }
    await humanWait(page, 1200, 2200);

    await dismissNotNow(page);

    // 3. Audience (best-effort) — page-wide, works for modal or inline.
    await setAudience(page, audience);

    // 4. Type the caption into the composer.
    await textbox.click();
    await humanWait(page, 500, 1000);
    await textbox.focus().catch(() => {});
    await humanWait(page, 300, 700);
    await humanType(page, resolvedCaption);
    await humanWait(page, 1500, 2500);

    // 5. Post. The Post button lives in both the modal and inline composer.
    const postBtn = page
      .locator(
        ['div[role="button"][aria-label="Post"]', 'div[aria-label="Post"][role="button"]'].join(', ')
      )
      .first();
    await postBtn.waitFor({ state: 'visible', timeout: 15000 });
    await humanClick(page, await postBtn.boundingBox());
    console.log('  [publish_text_post] Post clicked — waiting for composer to close...');

    // Success signal: the composer textbox detaches (modal closes / inline
    // collapses) once FB accepts the post.
    await textbox.waitFor({ state: 'detached', timeout: 60000 }).catch(() => {
      console.warn(
        "  [publish_text_post] composer didn't close in 60s — post may still have succeeded"
      );
    });
    await humanWait(page, 3000, 5000);

    console.log('  [publish_text_post] Done.');
  } catch (err) {
    await dumpFailure(page, `error-${userId || 'unknown'}`);
    throw err;
  }
};
