import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import "dotenv/config";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// User IDs come from multilogin/ids.txt (one per line, # = comment) — the SAME
// list update_name_notes.js reads — or from CLI args, which win over the file:
//   node multilogin/move_profiles.js <id> <id> ...
function resolveUserIds() {
  const args = process.argv.slice(2).filter((a) => a && !a.startsWith("--"));
  if (args.length) return args;
  const idsPath = path.resolve(__dirname, "ids.txt");
  if (!fs.existsSync(idsPath)) return [];
  return fs
    .readFileSync(idsPath, "utf8")
    .split(/\r?\n/)
    .map((l) => l.replace(/#.*$/, "").trim()) // strip inline + full-line comments
    .filter(Boolean);
}

const USER_IDS = resolveUserIds();

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
  console.error(
    "No user IDs. Paste them into multilogin/ids.txt (one per line) or pass as CLI args."
  );
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
