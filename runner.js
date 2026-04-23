/**
 * Recursive step runner - core execution engine.
 * Walks the step tree and executes handlers.
 */

require('dotenv').config();
const axios = require('axios');
const { launchBrowsers, closeBrowsers, testProxy } = require('./utils/browserManager');
const { fetchUser } = require('./utils/userApi');
const presets = require('./config/presets.json');
const { buildPageAddress } = require('./utils/pageAddressData');

const IMAGE_SERVER_BASE_URL = process.env.IMAGE_SERVER_BASE_URL || '';
const USER_API_BASE_URL = process.env.USER_API_BASE_URL || '';

/**
 * Before opening the browser, fetch current IP via the user's proxy and
 * append it to user.proxyLog if the IP differs from the last recorded entry.
 * Non-fatal — any failure (fetch, proxy, PATCH) is logged and skipped.
 */
async function recordProxyLog(userId) {
  if (!USER_API_BASE_URL) {
    console.warn(`[${userId}] [proxyLog] USER_API_BASE_URL not set — skipping`);
    return;
  }

  let user;
  try {
    user = await fetchUser(userId);
  } catch (err) {
    console.warn(`[${userId}] [proxyLog] fetchUser failed: ${err.message}`);
    return;
  }

  const proxy = user.proxies?.[0]?.proxy;
  if (!proxy) {
    console.warn(`[${userId}] [proxyLog] No proxies[0].proxy — skipping`);
    return;
  }

  let ipInfo;
  try {
    ipInfo = await testProxy(proxy);
  } catch (err) {
    console.warn(`[${userId}] [proxyLog] Proxy test failed: ${err.message}`);
    return;
  }

  const existingLog = Array.isArray(user.proxyLog) ? user.proxyLog : [];
  const lastEntry = existingLog[existingLog.length - 1];

  if (lastEntry && lastEntry.ip === ipInfo.ip) {
    console.log(`[${userId}] [proxyLog] IP unchanged (${ipInfo.ip}) — no new entry`);
    return;
  }

  const newEntry = {
    ip: ipInfo.ip || '',
    city: ipInfo.city || '',
    region: ipInfo.region || '',
    country: ipInfo.country || '',
    loc: ipInfo.loc || '',
    org: ipInfo.org || '',
    postal: ipInfo.postal || '',
    timezone: ipInfo.timezone || '',
    checkedAt: new Date().toISOString(),
  };

  try {
    await axios.patch(`${USER_API_BASE_URL}/api/profiles/${userId}`, {
      proxyLog: [...existingLog, newEntry],
    });
    console.log(`[${userId}] [proxyLog] New entry: ${newEntry.ip} (${newEntry.city}, ${newEntry.region}, ${newEntry.country})`);
  } catch (err) {
    const respBody = err.response?.data ? JSON.stringify(err.response.data) : err.message;
    console.warn(`[${userId}] [proxyLog] PATCH failed: ${respBody}`);
  }
}

async function persistTrackerLog(userId, note) {
  if (!userId || !note) return;
  if (!USER_API_BASE_URL) {
    console.warn('  [trackerLog] USER_API_BASE_URL not set — skipping tracker log POST.');
    return;
  }
  const today = new Date().toISOString().slice(0, 10);
  const target = `${USER_API_BASE_URL}/api/profiles/${userId}/tracker`;
  try {
    await axios.post(target, { date: today, note }, { timeout: 15000 });
    const preview = note.length > 120 ? `${note.slice(0, 120)}…` : note;
    console.log(`  [trackerLog] Logged "${preview.replace(/\n/g, ' | ')}" → ${target}`);
  } catch (err) {
    console.warn(`  [trackerLog] Failed to POST tracker log: ${err.message}`);
  }
}

/**
 * Flatten a step tree into a " - " joined chain of type names.
 * Example: search → [open_search_result → [connect, scroll, share_posts]]
 *   becomes "search - open_search_result - connect - scroll - share_posts"
 */
function describeStepChain(step) {
  const nested = Array.isArray(step.steps) ? step.steps.map(describeStepChain) : [];
  return [step.type, ...nested].join(' - ');
}

/**
 * Build the tracker-log note body.
 * On success: "SUCCESS\n1. <chain>\n2. <chain>..."
 * On failure: "FAIL at <type>: <message>\n1. <completed chain>..."
 */
