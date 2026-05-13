import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import "dotenv/config";

const MLX_BASE = "https://api.multilogin.com";
const API_BASE = process.env.API_BASE ?? "https://7or34.space";

const md5 = (s) => createHash("md5").update(s).digest("hex");

async function post(url, body, token) {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${url} ${res.status}: ${await res.text()}`);
  return res.json();
}

async function get(url) {
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`${url} ${res.status}: ${await res.text()}`);
  return res.json();
}

function maskUsername(username) {
  return String(username ?? "")
    .replace(/-sid-[^-]+/i, "-sid-***")
    .slice(0, 160);
}

async function main() {
  const { MLX_EMAIL, MLX_PASSWORD, WORKSPACE_ID, PROFILES_FILE = "profiles.json" } = process.env;
  const missing = Object.entries({ MLX_EMAIL, MLX_PASSWORD, WORKSPACE_ID })
    .filter(([, value]) => !value)
    .map(([key]) => key);
  if (missing.length) throw new Error(`Missing required .env values: ${missing.join(", ")}`);

  const entries = JSON.parse(await readFile(path.resolve(PROFILES_FILE), "utf8"));
  const signin = await post(`${MLX_BASE}/user/signin`, {
    email: MLX_EMAIL,
    password: md5(MLX_PASSWORD),
  });
  const token = signin.data.token;
  const refreshToken = signin.data.refresh_token;
  const workspace = await post(
    `${MLX_BASE}/user/refresh_token`,
    { email: MLX_EMAIL, refresh_token: refreshToken, workspace_id: WORKSPACE_ID },
    token,
  );

  const workspaceToken = workspace.data.token;
  const ids = [];
  const labelById = new Map();
  for (const entry of entries) {
    const userId = typeof entry === "string" ? entry : entry?.id;
    if (!userId) continue;

    const user = await get(`${API_BASE}/api/profiles/${userId}`);
    const fullName = `${user.firstName ?? ""} ${user.lastName ?? ""}`.trim() || userId;
    for (const browser of user.browsers ?? []) {
      if (browser.provider === "multilogin" && browser.browserId) {
        ids.push(browser.browserId);
        labelById.set(browser.browserId, fullName);
      }
    }
  }

  const metas = await post(`${MLX_BASE}/profile/metas`, { ids }, workspaceToken);
  for (const meta of metas.data?.profiles ?? []) {
    const id = meta.profile_id ?? meta.id ?? meta.uuid;
    const parametersProxy = meta.parameters?.proxy ?? null;
    const topProxy = meta.proxy ?? null;
    const proxy = parametersProxy ?? topProxy;
    const flags = meta.parameters?.flags ?? {};

    console.log(
      JSON.stringify({
        name: labelById.get(id) ?? id,
        id,
        hasParametersProxy: Boolean(parametersProxy),
        hasTopProxy: Boolean(topProxy),
        proxy: proxy
          ? {
              type: proxy.type,
              host: proxy.host,
              port: proxy.port,
              username: maskUsername(proxy.username),
            }
          : null,
        proxy_masking: flags.proxy_masking,
        webrtc_masking: flags.webrtc_masking,
        timezone_masking: flags.timezone_masking,
      }),
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
