import { createHash } from "node:crypto";
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

async function get(token, path) {
  const res = await fetch(`${MLX_BASE}${path}`, {
    headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`${path} ${res.status}: ${await res.text()}`);
  return res.json();
}

const email = process.env.MULTILOGIN_EMAIL || process.env.MLX_EMAIL;
const password = process.env.MULTILOGIN_PASSWORD || process.env.MLX_PASSWORD;
const workspaceId = process.env.MULTILOGIN_WORKSPACE_ID || process.env.WORKSPACE_ID;
const filter = process.argv[2] || process.env.FOLDER_FILTER || "";

if (!email || !password || !workspaceId) {
  console.error(
    "Set MULTILOGIN_EMAIL, MULTILOGIN_PASSWORD, and MULTILOGIN_WORKSPACE_ID in .env first"
  );
  process.exit(1);
}

const { token: initialToken, refreshToken } = await signIn(email, password);
const token = await switchWorkspace(initialToken, email, refreshToken, workspaceId);

const res = await get(token, `/workspace/folders?workspace_id=${workspaceId}`);
const folders = res?.data?.folders ?? [];

console.log(`\n=== Folders (workspace ${workspaceId}) — ${folders.length} total ===`);
for (const f of folders) {
  console.log(`  ${f.folder_id}  ${JSON.stringify(f.name)}  (profiles=${f.profiles_count})`);
}

if (filter) {
  const needle = filter.toLowerCase();
  const matches = folders.filter((f) => (f.name || "").toLowerCase().includes(needle));
  console.log(`\n=== Matches for "${filter}" — ${matches.length} ===`);
  for (const f of matches) {
    console.log(`  ${f.folder_id}  ${JSON.stringify(f.name)}  (profiles=${f.profiles_count})`);
  }
}

console.log("\nCopy the folder_id you want into FOLDER_ID in .env (or pass it to /profile/move).");
