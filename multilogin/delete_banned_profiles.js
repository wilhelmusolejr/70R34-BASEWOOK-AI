import { createHash } from "node:crypto";
import "dotenv/config";

// Banned user IDs (Mongo ObjectIds) from the online platform. For each one we
// resolve the user record, take the browsers[] entry whose provider is
// "multilogin", and remove that MLX profile via POST /profile/remove.
//
// NOTE: MLX's public API only soft-removes — the profile goes to the workspace
// TRASH BIN (recoverable). There is no API route for permanent purge (every
// candidate returns the gateway's 501 placeholder); empty the trash from the
// Multilogin UI if you need a hard delete. Sending `permanently: true` in the
// body deterministically trips that same 501, so we send `{ ids: [...] }` only.
//
// Override the list from the CLI (wins over the embedded list):
//   node multilogin/delete_banned_profiles.js <id> <id> ...
// Dry-run (resolve + plan, no deletion):
//   node multilogin/delete_banned_profiles.js --dry-run
const BANNED_IDS = [
  "69e22059bb8fecced7bfda2c",
  "69e220bdbb8fecced7bfda31",
  "69e22156bb8fecced7bfda3b",
  "69e222ebbb8fecced7bfda5e",
  "69e22334bb8fecced7bfda63",
  "69e22485bb8fecced7bfda72",
  "69e22cfbbb8fecced7bfda91",
  "69e22e3dbb8fecced7bfdaa0",
  "69e22ea5bb8fecced7bfdaa5",
  "69e22ed2bb8fecced7bfdaaa",
  "69e22efebb8fecced7bfdaaf",
  "69e22fb6bb8fecced7bfdab9",
  "69e230eabb8fecced7bfdabe",
  "69e4d720432434a8d7eb6188",
  "69e4e064432434a8d7eb6214",
  "69e4f475432434a8d7eb62f2",
  "69f3585493738d563ce21826",
  "69f3585493738d563ce21827",
  "69f3585493738d563ce2182b",
  "69f3585493738d563ce2182e",
  "69f3f38993738d563ce21cef",
  "69f3f38993738d563ce21cf8",
  "69f4b902e4db22596b581e5e",
  "69f5fcbd497c702fe2920aa7",
  "69f671b2497c702fe2920bc2",
  "69f831de497c702fe2921a17",
  "69f831de497c702fe2921a18",
  "69f831de497c702fe2921a1a",
  "69f831de497c702fe2921a1b",
  "69f831de497c702fe2921a1c",
  "69f831de497c702fe2921a1e",
  "69f831de497c702fe2921a1f",
  "69f85a71497c702fe2921c03",
  "69f85c44497c702fe2921c27",
  "69f85d7b497c702fe2921c30",
  "69f85f56497c702fe2921c4f",
  "69f8616b497c702fe2921c73",
  "69f86340497c702fe2921c8e",
  "69facd9ad7f59db2c21aeb85",
  "69facd9ad7f59db2c21aeb86",
  "69fb09bad7f59db2c21aeed3",
  "6a01899c9ceed638ddd6abc5",
  "6a03d4b076c1dbb6df141b21",
  "6a0693b658d511b75f9f2318",
  "6a0800e714cdafac36ab9b43",
  "6a0814809a99600488373f0b",
  "6a084cca9a996004883744bd",
  "6a0884ba94ca4be700287668",
  "6a0884ba94ca4be70028766c",
  "6a097481c68f2c604ba66577",
  "6a0a9f4f673f917afcff598c",
  "6a0d52c7673f917afcff8ea8",
  "6a0d52c7673f917afcff8ea9",
  "6a0d52c7673f917afcff8eb2",
  "6a0d52c7673f917afcff8eb3",
  "6a0d52c7673f917afcff8eb4",
  "6a0d52c7673f917afcff8eb5",
  "6a0d52c7673f917afcff8eb6",
  "6a13f1d2673f917afcfff25e",
  "6a13f1d2673f917afcfff25f",
  "6a13f1d2673f917afcfff260",
  "6a16a16a024059deb2244282",
  "6a1936f5024059deb224852c",
  "6a1936f5024059deb224852e",
  "6a1936f5024059deb224852f",
  "6a1936f5024059deb2248530",
  "6a19a0ac024059deb2249390",
  "6a19a0ac024059deb2249396",
  "6a19a0ac024059deb2249397",
  "6a19a0ac024059deb2249399",
  "6a1a5a80024059deb224c31b",
  "6a1a5a80024059deb224c31c",
  "6a1a5acd024059deb224c339",
  "6a1a5acd024059deb224c340",
  "6a1a5acd024059deb224c342",
  "6a1a6d48024059deb224c503",
  "6a1a6d48024059deb224c509",
  "6a1a6d48024059deb224c50a",
  "6a1aeafcd41d49bf0141e17d",
  "6a1aeafcd41d49bf0141e17e",
  "6a1aeafcd41d49bf0141e180",
  "6a1aeafcd41d49bf0141e181",
  "6a1b8f78d41d49bf01420bb3",
  "6a1b8f78d41d49bf01420bb4",
  "6a1b8f78d41d49bf01420bb5",
  "6a1beb45d41d49bf014217fb",
  "6a1ce6289d9f61f4e2675e79",
  "6a1ea36d9d9f61f4e267b957",
  "6a1fc70fe739488de1debde9",
  "6a2819e2dd2552ffa8026232",
];

