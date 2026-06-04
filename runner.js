/**
 * Recursive step runner - core execution engine.
 * Walks the step tree and executes handlers.
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { launchBrowsers, closeBrowsers } = require('./utils/browserManager');
const { fetchUser, updateProfile, fetchProfilesByStatus } = require('./utils/userApi');
const presets = require('./config/presets.json');
const { buildPageAddress } = require('./utils/pageAddressData');
const {
  runInSession,
  addStripId,
  buildDisplayName,
  buildProfileFolderName,
  getProfileLogDir,
} = require('./utils/sessionLog');
const { initRunLogDir } = require('./utils/runLogDir');
const { loadState, saveState, clearState } = require('./utils/taskState');
const { tryRecover, recoverUntilReady } = require('./utils/recoverers');
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
 *   failure       — abort-level failure (checkpoint / credentials rejected /
 *                   pre-flight / ensure_login). Whole session aborted.
 *   softFailures  — non-fatal step failures the runner continued past.
 *
 * Header: FAIL > PARTIAL > SUCCESS (abort wins). Completed chains listed,
 * then per-step soft-failure messages so triage can see what got skipped.
 */
function buildTrackerNote(completed, { failure, softFailures = [] } = {}, elapsedMs) {
  const lines = [];
  const elapsed = elapsedMs ? ` (${formatElapsed(elapsedMs)})` : '';
  if (failure) {
    // Prefer the actual failing step (err.stepType, set by runWithRetry) over
    // the top-level step.type so "FAIL at open_search_result" isn't mislabeled
    // "FAIL at search" when a child step is the one that failed.
    const failedType = failure.error?.stepType || failure.step?.type;
    const where = failedType ? ` at ${failedType}` : '';
    const msg = failure.error?.message || String(failure.error || 'unknown error');
    lines.push(`FAIL${where}${elapsed}: ${msg}`);
  } else if (softFailures.length > 0) {
    lines.push(`PARTIAL (${softFailures.length} failed)${elapsed}`);
  } else {
    lines.push(`SUCCESS${elapsed}`);
  }
  completed.forEach((chain, i) => lines.push(`${i + 1}. ${chain}`));
  if (softFailures.length > 0) {
    lines.push('');
    lines.push('Failed steps:');
    softFailures.forEach(({ step, error }) => {
      const msg = error?.message || String(error || 'unknown error');
      lines.push(`- ${step?.type || 'unknown'}: ${msg}`);
    });
  }
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
  publish_post: require('./actions/publish_post'),
  check_ip: require('./actions/check_ip'),
  search: require('./actions/search'),
  open_search_result: require('./actions/open_search_result'),
  follow: require('./actions/follow'),
  connect: require('./actions/connect'),
  connect_loop: require('./actions/connect_loop'),
  accept_loop: require('./actions/accept_loop'),
  outlook_login: require('./actions/outlook_login'),
  setup_privacy: require('./actions/setup_privacy'),
  facebook_signup: require('./actions/facebook_signup'),
  facebook_login: require('./actions/facebook_login'),
  ensure_login: require('./actions/ensure_login'),
  marketplace_location: require('./actions/marketplace_location'),
  wait: require('./actions/wait'),
};

const { isLoggedOut } = require('./actions/ensure_login');

// Step types that do NOT require an authenticated Facebook session. If the
// entire task tree is made of these, the runner skips its auto re-login —
// otherwise an outlook_login / check_ip / wait-only task would be hijacked
// by the FB signup form. `random_preset` is excluded conservatively: presets
// can contain FB steps, so we treat them as needing an FB session.
const NON_FB_STEP_TYPES = new Set(['outlook_login', 'check_ip', 'wait']);

function taskNeedsFacebookSession(steps) {
  if (!Array.isArray(steps)) return true;
  for (const step of steps) {
    if (!step || !step.type) continue;
    if (!NON_FB_STEP_TYPES.has(step.type)) return true;
    if (step.steps && taskNeedsFacebookSession(step.steps)) return true;
  }
  return false;
}

const STEP_RETRY_ATTEMPTS = 3;
const RETRY_WAIT_MS = 60000;

async function runWithRetry(fn, profileId, stepType, page) {
  let lastError;

  for (let attempt = 1; attempt <= STEP_RETRY_ATTEMPTS; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;

      // Stamp the ACTUAL failing step type onto the error (once, by the
      // innermost runWithRetry — closest to the throw). When a child step fails
      // (e.g. open_search_result under search), the error propagates up to
      // runBrowser whose `step` is the top-level parent; without this, the log
      // would mislabel it "Step search failed" instead of naming the real
      // child. Consumers prefer err.stepType over the top-level step.type.
      if (err && !err.stepType) err.stepType = stepType;

      // NOTE: forensic dumping happens at the END of this function (terminal
      // failure), NOT here on the first throw. We used to dump eagerly on every
      // attempt, but that (a) left misleading fail-*.html/png dumps for errors
      // that tryRecover then FIXED (e.g. a consent page cleared by the cookie
      // recoverer, after which the retry succeeded — the folder ends up SUCCESS
      // yet full of fail-* files), and (b) wrote one ~4MB dump PER attempt for a
      // genuine 3-attempt failure. Now we recover first and dump once, only if
      // the step actually fails. See the dump before `throw lastError` below.

      // Browser-dead detection. Playwright surfaces "Target page, context or
      // browser has been closed" when the underlying chromium / CDP socket
      // is gone (MLX session timeout, native crash, navigation crashed the
      // page). Every subsequent step in this profile would burn 3×60s on
      // the same error before soft-failing — short-circuit instead. Marked
      // as noRetry so runWithRetry breaks out, AND as browserDead so
      // runBrowser's catch can abort the whole profile's remaining steps.
      if (err && /Target page, context or browser has been closed/i.test(err.message || '')) {
        console.warn(
          `BROWSER DEAD detected on ${stepType} — aborting profile (no point retrying on a closed session)`
        );
        err.browserDead = true;
        err.noRetry = true;
        break;
      }

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
          await dumpCheckpointState(page, `step-${stepType}`);
          console.warn(`CHECKPOINT detected on ${stepType} (url=${url}) — aborting profile`);
          err.checkpoint = true;
          err.noRetry = true;
          err.dumped = true; // checkpoint-*.{html,png} already written — skip terminal dump
          break;
        }
        console.log(`Soft checkpoint dismissed during ${stepType} — letting retry continue`);
      }

      // Email-confirmation gate — FB parked the session on confirmemail.php
      // (account exists but FB wants an emailed code we don't enter). Retrying
      // any step just times out on a page that will never render. Abort + flag
      // for manual review, same as a checkpoint.
      if (isConfirmEmailUrl(url)) {
        console.warn(
          `CONFIRMEMAIL gate detected on ${stepType} (url=${url}) — aborting profile`
        );
        err.needChecking = true;
        err.noRetry = true;
        break;
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

      // Recovery chain — walk the registry, try to fix whatever common FB
      // page state is blocking us (EU cookie consent, soft checkpoint, etc.).
      // Three possible outcomes:
      //   recovered → page is usable, shrink retry wait from 60s to 2s
      //   unfixable → URL is a known dead-end (e.g. ad-free consent flow
      //               we don't yet handle). Skip remaining retries — burning
      //               them only burns time. Step soft-fails immediately.
      //   neither   → no recoverer matched; do the normal 60s wait + retry
      const recovery = await tryRecover(page, { stepType });
      if (recovery.unfixable) {
        console.warn(
          `Step ${stepType} blocked by "${recovery.unfixable}" — skipping remaining ${STEP_RETRY_ATTEMPTS - attempt} attempt(s)`
        );
        err.noRetry = true;
        break;
      }
      const waitMs = recovery.recovered ? 2000 : RETRY_WAIT_MS;
      if (recovery.recovered) {
        console.log(`Recovered via "${recovery.recovered}" — retrying in ${waitMs / 1000}s`);
      } else {
        console.warn(`Retrying in ${waitMs / 1000}s...`);
      }
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }

  // Terminal failure — every path that reaches here has given up (exhausted
  // attempts, noRetry, unfixable, browser-dead, hard checkpoint). NOW we know
  // it's a real failure (not something recovery fixed), so dump the broken page
  // state ONCE. `err.dumped` skips paths that already wrote their own forensics
  // (checkpoint → checkpoint-*.{html,png}).
  if (lastError && !lastError.dumped && page) {
    await dumpStepFailure(page, stepType, lastError);
    lastError.dumped = true;
  }

  throw lastError;
}

