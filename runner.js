/**
 * Recursive step runner - core execution engine.
 * Walks the step tree and executes handlers.
 */

require('dotenv').config();
const axios = require('axios');
const { launchBrowsers, closeBrowsers } = require('./utils/browserManager');
const { fetchUser, updateProfile } = require('./utils/userApi');
const presets = require('./config/presets.json');
const { buildPageAddress } = require('./utils/pageAddressData');
const { runInSession, addStripId, buildDisplayName } = require('./utils/sessionLog');
const { vaultLog } = require('./vault-log');

const IMAGE_SERVER_BASE_URL = process.env.IMAGE_SERVER_BASE_URL || '';
const USER_API_BASE_URL = process.env.USER_API_BASE_URL || '';

function todayInManila() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Manila' });
}

async function persistTrackerLog(userId, note) {
  if (!userId || !note) return;
  if (!USER_API_BASE_URL) {
    console.warn('  [trackerLog] USER_API_BASE_URL not set — skipping tracker log POST.');
    return;
  }
  const today = todayInManila();
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

function formatElapsed(ms) {
  const sec = ms / 1000;
  if (sec < 60) return `${sec.toFixed(1)}s`;
  const min = Math.floor(sec / 60);
  const remSec = Math.round(sec % 60);
  return `${min}m ${remSec}s`;
}

/**
 * Build the tracker-log note body.
 * On success: "SUCCESS (8m 44s)\n1. <chain>\n2. <chain>..."
 * On failure: "FAIL at <type> (1m 27s): <message>\n1. <completed chain>..."
 * Elapsed is omitted if elapsedMs is falsy.
 */
function buildTrackerNote(completed, failure, elapsedMs) {
  const lines = [];
  const elapsed = elapsedMs ? ` (${formatElapsed(elapsedMs)})` : '';
  if (failure) {
    const where = failure.step?.type ? ` at ${failure.step.type}` : '';
    const msg = failure.error?.message || String(failure.error || 'unknown error');
    lines.push(`FAIL${where}${elapsed}: ${msg}`);
  } else {
    lines.push(`SUCCESS${elapsed}`);
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
  const filenames = linkedAssets.map((asset) => getAssetFilename(asset)).filter(Boolean);

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
  connect_loop: require('./actions/connect_loop'),
  accept_loop: require('./actions/accept_loop'),
  outlook_login: require('./actions/outlook_login'),
  facebook_signup: require('./actions/facebook_signup'),
  facebook_login: require('./actions/facebook_login'),
  ensure_login: require('./actions/ensure_login'),
  wait: require('./actions/wait'),
};

const { isLoggedOut } = require('./actions/ensure_login');

const STEP_RETRY_ATTEMPTS = 3;
const RETRY_WAIT_MS = 60000;

async function runWithRetry(fn, profileId, stepType, page) {
  let lastError;

  for (let attempt = 1; attempt <= STEP_RETRY_ATTEMPTS; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;

      // Checkpoint detection — FB has flagged this profile (login challenge,
      // ID verification, etc.). Retrying won't help and burns cooldown time.
      // Mark the error so runBrowser can short-circuit the whole task.
      const url = page ? safePageUrl(page) : '';
      if (url.includes('checkpoint')) {
        // Soft "we suspect automated behavior" modal? Dismiss and let the
        // retry continue on the (now clean) page. Only escalate to a hard
        // checkpoint abort if Dismiss isn't there.
        const dismissed = await tryDismissSoftCheckpoint(page);
        if (!dismissed) {
          console.warn(`CHECKPOINT detected on ${stepType} (url=${url}) — aborting profile`);
          err.checkpoint = true;
          err.noRetry = true;
          break;
        }
        console.log(`Soft checkpoint dismissed during ${stepType} — letting retry continue`);
      }

      // Handlers can set err.noRetry = true to opt out of step-level retry
      // (e.g. create_page, which handles its own retries internally — a
      // whole-handler restart would spawn a duplicate Page on FB).
      if (err && err.noRetry) {
        console.warn(`${stepType} threw noRetry error — skipping runner retry: ${err.message}`);
        break;
      }

      if (attempt >= STEP_RETRY_ATTEMPTS) break;

      console.warn(
        `Error on ${stepType} (attempt ${attempt}/${STEP_RETRY_ATTEMPTS}): ${err.message}`
      );
      console.warn(`Retrying in ${RETRY_WAIT_MS / 1000}s...`);
      await new Promise((resolve) => setTimeout(resolve, RETRY_WAIT_MS));
    }
  }

  throw lastError;
}

function safePageUrl(page) {
  try {
    return page.url();
  } catch (_) {
    return '';
  }
}

/**
 * Some "checkpoint" URLs are soft warnings — FB shows a modal saying
 * "We suspect automated behavior on your account" with a Dismiss button.
 * The account is NOT actually challenged; the modal is informational and
 * the page underneath is functional. Click Dismiss and the URL clears.
 *
 * Returns true if a soft modal was found and dismissed, false otherwise.
 * Requires both signals (the Dismiss button AND the warning text) so we
 * don't dismiss something unrelated.
 */
async function tryDismissSoftCheckpoint(page) {
  if (!page) return false;
  const { humanClick, humanWait } = require('./utils/humanBehavior');

  try {
    const dismissBtn = page.locator('div[aria-label="Dismiss"][role="button"]').first();
    const btnVisible = await dismissBtn.isVisible({ timeout: 2000 }).catch(() => false);
    if (!btnVisible) return false;

    const warningVisible = await page
      .getByText(/automated behavior/i)
      .first()
      .isVisible({ timeout: 1000 })
      .catch(() => false);
    if (!warningVisible) return false;

    const box = await dismissBtn.boundingBox();
    if (!box) return false;

    console.log('Soft checkpoint modal detected — clicking Dismiss');
    await humanClick(page, box);
    await humanWait(page, 1500, 2500);
    return true;
  } catch (err) {
    console.warn(`tryDismissSoftCheckpoint failed (non-fatal): ${err.message}`);
    return false;
  }
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
        profileUrl: user.profileUrl || '',
      };
    } else if (step.type === 'setup_about') {
      s.params = {
        ...(step.params || {}),
        userId: (step.params && step.params.userId) || user._id || user.id || '',
        profileUrl:
          step.params && typeof step.params.profileUrl === 'string'
            ? step.params.profileUrl
            : user.profileUrl || '',
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
        email:
          step.params?.email ||
          user.emails?.find((item) => item.selected)?.address ||
          user.emails?.[0]?.address ||
          '',
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

    if (step.type === 'connect_loop' && !(step.params && step.params.userId)) {
      s.params = {
        ...(step.params || {}),
        userId: user._id || user.id || '',
      };
    }

    if (step.type === 'accept_loop' && !(step.params && step.params.userId)) {
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

    if (
      (step.type === 'share_posts' || step.type === 'share_post') &&
      !(step.params && step.params.userIdentity)
    ) {
      s.params = {
        ...(step.params || {}),
        userIdentity: user.identityPrompt || '',
      };
    }

    if (step.type === 'outlook_login') {
      const selectedEmail =
        user.emails?.find((e) => e.selected)?.address || user.emails?.[0]?.address || '';
      s.params = {
        ...(step.params || {}),
        email: step.params?.email || selectedEmail,
        password: step.params?.password || user.emailPassword || '',
      };
    }

    if (step.type === 'facebook_signup') {
      const selectedEmail =
        user.emails?.find((e) => e.selected)?.address || user.emails?.[0]?.address || '';
      s.params = {
        ...(step.params || {}),
        userId: step.params?.userId || user._id || user.id || '',
        firstName: step.params?.firstName || user.firstName || '',
        lastName: step.params?.lastName || user.lastName || '',
        birthdayDate:
          step.params?.birthdayDate || user.birthdayDate || user.dob || '',
        gender: step.params?.gender || user.gender || '',
        email: step.params?.email || selectedEmail,
        password: step.params?.password || user.facebookPassword || '',
      };
    }

    if (step.type === 'facebook_login') {
      const selectedEmail =
        user.emails?.find((e) => e.selected)?.address || user.emails?.[0]?.address || '';
      s.params = {
        ...(step.params || {}),
        email: step.params?.email || selectedEmail,
        password: step.params?.password || user.facebookPassword || '',
      };
    }

    if (step.type === 'ensure_login') {
      const selectedEmail =
        user.emails?.find((e) => e.selected)?.address || user.emails?.[0]?.address || '';
      s.params = {
        ...(step.params || {}),
        firstName: step.params?.firstName || user.firstName || '',
        lastName: step.params?.lastName || user.lastName || '',
        birthdayDate:
          step.params?.birthdayDate || user.birthdayDate || user.dob || '',
        gender: step.params?.gender || user.gender || '',
        email: step.params?.email || selectedEmail,
        password: step.params?.password || user.facebookPassword || '',
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
async function runRandomPreset(page, step, profileId, user, vaultState) {
  const pool = (step.params && step.params.from) || Object.keys(presets);
  const validKeys = pool.filter((k) => presets[k]);

  if (!validKeys.length) throw new Error('random_preset: no valid presets available');

  const key = validKeys[Math.floor(Math.random() * validKeys.length)];
  const preset = presets[key];

  console.log(`random_preset → "${key}" (${preset.description || ''})`);

  const presetSteps = user ? injectUserParams(preset.steps, user) : preset.steps;

  for (const presetStep of presetSteps) {
    await runStep(page, presetStep, profileId, user, vaultState);
  }
}

function emitVaultStepStart(vaultState, step, path) {
  if (!vaultState) return;
  vaultLog.browser(
    {
      browserId: vaultState.browserId,
      profileId: vaultState.profileId,
      profileName: vaultState.profileName,
      online: true,
      currentStepPath: path.join(' › '),
    },
    [`Starting: ${step.type}`]
  );
}

/**
 * Execute a single step and recurse into child steps.
 */
async function runStep(page, step, profileId, user, vaultState) {
  if (step.type === 'random_preset') {
    await runRandomPreset(page, step, profileId, user, vaultState);
    return;
  }

  // Step-level skip probability. `"chance": 0.6` = run 60% of the time, skip
  // 40%. Applies to any step type. A skipped step also skips its nested
  // `steps[]` subtree — the whole branch is "did nothing" for this session.
  // Lets a single tasks.json look different on every run.
  if (typeof step.chance === 'number' && step.chance < 1) {
    if (Math.random() >= step.chance) {
      console.log(`Skipping: ${step.type} (chance=${step.chance})`);
      if (vaultState) {
        vaultLog.browser(
          { browserId: vaultState.browserId },
          [`Skipped: ${step.type} (chance=${step.chance})`]
        );
      }
      return;
    }
  }

  const handler = handlers[step.type];
  if (!handler) throw new Error(`Unknown step type: ${step.type}`);

  console.log(`Starting: ${step.type}`);

  const nextPath = vaultState ? [...vaultState.path, step.type] : null;
  emitVaultStepStart(vaultState, step, nextPath || [step.type]);

  await runWithRetry(() => handler(page, step.params || {}), profileId, step.type, page);

  // Post-action checkpoint sweep. runWithRetry already short-circuits when a
  // step throws on a checkpoint URL, but FB can also silently redirect
  // mid-action without the handler throwing — e.g. a like_posts that
  // completes its clicks while the next navigation lands on /checkpoint/.
  // Catch that here so the next step doesn't run on the challenge page.
  const urlAfter = safePageUrl(page);
  if (urlAfter && urlAfter.includes('checkpoint')) {
    // Soft modal first — if dismissed, we continue normally. Only a true
    // (non-dismissable) checkpoint should abort the profile.
    const dismissed = await tryDismissSoftCheckpoint(page);
    if (!dismissed) {
      const cpErr = new Error(`Checkpoint detected after ${step.type} (url=${urlAfter})`);
      cpErr.checkpoint = true;
      cpErr.noRetry = true;
      throw cpErr;
    }
  }

  console.log(`Completed: ${step.type}`);

  if (vaultState) {
    vaultLog.browser({ browserId: vaultState.browserId }, [`Completed: ${step.type}`]);
  }

  if (step.steps && step.steps.length > 0) {
    const childState = vaultState ? { ...vaultState, path: nextPath } : null;
    for (const childStep of step.steps) {
      const betweenMs = 5000 + Math.random() * 10000;
      console.log(`Waiting ${(betweenMs / 1000).toFixed(1)}s before next step...`);
      await new Promise((r) => setTimeout(r, betweenMs));
      await runStep(page, childStep, profileId, user, childState);
    }
  }
}

/**
 * Execute all steps for a single browser session.
 */
async function runBrowser(session, steps, options = {}) {
  const { page, profileId, user } = session;
  const { browserId, profileName } = options;
  const browserStartedAt = Date.now();
  const vaultState = browserId
    ? { browserId, profileId, profileName: profileName || profileId, path: [] }
    : null;

  if (vaultState) {
    vaultLog.browser(
      {
        browserId,
        profileId,
        profileName: vaultState.profileName,
        online: true,
        currentStepPath: '',
      },
      ['browser:online']
    );
  }

  page.setDefaultNavigationTimeout(90000);
  page.setDefaultTimeout(60000);

  // Close any extra tabs the profile launched with (welcome page, last-session
  // restores, etc.) so the session starts on a single clean tab.
  try {
    const ctx = page.context();
    const others = ctx.pages().filter((p) => p !== page);
    for (const p of others) await p.close().catch(() => {});
    if (others.length) {
      console.log(`Closed ${others.length} extra tab(s) on open`);
    }
  } catch (err) {
    console.warn(`Open-time tab cleanup failed (non-fatal): ${err.message}`);
  }

  if (options.blockMedia !== false) {
    const BLOCKED_TYPES = new Set(['image', 'media', 'font']);
    console.log(`Media blocking: ON`);
    await page.route('**/*', (route) => {
      if (BLOCKED_TYPES.has(route.request().resourceType())) {
        route.abort();
      } else {
        route.continue();
      }
    });
  } else {
    console.log(`Media blocking: OFF`);
  }

  const currentUrl = page.url();
  if (!currentUrl.includes('facebook.com')) {
    console.log(`Not on Facebook — navigating to homepage first...`);
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
    // Auto re-login: detect logged-out state and re-auth before any task step
    // runs on a guest session. Detection uses three signals (URL / password
    // field / profile probe via user.profileUrl). Re-auth navigates to
    // /reg/?entry_point=login&next= and re-runs the signup form fill — same
    // success signal as a fresh signup (home href visible). Treated as a
    // synthetic step so failures land in the tracker log + per-profile FAIL.
    try {
      const probeUrl = user?.profileUrl || '';
      if (await isLoggedOut(page, { profileProbeUrl: probeUrl })) {
        console.log(`[${profileId}] Session is logged out — attempting re-login via signup...`);
        const selectedEmail =
          user?.emails?.find((e) => e.selected)?.address || user?.emails?.[0]?.address || '';
        const reloginParams = {
          firstName: user?.firstName || '',
          lastName: user?.lastName || '',
          birthdayDate: user?.birthdayDate || user?.dob || '',
          gender: user?.gender || '',
          email: selectedEmail,
          password: user?.facebookPassword || '',
        };
        const missing = Object.entries(reloginParams)
          .filter(([_, v]) => !v)
          .map(([k]) => k);
        if (missing.length) {
          const err = new Error(`missing signup fields on user record: ${missing.join(', ')}`);
          err.noRetry = true;
          throw err;
        }
        await handlers.ensure_login(page, reloginParams);
        console.log(`[${profileId}] Re-login succeeded.`);
        completed.push('ensure_login (auto)');
      }
    } catch (err) {
      err.noRetry = true;
      failure = { step: { type: 'ensure_login' }, error: err };
      if (vaultState) {
        vaultLog.browser({ browserId: vaultState.browserId }, [
          { level: 'error', msg: `Auto re-login failed: ${err.message}` },
        ]);
      }
      throw err;
    }

    for (let i = 0; i < injectedSteps.length; i++) {
      if (i > 0) {
        const betweenMs = 5000 + Math.random() * 10000;
        console.log(`Waiting ${(betweenMs / 1000).toFixed(1)}s before next step...`);
        await new Promise((r) => setTimeout(r, betweenMs));
      }
      const step = injectedSteps[i];
      try {
        await runStep(page, step, profileId, user, vaultState);
        completed.push(describeStepChain(step));
      } catch (err) {
        failure = { step, error: err };
        if (vaultState) {
          const msg =
            err && err.checkpoint
              ? `Checkpoint hit during ${step.type} — aborting profile`
              : `Step ${step.type} failed: ${err.message}`;
          vaultLog.browser({ browserId: vaultState.browserId }, [{ level: 'error', msg }]);
        }
        if (err && err.checkpoint) {
          console.warn(
            `Checkpoint hit during ${step.type} — skipping remaining steps for this profile`
          );

          // Flag the user record so it's surfaced for manual review and won't
          // get picked up by another task run blind. Best-effort — PATCH
          // errors are logged but don't block the abort.
          const userId = user?._id || user?.id || '';
          if (userId) {
            try {
              await updateProfile(userId, { status: 'Need Checking' });
              console.log(`Profile ${userId} status -> "Need Checking"`);
            } catch (patchErr) {
              console.warn(
                `Failed to PATCH status "Need Checking" for ${userId}: ${patchErr.message}`
              );
            }
          }
        }
        throw err;
      }
    }
  } finally {
    const userId = user?._id || user?.id || '';
    const elapsedMs = Date.now() - browserStartedAt;
    const note = buildTrackerNote(completed, failure, elapsedMs);
    await persistTrackerLog(userId, note);

    // Per log.md "Ending a profile" — final /browser MUST fire on both success
    // and failure paths, with currentStepPath: "done" and online: false. Lives
    // in finally so a thrown step still produces the offline ping.
    if (vaultState) {
      const endLogs = failure
        ? ['profile failed', 'browser:offline']
        : ['profile complete', 'browser:offline'];
      vaultLog.browser(
        { browserId: vaultState.browserId, online: false, currentStepPath: 'done' },
        endLogs
      );
    }
  }

  // Leave the browser on a single blank tab before close
  try {
    const context = page.context();
    const blank = await context.newPage();
    await blank.goto('about:blank').catch(() => {});
    for (const p of context.pages()) {
      if (p !== blank) await p.close().catch(() => {});
    }
    console.log(`Closed all tabs except one blank tab`);
  } catch (err) {
    console.warn(`Tab cleanup failed (non-fatal): ${err.message}`);
  }

  const doneMs = 10000 + Math.random() * 5000;
  console.log(`Task done — cooling down ${(doneMs / 1000).toFixed(1)}s...`);
  await new Promise((r) => setTimeout(r, doneMs));

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
  const startedAtMs = Date.now();

  console.log(
    `\n=== Task ${taskId}: ${userIds.length} profile(s), concurrency: ${limit}, blockMedia: ${options.blockMedia} ===\n`
  );

  vaultLog.task({
    taskId,
    concurrency: limit,
    blockMedia: options.blockMedia,
    profiles: userIds,
    steps,
  });

  const provider = process.env.BROWSER_PROVIDER || 'hidemium';
  const results = new Array(userIds.length);
  const timingsMs = new Array(userIds.length).fill(0);
  const queue = [...userIds.entries()];

  async function worker(slotIndex) {
    const browserId = `${provider}-${slotIndex}`;

    while (queue.length > 0) {
      const [index, userId] = queue.shift();
      const profileStartedAt = Date.now();

      let userPreview = null;
      try {
        userPreview = await fetchUser(userId);
      } catch (err) {
        console.warn(`[${userId}] Pre-fetch user failed (will fall back to userId): ${err.message}`);
      }
      const displayName = buildDisplayName(userPreview, userId);

      await runInSession({ displayName, browserId, idsToStrip: [userId] }, async () => {
        let session;
        try {
          const browserInfos = await launchBrowsers([userId]);
          session = { ...browserInfos[0], steps };
        } catch (err) {
          console.error(`Failed to open browser:`, err.message);
          results[index] = { status: 'rejected', reason: err };
          vaultLog.browser(
            {
              browserId,
              profileId: userId,
              profileName: displayName,
              online: false,
              currentStepPath: 'done',
            },
            [
              { level: 'error', msg: `Failed to open browser: ${err.message}` },
              'browser:offline',
            ]
          );
          vaultLog.done(userId);
          return;
        }

        addStripId(session.profileId);

        results[index] = await Promise.allSettled([
          runBrowser(session, session.steps, {
            ...options,
            browserId,
            profileName: displayName,
          }),
        ]).then((r) => r[0]);

        vaultLog.done(session.profileId || userId);

        await closeBrowsers([session]);
      });

      timingsMs[index] = Date.now() - profileStartedAt;
    }
  }

  const workers = Array.from({ length: limit }, (_, i) => worker(i + 1));
  await Promise.all(workers);

  // profileId in results = user record _id (the value from tasks.json
  // `profiles[]`), NOT the underlying browser UUID. Callers and downstream
  // dashboards key off the user id; the browser id is an implementation
  // detail of the provider.
  const formattedResults = results.map((result, index) => {
    const userId = userIds[index];
    const elapsedSec = Number((timingsMs[index] / 1000).toFixed(1));
    if (result?.status === 'fulfilled') {
      return { profileId: userId, status: 'success', elapsedSec };
    } else {
      const msg = result?.reason?.message || 'unknown error';
      console.error(`[${userId}] Error:`, msg);
      return { profileId: userId, status: 'error', error: msg, elapsedSec };
    }
  });

  const successCount = formattedResults.filter((r) => r.status === 'success').length;
  const errorCount = formattedResults.length - successCount;
  const totalElapsedSec = ((Date.now() - startedAtMs) / 1000).toFixed(1);

  const perProfileMs = timingsMs.filter((ms) => ms > 0);
  const avgSec = perProfileMs.length
    ? (perProfileMs.reduce((a, b) => a + b, 0) / perProfileMs.length / 1000).toFixed(1)
    : '0.0';
  const minSec = perProfileMs.length ? (Math.min(...perProfileMs) / 1000).toFixed(1) : '0.0';
  const maxSec = perProfileMs.length ? (Math.max(...perProfileMs) / 1000).toFixed(1) : '0.0';

  console.log(`\n=== Task ${taskId}: Completed ===`);
  console.log(`  Profiles:    ${formattedResults.length}`);
  console.log(`  Succeeded:   ${successCount}`);
  console.log(`  Failed:      ${errorCount}`);
  console.log(`  Total time:  ${totalElapsedSec}s`);
  console.log(`  Per profile: avg ${avgSec}s, min ${minSec}s, max ${maxSec}s`);

  if (errorCount > 0) {
    console.log('\n  Failures:');
    formattedResults
      .filter((r) => r.status === 'error')
      .forEach((r) => console.log(`    - ${r.profileId} (${r.elapsedSec}s): ${r.error}`));
  }
  console.log();

  return { taskId, results: formattedResults };
}

module.exports = { runTask, runStep };