function buildTrackerNote(completed, failure) {
  const lines = [];
  if (failure) {
    const where = failure.step?.type ? ` at ${failure.step.type}` : '';
    const msg = failure.error?.message || String(failure.error || 'unknown error');
    lines.push(`FAIL${where}: ${msg}`);
  } else {
    lines.push('SUCCESS');
  }
  completed.forEach((chain, i) => lines.push(`${i + 1}. ${chain}`));
  return lines.join('\n');
}

function getAssetFilename(asset) {
  return asset?.imageId?.filename || asset?.filename || asset?.fileName || asset?.url || '';
}

function buildImageUrl(filename) {
  if (!filename) return '';
  if (/^https?:\/\//i.test(filename)) return filename;
  return `${IMAGE_SERVER_BASE_URL}${filename}`;
}

function resolveSetupPageImages(user) {
  const linkedAssets = Array.isArray(user.linkedPage?.assets) ? user.linkedPage.assets : [];
  const filenames = linkedAssets
    .map((asset) => getAssetFilename(asset))
    .filter(Boolean);

  const byKeyword = (keyword) => filenames.find((f) => f.toLowerCase().includes(keyword));

  const profileFilename = byKeyword('profile') || filenames[0] || '';
  const coverFilename = byKeyword('cover') || filenames[1] || filenames[0] || '';

  return {
    profilePhotoUrl: buildImageUrl(profileFilename),
    coverPhotoUrl: buildImageUrl(coverFilename),
  };
}

// Handler registry - add new handlers here
const handlers = {
  homepage_interaction: require('./actions/homepage_interaction'),
  scroll: require('./actions/scroll'),
  like_posts: require('./actions/like_posts'),
  share_posts: require('./actions/share_posts'),
  setup_about: require('./actions/setup_about'),
  setup_avatar: require('./actions/setup_avatar'),
  setup_cover: require('./actions/setup_cover'),
  create_page: require('./actions/create_page'),
  schedule_posts: require('./actions/schedule_posts'),
  switch_profile: require('./actions/switch_profile'),
  add_friend: require('./actions/add_friend'),
  visit_profile: require('./actions/visit_profile'),
  share_post: require('./actions/share_post'),
  check_ip: require('./actions/check_ip'),
  search: require('./actions/search'),
  open_search_result: require('./actions/open_search_result'),
  follow: require('./actions/follow'),
  connect: require('./actions/connect'),
};


const STEP_RETRY_ATTEMPTS = 3;
const RETRY_WAIT_MS = 60000;

async function runWithRetry(fn, profileId, stepType) {
  let lastError;

  for (let attempt = 1; attempt <= STEP_RETRY_ATTEMPTS; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;

      // Handlers can set err.noRetry = true to opt out of step-level retry
      // (e.g. create_page, which handles its own retries internally — a
      // whole-handler restart would spawn a duplicate Page on FB).
      if (err && err.noRetry) {
        console.warn(`[${profileId}] ${stepType} threw noRetry error — skipping runner retry: ${err.message}`);
        break;
      }

      if (attempt >= STEP_RETRY_ATTEMPTS) break;

      console.warn(`[${profileId}] Error on ${stepType} (attempt ${attempt}/${STEP_RETRY_ATTEMPTS}): ${err.message}`);
      console.warn(`[${profileId}] Retrying in ${RETRY_WAIT_MS / 1000}s...`);
      await new Promise((resolve) => setTimeout(resolve, RETRY_WAIT_MS));
    }
  }

  throw lastError;
}

/**
 * Walk the step tree and inject user data into setup steps that have no explicit params.
 * setup_about  — filled from user fields
 * setup_avatar — photoUrl built from user.images[0]
 * setup_cover  — photoUrl built from user.images[1]
 *
 * Explicit params in tasks.json always take priority.
 */
