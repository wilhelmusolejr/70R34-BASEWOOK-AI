import { createHash } from "node:crypto";
import "dotenv/config";

// ---- Edit this list. MongoDB _id values from the online profile API. ----
const USER_IDS = ["69e21bfbbb8fecced7bfda00","69e21c9bbb8fecced7bfda04","69e21dbcbb8fecced7bfda09","69e21e00bb8fecced7bfda0e","69e21e34bb8fecced7bfda13","69e21e63bb8fecced7bfda18","69e21f41bb8fecced7bfda1d","69e21fd2bb8fecced7bfda22","69e2200ebb8fecced7bfda27","69e22121bb8fecced7bfda36","69e2218dbb8fecced7bfda40","69e221d5bb8fecced7bfda45","69e22210bb8fecced7bfda4a","69e22244bb8fecced7bfda4f","69e222b7bb8fecced7bfda59","69e223ffbb8fecced7bfda68","69e2244abb8fecced7bfda6d","69e22b53bb8fecced7bfda77","69e22b81bb8fecced7bfda7c","69e22c38bb8fecced7bfda81","69e22c72bb8fecced7bfda86","69e22cc3bb8fecced7bfda8b","69e22d7dbb8fecced7bfda96","69e22dc3bb8fecced7bfda9b","69e22f8fbb8fecced7bfdab4","69e23115bb8fecced7bfdac3","69e4c967432434a8d7eb60ec","69e4f475432434a8d7eb62f2","69f3585493738d563ce21828","69f3585493738d563ce21829","69f3585493738d563ce2182e","69f36dd093738d563ce21912","69f3f38993738d563ce21cf0","69f3f38993738d563ce21cf2","69f488af93738d563ce21fee","69f488af93738d563ce21fef","69f488af93738d563ce21ff1","69f4a1997ccc7b69484b3ca6","69f4a5a37ccc7b69484b3e70","69f4a8457ccc7b69484b3e9b","69f4b475e4db22596b581e27","69f4bf1de4db22596b581ea2","69f4bf9de4db22596b581eb5","69f5c624497c702fe2920960","69f5c624497c702fe2920961","69f5c624497c702fe2920962","69f5c624497c702fe2920963","69f5df5d497c702fe29209df","69f831de497c702fe2921a1d","69f85883497c702fe2921bfa","69f85b36497c702fe2921c14","69f85c44497c702fe2921c27","69f85de8497c702fe2921c39","69f85e43497c702fe2921c42","69f85fbb497c702fe2921c58","69f8611a497c702fe2921c6a","69f86260497c702fe2921c7c","69f862da497c702fe2921c85","69f86400497c702fe2921c9a","69f86481497c702fe2921cad","69f86569497c702fe2921cc4","69f86782497c702fe2921ccd","69fab5d4d7f59db2c21aeb16","69fab5d4d7f59db2c21aeb18","69fae84ad7f59db2c21aed24","69fae84ad7f59db2c21aed25","69faf30ad7f59db2c21aee3e","69fb09bad7f59db2c21aeed4"];

const MLX_BASE = "https://api.multilogin.com";
const API_BASE = process.env.API_BASE ?? process.env.USER_API_BASE_URL ?? "https://7or34.space";
const MOVE_DELAY_MS = 4000;
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

async function listFolderProfileIds(token, workspaceId, folderId) {
  const ids = new Set();
  const pageSize = 100;
  let offset = 0;
  while (true) {
    const res = await fetch(`${MLX_BASE}/profile/search`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        is_removed: false,
        workspace_id: workspaceId,
        storage_type: "all",
        search_text: "",
        folder_id: folderId,
        limit: pageSize,
        offset,
      }),
    });
    if (!res.ok) throw new Error(`profile/search ${res.status}: ${await res.text()}`);
    const json = await res.json();
    const items = json?.data?.profiles ?? json?.data?.items ?? json?.data ?? [];
    if (!Array.isArray(items) || items.length === 0) break;
    for (const p of items) {
      const pid = p?.id ?? p?.profile_id;
      if (pid) ids.add(pid);
    }
    if (items.length < pageSize) break;
    offset += pageSize;
  }
  return ids;
}

async function moveOnce(token, destFolderId, profileId) {
  const res = await fetch(`${MLX_BASE}/profile/move`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ dest_folder_id: destFolderId, ids: [profileId] }),
  });
  const text = await res.text();
  return { ok: res.ok, status: res.status, text };
}