/**
 * Generic step-failure dump. Captures HTML + full-page screenshot to the
 * per-profile run-scoped folder so every failure has forensics. Called from
 * runWithRetry's catch on the FIRST throw (before tryRecover mutates the
 * page) so the dump is the actual broken state, not a post-recovery view.
 *
 * `attempt` (optional) is folded into the filename so concurrent retries on
 * the same step don't overwrite each other — though in practice only the
 * first attempt dumps (err.dumped flag).
 *
 * Best-effort — swallows its own errors. Caller throws regardless.
 */
async function dumpStepFailure(page, stepType, err, attempt) {
  try {
    if (!page) return;
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const safeStep = String(stepType || 'step').replace(/[^a-z0-9_-]+/gi, '_');

    const profileDir = getProfileLogDir();
    const targetDir = profileDir || path.join(process.cwd(), 'logs');
    try {
      if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
    } catch (_) {}

    const attemptTag = attempt ? `-attempt${attempt}` : '';
    const baseName = `fail-${safeStep}${attemptTag}-${ts}`;
    const htmlPath = path.join(targetDir, `${baseName}.html`);
    const pngPath = path.join(targetDir, `${baseName}.png`);

    let url = '(unknown)';
    try {
      url = page.url();
    } catch (_) {}

    const errMsg = (err && err.message) || String(err || 'unknown error');
    const header = `<!-- step: ${stepType} -->\n<!-- attempt: ${attempt || '?'} -->\n<!-- url: ${url} -->\n<!-- error: ${errMsg.replace(/-->/g, '--&gt;')} -->\n`;

    try {
      const html = await page.content();
      fs.writeFileSync(htmlPath, header + html, 'utf8');
      console.warn(`  [fail] dumped HTML → ${htmlPath}`);
    } catch (e) {
      console.warn(`  [fail] HTML dump failed: ${e.message}`);
    }

    try {
      await page.screenshot({ path: pngPath, fullPage: true });
      console.warn(`  [fail] dumped screenshot → ${pngPath}`);
    } catch (e) {
      console.warn(`  [fail] screenshot failed: ${e.message}`);
    }
  } catch (e) {
    console.warn(`  [fail] dumpStepFailure swallowed: ${e.message}`);
  }
}

function safePageUrl(page) {
  try {
    return page.url();
  } catch (_) {
    return '';
  }
}

/**
 * Detect FB's email-confirmation gate. After a signup OR a risk flag on an
 * existing session, FB parks the page on confirmemail.php demanding a code
 * emailed to the account. We don't enter that code, so every subsequent step
 * just times out against a page that never renders the expected UI (an
 * already-logged-in profile redirected here will FAIL setup_privacy, search,
 * setup_cover, … one after another, each burning its full retry budget).
 *
 * Treated exactly like a checkpoint: abort the profile and flag it
 * `status: "Need Checking"` for manual review. Detected in the same three
 * places as checkpoint — pre-flight, in-retry step error, post-step sweep —
 * via `err.needChecking`, which runBrowser's catch already handles
 * (`facebook_signup` sets the same flag when it hits confirmemail mid-signup).
 */
function isConfirmEmailUrl(url) {
  return !!url && url.includes('confirmemail.php');
}

/**
 * Page-readiness gate — run BEFORE every step. If the page is parked on a
 * consent funnel (EU cookie / ad-free / GDPR data-settings), clear it FIRST so
 * the step doesn't run on a blocked page. Steps that don't touch the page would
 * otherwise "succeed" on top of the consent screen, and page-touching steps
 * would each burn their full 3×retry budget — the consent page is fixed once,
 * up front, not rediscovered per step.
 *
 * recoverUntilReady loops the recovery chain until the page is clean (handles
 * FB's chained cookie→ad_free→3pd funnels in one gate). If it can't clear the
 * page, we dump the blocked HTML (so an unhandled consent variant can be turned
 * into a new recoverer) and throw err.pageBlocked — runBrowser treats that as
 * an abort: skip remaining steps, FAIL tracker note, NO Need-Checking PATCH
 * (a stuck consent funnel is a recovery gap on our side, not a flagged account;
 * it re-runs cleanly next cycle).
 *
 * Checkpoints are NOT handled here — they keep their dedicated pre-flight /
 * in-retry / post-step detection + Need-Checking PATCH.
 */
async function ensurePageReady(page, vaultState) {
  // Email-confirmation gate first — it's STICKY (once FB gates an account on
  // confirmemail.php it stays gated for the session), so detecting it proactively
  // at the top of every step is strictly better than letting each step burn its
  // retry budget against a page that never renders. Unlike a consent funnel this
  // is NOT recoverable on our side (we don't enter the emailed code), so we flag
  // the profile Need Checking via err.needChecking — which runBrowser's catch
  // already handles — rather than err.pageBlocked. This is the proactive partner
  // to the in-retry + post-step + pre-flight confirmemail checks (mirroring the
  // sticky-checkpoint handling), guaranteeing detection even for tasks whose
  // first step navigates somewhere other than confirmemail.
  const url = safePageUrl(page);
  if (isConfirmEmailUrl(url)) {
    console.warn(`CONFIRMEMAIL gate detected before step (url=${url}) — aborting profile`);
    const ceErr = new Error(`Email confirmation gate (confirmemail.php) — manual review required`);
    ceErr.needChecking = true;
    ceErr.noRetry = true;
    if (vaultState) {
      vaultLog.browser({ browserId: vaultState.browserId }, [
        { level: 'error', msg: `Email confirmation gate (confirmemail.php) — aborting profile` },
      ]);
    }
    throw ceErr;
  }

  const { ready, reason } = await recoverUntilReady(page, {});
  if (ready) return;

  const err = new Error(`Page blocked by consent flow (${reason}) — cannot continue`);
  err.pageBlocked = true;
  err.noRetry = true;

  if (!err.dumped) {
    await dumpStepFailure(page, 'consent-blocked', err);
    err.dumped = true;
  }
  if (vaultState) {
    vaultLog.browser({ browserId: vaultState.browserId }, [
      { level: 'error', msg: `Page blocked (${reason}) — aborting profile` },
    ]);
  }
  throw err;
}