function injectUserParams(steps, user) {
  return steps.map((step) => {
    const s = { ...step };

    if (step.type === 'setup_about' && !step.params) {
      s.params = {
        bio: user.bio,
        city: user.city,
        hometown: user.hometown,
        personal: user.personal,
        work: user.work,
        education: user.education,
        hobbies: user.hobbies,
        travel: user.travel,
        userId: user._id || user.id || '',
      };
    } else if (step.type === 'setup_about' && !(step.params && step.params.userId)) {
      s.params = {
        ...(step.params || {}),
        userId: user._id || user.id || '',
      };
    }

    if (step.type === 'setup_avatar') {
      const next = { ...(step.params || {}) };

      if (!next.photoUrl) {
        const img = user.images && user.images[0];
        if (img) next.photoUrl = `${IMAGE_SERVER_BASE_URL}${img.imageId.filename}`;
      }

      if (!next.userIdentity) {
        next.userIdentity = user.identityPrompt || '';
      }

      s.params = next;
    }

    if (step.type === 'setup_cover' && !(step.params && step.params.photoUrl)) {
      const img = user.images && user.images[1];
      if (img) {
        s.params = {
          ...(step.params || {}),
          photoUrl: `${IMAGE_SERVER_BASE_URL}${img.imageId.filename}`,
        };
      }
    }

    if (step.type === 'create_page') {
      const pageAddress = buildPageAddress({
        city: user.city,
        state: user.state,
        zipCode: user.zip_code,
      });
      const pageImages = resolveSetupPageImages(user);

      s.params = {
        ...(step.params || {}),
        pageName: step.params?.pageName || user.linkedPage?.pageName || '',
        bio: step.params?.bio ?? user.linkedPage?.bio ?? '',
        email: step.params?.email || user.emails?.find((item) => item.selected)?.address || user.emails?.[0]?.address || '',
        streetAddress: step.params?.streetAddress || pageAddress.streetAddress,
        city: step.params?.city || user.city || '',
        state: step.params?.state || pageAddress.stateName,
        zipCode: step.params?.zipCode || pageAddress.zipCode,
        profilePhotoUrl: step.params?.profilePhotoUrl || pageImages.profilePhotoUrl,
        coverPhotoUrl: step.params?.coverPhotoUrl || pageImages.coverPhotoUrl,
        userId: step.params?.userId || user._id || user.id || '',
      };
    }

    if (step.type === 'schedule_posts' && !(step.params && step.params.posts)) {
      s.params = {
        ...(step.params || {}),
        posts: user.linkedPage?.posts || [],
      };
    }

    if (step.type === 'switch_profile' && !(step.params && step.params.userName)) {
      s.params = {
        ...(step.params || {}),
        userName: `${user.firstName || ''} ${user.lastName || ''}`.trim(),
      };
    }

    if (step.type === 'check_ip' && !(step.params && step.params.userId)) {
      s.params = {
        ...(step.params || {}),
        userId: user._id || user.id || '',
      };
    }

    if (step.type === 'search' && !(step.params && step.params.city)) {
      s.params = {
        ...(step.params || {}),
        city: user.city || '',
      };
    }

    if ((step.type === 'share_posts' || step.type === 'share_post')
        && !(step.params && step.params.userIdentity)) {
      s.params = {
        ...(step.params || {}),
        userIdentity: user.identityPrompt || '',
      };
    }

    if (s.steps) {
      s.steps = injectUserParams(s.steps, user);
    }

    return s;
  });
}

/**
 * Resolve a random_preset step into a preset and run its steps.
 * Preset steps are passed through injectUserParams so they get the same
 * auto-injection treatment as top-level tasks.json steps.
 */
async function runRandomPreset(page, step, profileId, user) {
  const pool = (step.params && step.params.from) || Object.keys(presets);
  const validKeys = pool.filter((k) => presets[k]);

  if (!validKeys.length) throw new Error('random_preset: no valid presets available');

  const key = validKeys[Math.floor(Math.random() * validKeys.length)];
  const preset = presets[key];

  console.log(`[${profileId}] random_preset → "${key}" (${preset.description || ''})`);

  const presetSteps = user ? injectUserParams(preset.steps, user) : preset.steps;

  for (const presetStep of presetSteps) {
    await runStep(page, presetStep, profileId, user);
  }
}

/**
 * Execute a single step and recurse into child steps.
 */
async function runStep(page, step, profileId, user) {
  if (step.type === 'random_preset') {
    await runRandomPreset(page, step, profileId, user);
    return;
  }

  const handler = handlers[step.type];
  if (!handler) throw new Error(`Unknown step type: ${step.type}`);

  console.log(`[${profileId}] Starting: ${step.type}`);

  await runWithRetry(
    () => handler(page, step.params || {}),
    profileId,
    step.type
  );

  console.log(`[${profileId}] Completed: ${step.type}`);

  if (step.steps && step.steps.length > 0) {
    for (const childStep of step.steps) {
      const betweenMs = 5000 + Math.random() * 10000;
      console.log(`[${profileId}] Waiting ${(betweenMs / 1000).toFixed(1)}s before next step...`);
      await new Promise(r => setTimeout(r, betweenMs));
      await runStep(page, childStep, profileId, user);
    }
  }
}