function resolveUserIds() {
  const args = process.argv.slice(2).filter((a) => a && !a.startsWith("--"));
  return args.length ? args : BANNED_IDS;
}

const DRY_RUN = process.argv.includes("--dry-run");
const USER_IDS = resolveUserIds();

const MLX_BASE = "https://api.multilogin.com";
const API_BASE = process.env.API_BASE ?? process.env.USER_API_BASE_URL ?? "https://7or34.space";
const DELETE_DELAY_MS = 2000;
const RETRY_BACKOFFS_MS = [10000, 30000, 60000];

const md5 = (s) => createHash("md5").update(s).digest("hex");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function signIn(email, password) {
  const res = await fetch(`${MLX_BASE}/user/signin`, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: md5(password) }),
  });
  if (!res.ok) throw new Error(`signin ${res.status}: ${await res.text()}`);
  const { data } = await res.json();
  return { token: data.token, refreshToken: data.refresh_token };
}

async function switchWorkspace(token, email, refreshToken, workspaceId) {
  const res = await fetch(`${MLX_BASE}/user/refresh_token`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ email, refresh_token: refreshToken, workspace_id: workspaceId }),
  });
  if (!res.ok) throw new Error(`refresh_token ${res.status}: ${await res.text()}`);
  return (await res.json()).data.token;
}

async function getUser(id) {
  const res = await fetch(`${API_BASE}/api/profiles/${id}`, {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`GET /api/profiles/${id} ${res.status}: ${await res.text()}`);
  return res.json();
}

function extractMlxBrowserId(user) {
  const b = (user?.browsers ?? []).find((x) => x?.provider === "multilogin");
  return b?.browserId ?? null;
}

async function removeOnce(token, profileId) {
  // MLX X: remove a profile (moves it to the workspace trash bin).
  const res = await fetch(`${MLX_BASE}/profile/remove`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ ids: [profileId] }),
  });
  const text = await res.text();
  return { ok: res.ok, status: res.status, text };
}

