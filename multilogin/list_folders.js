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

const { MLX_EMAIL, MLX_PASSWORD, WORKSPACE_ID } = process.env;
if (!MLX_EMAIL || !MLX_PASSWORD || !WORKSPACE_ID) {
  console.error("Set MLX_EMAIL, MLX_PASSWORD, and WORKSPACE_ID in .env first");
  process.exit(1);
}

const { token: initialToken, refreshToken } = await signIn(MLX_EMAIL, MLX_PASSWORD);
const token = await switchWorkspace(initialToken, MLX_EMAIL, refreshToken, WORKSPACE_ID);

const folders = await get(token, `/workspace/folders?workspace_id=${WORKSPACE_ID}`);
console.log(`\n=== Folders (workspace ${WORKSPACE_ID}) ===`);
console.dir(folders, { depth: null });

console.log("\nCopy the folder `id` you want into FOLDER_ID in .env");