/**
 * Execute all steps for a single browser session.
 */
async function runBrowser(session, steps, options = {}) {
  const { page, profileId, user } = session;

  page.setDefaultNavigationTimeout(90000);
  page.setDefaultTimeout(60000);

  if (options.blockMedia !== false) {
    const BLOCKED_TYPES = new Set(['image', 'media', 'font']);
    console.log(`[${profileId}] Media blocking: ON`);
    await page.route('**/*', (route) => {
      if (BLOCKED_TYPES.has(route.request().resourceType())) {
        route.abort();
      } else {
        route.continue();
      }
    });
  } else {
    console.log(`[${profileId}] Media blocking: OFF`);
  }

  const currentUrl = page.url();
  if (!currentUrl.includes('facebook.com')) {
    console.log(`[${profileId}] Not on Facebook — navigating to homepage first...`);
    await page.goto('https://www.facebook.com', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2000 + Math.random() * 1500);
  }

  // Temporarily disabled: keep check_ip available as an explicit step,
  // but do not auto-trigger it on every browser session.
  // try {
  //   console.log(`[${profileId}] Recording browser IP...`);
  //   await handlers.check_ip(page, { userId: user?._id || user?.id || profileId });
  // } catch (err) {
  //   console.warn(`[${profileId}] check_ip failed (non-fatal): ${err.message}`);
  // }

  const injectedSteps = user ? injectUserParams(steps, user) : steps;
  const completed = [];
  let failure = null;

  try {
    for (let i = 0; i < injectedSteps.length; i++) {
      if (i > 0) {
        const betweenMs = 5000 + Math.random() * 10000;
        console.log(`[${profileId}] Waiting ${(betweenMs / 1000).toFixed(1)}s before next step...`);
        await new Promise(r => setTimeout(r, betweenMs));
      }
      const step = injectedSteps[i];
      try {
        await runStep(page, step, profileId, user);
        completed.push(describeStepChain(step));
      } catch (err) {
        failure = { step, error: err };
        throw err;
      }
    }
  } finally {
    const userId = user?._id || user?.id || '';
    const note = buildTrackerNote(completed, failure);
    await persistTrackerLog(userId, note);
  }

  const doneMs = 10000 + Math.random() * 5000;
  console.log(`[${profileId}] Task done — cooling down ${(doneMs / 1000).toFixed(1)}s...`);
  await new Promise(r => setTimeout(r, doneMs));

  return { profileId, status: 'success' };
}

/**
 * Run a complete task across multiple browsers with a concurrency limit.
 * Browsers are opened lazily — only concurrency-many are open at once.
 */
async function runTask(task) {
  const { taskId, profiles: userIds, concurrency, blockMedia, steps } = task;
  const limit = concurrency && concurrency > 0 ? concurrency : userIds.length;
  const options = { blockMedia: blockMedia !== false };

  console.log(`\n=== Task ${taskId}: ${userIds.length} profile(s), concurrency: ${limit}, blockMedia: ${options.blockMedia} ===\n`);

  const results = new Array(userIds.length);
  const queue = [...userIds.entries()];

  async function worker() {
    while (queue.length > 0) {
      const [index, userId] = queue.shift();

      await recordProxyLog(userId);

      let session;
      try {
        const browserInfos = await launchBrowsers([userId]);
        session = { ...browserInfos[0], steps };
      } catch (err) {
        console.error(`[${userId}] Failed to open browser:`, err.message);
        results[index] = { status: 'rejected', reason: err };
        continue;
      }

      const { profileId } = session;
      results[index] = await Promise.allSettled([
        runBrowser(session, session.steps, options),
      ]).then((r) => r[0]);

      await closeBrowsers([session]);
    }
  }

  const workers = Array.from({ length: limit }, () => worker());
  await Promise.all(workers);

  const formattedResults = results.map((result, index) => {
    const userId = userIds[index];
    const profileId = result?.value?.profileId || userId;
    if (result?.status === 'fulfilled') {
      return { profileId, status: 'success' };
    } else {
      const msg = result?.reason?.message || 'unknown error';
      console.error(`[${profileId}] Error:`, msg);
      return { profileId, status: 'error', error: msg };
    }
  });

  console.log(`\n=== Task ${taskId}: Completed ===\n`);
  return { taskId, results: formattedResults };
}

module.exports = { runTask, runStep };
