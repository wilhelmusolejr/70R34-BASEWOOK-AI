/**
 * Recursive step runner - core execution engine.
 * Walks the step tree and executes handlers.
 */

const { launchBrowsers } = require('./utils/browserManager');

// Handler registry - add new handlers here
const handlers = {
  homepage_interaction: require('./actions/homepage_interaction'),
  scroll: require('./actions/scroll'),
  like_posts: require('./actions/like_posts'),
  share_posts: require('./actions/share_posts'),
  setup_about: require('./actions/setup_about'),
  setup_avatar: require('./actions/setup_avatar'),
  setup_cover: require('./actions/setup_cover'),
  add_friend: require('./actions/add_friend'),
  visit_profile: require('./actions/visit_profile'),
  share_post: require('./actions/share_post')
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
  'timeout'
];

const STEP_RETRY_ATTEMPTS = 3;
const STEP_RETRY_WAIT_MS = 60000; // 1 minute — covers brief proxy disconnections

function isNetworkError(err) {
  const msg = err.message || '';
  return NETWORK_ERROR_PATTERNS.some(pattern => msg.includes(pattern));
}

/**
 * Execute a handler with retry logic for network errors.
 * Non-network errors (bad selectors, logic errors) fail immediately — no retry.
 */
async function runWithRetry(fn, profileId, stepType) {
  let lastError;

  for (let attempt = 1; attempt <= STEP_RETRY_ATTEMPTS; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;

      if (!isNetworkError(err)) {
        throw err; // Logic/selector errors — don't retry
      }

      if (attempt < STEP_RETRY_ATTEMPTS) {
        console.warn(`[${profileId}] Network error on ${stepType} (attempt ${attempt}/${STEP_RETRY_ATTEMPTS}): ${err.message}`);
        console.warn(`[${profileId}] Waiting ${STEP_RETRY_WAIT_MS / 1000}s before retry...`);
        await new Promise(resolve => setTimeout(resolve, STEP_RETRY_WAIT_MS));
      }
    }
  }

  throw lastError;
}

/**
 * Execute a single step and recurse into child steps.
 */
async function runStep(page, step, profileId) {
  const handler = handlers[step.type];

  if (!handler) {
    throw new Error(`Unknown step type: ${step.type}`);
  }

  console.log(`[${profileId}] Starting: ${step.type}`);

  await runWithRetry(
    () => handler(page, step.params || {}),
    profileId,
    step.type
  );

  console.log(`[${profileId}] Completed: ${step.type}`);

  // Recurse into child steps if present
  if (step.steps && step.steps.length > 0) {
    for (const childStep of step.steps) {
      await runStep(page, childStep, profileId);
    }
  }
}

/**
 * Execute all steps for a single browser.
 */
async function runBrowser(browserInfo, steps) {
  const { page, profileId } = browserInfo;

  // Slow proxy tolerance — extend default navigation and action timeouts
  page.setDefaultNavigationTimeout(90000); // 90s for page loads
  page.setDefaultTimeout(60000);           // 60s for selectors/actions

  // Block media resources to save data — images, video, audio, fonts
  const BLOCKED_TYPES = new Set(['image', 'media', 'font']);
  await page.route('**/*', (route) => {
    if (BLOCKED_TYPES.has(route.request().resourceType())) {
      route.abort();
    } else {
      route.continue();
    }
  });

  for (const step of steps) {
    await runStep(page, step, profileId);
  }

  return { profileId, status: 'success' };
}

/**
 * Run a complete task across multiple browsers in parallel.
 *
 * @param {Object} task - Task object with taskId, browsers, steps
 * @returns {Promise<{taskId, results}>}
 */
async function runTask(task) {
  const { taskId, browsers: browserCount, steps } = task;

  console.log(`\n=== Task ${taskId}: Starting with ${browserCount} browser(s) ===\n`);

  // Connect to Hidemium profiles
  const browserInfos = await launchBrowsers(browserCount);
  console.log(`Connected to ${browserInfos.length} browser(s)\n`);

  // Run steps on each browser in parallel
  const results = await Promise.allSettled(
    browserInfos.map(browserInfo => runBrowser(browserInfo, steps))
  );

  // Format results
  const formattedResults = results.map((result, index) => {
    const profileId = browserInfos[index].profileId;

    if (result.status === 'fulfilled') {
      return { profileId, status: 'success' };
    } else {
      console.error(`[${profileId}] Error:`, result.reason.message);
      return { profileId, status: 'error', error: result.reason.message };
    }
  });

  console.log(`\n=== Task ${taskId}: Completed ===\n`);

  return {
    taskId,
    results: formattedResults
  };
}

module.exports = { runTask, runStep };