async function removeOne(token, profileId) {
  for (let attempt = 0; ; attempt++) {
    let result;
    try {
      result = await removeOnce(token, profileId);
    } catch (err) {
      if (attempt >= RETRY_BACKOFFS_MS.length) throw err;
      const wait = RETRY_BACKOFFS_MS[attempt];
      console.log(
        `\n    network error (${err.message}), backing off ${wait / 1000}s (retry ${attempt + 1}/${RETRY_BACKOFFS_MS.length})...`
      );
      await sleep(wait);
      continue;
    }
    if (result.ok) return result.text ? JSON.parse(result.text) : {};
    // Idempotent: a profile already in the trash returns 400 "Profiles already
    // removed" — treat that as success, not a failure.
    if (result.status === 400 && /already removed/i.test(result.text)) {
      return { status: { message: "already removed" } };
    }
    const retriable = result.status >= 500 || result.status === 429;
    if (!retriable || attempt >= RETRY_BACKOFFS_MS.length) {
      throw new Error(`profile/remove ${result.status}: ${result.text.slice(0, 200)}`);
    }
    const wait = RETRY_BACKOFFS_MS[attempt];
    console.log(
      `\n    HTTP ${result.status}, backing off ${wait / 1000}s (retry ${attempt + 1}/${RETRY_BACKOFFS_MS.length})...`
    );
    await sleep(wait);
  }
}

// ---- main ----
const email = process.env.MULTILOGIN_EMAIL;
const password = process.env.MULTILOGIN_PASSWORD;
const workspaceId = process.env.MULTILOGIN_WORKSPACE_ID;

const missing = Object.entries({
  MULTILOGIN_EMAIL: email,
  MULTILOGIN_PASSWORD: password,
  MULTILOGIN_WORKSPACE_ID: workspaceId,
})
  .filter(([, v]) => !v)
  .map(([k]) => k);
if (missing.length) {
  console.error(`Missing required .env values: ${missing.join(", ")}`);
  process.exit(1);
}

if (USER_IDS.length === 0) {
  console.error("No user IDs to process.");
  process.exit(1);
}

console.log(`Resolving ${USER_IDS.length} banned user record(s) via ${API_BASE} ...`);
const resolved = [];
const skipped = [];
for (const uid of USER_IDS) {
  try {
    const user = await getUser(uid);
    const mlxId = extractMlxBrowserId(user);
    const display = `${user.firstName ?? ""} ${user.lastName ?? ""}`.trim() || uid;
    if (!mlxId) {
      skipped.push({ uid, reason: "no multilogin browser on user record", display });
      continue;
    }
    resolved.push({ uid, mlxId, display });
  } catch (err) {
    skipped.push({ uid, reason: err.message, display: uid });
  }
}
console.log(`Resolved ${resolved.length} multilogin browserId(s). Skipped ${skipped.length}.`);

for (const s of skipped) console.log(`  SKIP (${s.reason}) ${s.uid}  ${s.display}`);

if (resolved.length === 0) {
  console.log(`\nNothing to delete.`);
  process.exit(0);
}

if (DRY_RUN) {
  console.log(`\n[dry-run] Would remove ${resolved.length} MLX profile(s) (-> trash bin):`);
  for (const r of resolved) console.log(`  ${r.uid}  ${r.mlxId}  ${r.display}`);
  console.log(`\n[dry-run] No changes made. Re-run without --dry-run to delete.`);
  process.exit(0);
}

console.log(`\nSigning in as ${email} ...`);
const { token: initialToken, refreshToken } = await signIn(email, password);
const token = await switchWorkspace(initialToken, email, refreshToken, workspaceId);

console.log(
  `\nRemoving ${resolved.length} MLX profile(s) to trash (${DELETE_DELAY_MS / 1000}s between each) ...`
);
let removed = 0;
let failed = 0;
for (let i = 0; i < resolved.length; i++) {
  const r = resolved[i];
  process.stdout.write(`  [${i + 1}/${resolved.length}] ${r.display} (${r.mlxId}) ... `);
  try {
    const out = await removeOne(token, r.mlxId);
    console.log(out?.status?.message || "ok");
    removed++;
  } catch (err) {
    console.log("FAIL");
    console.error(`    ${err.message}`);
    failed++;
  }
  if (i < resolved.length - 1) await sleep(DELETE_DELAY_MS);
}

console.log(`\nDone. Removed ${removed}/${resolved.length}. Failed ${failed}.`);
