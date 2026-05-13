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

const { MLX_EMAIL, MLX_PASSWORD, WORKSPACE_ID, BROWSER_TYPE = "mimic", OS_TYPE = "macos" } = process.env;

const { token: t0, refreshToken } = await signIn(MLX_EMAIL, MLX_PASSWORD);
const token = await switchWorkspace(t0, MLX_EMAIL, refreshToken, WORKSPACE_ID);

const candidates = [
  `/profile/browser_cores?browser_type=${BROWSER_TYPE}&os_type=${OS_TYPE}`,
  `/browser/cores?browser_type=${BROWSER_TYPE}&os_type=${OS_TYPE}`,
  `/profile/cores?browser_type=${BROWSER_TYPE}&os_type=${OS_TYPE}`,
  `/core/versions?browser_type=${BROWSER_TYPE}&os_type=${OS_TYPE}`,
  `/cores?browser_type=${BROWSER_TYPE}&os_type=${OS_TYPE}`,
];

for (const path of candidates) {
  const res = await fetch(`${MLX_BASE}${path}`, {
    headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
  });
  const text = await res.text();
  console.log(`\n${res.status}  ${path}`);
  console.log(text.slice(0, 800));
  if (res.ok) break;
}
