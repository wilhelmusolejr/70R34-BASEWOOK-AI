// Reusable client for posting bot events to the profile-vault Logs API.
//
// Usage:
//   import { createLogsClient } from "./scripts/logs-client.js";
//   const logs = createLogsClient({ baseUrl: "https://7or34.space" });
//
//   await logs.startTask({
//     taskId: "warmup-2026-05-15",
//     concurrency: 3,
//     blockMedia: true,
//     profiles: ["p1", "p2"],
//     steps: ["login", "warmup", "logout"],
//   });
//
//   const b = logs.browser("browser-A", { profileId: "p1", profileName: "Jane" });
//   await b.info("launching browser");
//   await b.step("warmup");
//   await b.warn("captcha appeared");
//   await b.error("submit failed");
//   await b.offline();
//
//   await logs.markProcessed("p1");
//   await logs.reset();
//
// Run the file directly to push a demo sequence:
//   node scripts/logs-client.js https://7or34.space

const DEFAULT_BASE_URL =
  process.env.LOGS_BASE_URL ||
  process.env.VITE_API_URL ||
  "http://localhost:4000";

export function createLogsClient({ baseUrl = DEFAULT_BASE_URL } = {}) {
  const root = baseUrl.replace(/\/+$/, "");

  async function post(path, body) {
    const res = await fetch(`${root}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body ?? {}),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`POST ${path} failed: ${res.status} ${text}`);
    }
    return res.json();
  }

  function normalizeSteps(steps) {
    if (!Array.isArray(steps)) return [];
    return steps.map((s) =>
      typeof s === "string" ? { type: s } : { type: String(s?.type || "step") },
    );
  }

  return {
    startTask({
      taskId,
      concurrency = 1,
      blockMedia = false,
      startedAt = Date.now(),
      profiles = [],
      steps = [],
    }) {
      return post("/api/logs/task", {
        taskId,
        concurrency,
        blockMedia,
        startedAt,
        profiles,
        steps: normalizeSteps(steps),
      });
    },

    markProcessed(profileId) {
      return post("/api/logs/processed", { profileId });
    },

    reset() {
      return post("/api/logs/reset", {});
    },

    // Returns a per-browser handle with shortcut log methods.
    browser(browserId, init = {}) {
      let state = {
        browserId,
        profileId: init.profileId,
        profileName: init.profileName,
        online: init.online ?? true,
        currentStepPath: init.currentStepPath,
      };

      const send = (patch = {}, logs = []) => {
        state = { ...state, ...patch };
        return post("/api/logs/browser", { ...state, logs });
      };

      const log = (level) => (msg) => send({}, [{ level, msg, ts: timeOfDay() }]);

      return {
        info: log("info"),
        warn: log("warn"),
        error: log("error"),
        step: (currentStepPath) => send({ currentStepPath }),
        update: (patch) => send(patch),
        logs: (entries) => send({}, entries),
        offline: () => send({ online: false }),
        online: () => send({ online: true }),
      };
    },
  };
}

function timeOfDay() {
  return new Date().toTimeString().slice(0, 8);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function demo(baseUrl) {
  const logs = createLogsClient({ baseUrl });

  console.log(`pushing demo task to ${baseUrl}`);
  await logs.reset();
  await logs.startTask({
    taskId: `demo-${new Date().toISOString().slice(0, 10)}`,
    concurrency: 3,
    blockMedia: true,
    profiles: ["p1", "p2", "p3"],
    steps: ["login", "warmup", "post", "logout"],
  });

  const a = logs.browser("browser-A", { profileId: "p1", profileName: "Jane Doe" });
  const b = logs.browser("browser-B", { profileId: "p2", profileName: "John Smith" });
  const c = logs.browser("browser-C", { profileId: "p3", profileName: "Alice Brown" });

  await a.step("login");
  await a.info("launching hidemium browser");
  await sleep(400);
  await a.info("logged in");
  await a.step("warmup");
  await a.info("scrolling feed");

  await b.step("login");
  await b.warn("captcha appeared, retrying");
  await sleep(400);
  await b.info("captcha solved");
  await b.step("post");

  await c.step("post");
  await c.error("post submit failed: network timeout");
  await sleep(300);
  await c.warn("retrying");
  await c.info("post submitted on retry");

  await logs.markProcessed("p1");
  await logs.markProcessed("p2");
  await logs.markProcessed("p3");

  await a.offline();
  await b.offline();
  await c.offline();

  console.log("done. open the Logs page to verify.");
}

if (import.meta.url === `file://${process.argv[1].replace(/\\/g, "/")}`) {
  const baseUrl = process.argv[2] || DEFAULT_BASE_URL;
  demo(baseUrl).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
