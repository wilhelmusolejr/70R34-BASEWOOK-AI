require('dotenv').config();

const path = require('path');
const { fetchUser } = require('./utils/userApi');
const { openProfile } = require('./utils/browserManager');
const { humanWait, humanClick, humanType, scrollToCenter, humanDelay } = require('./utils/humanBehavior');
const task = require('./tasks.json');

const PROBE_PATH = path.resolve(__dirname, 'temporary_learning', 'setup_page_probe.js');
const KEEP_PROFILE_OPEN = process.env.PROBE_KEEP_OPEN !== 'false';
const OPEN_HOME_IF_BLANK = process.env.PROBE_OPEN_HOME_IF_BLANK !== 'false';

function getTargetUserId() {
  return process.env.PROBE_USER_ID || task.profiles?.[0];
}

async function getUserBrowserId(userId) {
  const user = await fetchUser(userId);
  if (!user?.browsers?.length) {
    throw new Error(`User ${userId} has no browsers configured`);
  }

  const { browserId, provider } = user.browsers[0];
  const resolvedProvider = provider || 'hidemium';
  if (resolvedProvider !== 'hidemium') {
    throw new Error(`Unsupported browser provider: ${resolvedProvider}`);
  }

  return { user, browserId };
}

async function getWorkingPage(context) {
  const pages = context.pages();
  if (!pages.length) return context.newPage();

  const webPages = pages.filter((page) => {
    const url = page.url() || 'about:blank';
    return url === 'about:blank' || url.startsWith('http://') || url.startsWith('https://');
  });

  const nonBlank = webPages.find((page) => {
    const url = page.url() || '';
    return url && url !== 'about:blank';
  });

  return nonBlank || webPages[0] || context.newPage();
}

async function ensureStartPage(page) {
  const currentUrl = page.url() || 'about:blank';
  if (!OPEN_HOME_IF_BLANK || currentUrl !== 'about:blank') return;

  await page.goto('https://www.facebook.com', { waitUntil: 'domcontentloaded' });
  await humanWait(page, 1500, 3000);
}

async function main() {
  const userId = getTargetUserId();
  if (!userId) {
    throw new Error('No target user ID found. Set PROBE_USER_ID or put a profile in tasks.json');
  }

  const { user, browserId } = await getUserBrowserId(userId);
  const session = await openProfile(browserId);
  const { browser, context, profileId } = session;

  try {
    const page = await getWorkingPage(context);
    await ensureStartPage(page);

    delete require.cache[require.resolve(PROBE_PATH)];
    const runProbe = require(PROBE_PATH);

    console.log(`[probe] User: ${user.firstName} ${user.lastName}`);
    console.log(`[probe] Profile: ${profileId}`);
    console.log(`[probe] Page: ${page.url() || 'about:blank'}`);
    console.log(`[probe] Running ${PROBE_PATH}`);

    await runProbe(page, {
      user,
      task,
      humanWait,
      humanClick,
      humanType,
      scrollToCenter,
      humanDelay,
    });

    console.log('[probe] Completed successfully');
  } finally {
    if (!KEEP_PROFILE_OPEN) {
      await browser.close().catch(() => {});
    } else {
      console.log('[probe] Profile left open for faster iteration');
    }
  }
}

main().catch((error) => {
  console.error('[probe] Failed:', error.message);
  console.error(error.stack);
  process.exitCode = 1;
});
