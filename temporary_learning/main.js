// multi-profile.js
// Usage:
//   node multi-profile.js --task profile_interaction --url https://facebook.com/someone --uuids uuid1,uuid2,uuid3
//   node multi-profile.js --task homepage_interaction --uuids uuid1,uuid2,uuid3,uuid4,uuid5
//
// Each profile runs: random filler → main task → random filler
// Profiles start with staggered delays so they don't all hit Facebook at the same instant.

const fs = require("fs");
const path = require("path");
const { openProfile, closeProfile } = require("./hidemium");
const {
  createRunSessionId,
  captureIssueScreenshot,
  instrumentPage,
  runWithErrorScreenshot,
  setPageContext,
  withLogContext,
} = require("./utils/runtime-monitor");

// ---------- step registry ----------

// MAIN_TASKS: the tasks that can be chosen as the primary task via --task flag.
// These are explicitly registered so we can validate --task and pass the right data.
const MAIN_TASKS = {
  homepage_interaction: {
    module: require("./steps/homepage-interaction"),
    label: "Homepage Interaction",
  },
  profile_interaction: {
    module: require("./steps/profile-interaction"),
    label: "Profile Interaction",
  },
  profile_setup: {
    module: require("./steps/profile-setup"),
    label: "Profile Setup",
  },
  search_interaction: {
    module: require("./steps/search-interaction"),
    label: "Search Interaction",
  },
};

// FILLER_STEPS: auto-discovered from steps/ — any .js added there becomes a filler candidate.
// test-script.js is always excluded; the chosen main task file is excluded at runtime.
const EXCLUDED_FROM_FILLERS = new Set(["test-script.js"]);
const FILLER_WEIGHTS = {
  "search-interaction.js": 3,
  "profile-interaction.js": 1,
};

const ALL_FILLER_STEPS = fs
  .readdirSync(path.join(__dirname, "steps"))
  .filter((f) => f.endsWith(".js") && !EXCLUDED_FROM_FILLERS.has(f))
  .map((f) => ({
    label: f.replace(".js", ""),
    file: f,
    fn: require(path.join(__dirname, "steps", f)),
  }));

console.log(`[multi] Filler pool: ${ALL_FILLER_STEPS.map((s) => s.label).join(", ")}\n`);

// ---------- helpers ----------

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Exclude the main task's file from filler candidates so it isn't run twice.
function pickRandomFillers(mainTaskFile, count) {
  const available = ALL_FILLER_STEPS.filter((s) => s.file !== mainTaskFile);
  const weighted = available.flatMap((step) =>
    Array.from(
      { length: FILLER_WEIGHTS[step.file] || 1 },
      () => step,
    ),
  );
  const shuffled = [...weighted].sort(() => Math.random() - 0.5);
  const picked = [];
  const seenFiles = new Set();

  for (const step of shuffled) {
    if (seenFiles.has(step.file)) {
      continue;
    }

    picked.push(step);
    seenFiles.add(step.file);

    if (picked.length >= Math.min(count, available.length)) {
      break;
    }
  }

  return picked;
}

function parseArgs() {
  const args = process.argv.slice(2);
  const parsed = {};
  for (let i = 0; i < args.length; i += 1) {
    if (args[i].startsWith("--")) {
      parsed[args[i].replace("--", "")] = args[i + 1] || true;
      i += 1;
    }
  }
  return parsed;
}

// ---------- run one profile (same logic as single-profile.js) ----------

