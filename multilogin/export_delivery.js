import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import "dotenv/config";

const MLX_BASE = "https://api.multilogin.com";
const API_BASE = process.env.API_BASE ?? process.env.USER_API_BASE_URL ?? "https://7or34.space";

const md5 = (s) => createHash("md5").update(s).digest("hex");

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

async function searchFolderProfiles(token, workspaceId, folderId) {
  const items = [];
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
    const page = json?.data?.profiles ?? json?.data?.items ?? json?.data ?? [];
    if (!Array.isArray(page) || page.length === 0) break;
    items.push(...page);
    if (page.length < pageSize) break;
    offset += pageSize;
  }
  return items;
}

async function getUser(id) {
  const res = await fetch(`${API_BASE}/api/profiles/${id}`, {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`GET /api/profiles/${id} ${res.status}`);
  return res.json();
}

function pickEmail(user) {
  const list = user?.emails ?? [];
  return (list.find((e) => e?.selected) || list[0])?.address ?? "";
}

function csvField(v) {
  if (v == null) return "";
  const s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function csvLine(values) {
  return values.map(csvField).join(",");
}

// ---- main ----
const args = process.argv.slice(2);
let outPath = null;
let folderId = process.env.MULTILOGIN_DELIVERY_FOLDER_ID;
for (const a of args) {
  if (a.startsWith("--out=")) outPath = a.slice(6);
  else if (a.startsWith("--folder=")) folderId = a.slice(9);
}

const email = process.env.MULTILOGIN_EMAIL;
const password = process.env.MULTILOGIN_PASSWORD;
const workspaceId = process.env.MULTILOGIN_WORKSPACE_ID;

const missing = Object.entries({
  MULTILOGIN_EMAIL: email,
  MULTILOGIN_PASSWORD: password,
  MULTILOGIN_WORKSPACE_ID: workspaceId,
  folderId,
})
  .filter(([, v]) => !v)
  .map(([k]) => k);
if (missing.length) {
  console.error(`Missing required values: ${missing.join(", ")}`);
  process.exit(1);
}

if (!outPath) {
  const ts = new Date().toISOString().replace(/[:.]/g, "-").replace("T", "_").slice(0, 19);
  outPath = path.resolve(`delivery_export_${ts}.csv`);
} else {
  outPath = path.resolve(outPath);
}

console.log(`Signing in as ${email} ...`);
const { token: initialToken, refreshToken } = await signIn(email, password);
const token = await switchWorkspace(initialToken, email, refreshToken, workspaceId);

console.log(`Listing profiles in folder ${folderId} ...`);
const profiles = await searchFolderProfiles(token, workspaceId, folderId);
console.log(`  ${profiles.length} profile(s) in folder`);

console.log(`Resolving user records via ${API_BASE} ...`);
const rows = [];
let withUser = 0;
let withoutUser = 0;
for (let i = 0; i < profiles.length; i++) {
  const p = profiles[i];
  const profileId = p?.id ?? p?.profile_id ?? "";
  const profileName = p?.name ?? p?.profile_name ?? "";
  const notes = p?.notes ?? "";
  const createdAt = p?.created_at ?? "";
  const browserType = p?.browser_type ?? "";
  const osType = p?.os_type ?? "";

  let user = null;
  const userIdGuess = typeof notes === "string" && /^[0-9a-f]{24}$/i.test(notes.trim()) ? notes.trim() : null;
  if (userIdGuess) {
    try {
      user = await getUser(userIdGuess);
      withUser++;
    } catch (_err) {
      withoutUser++;
    }
  } else {
    withoutUser++;
  }

  rows.push([
    profileId,
    profileName,
    notes,
    createdAt,
    browserType,
    osType,
    user?._id ?? userIdGuess ?? "",
    user?.firstName ?? "",
    user?.lastName ?? "",
    pickEmail(user),
    user?.emailPassword ?? "",
    user?.facebookPassword ?? "",
    user?.birthdayDate ?? user?.dob ?? "",
    user?.gender ?? "",
    user?.profileUrl ?? "",
    user?.pageUrl ?? "",
    user?.city ?? "",
    user?.status ?? "",
  ]);

  if ((i + 1) % 25 === 0) console.log(`  resolved ${i + 1}/${profiles.length}`);
}

const header = [
  "mlx_profile_id",
  "mlx_profile_name",
  "mlx_notes",
  "mlx_created_at",
  "mlx_browser_type",
  "mlx_os_type",
  "user_id",
  "first_name",
  "last_name",
  "email",
  "email_password",
  "facebook_password",
  "birthday_date",
  "gender",
  "profile_url",
  "page_url",
  "city",
  "status",
];

const csv = [csvLine(header), ...rows.map(csvLine)].join("\r\n") + "\r\n";
await writeFile(outPath, csv, "utf8");

console.log(`\nDone.`);
console.log(`  Profiles exported: ${rows.length}`);
console.log(`  With user record:  ${withUser}`);
console.log(`  Without user link: ${withoutUser}`);
console.log(`  Output:            ${outPath}`);
