/**
 * Recursive step runner - core execution engine.
 * Walks the step tree and executes handlers.
 */

require('dotenv').config();
const { launchBrowsers, closeBrowsers } = require('./utils/browserManager');
const presets = require('./config/presets.json');
const { buildPageAddress } = require('./utils/pageAddressData');

const IMAGE_SERVER_BASE_URL = process.env.IMAGE_SERVER_BASE_URL || '';

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
  setup_page: require('./actions/setup_page'),
  add_friend: require('./actions/add_friend'),
  visit_profile: require('./actions/visit_profile'),
  share_post: require('./actions/share_post'),
};

// Network-related error patterns that are worth retrying
const NETWORK_ERROR_PATTERNS = [
  'net::ERR_',
  'ERR_CONNECTION',
  'ERR_INTERNET_DISCONNECTED',
  'ERR_NETWORK',
  'ERR_TIMED_OUT',
  'ERR_PROXY',
  'socket hang up',
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'Timeout',
  'timeout',
];

const STEP_RETRY_ATTEMPTS = 3;
const NETWORK_RETRY_WAIT_MS = 60000;
const SELECTOR_RETRY_WAIT_MS = 5000;

function isNetworkError(err) {
  const msg = err.message || '';
  return NETWORK_ERROR_PATTERNS.some((pattern) => msg.includes(pattern));
}

/**
 * Execute a handler with retry logic for all errors.
 * Network errors wait 60s between attempts (proxy recovery).
 * Selector/logic errors wait 5s (DOM may not be ready yet).
 */
async function runWithRetry(fn, profileId, stepType) {
  let lastError;

  for (let attempt = 1; attempt <= STEP_RETRY_ATTEMPTS; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;

      if (attempt >= STEP_RETRY_ATTEMPTS) break;

      const waitMs = isNetworkError(err) ? NETWORK_RETRY_WAIT_MS : SELECTOR_RETRY_WAIT_MS;
      const kind = isNetworkError(err) ? 'Network' : 'Step';
      console.warn(`[${profileId}] ${kind} error on ${stepType} (attempt ${attempt}/${STEP_RETRY_ATTEMPTS}): ${err.message}`);
      console.warn(`[${profileId}] Retrying in ${waitMs / 1000}s...`);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
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
      };
    }

    if (step.type === 'setup_avatar' && !(step.params && step.params.photoUrl)) {
      const img = user.images && user.images[0];
      if (img) {
        s.params = {
          ...(step.params || {}),
          photoUrl: `${IMAGE_SERVER_BASE_URL}${img.imageId.filename}`,
        };
      }
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

    if (step.type === 'setup_page') {
      const pageAddress = buildPageAddress({
        city: user.city,
        state: user.state,
        zipCode: user.zip_code,
      });
      const pageImages = resolveSetupPageImages(user);

      s.params = {
        ...(step.params || {}),
        pageName: step.params?.pageName || user.linkedPage?.pageName || '',
        bio: step.params?.bio ?? user.linkedPage?.bio ?? user.bio ?? '',
        email: step.params?.email || user.emails?.find((item) => item.selected)?.address || user.emails?.[0]?.address || '',
        streetAddress: step.params?.streetAddress || pageAddress.streetAddress,
        city: step.params?.city || user.city || '',
        state: step.params?.state || pageAddress.stateName,
        zipCode: step.params?.zipCode || pageAddress.zipCode,
        profilePhotoUrl: step.params?.profilePhotoUrl || pageImages.profilePhotoUrl,
        coverPhotoUrl: step.params?.coverPhotoUrl || pageImages.coverPhotoUrl,
        posts: step.params?.posts || user.linkedPage?.posts || [],
        userName: step.params?.userName || `${user.firstName || ''} ${user.lastName || ''}`.trim(),
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
 */
async function runRandomPreset(page, step, profileId) {
  const pool = (step.params && step.params.from) || Object.keys(presets);
  const validKeys = pool.filter((k) => presets[k]);

  if (!validKeys.length) throw new Error('random_preset: no valid presets available');

  const key = validKeys[Math.floor(Math.random() * validKeys.length)];
  const preset = presets[key];

  console.log(`[${profileId}] random_preset → "${key}" (${preset.description || ''})`);

  for (const presetStep of preset.steps) {
    await runStep(page, presetStep, profileId);
  }
}

/**
 * Execute a single step and recurse into child steps.
 */
async function runStep(page, step, profileId) {
  if (step.type === 'random_preset') {
    await runRandomPreset(page, step, profileId);
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
      await runStep(page, childStep, profileId);
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

  const injectedSteps = user ? injectUserParams(steps, user) : steps;

  for (let i = 0; i < injectedSteps.length; i++) {
    if (i > 0) {
      const betweenMs = 5000 + Math.random() * 10000;
      console.log(`[${profileId}] Waiting ${(betweenMs / 1000).toFixed(1)}s before next step...`);
      await new Promise(r => setTimeout(r, betweenMs));
    }
    await runStep(page, injectedSteps[i], profileId);
  }

  const doneMs = 10000 + Math.random() * 5000;
  console.log(`[${profileId}] Task done — cooling down ${(doneMs / 1000).toFixed(1)}s...`);
  await new Promise(r => setTimeout(r, doneMs));

  return { profileId, status: 'success' };
}

/**
 * Run sessions with a sliding concurrency window.
 * Each session has its own steps (with user params already injected).
 */
async function runWithConcurrency(sessions, limit, options = {}) {
  const results = new Array(sessions.length);
  const queue = [...sessions.entries()];

  async function worker() {
    while (queue.length > 0) {
      const [index, session] = queue.shift();
      results[index] = await Promise.allSettled([
        runBrowser(session, session.steps, options),
      ]).then((r) => r[0]);
    }
  }

  const workers = Array.from({ length: limit }, () => worker());
  await Promise.all(workers);
  return results;
}

/**
 * Run a complete task across multiple browsers in parallel.
 *
 * @param {Object} task - Task object
 *   browsers    {string[]} — explicit list of user IDs to run
 *   concurrency {number}  — max parallel browsers (default: all)
 *   blockMedia  {boolean} — block images/video/fonts (default: true)
 *   steps       {Array}   — step tree
 */
async function runTask(task) {
  const { taskId, profiles: userIds, concurrency, blockMedia, steps } = task;
  const limit = concurrency && concurrency > 0 ? concurrency : userIds.length;
  const options = { blockMedia: blockMedia !== false };

  console.log(`\n=== Task ${taskId}: ${userIds.length} profile(s), concurrency: ${limit}, blockMedia: ${options.blockMedia} ===\n`);

  const browserInfos = await launchBrowsers(userIds);
  console.log(`Connected to ${browserInfos.length} browser(s)\n`);

  // Attach the base steps to each session; injectUserParams runs inside runBrowser
  const sessions = browserInfos.map((info) => ({ ...info, steps }));

  const results = await runWithConcurrency(sessions, limit, options);

  const formattedResults = results.map((result, index) => {
    const profileId = browserInfos[index].profileId;
    if (result.status === 'fulfilled') {
      return { profileId, status: 'success' };
    } else {
      console.error(`[${profileId}] Error:`, result.reason.message);
      return { profileId, status: 'error', error: result.reason.message };
    }
  });

  await closeBrowsers(browserInfos);

  console.log(`\n=== Task ${taskId}: Completed ===\n`);
  return { taskId, results: formattedResults };
}

module.exports = { runTask, runStep };
