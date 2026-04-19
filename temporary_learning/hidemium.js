// hidemium.js — Reusable helper module
const axios = require("axios");
const { chromium } = require("playwright");
const {
  installConsoleFormatting,
  instrumentPage,
  setPageContext,
} = require("./utils/runtime-monitor");

const API = "http://127.0.0.1:2222";
const API_TOKEN = "pMgajBtFminGid3d6Wh0zFu2gPGx3BhUt3KX0S"; // <-- paste your token from Hidemium Settings > Generate token

const headers = { Authorization: `Bearer ${API_TOKEN}` };
const OPEN_PROFILE_ATTEMPTS = 10;
const OPEN_PROFILE_RETRY_MS = 60000;

installConsoleFormatting();

// Resource types to block — saves 80-90% bandwidth on media-heavy sites like Facebook.
// Like/Share buttons are found by aria-label so images are not needed.
// Applied at the context level so ALL pages in the session are covered, not just the first one.
const BLOCKED_RESOURCE_TYPES = new Set(["image", "media", "font"]);

async function blockMediaResources(context) {
  await context.route("**/*", (route) => {
    if (BLOCKED_RESOURCE_TYPES.has(route.request().resourceType())) {
      route.abort();
    } else {
      route.continue();
    }
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function openProfile(uuid) {
  let lastError;

  for (let attempt = 1; attempt <= OPEN_PROFILE_ATTEMPTS; attempt += 1) {
    let browser;

    try {
      const { data } = await axios.get(`${API}/openProfile?uuid=${uuid}`, {
        headers,
      });
      if (data.status !== "successfully") {
        throw new Error(`Failed to open ${uuid}: ${JSON.stringify(data)}`);
      }

      browser = await chromium.connectOverCDP(
        `http://127.0.0.1:${data.data.remote_port}`,
      );
      const context = browser.contexts()[0];
      const page = context.pages()[0] || (await context.newPage());

      setPageContext(page, {
        account: uuid.slice(-8),
        accountUuid: uuid,
      });
      instrumentPage(page);

      await blockMediaResources(context);
      console.log(
        `[hidemium] Media blocking enabled for profile ${uuid.slice(-8)}`,
      );

      return { browser, context, page, port: data.data.remote_port };
    } catch (error) {
      lastError = error;

      if (browser) {
        await browser.close().catch(() => {});
      }

      console.error(
        `[hidemium] Open profile failed for ${uuid.slice(-8)} (attempt ${attempt}/${OPEN_PROFILE_ATTEMPTS}): ${error.message}`,
      );

      if (attempt >= OPEN_PROFILE_ATTEMPTS) {
        break;
      }

      console.log(
        `[hidemium] Waiting ${OPEN_PROFILE_RETRY_MS / 1000}s before retrying profile open...`,
      );
      await sleep(OPEN_PROFILE_RETRY_MS);
    }
  }

  throw lastError;
}

async function closeProfile(uuid, browser) {
  if (browser) await browser.close().catch(() => {});
  await axios
    .get(`${API}/closeProfile?uuid=${uuid}`, { headers })
    .catch(() => {});
}

async function listProfiles() {
  const { data } = await axios.get(`${API}/profiles`, { headers });
  return data.data || [];
}

module.exports = { openProfile, closeProfile, listProfiles };
