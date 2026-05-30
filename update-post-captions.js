/**
 * update-post-captions.js
 *
 * For each user ID, fetch the user record and regenerate the `caption` field
 * of every entry in `user.posts[]` using generatePostCaption (Gemini +
 * system_prompt_post.txt). The new captions are derived from the user's
 * `identityPrompt` + each post's `context`, then PATCHed back to the record.
 *
 * Usage:
 *   node update-post-captions.js                  # uses DEFAULT_USER_IDS below
 *   node update-post-captions.js <id1> <id2> ...  # process specific ids
 *
 * Skips a post when:
 *   - it has no images (nothing to caption)
 *   - --skip-existing is passed AND the post already has a non-empty caption
 *
 * The PATCH overwrites the whole `posts` array — context and images are
 * carried through unchanged, only `caption` is regenerated.
 */

require('dotenv').config();
const axios = require('axios');
const { fetchUser } = require('./utils/userApi');
const { generatePostCaption } = require('./utils/generatePostCaption');

const USER_API_BASE_URL = process.env.USER_API_BASE_URL;

// Posts live in their own collection — PATCHing the profile silently drops
// the `posts` field. Update one post at a time via /api/posts/:postId.
async function updatePostCaption(postId, caption) {
  if (!USER_API_BASE_URL) throw new Error('USER_API_BASE_URL is not set');
  await axios.patch(`${USER_API_BASE_URL}/api/posts/${postId}`, { caption }, { timeout: 15000 });
}

const DEFAULT_USER_IDS = [
  '69fae777d7f59db2c21aece7',
  '69fca5681e49eec688fcfc6c',
  '69fd72f01e49eec688fd0551',
  '6a03d4b076c1dbb6df141b1e',
];

function parseArgs(argv) {
  const args = argv.slice(2);
  const flags = { skipExisting: false, dryRun: false };
  const ids = [];
  for (const a of args) {
    if (a === '--skip-existing') flags.skipExisting = true;
    else if (a === '--dry-run') flags.dryRun = true;
    else ids.push(a);
  }
  return { ids: ids.length ? ids : DEFAULT_USER_IDS, flags };
}

async function regeneratePostsForUser(user, flags) {
  const userId = user._id || user.id;
  const identity = user.identityPrompt || '';
  const posts = Array.isArray(user.posts) ? user.posts : [];

  if (!identity) {
    console.warn(`  [skip] no identityPrompt on user ${userId} — leaving posts unchanged`);
    return { changedCount: 0, updates: [] };
  }
  if (posts.length === 0) {
    console.warn(`  [skip] no posts on user ${userId}`);
    return { changedCount: 0, updates: [] };
  }

  const updates = [];

  for (let i = 0; i < posts.length; i++) {
    const post = posts[i] || {};
    const postId = post._id || post.id;
    const hasImages = Array.isArray(post.images) && post.images.length > 0;
    const existingCaption = String(post.caption || '').trim();
    const context = String(post.context || '').trim();

    if (!postId) {
      console.warn(`  [post ${i + 1}/${posts.length}] no postId — skipping`);
      continue;
    }
    if (!hasImages) {
      console.log(`  [post ${i + 1}/${posts.length}] no images — keeping as-is`);
      continue;
    }
    if (flags.skipExisting && existingCaption) {
      console.log(
        `  [post ${i + 1}/${posts.length}] already has caption (--skip-existing) — keeping`
      );
      continue;
    }

    console.log(`  [post ${i + 1}/${posts.length}] generating caption...`);
    const newCaption = (await generatePostCaption(identity, context)) || '';

    if (!newCaption) {
      console.warn(`  [post ${i + 1}/${posts.length}] generator returned empty — keeping existing`);
      continue;
    }
    if (newCaption === existingCaption) {
      console.log(`  [post ${i + 1}/${posts.length}] unchanged`);
      continue;
    }

    updates.push({ postId, newCaption, oldCaption: existingCaption });

    await new Promise((r) => setTimeout(r, 600));
  }

  return { changedCount: updates.length, updates };
}

async function processUser(userId, flags) {
  console.log(`\n=== ${userId} ===`);
  let user;
  try {
    user = await fetchUser(userId);
  } catch (err) {
    console.error(`  [error] fetchUser failed: ${err.message}`);
    return { userId, ok: false, error: err.message };
  }

  const displayName = [user.firstName, user.lastName].filter(Boolean).join(' ') || userId;
  console.log(`  Name: ${displayName}`);
  console.log(
    `  Identity: "${(user.identityPrompt || '').slice(0, 100)}${(user.identityPrompt || '').length > 100 ? '…' : ''}"`
  );

  const result = await regeneratePostsForUser(user, flags);

  if (result.changedCount === 0) {
    console.log(`  [done] no captions changed for ${displayName}`);
    return { userId, ok: true, changed: 0 };
  }

  if (flags.dryRun) {
    console.log(`  [dry-run] would PATCH ${result.changedCount} caption(s) for ${displayName}`);
    for (const u of result.updates) {
      console.log(`    - post ${u.postId}: "${u.newCaption}"`);
    }
    return { userId, ok: true, changed: result.changedCount, dryRun: true };
  }

  let ok = 0;
  let fail = 0;
  for (const u of result.updates) {
    try {
      await updatePostCaption(u.postId, u.newCaption);
      ok++;
    } catch (err) {
      console.error(`  [error] PATCH post ${u.postId} failed: ${err.message}`);
      fail++;
    }
  }
  console.log(
    `  [done] PATCHed ${ok}/${result.updates.length} caption(s) for ${displayName}${fail ? ` (${fail} failed)` : ''}`
  );
  return { userId, ok: fail === 0, changed: ok, failed: fail };
}

async function main() {
  const { ids, flags } = parseArgs(process.argv);

  console.log(`Processing ${ids.length} user(s)`);
  if (flags.skipExisting)
    console.log('  --skip-existing: keeping posts that already have a caption');
  if (flags.dryRun) console.log('  --dry-run: no PATCH calls will be made');

  const results = [];
  for (const id of ids) {
    results.push(await processUser(id, flags));
  }

  console.log('\n=== Summary ===');
  for (const r of results) {
    if (r.skipped) {
      console.log(`  ${r.userId}: skipped (no posts or no identity)`);
    } else if (!r.ok) {
      console.log(`  ${r.userId}: ERROR — ${r.error}`);
    } else {
      const tag = r.dryRun ? ' (dry-run)' : '';
      console.log(`  ${r.userId}: ${r.changed} caption(s) updated${tag}`);
    }
  }
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
