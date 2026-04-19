// single-profile.js
const { openProfile, closeProfile } = require("./hidemium");
const runTestScript = require("./steps/test-script");
const runHomepageInteraction = require("./steps/homepage-interaction");
const runProfileInteraction = require("./steps/profile-interaction");
const runProfileSetup = require("./steps/profile-setup");
const runSearchInteraction = require("./steps/search-interaction");
const {
  createRunSessionId,
  captureIssueScreenshot,
  instrumentPage,
  runWithErrorScreenshot,
  setPageContext,
  withLogContext,
} = require("./utils/runtime-monitor");

const PROFILE_UUID = "local-0803c727-8848-49c8-8892-7265f6c0918b";
const KEEP_PROFILE_OPEN = true;
const REUSE_CURRENT_TAB = true;
const START_URL = "https://www.facebook.com/";
const OPEN_START_URL_WHEN_BLANK = true;
const STEP_KEY = process.env.STEP_KEY || "profile_setup";

const STEP_RUNNERS = {
  test_script: runTestScript,
  homepage_interaction: runHomepageInteraction,
  profile_interaction: runProfileInteraction,
  profile_setup: runProfileSetup,
  search_interaction: runSearchInteraction,
};

async function getWorkingPage(context) {
  const pages = context.pages();

  if (pages.length === 0) {
    return context.newPage();
  }

  const isAutomatablePage = (page) => {
    const url = page.url() || "about:blank";
    return (
      url === "about:blank" ||
      url.startsWith("http://") ||
      url.startsWith("https://")
    );
  };

  const automatablePages = pages.filter(isAutomatablePage);

  if (!REUSE_CURRENT_TAB) {
    return automatablePages[0] || context.newPage();
  }

  // Reuse a normal web tab, not devtools:// or other browser-internal pages.
  const nonBlankWebPage = automatablePages.find(
    (p) => p.url() && p.url() !== "about:blank",
  );
  return nonBlankWebPage || automatablePages[0] || context.newPage();
}

async function ensureStartPage(page) {
  const currentUrl = page.url() || "about:blank";

  if (!OPEN_START_URL_WHEN_BLANK || currentUrl !== "about:blank") {
    return;
  }

  await page.goto(START_URL, { waitUntil: "domcontentloaded" });
  console.log(`Opened start URL: ${START_URL}`);
}

async function run() {
  const runSessionId = createRunSessionId();

  return withLogContext(
    {
      account: PROFILE_UUID.slice(-8),
      accountUuid: PROFILE_UUID,
      runTag: "single-profile",
      runSessionId,
    },
    async () => {
      let browser;
      let page;
      const shouldCloseProfile = !KEEP_PROFILE_OPEN;
      const runStep = STEP_RUNNERS[STEP_KEY];

      if (!runStep) {
        throw new Error(
          `Unknown STEP_KEY "${STEP_KEY}". Available: ${Object.keys(STEP_RUNNERS).join(", ")}`,
        );
      }

      try {
        const session = await openProfile(PROFILE_UUID);
        browser = session.browser;
        console.log(`Session started: ${runSessionId}`);

        page = await getWorkingPage(session.context);
        setPageContext(page, {
          account: PROFILE_UUID.slice(-8),
          accountUuid: PROFILE_UUID,
          runTag: "single-profile",
          runSessionId,
        });
        instrumentPage(page);

        await runWithErrorScreenshot(page, "ensure-start-page", () =>
          ensureStartPage(page),
        );
        console.log(`Using current tab: ${page.url() || "about:blank"}`);

        console.log(`Running step: ${STEP_KEY}`);
        await runWithErrorScreenshot(page, `single-step-${STEP_KEY}`, () =>
          runStep(page),
        );
      } catch (error) {
        await captureIssueScreenshot(page, "single-profile-run-error", error);
        throw error;
      } finally {
        if (shouldCloseProfile) {
          await closeProfile(PROFILE_UUID, browser);
          console.log("Profile closed");
          return;
        }

        // Dev mode: keep profile/browser open across runs for fast iteration.
        console.log("Development mode: profile left open for reuse.");
      }
    },
  );
}

run().catch((error) => {
  console.error("Automation failed:", error);
  process.exitCode = 1;
});