/**
 * Rename the per-profile log folder after the session ends so scanning the
 * `profiles/` dir at a glance shows which ones passed and which didn't:
 *
 *   profiles/SUCCESS - Marco Rossi - 6a020462/
 *   profiles/FAIL - Anna Bianchi - 6a02943a/
 *
 * Best-effort — swallows errors so a Windows file-lock or already-renamed
 * collision can never break the run. The original folder name format is
 * `{Name}-{shortId}` from buildProfileFolderName; we expand to spaces and
 * prefix the status.
 */
function renameProfileFolderWithStatus({ runLogDir, displayName, userId, status }) {
  try {
    if (!runLogDir || !displayName) return;
    const oldName = buildProfileFolderName(displayName, userId);
    const oldPath = path.join(runLogDir, 'profiles', oldName);
    if (!fs.existsSync(oldPath)) return;

    const safeName = String(displayName).replace(/[\\/:*?"<>|]/g, '_').trim() || 'unknown';
    const shortId = userId ? String(userId).slice(0, 8) : '';
    const newName =
      shortId && safeName !== String(userId)
        ? `${status} - ${safeName} - ${shortId}`
        : `${status} - ${safeName}`;
    const newPath = path.join(runLogDir, 'profiles', newName);
    if (oldPath === newPath) return;

    fs.renameSync(oldPath, newPath);
  } catch (err) {
    console.warn(`Failed to rename profile folder to "${status}": ${err.message}`);
  }
}

/**
 * Failure forensics for checkpoint detection — follows the dumpFailure
 * convention documented in CLAUDE.md ("Failure forensics — HTML + screenshot
 * dumps"). Writes the current page HTML + a full-page PNG so the actual
 * checkpoint variant can be inspected later (was it a real hard checkpoint
 * gating the account, or a soft modal variant we didn't recognize — different
 * button label, different warning text, different language?).
 *
 * Output path: when called inside a `runInSession` scope, drops into the
 * per-profile run-scoped folder (`logs/{taskId}-{ts}/profiles/{name}-{shortId}/`).
 * Falls back to flat `logs/` when no session is active.
 *
 * Best-effort — swallows its own errors so a dump failure can never mask the
 * underlying checkpoint throw. Caller MUST still throw after the dump returns.
 */
async function dumpCheckpointState(page, label) {
  try {
    if (!page) return;
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const safeLabel = String(label || 'checkpoint').replace(/[^a-z0-9_-]+/gi, '_');

    const profileDir = getProfileLogDir();
    const targetDir = profileDir || path.join(process.cwd(), 'logs');
    try {
      if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
    } catch (_) {}

    const baseName = `checkpoint-${safeLabel}-${ts}`;
    const htmlPath = path.join(targetDir, `${baseName}.html`);
    const pngPath = path.join(targetDir, `${baseName}.png`);

    let url = '(unknown)';
    try {
      url = page.url();
    } catch (_) {}

    try {
      const html = await page.content();
      fs.writeFileSync(htmlPath, `<!-- url: ${url} -->\n${html}`, 'utf8');
      console.warn(`  [checkpoint] dumped HTML → ${htmlPath}`);
    } catch (err) {
      console.warn(`  [checkpoint] HTML dump failed: ${err.message}`);
    }

    try {
      await page.screenshot({ path: pngPath, fullPage: true });
      console.warn(`  [checkpoint] dumped screenshot → ${pngPath}`);
    } catch (err) {
      console.warn(`  [checkpoint] screenshot failed: ${err.message}`);
    }
  } catch (err) {
    console.warn(`  [checkpoint] dumpCheckpointState swallowed: ${err.message}`);
  }
}

/**
 * Some "checkpoint" URLs are soft warnings — FB shows a modal with a Dismiss
 * button on top of an otherwise functional page. Click Dismiss and the URL
 * clears. Returns true if a Dismiss button was found and clicked, false
 * otherwise (caller treats false as a hard checkpoint).
 *
 * **Caller MUST have already confirmed the URL contains "checkpoint" before
 * calling.** That gate is what makes "any Dismiss button on this page" a
 * reliable signal of the soft variant. We deliberately do NOT gate on the
 * warning text — FB tweaks the wording, shows it in different languages, and
 * any Dismiss button on a /checkpoint/ URL IS the checkpoint dismiss button.
 *
 * Uses `waitFor({ state: 'visible' })`, not `isVisible({ timeout })`:
 * Playwright's `isVisible` reads the current visibility state and only
 * partially honors `timeout`, which is why the previous 2s probe was firing
 * before the modal mounted on slower checkpoint pages and returning false
 * even when the Dismiss button was about to appear.
 */
async function tryDismissSoftCheckpoint(page) {
  if (!page) return false;
  const { humanClick, humanWait } = require('./utils/humanBehavior');

  try {
    // Let the checkpoint page finish its redirect chain + modal mount before
    // probing. Already-loaded pages resolve immediately.
    await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {});

    const dismissBtn = page.locator('div[aria-label="Dismiss"][role="button"]').first();
    try {
      await dismissBtn.waitFor({ state: 'visible', timeout: 10000 });
    } catch (_) {
      return false; // genuinely not there — hard checkpoint
    }

    const box = await dismissBtn.boundingBox();
    if (!box) return false;

    console.log('Soft checkpoint modal detected — clicking Dismiss');
    await humanClick(page, box);
    await humanWait(page, 2000, 3500);
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

      if (!next.country) {
        next.country = user.country || '';
      }

      if (!next.userId) next.userId = user._id || user.id || '';

      s.params = next;
    }

    if (step.type === 'setup_cover') {
      const next = { ...(step.params || {}) };
      if (!next.photoUrl) {
        const img = user.images && user.images[1];
        if (img) next.photoUrl = `${IMAGE_SERVER_BASE_URL}${img.imageId.filename}`;
      }
      if (!next.userId) next.userId = user._id || user.id || '';
      s.params = next;
    }

    if (step.type === 'setup_privacy') {
      // Inject userId AND the current onboarding.privacyPublicAt stamp so the
      // action can short-circuit when this profile is already marked done.
      // Explicit params win for both — handy for testing the walkthrough on
      // an already-stamped account.
      s.params = {
        ...(step.params || {}),
        userId: step.params?.userId || user._id || user.id || '',
        privacyPublicAt:
          step.params?.privacyPublicAt !== undefined
            ? step.params.privacyPublicAt
            : user.onboarding?.privacyPublicAt || '',
      };
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
        // pageUrl is the duplicate-Page guard. When the user record already
        // has one, create_page's guard returns immediately. Pass the current
        // value (may be empty string) — explicit non-empty in step.params
        // overrides; explicit empty string forces re-creation.
        pageUrl:
          typeof step.params?.pageUrl === 'string' ? step.params.pageUrl : user.pageUrl || '',
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

    if (step.type === 'visit_profile') {
      s.params = {
        ...(step.params || {}),
        country: step.params?.country || user.country || '',
      };
    }

    if (step.type === 'connect_loop') {
      s.params = {
        ...(step.params || {}),
        userId: step.params?.userId || user._id || user.id || '',
        country: step.params?.country || user.country || '',
      };
    }

    if (step.type === 'accept_loop' && !(step.params && step.params.userId)) {
      s.params = {
        ...(step.params || {}),
        userId: user._id || user.id || '',
      };
    }

    if (step.type === 'search') {
      s.params = {
        ...(step.params || {}),
        ...(!step.params?.city ? { city: user.city || '' } : {}),
        ...(!step.params?.country ? { country: user.country || '' } : {}),
      };
    }

    if (step.type === 'marketplace_location') {
      s.params = {
        ...(step.params || {}),
        ...(!step.params?.city ? { city: user.city || '' } : {}),
        ...(!step.params?.country ? { country: user.country || '' } : {}),
        ...(!step.params?.userId ? { userId: user._id || user.id || '' } : {}),
      };
    }

    if (step.type === 'share_posts' || step.type === 'share_post') {
      s.params = {
        ...(step.params || {}),
        ...(!step.params?.userIdentity ? { userIdentity: user.identityPrompt || '' } : {}),
        ...(!step.params?.userId ? { userId: user._id || user.id || '' } : {}),
      };
    }

    // publish_post: when imageUrls is missing, pick a random entry from
    // user.posts[] and use its images. We deliberately do NOT inject
    // pick.caption — captions are now AI-generated from userIdentity +
    // postContext via generatePostCaption (uses system_prompt_post.txt).
    // pick.context (a short description of what's in the images) is
    // injected as postContext so the model has something concrete to anchor
    // on; the 50-reasons fallback in the prompt handles vague/empty
    // contexts. Explicit params always win.
    //
    // user.posts[*].images entries are stored as `{ filename }` (sometimes
    // nested as `{ imageId: { filename } }`) — resolve through buildImageUrl
    // so they end up as full URLs the downloader can consume.
    if (step.type === 'publish_post') {
      const next = { ...(step.params || {}) };
      const userPosts = Array.isArray(user.posts) ? user.posts : [];
      const hasImages = Array.isArray(next.imageUrls) && next.imageUrls.length > 0;

      if (!hasImages && userPosts.length > 0) {
        const candidates = userPosts.filter(
          (p) => p && Array.isArray(p.images) && p.images.length > 0
        );
        if (candidates.length > 0) {
          const pick = candidates[Math.floor(Math.random() * candidates.length)];
          next.imageUrls = pick.images
            .map((img) => {
              if (typeof img === 'string') return buildImageUrl(img);
              if (!img) return '';
              return buildImageUrl(getAssetFilename(img));
            })
            .filter(Boolean);
          if (!next.postContext && typeof pick.context === 'string') {
            next.postContext = pick.context;
          }
          // Inject the picked entry's caption so captionSource="post" can use it.
          // captionSource="ai" (default) ignores this field.
          if (!next.postCaption && typeof pick.caption === 'string') {
            next.postCaption = pick.caption;
          }
        }
      }

      if (!next.userIdentity) next.userIdentity = user.identityPrompt || '';
      if (!next.userId) next.userId = user._id || user.id || '';
      s.params = next;
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
        birthdayDate: step.params?.birthdayDate || user.birthdayDate || user.dob || '',
        gender: step.params?.gender || user.gender || '',
        email: step.params?.email || selectedEmail,
        password: step.params?.password || user.facebookPassword || '',
        // Pass the current accountCreated value so the action knows whether
        // to stamp (empty → stamp on home-feed landing; non-empty → never
        // overwrite). String-or-explicit handling means an empty string in
        // step.params forces a re-stamp on this run only.
        accountCreated:
          typeof step.params?.accountCreated === 'string'
            ? step.params.accountCreated
            : user.accountCreated || '',
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
        userId: step.params?.userId || user._id || user.id || '',
        firstName: step.params?.firstName || user.firstName || '',
        lastName: step.params?.lastName || user.lastName || '',
        birthdayDate: step.params?.birthdayDate || user.birthdayDate || user.dob || '',
        gender: step.params?.gender || user.gender || '',
        email: step.params?.email || selectedEmail,
        password: step.params?.password || user.facebookPassword || '',
        accountCreated:
          typeof step.params?.accountCreated === 'string'
            ? step.params.accountCreated
            : user.accountCreated || '',
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
 * Evaluate per-step `guard` block against the user record. Runs BEFORE the
 * `chance` roll so an ineligible profile never wastes a probability slot.
 * Returns { pass, reason }.
 *
 * Supported guards (all optional, all must pass when set):
 *
 *   ifOnboardingMissing: "<key>"
 *     Skip when user.onboarding.<key> is truthy. Used to guard idempotent
 *     setup steps: ifOnboardingMissing="profileImageSetAt" means "only run
 *     setup_avatar if the avatar onboarding stamp is null".
 *
 *   ifFieldEmpty: "<top-level field>"
 *     Skip when user.<field> is truthy. Top-level only — does not look
 *     inside subdocuments. Used for things like ifFieldEmpty="pageUrl"
 *     to guard create_page on the user not yet having a Page.
 *
 *   minAccountAgeDays: N
 *     Skip when (now - user.accountCreated) < N days. Empty/invalid
 *     accountCreated is treated as "age unknown" → guard fails (safe
 *     default — don't run age-gated actions until we know the age).
 *     facebook_signup stamps accountCreated on home-feed landing so new
 *     signups get tracked; existing profiles need a backfill via
 *     `backfill-account-created.js`.
 */
function evaluateStepGuards(step, user) {
  const guard = step.guard;
  if (!guard || typeof guard !== 'object') return { pass: true };

  if (guard.ifOnboardingMissing) {
    const v = user?.onboarding?.[guard.ifOnboardingMissing];
    if (v) {
      return {
        pass: false,
        reason: `onboarding.${guard.ifOnboardingMissing} already stamped (${v})`,
      };
    }
  }

  if (guard.ifFieldEmpty) {
    const v = user?.[guard.ifFieldEmpty];
    if (v !== '' && v != null && !(Array.isArray(v) && v.length === 0)) {
      const shown = typeof v === 'string' ? v.slice(0, 60) : JSON.stringify(v).slice(0, 60);
      return { pass: false, reason: `${guard.ifFieldEmpty} is not empty (${shown})` };
    }
  }

  if (Number.isFinite(guard.minAccountAgeDays) && guard.minAccountAgeDays > 0) {
    const accountCreated = user?.accountCreated;
    if (!accountCreated || typeof accountCreated !== 'string' || !accountCreated.trim()) {
      return {
        pass: false,
        reason: `accountCreated empty (need >=${guard.minAccountAgeDays}d age)`,
      };
    }
    const created = new Date(accountCreated);
    if (Number.isNaN(created.getTime())) {
      return { pass: false, reason: `accountCreated invalid (${accountCreated})` };
    }
    const ageDays = (Date.now() - created.getTime()) / 86_400_000;
    if (ageDays < guard.minAccountAgeDays) {
      return {
        pass: false,
        reason: `account age ${ageDays.toFixed(1)}d < required ${guard.minAccountAgeDays}d`,
      };
    }
  }

  return { pass: true };
}

/**
 * Execute a single step and recurse into child steps.
 */
async function runStep(page, step, profileId, user, vaultState) {
  // Page-readiness gate — clear any consent funnel the page is parked on
  // BEFORE running this step (or its children). Throws err.pageBlocked if the
  // page can't be cleared, which runBrowser treats as an abort. Runs for every
  // step (top-level and nested) so a navigator child that triggers a consent
  // redirect can't leave the next child running on a blocked page.
  await ensurePageReady(page, vaultState);

  if (step.type === 'random_preset') {
    await runRandomPreset(page, step, profileId, user, vaultState);
    return;
  }

  // Per-step `guard` — onboarding-set / field-set / age-too-young checks.
  // Runs BEFORE the chance roll so an ineligible profile never wastes a
  // probability slot. Skipped guards also skip the nested steps[] subtree.
  const gate = evaluateStepGuards(step, user);
  if (!gate.pass) {
    console.log(`Skipping: ${step.type} (guard: ${gate.reason})`);
    if (vaultState) {
      vaultLog.browser({ browserId: vaultState.browserId }, [
        `Skipped: ${step.type} (guard: ${gate.reason})`,
      ]);
    }
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
        vaultLog.browser({ browserId: vaultState.browserId }, [
          `Skipped: ${step.type} (chance=${step.chance})`,
        ]);
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
      await dumpCheckpointState(page, `post-${step.type}`);
      const cpErr = new Error(`Checkpoint detected after ${step.type} (url=${urlAfter})`);
      cpErr.checkpoint = true;
      cpErr.noRetry = true;
      throw cpErr;
    }
  }

  // Post-action email-confirmation sweep. FB can redirect to confirmemail.php
  // mid-action without the handler throwing — catch it so the next step doesn't
  // run against a gate that never clears.
  if (isConfirmEmailUrl(urlAfter)) {
    const ceErr = new Error(`Email confirmation gate after ${step.type} (url=${urlAfter})`);
    ceErr.needChecking = true;
    ceErr.noRetry = true;
    throw ceErr;
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
  const softFailures = [];
  let failure = null;

  try {
    // Pre-flight checkpoint check. If FB has redirected the homepage to a
    // /checkpoint/ URL, the session is logged-in-but-flagged. Running any
    // step on that page (including isLoggedOut → ensure_login, which would
    // re-trigger the signup form on top of a flagged session) wastes time
    // at best and risks duplicate-account creation at worst. Detect early,
    // attempt the soft-modal dismiss, else short-circuit the profile with
    // the same "Need Checking" PATCH the post-step sweep uses.
    try {
      const preFlightUrl = safePageUrl(page);
      if (preFlightUrl.includes('checkpoint')) {
        const dismissed = await tryDismissSoftCheckpoint(page);
        if (!dismissed) {
          // Dump page state before throwing so we can inspect whether this
          // was a real hard checkpoint or a soft modal variant we didn't
          // recognize. Forensics only — must still throw.
          await dumpCheckpointState(page, 'preflight');
          const cpErr = new Error(`Checkpoint detected at pre-flight (url=${preFlightUrl})`);
          cpErr.checkpoint = true;
          cpErr.noRetry = true;
          throw cpErr;
        }
        console.log(`Soft checkpoint dismissed at pre-flight — continuing`);
      }

      // Pre-flight email-confirmation check — session opened directly on
      // confirmemail.php. Same abort + Need-Checking flag as a checkpoint.
      if (isConfirmEmailUrl(preFlightUrl)) {
        const ceErr = new Error(`Email confirmation gate at pre-flight (url=${preFlightUrl})`);
        ceErr.needChecking = true;
        ceErr.noRetry = true;
        throw ceErr;
      }
    } catch (err) {
      const preflightAbort = !!(err && (err.checkpoint || err.needChecking));
      failure = {
        step: {
          type: err && err.needChecking ? 'pre_flight_confirmemail' : 'pre_flight_checkpoint',
        },
        error: err,
      };
      if (vaultState) {
        const msg = err && err.checkpoint
          ? `Checkpoint hit at pre-flight — aborting profile`
          : err && err.needChecking
            ? `Email confirmation gate at pre-flight — aborting profile`
            : `Pre-flight check failed: ${err.message}`;
        vaultLog.browser({ browserId: vaultState.browserId }, [{ level: 'error', msg }]);
      }
      if (preflightAbort) {
        const why = err.checkpoint ? 'checkpoint' : 'confirmemail';
        console.warn(`Pre-flight abort (${why}) — skipping all steps for this profile`);
        const userId = user?._id || user?.id || '';
        if (userId) {
          try {
            await updateProfile(userId, { status: 'Need Checking' });
            console.log(`Profile ${userId} status -> "Need Checking" (${why})`);
          } catch (patchErr) {
            console.warn(
              `Failed to PATCH status "Need Checking" for ${userId}: ${patchErr.message}`
            );
          }
        }
      }
      throw err;
    }

    // Auto re-login: detect logged-out state and re-auth before any task step
    // runs on a guest session. Detection uses three signals (URL / password
    // field / profile probe via user.profileUrl). Re-auth navigates to
    // /reg/?entry_point=login&next= and re-runs the signup form fill — same
    // success signal as a fresh signup (home href visible). Treated as a
    // synthetic step so failures land in the tracker log + per-profile FAIL.
    //
    // Gate: only run when the task actually touches Facebook. An outlook_login
    // / check_ip / wait-only task does not need an FB session, and hijacking
    // it for a signup form burns minutes and overwrites the test scenario.
    try {
      if (!taskNeedsFacebookSession(injectedSteps)) {
        console.log(
          `[${profileId}] Skipping auto re-login — no step in this task requires a Facebook session.`
        );
      } else {
        const probeUrl = user?.profileUrl || '';
        if (
          await isLoggedOut(page, {
            profileProbeUrl: probeUrl,
            country: user?.country || '',
            excludeUserId: user?._id || user?.id || '',
          })
        ) {
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
          // userId + accountCreated are passed separately — they're allowed
          // to be empty (accountCreated empty means "stamp on success") so
          // they're excluded from the required-field check below.
          reloginParams.userId = user?._id || user?.id || '';
          reloginParams.accountCreated = user?.accountCreated || '';
          const missing = Object.entries(reloginParams)
            .filter(([k, v]) => !v && k !== 'accountCreated')
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
      }
    } catch (err) {
      err.noRetry = true;
      failure = { step: { type: 'ensure_login' }, error: err };
      // ensure_login is called directly (not via runWithRetry) so the central
      // dump in runWithRetry never sees it — fire one manually to keep this
      // path's forensics on par. `err.dumped` guards against double-dumps if
      // an inner action (facebook_signup) already captured one.
      if (!err.dumped) {
        await dumpStepFailure(page, 'ensure_login', err);
        err.dumped = true;
      }
      if (vaultState) {
        vaultLog.browser({ browserId: vaultState.browserId }, [
          { level: 'error', msg: `Auto re-login failed: ${err.message}` },
        ]);
      }
      // Email-confirmation (confirmemail.php), checkpoint, or rejected creds
      // hit during re-login → flag the profile for manual review. The account
      // may exist but is gated (needs an emailed code / challenge / new creds),
      // so it shouldn't be re-run blind by the next task.
      if (err.needChecking || err.checkpoint || err.credentialsRejected) {
        const uid = user?._id || user?.id || '';
        if (uid) {
          const why = err.needChecking
            ? 'email confirmation'
            : err.checkpoint
              ? 'checkpoint'
              : 'credentials rejected';
          try {
            await updateProfile(uid, { status: 'Need Checking' });
            console.log(`Profile ${uid} status -> "Need Checking" (${why})`);
          } catch (patchErr) {
            console.warn(`Failed to PATCH status "Need Checking" for ${uid}: ${patchErr.message}`);
          }
        }
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
        const isCheckpoint = !!(err && err.checkpoint);
        const isCredRejected = !!(err && err.credentialsRejected);
        const isBrowserDead = !!(err && err.browserDead);
        const isPageBlocked = !!(err && err.pageBlocked);
        const isNeedChecking = !!(err && err.needChecking);
        const isAbort =
          isCheckpoint || isCredRejected || isBrowserDead || isPageBlocked || isNeedChecking;

        // The actual step that failed — a child (e.g. open_search_result) when
        // `step` is its top-level parent (e.g. search). Falls back to the
        // top-level type for errors thrown outside runWithRetry.
        const failedType = (err && err.stepType) || step.type;

        if (vaultState) {
          const msg = isCheckpoint
            ? `Checkpoint hit during ${failedType} — aborting profile`
            : isCredRejected
              ? `Credentials rejected during ${failedType} — aborting profile`
              : isBrowserDead
                ? `Browser session died during ${failedType} — aborting profile`
                : isPageBlocked
                  ? `Page blocked by consent flow during ${failedType} — aborting profile`
                  : isNeedChecking
                    ? `Manual review required during ${failedType} — aborting profile`
                    : `Step ${failedType} failed: ${err.message} — continuing to next step`;
          vaultLog.browser({ browserId: vaultState.browserId }, [{ level: 'error', msg }]);
        }

        if (isCheckpoint) {
          failure = { step, error: err };
          console.warn(
            `Checkpoint hit during ${failedType} — skipping remaining steps for this profile`
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
          throw err;
        }

        // Credential rejection (e.g. outlook_login got "That password is
        // incorrect"). Flag the user record so the email password gets
        // re-issued instead of the bot re-running the same dead creds. Re-uses
        // "Need Checking" — same status the checkpoint branch sets — because
        // that value is whitelisted server-side. The tracker-log entry written
        // in the finally block carries the specific reason for triage.
        if (isCredRejected) {
          failure = { step, error: err };
          console.warn(
            `Credentials rejected during ${failedType} — flagging profile and skipping remaining steps`
          );
          const userId = user?._id || user?.id || '';
          if (userId) {
            try {
              await updateProfile(userId, { status: 'Need Checking' });
              console.log(`Profile ${userId} status -> "Need Checking" (credentials rejected)`);
            } catch (patchErr) {
              console.warn(
                `Failed to PATCH status "Need Checking" for ${userId}: ${patchErr.message}`
              );
            }
          }
          throw err;
        }

        // Browser-dead — the underlying chromium/CDP socket is gone. Every
        // subsequent step would burn 3×60s of retry on the same error, then
        // soft-fail. Cheaper to abort the whole profile here. Status is NOT
        // PATCHed to Need Checking since the cause is usually MLX-side
        // (session timeout, agent crash) and the account itself is fine.
        if (isBrowserDead) {
          failure = { step, error: err };
          console.warn(
            `Browser session died during ${failedType} — skipping remaining steps for this profile`
          );
          throw err;
        }

        // Page blocked by a consent funnel the recovery gate couldn't clear.
        // Running the rest of the flow would just waste 3×retry per remaining
        // step on a dead page. Abort. Status is NOT PATCHed to Need Checking —
        // a stuck consent funnel is a recovery gap on our side, not a flagged
        // account; it re-runs cleanly next cycle (and the blocked HTML was
        // dumped by ensurePageReady for building a new recoverer).
        if (isPageBlocked) {
          failure = { step, error: err };
          console.warn(
            `Page blocked by consent flow during ${failedType} — skipping remaining steps for this profile`
          );
          throw err;
        }

        // Needs manual review (e.g. facebook_signup hit confirmemail.php — the
        // account exists but is gated behind an emailed code we don't enter
        // yet). Flag the profile so it surfaces for triage instead of being
        // re-run blind, and abort the rest of the session.
        if (isNeedChecking) {
          failure = { step, error: err };
          console.warn(
            `Manual review required during ${failedType} — flagging profile and skipping remaining steps`
          );
          const userId = user?._id || user?.id || '';
          if (userId) {
            try {
              await updateProfile(userId, { status: 'Need Checking' });
              console.log(`Profile ${userId} status -> "Need Checking" (${failedType})`);
            } catch (patchErr) {
              console.warn(
                `Failed to PATCH status "Need Checking" for ${userId}: ${patchErr.message}`
              );
            }
          }
          throw err;
        }

        // Non-abort failure: record + carry on to the next top-level step.
        // The step's own retry budget already exhausted inside runWithRetry;
        // a single failure shouldn't waste the rest of the session.
        console.warn(
          `Step ${failedType} failed (non-fatal): ${err.message} — continuing to next step`
        );
        softFailures.push({ step, error: err });
      }
    }
  } finally {
    const userId = user?._id || user?.id || '';
    const elapsedMs = Date.now() - browserStartedAt;
    const note = buildTrackerNote(completed, { failure, softFailures }, elapsedMs);
    await persistTrackerLog(userId, note);

    // Per log.md "Ending a profile" — final /browser MUST fire on both success
    // and failure paths, with currentStepPath: "done" and online: false. Lives
    // in finally so a thrown step still produces the offline ping.
    if (vaultState) {
      const endLogs = failure
        ? ['profile failed', 'browser:offline']
        : softFailures.length > 0
          ? [`profile complete (${softFailures.length} non-fatal failure(s))`, 'browser:offline']
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
/**
 * Resolve a task's profile list. Two sources, with explicit-wins precedence:
 *
 *   1. `task.profiles[]` — explicit list. Wins when non-empty (after filtering
 *      out empty strings).
 *   2. `task.profilesFromStatus` — dynamic fetch via GET /api/profiles?status=X.
 *      Used when `profiles` is missing or empty (or only contains empties).
 *
 * Throws when both are missing/empty. Returns { source, userIds, prefetched }
 * where `prefetched` is the array of full user records when the source was
 * the API (re-used downstream for the cooldown gate to skip a second fetch).
 */
async function resolveProfileList(task) {
  const explicit = Array.isArray(task.profiles) ? task.profiles.filter(Boolean) : [];
  if (explicit.length > 0) {
    return { source: 'explicit', userIds: explicit, prefetched: null };
  }

  const status = String(task.profilesFromStatus || '').trim();
  if (!status) {
    throw new Error(
      'Task must specify either profiles[] (non-empty) or profilesFromStatus (e.g. "Active")'
    );
  }

  console.log(`[task] Fetching profiles by status=${status} from API...`);
  const profiles = await fetchProfilesByStatus(status);
  const userIds = profiles.map((p) => p._id || p.id).filter(Boolean);
  console.log(`[task] API returned ${userIds.length} profile(s) with status=${status}`);

  // Index by id so the worker's cooldown check can look up the prefetched
  // record without a second fetchUser call.
  const prefetched = new Map();
  for (const u of profiles) {
    const id = u._id || u.id;
    if (id) prefetched.set(String(id), u);
  }

  return { source: 'api', userIds, prefetched };
}

/**
 * Cooldown gate — returns { skipped, reason, elapsedHours } for the per-
 * profile worker. Currently only `cooldown.shareHours` is implemented; the
 * shape leaves room for additional gates (e.g. minHoursSinceLastConnect).
 *
 * Behavior:
 *   - no cooldown config        → not skipped (legacy task configs work as-is)
 *   - lastSharedAt missing/null → not skipped (never shared, allow)
 *   - lastSharedAt < threshold  → SKIPPED with elapsed-hours reason
 *   - lastSharedAt >= threshold → not skipped, run normally
 */
function checkCooldown(user, cooldownConfig) {
  if (!cooldownConfig || typeof cooldownConfig !== 'object') {
    return { skipped: false };
  }
  const shareHours = Number(cooldownConfig.shareHours);
  if (!Number.isFinite(shareHours) || shareHours <= 0) {
    return { skipped: false };
  }
  const lastSharedAt = user?.onboarding?.lastSharedAt;
  if (!lastSharedAt) return { skipped: false };

  const last = new Date(lastSharedAt);
  if (Number.isNaN(last.getTime())) return { skipped: false };

  const elapsedMs = Date.now() - last.getTime();
  const elapsedHours = elapsedMs / 3_600_000;
  if (elapsedHours >= shareHours) return { skipped: false };

  const remaining = (shareHours - elapsedHours).toFixed(1);
  return {
    skipped: true,
    elapsedHours,
    reason: `last shared ${elapsedHours.toFixed(1)}h ago (cooldown ${shareHours}h, ${remaining}h remaining)`,
  };
}

async function runTask(task) {
  const { taskId, concurrency, blockMedia, steps, cooldown } = task;

  // Resolve profile list — explicit `profiles[]` wins, falls back to
  // `profilesFromStatus` API fetch. Throws if both are missing/empty.
  const { source: profileSource, userIds, prefetched } = await resolveProfileList(task);
  const limit = concurrency && concurrency > 0 ? concurrency : userIds.length;
  const options = { blockMedia: blockMedia !== false };
  const startedAtMs = Date.now();

  // Memoized — if run-task.js already initialized the dir (so it could set up
  // the top-level tasks-logs.log tee before this point), this call is a no-op
  // and returns the same path.
  const runLogDir = initRunLogDir(taskId);

  console.log(
    `\n=== Task ${taskId}: ${userIds.length} profile(s), concurrency: ${limit}, blockMedia: ${options.blockMedia} ===`
  );
  console.log(`Logs: ${runLogDir}\n`);

  // Resumable-state load. If a previous run of this task was interrupted, the
  // completed-profile map tells us which userIds to skip. The profilesHash on
  // the state file invalidates automatically when the task's profile list is
  // edited.
  const persisted = loadState(taskId, userIds);
  const state = {
    startedAt: persisted.startedAt || new Date().toISOString(),
    completed: { ...persisted.completed },
  };

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
  const displayNames = new Array(userIds.length).fill('');

  // Pre-seed results / timings for previously-completed profiles so the
  // end-of-task summary covers the full task, not just this restart's slice.
  for (let i = 0; i < userIds.length; i++) {
    const prior = state.completed[userIds[i]];
    if (!prior) continue;
    if (prior.status === 'success') {
      results[i] = {
        status: 'fulfilled',
        value: { profileId: userIds[i], status: 'success', resumed: true },
      };
    } else if (prior.status === 'skipped') {
      results[i] = {
        status: 'fulfilled',
        value: { profileId: userIds[i], status: 'skipped', reason: prior.reason || '' },
      };
    } else {
      results[i] = {
        status: 'rejected',
        reason: new Error(prior.error || 'previous run errored'),
      };
    }
    timingsMs[i] = Math.round((prior.elapsedSec || 0) * 1000);
  }

  const queue = [...userIds.entries()].filter(([_, userId]) => !state.completed[userId]);

  if (queue.length === 0 && userIds.length > 0) {
    console.log(
      `[taskState] All ${userIds.length} profile(s) already processed in this state — nothing to do. Use --fresh to re-run.`
    );
  } else if (Object.keys(state.completed).length > 0) {
    console.log(
      `[taskState] Skipping ${Object.keys(state.completed).length}, running ${queue.length} remaining profile(s)`
    );
  }

  async function worker(slotIndex) {
    const browserId = `${provider}-${slotIndex}`;

    while (queue.length > 0) {
      const [index, userId] = queue.shift();
      const profileStartedAt = Date.now();

      let userPreview = prefetched?.get(String(userId)) || null;
      if (!userPreview) {
        try {
          userPreview = await fetchUser(userId);
        } catch (err) {
          console.warn(
            `[${userId}] Pre-fetch user failed (will fall back to userId): ${err.message}`
          );
        }
      }
      const displayName = buildDisplayName(userPreview, userId);
      displayNames[index] = displayName;

      // Cooldown gate — check BEFORE opening the browser so a skip costs ~0s
      // instead of the ~15s browser-open overhead. lastSharedAt comes off the
      // user record's onboarding subdocument.
      const cd = checkCooldown(userPreview, cooldown);
      if (cd.skipped) {
        console.log(`[${displayName}] SKIPPED (cooldown): ${cd.reason}`);
        await persistTrackerLog(
          userPreview?._id || userPreview?.id || userId,
          `SKIPPED (cooldown): ${cd.reason}`
        );
        const completedAt = new Date().toISOString();
        results[index] = {
          status: 'fulfilled',
          value: { profileId: userId, status: 'skipped', reason: cd.reason },
        };
        timingsMs[index] = 0;
        state.completed[userId] = {
          status: 'skipped',
          completedAt,
          elapsedSec: 0,
          reason: cd.reason,
        };
        saveState(taskId, userIds, state);
        continue; // next userId from the queue
      }

      await runInSession({ displayName, browserId, idsToStrip: [userId], userId }, async () => {
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
            [{ level: 'error', msg: `Failed to open browser: ${err.message}` }, 'browser:offline']
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

      // Persist completion regardless of success/failure. Both are "we tried
      // this one and moved on" — re-running shouldn't re-process either.
      const result = results[index];
      const elapsedSec = Number((timingsMs[index] / 1000).toFixed(1));
      if (result?.status === 'fulfilled') {
        state.completed[userId] = {
          status: 'success',
          completedAt: new Date().toISOString(),
          elapsedSec,
        };
      } else {
        state.completed[userId] = {
          status: 'error',
          completedAt: new Date().toISOString(),
          elapsedSec,
          error: result?.reason?.message || 'unknown error',
        };
      }
      saveState(taskId, userIds, state);

      // Tag the per-profile folder with SUCCESS/FAIL so the profiles/ listing
      // shows outcomes at a glance. Runs after runInSession has exited (no
      // more file handles into the folder), best-effort on Windows. Skipped
      // profiles never opened a browser so there's no folder to rename.
      renameProfileFolderWithStatus({
        runLogDir,
        displayName,
        userId,
        status: result?.status === 'fulfilled' ? 'SUCCESS' : 'FAIL',
      });
    }
  }

  const workers = Array.from({ length: limit }, (_, i) => worker(i + 1));
  await Promise.all(workers);

  // All profiles in this task have been processed at least once → clear the
  // state file so the next manual `node run-task.js ...` invocation starts
  // fresh. A killed-mid-batch run leaves the file intact for resume.
  const allDone = userIds.every((uid) => state.completed[uid]);
  if (allDone) clearState(taskId);

  // profileId in results = user record _id (the value from tasks.json
  // `profiles[]`), NOT the underlying browser UUID. Callers and downstream
  // dashboards key off the user id; the browser id is an implementation
  // detail of the provider.
  const formattedResults = results.map((result, index) => {
    const userId = userIds[index];
    const displayName = displayNames[index] || userId;
    const elapsedSec = Number((timingsMs[index] / 1000).toFixed(1));
    if (result?.status === 'fulfilled') {
      // Skipped profiles (cooldown gate) carry a sentinel on the value object.
      if (result.value?.status === 'skipped') {
        return {
          profileId: userId,
          profileName: displayName,
          status: 'skipped',
          reason: result.value.reason || '',
          elapsedSec,
        };
      }
      return { profileId: userId, profileName: displayName, status: 'success', elapsedSec };
    } else {
      const msg = result?.reason?.message || 'unknown error';
      console.error(`[${userId}] Error:`, msg);
      return {
        profileId: userId,
        profileName: displayName,
        status: 'error',
        error: msg,
        elapsedSec,
      };
    }
  });

  const successCount = formattedResults.filter((r) => r.status === 'success').length;
  const skippedCount = formattedResults.filter((r) => r.status === 'skipped').length;
  const errorCount = formattedResults.filter((r) => r.status === 'error').length;
  const totalElapsedSec = ((Date.now() - startedAtMs) / 1000).toFixed(1);

  const perProfileMs = timingsMs.filter((ms) => ms > 0);
  const avgSec = perProfileMs.length
    ? (perProfileMs.reduce((a, b) => a + b, 0) / perProfileMs.length / 1000).toFixed(1)
    : '0.0';
  const minSec = perProfileMs.length ? (Math.min(...perProfileMs) / 1000).toFixed(1) : '0.0';
  const maxSec = perProfileMs.length ? (Math.max(...perProfileMs) / 1000).toFixed(1) : '0.0';

  console.log(`\n=== Task ${taskId}: Completed ===`);
  console.log(`  Profiles:    ${formattedResults.length} (source: ${profileSource})`);
  console.log(`  Succeeded:   ${successCount}`);
  if (skippedCount > 0) console.log(`  Skipped:     ${skippedCount} (cooldown)`);
  console.log(`  Failed:      ${errorCount}`);
  console.log(`  Total time:  ${totalElapsedSec}s`);
  console.log(`  Per profile: avg ${avgSec}s, min ${minSec}s, max ${maxSec}s`);

  if (errorCount > 0) {
    console.log('\n  Failures:');
    formattedResults
      .filter((r) => r.status === 'error')
      .forEach((r) =>
        console.log(`    - ${r.profileName} [${r.profileId}] (${r.elapsedSec}s): ${r.error}`)
      );
  }
  if (skippedCount > 0) {
    console.log('\n  Skipped:');
    formattedResults
      .filter((r) => r.status === 'skipped')
      .forEach((r) => console.log(`    - ${r.profileName} [${r.profileId}]: ${r.reason}`));
  }
  console.log();

  writeSummaryFile({
    taskId,
    runLogDir,
    formattedResults,
    successCount,
    skippedCount,
    errorCount,
    totalElapsedSec,
    avgSec,
    minSec,
    maxSec,
    startedAtMs,
    profileSource,
  });

  return { taskId, results: formattedResults };
}

function writeSummaryFile({
  taskId,
  runLogDir,
  formattedResults,
  successCount,
  skippedCount = 0,
  errorCount,
  totalElapsedSec,
  avgSec,
  minSec,
  maxSec,
  startedAtMs,
  profileSource,
}) {
  if (!runLogDir) return;

  const startedAt = new Date(startedAtMs).toISOString();
  const finishedAt = new Date().toISOString();
  const failures = formattedResults.filter((r) => r.status === 'error');
  const skipped = formattedResults.filter((r) => r.status === 'skipped');
  const successes = formattedResults.filter((r) => r.status === 'success');

  const lines = [];
  lines.push(`# Task summary: ${taskId}`);
  lines.push('');
  lines.push(`Started:   ${startedAt}`);
  lines.push(`Finished:  ${finishedAt}`);
  lines.push(`Duration:  ${totalElapsedSec}s`);
  lines.push('');
  lines.push(`Profiles:  ${formattedResults.length}${profileSource ? ` (source: ${profileSource})` : ''}`);
  lines.push(`Succeeded: ${successCount}`);
  if (skippedCount > 0) lines.push(`Skipped:   ${skippedCount} (cooldown)`);
  lines.push(`Failed:    ${errorCount}`);
  lines.push(`Per profile: avg ${avgSec}s, min ${minSec}s, max ${maxSec}s`);
  lines.push('');

  if (failures.length > 0) {
    lines.push(`## Failures (${failures.length})`);
    lines.push('');
    for (const r of failures) {
      lines.push(`- **${r.profileName}** \`${r.profileId}\` (${r.elapsedSec}s)`);
      lines.push(`  - ${r.error}`);
    }
    lines.push('');
  }

  if (skipped.length > 0) {
    lines.push(`## Skipped (${skipped.length})`);
    lines.push('');
    for (const r of skipped) {
      lines.push(`- ${r.profileName} \`${r.profileId}\` — ${r.reason}`);
    }
    lines.push('');
  }

  if (successes.length > 0) {
    lines.push(`## Successes (${successes.length})`);
    lines.push('');
    for (const r of successes) {
      lines.push(`- ${r.profileName} \`${r.profileId}\` (${r.elapsedSec}s)`);
    }
    lines.push('');
  }

  try {
    const summaryPath = path.join(runLogDir, 'summary.md');
    fs.writeFileSync(summaryPath, lines.join('\n'), 'utf8');
    console.log(`Summary written → ${summaryPath}\n`);
  } catch (err) {
    console.warn(`Failed to write summary file: ${err.message}`);
  }
}

module.exports = { runTask, runStep };