async function runOneProfile(profileUuid, mainTaskKey, taskData, profileIndex) {
  const tag = `[profile-${profileIndex + 1}:${profileUuid.slice(-8)}]`;
  const mainTask = MAIN_TASKS[mainTaskKey];
  const runTag = `profile-${profileIndex + 1}`;
  const runSessionId = createRunSessionId();

  return withLogContext(
    {
      account: profileUuid.slice(-8),
      accountUuid: profileUuid,
      runTag,
      runSessionId,
    },
    async () => {
      let session;
      let page;

      try {
        console.log(`${tag} Opening profile...`);
        console.log(`${tag} Session started: ${runSessionId}`);
        session = await openProfile(profileUuid);
        page =
          session.context.pages().find((p) => p.url() !== "about:blank") ||
          session.context.pages()[0] ||
          (await session.context.newPage());

        setPageContext(page, {
          account: profileUuid.slice(-8),
          accountUuid: profileUuid,
          runTag,
          runSessionId,
        });
        instrumentPage(page);

        console.log(`${tag} Attached to: ${page.url() || "about:blank"}`);

        // derive the filename used to exclude this task from fillers
        const mainTaskFile = mainTaskKey.replace(/_/g, "-") + ".js";

        if (!taskData.isTestMode) {
          const beforeSteps = pickRandomFillers(mainTaskFile, randomInt(1, 2));
          for (const step of beforeSteps) {
            console.log(`${tag} Filler: ${step.label}`);
            await runWithErrorScreenshot(page, `filler-before-${step.label}`, () =>
              step.fn(page, null),
            );
            await sleep(randomInt(3000, 8000));
          }
        } else {
          console.log(`${tag} Test mode enabled - skipping filler before main task.`);
        }

        console.log(`${tag} Main task: ${mainTask.label}`);
        await runWithErrorScreenshot(page, `main-task-${mainTaskKey}`, () =>
          mainTask.module(page, taskData),
        );
        await sleep(randomInt(3000, 8000));

        if (!taskData.isTestMode) {
          const afterSteps = pickRandomFillers(mainTaskFile, randomInt(1, 2));
          for (const step of afterSteps) {
            console.log(`${tag} Filler: ${step.label}`);
            await runWithErrorScreenshot(page, `filler-after-${step.label}`, () =>
              step.fn(page, null),
            );
            await sleep(randomInt(3000, 8000));
          }
        } else {
          console.log(`${tag} Test mode enabled - skipping filler after main task.`);
        }

        console.log(`${tag} Done.`);
      } catch (err) {
        await captureIssueScreenshot(page, "run-one-profile-error", err);
        console.error(`${tag} Error: ${err.message}`);
      } finally {
        await closeProfile(profileUuid, session && session.browser);
        console.log(`${tag} Profile closed.`);
      }
    },
  );
}

// ---------- main ----------

async function main() {
  const args = parseArgs();

  const uuids = (args.uuids || "").split(",").filter(Boolean);
  const mainTaskKey = args.task || "homepage_interaction";
  const maxConcurrent = parseInt(args.concurrency || "5", 10);
  const isTestMode =
    String(args["test-mode"] || process.env.TEST_MODE || "").toLowerCase() ===
    "true";

  if (uuids.length === 0) {
    console.error(
      "Usage: node multi-profile.js --uuids uuid1,uuid2,... --task <task> [--url <url>]",
    );
    process.exit(1);
  }

  if (!MAIN_TASKS[mainTaskKey]) {
    console.error(
      `Unknown task: "${mainTaskKey}". Available: ${Object.keys(MAIN_TASKS).join(", ")}`,
    );
    process.exit(1);
  }

  const taskData = {
    url: args.url || null,
    message: args.message || null,
    isTestMode,
  };

  console.log(`[multi] Profiles: ${uuids.length}`);
  console.log(`[multi] Task: ${mainTaskKey}`);
  console.log(`[multi] Max concurrent: ${maxConcurrent}`);
  console.log(`[multi] Test mode: ${isTestMode ? "enabled" : "disabled"}`);
  if (taskData.url) console.log(`[multi] URL: ${taskData.url}`);

  // staggered parallel execution with concurrency limit
  const running = new Set();
  const queue = [...uuids];
  let index = 0;

  async function startNext() {
    if (queue.length === 0) return;

    const uuid = queue.shift();
    const currentIndex = index;
    index += 1;

    // stagger: each profile starts 5-15s after the previous one
    if (currentIndex > 0) {
      const staggerMs = randomInt(5000, 15000);
      console.log(
        `[multi] Staggering profile ${currentIndex + 1} by ${(staggerMs / 1000).toFixed(1)}s...`,
      );
      await sleep(staggerMs);
    }

    const promise = runOneProfile(uuid, mainTaskKey, taskData, currentIndex);
    running.add(promise);

    promise.finally(() => {
      running.delete(promise);
      startNext(); // fill the slot
    });
  }

  // start up to maxConcurrent profiles
  const initialBatch = Math.min(maxConcurrent, queue.length);
  for (let i = 0; i < initialBatch; i += 1) {
    startNext();
  }

  // wait for all to complete
  while (running.size > 0) {
    await Promise.race(running);
  }

  console.log("\n[multi] All profiles complete.");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exitCode = 1;
});