async function moveOne(token, destFolderId, profileId) {
  for (let attempt = 0; ; attempt++) {
    let result;
    try {
      result = await moveOnce(token, destFolderId, profileId);
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
    const retriable = result.status >= 500 || result.status === 429;
    if (!retriable || attempt >= RETRY_BACKOFFS_MS.length) {
      throw new Error(`profile/move ${result.status}: ${result.text.slice(0, 200)}`);
    }
    const wait = RETRY_BACKOFFS_MS[attempt];
    console.log(
      `\n    HTTP ${result.status}, backing off ${wait / 1000}s (retry ${attempt + 1}/${RETRY_BACKOFFS_MS.length})...`
    );
    await sleep(wait);
  }
}

function extractMlxBrowserId(user) {
  const b = (user?.browsers ?? []).find((x) => x?.provider === "multilogin");
  return b?.browserId ?? null;
}

// ---- main ----
const email = process.env.MULTILOGIN_EMAIL;
const password = process.env.MULTILOGIN_PASSWORD;
const workspaceId = process.env.MULTILOGIN_WORKSPACE_ID;
const sourceFolderId = process.env.MULTILOGIN_FOLDER_ID;
const destFolderId = process.env.MULTILOGIN_DELIVERY_FOLDER_ID;

const missing = Object.entries({
  MULTILOGIN_EMAIL: email,
  MULTILOGIN_PASSWORD: password,
  MULTILOGIN_WORKSPACE_ID: workspaceId,
  MULTILOGIN_FOLDER_ID: sourceFolderId,
  MULTILOGIN_DELIVERY_FOLDER_ID: destFolderId,
})
  .filter(([, v]) => !v)
  .map(([k]) => k);
if (missing.length) {
  console.error(`Missing required .env values: ${missing.join(", ")}`);
  process.exit(1);
}

if (USER_IDS.length === 0) {
  console.error("USER_IDS array is empty. Edit multilogin/move_profiles.js and add the ids.");
  process.exit(1);
}

console.log(`Resolving ${USER_IDS.length} user record(s) via ${API_BASE} ...`);
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

console.log(`\nSigning in as ${email} ...`);
const { token: initialToken, refreshToken } = await signIn(email, password);
const token = await switchWorkspace(initialToken, email, refreshToken, workspaceId);

console.log(`Listing profiles in source folder ${sourceFolderId} ...`);
const inSource = await listFolderProfileIds(token, workspaceId, sourceFolderId);
console.log(`  ${inSource.size} profile(s) in source`);

console.log(`Listing profiles in delivery folder ${destFolderId} ...`);
const inDest = await listFolderProfileIds(token, workspaceId, destFolderId);
console.log(`  ${inDest.size} profile(s) in delivery`);

const toMove = [];
const alreadyDelivered = [];
const notInSource = [];
for (const r of resolved) {
  if (inDest.has(r.mlxId)) {
    alreadyDelivered.push(r);
  } else if (inSource.has(r.mlxId)) {
    toMove.push(r);
  } else {
    notInSource.push(r);
  }
}

console.log(`\nPlan:`);
console.log(`  to move:           ${toMove.length}`);
console.log(`  already delivered: ${alreadyDelivered.length}`);
console.log(`  not in source:     ${notInSource.length}`);
console.log(`  user-record skip:  ${skipped.length}`);

for (const r of alreadyDelivered) console.log(`  SKIP (already in delivery) ${r.uid}  ${r.display}`);
for (const r of notInSource) console.log(`  SKIP (not in source folder) ${r.uid}  ${r.display}`);
for (const s of skipped) console.log(`  SKIP (${s.reason}) ${s.uid}  ${s.display}`);

if (toMove.length === 0) {
  console.log(`\nNothing to move.`);
  process.exit(0);
}

console.log(`\nMoving ${toMove.length} profile(s) -> ${destFolderId} (1s between each) ...`);
let moved = 0;
let failed = 0;
for (let i = 0; i < toMove.length; i++) {
  const r = toMove[i];
  process.stdout.write(`  [${i + 1}/${toMove.length}] ${r.display} (${r.mlxId}) ... `);
  try {
    const out = await moveOne(token, destFolderId, r.mlxId);
    console.log(out?.status?.message || "ok");
    moved++;
  } catch (err) {
    console.log("FAIL");
    console.error(`    ${err.message}`);
    failed++;
  }
  if (i < toMove.length - 1) await sleep(MOVE_DELAY_MS);
}

console.log(`\nDone. Moved ${moved}/${toMove.length}. Failed ${failed}.`);
