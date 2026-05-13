import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import "dotenv/config";

const MLX_BASE = "https://api.multilogin.com";
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

async function searchProfiles(token, { workspaceId, folderId, limit, offset }) {
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
      limit,
      offset,
    }),
  });
  if (!res.ok) throw new Error(`profile/search ${res.status}: ${await res.text()}`);
  return res.json();
}

const { MLX_EMAIL, MLX_PASSWORD, WORKSPACE_ID, FOLDER_ID, OUTPUT_FILE = "profile_ids.json" } = process.env;
const missing = Object.entries({ MLX_EMAIL, MLX_PASSWORD, WORKSPACE_ID, FOLDER_ID })
  .filter(([, v]) => !v)
  .map(([k]) => k);
if (missing.length) {
  console.error(`Missing required .env values: ${missing.join(", ")}`);
  process.exit(1);
}

const { token: initialToken, refreshToken } = await signIn(MLX_EMAIL, MLX_PASSWORD);
const token = await switchWorkspace(initialToken, MLX_EMAIL, refreshToken, WORKSPACE_ID);

const collected = [];
const pageSize = 100;
let offset = 0;
while (true) {
  const page = await searchProfiles(token, {
    workspaceId: WORKSPACE_ID,
    folderId: FOLDER_ID,
    limit: pageSize,
    offset,
  });
  const items = page?.data?.profiles ?? page?.data?.items ?? page?.data ?? [];
  if (!Array.isArray(items) || items.length === 0) break;
  collected.push(...items);
  if (items.length < pageSize) break;
  offset += pageSize;
}

const mapped = collected.map((p) => ({
  fullName: p.name ?? p.profile_name ?? null,
  profile_id: p.id ?? p.profile_id ?? null,
}));

const outPath = path.resolve(OUTPUT_FILE);
await writeFile(outPath, JSON.stringify(mapped, null, 2), "utf8");
console.log(`Wrote ${mapped.length} profiles to ${outPath}`);
