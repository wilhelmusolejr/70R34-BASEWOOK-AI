import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import "dotenv/config";

const MLX_BASE = "https://api.multilogin.com";
const API_BASE = process.env.API_BASE ?? "https://7or34.space";

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

async function getUser(id) {
  const res = await fetch(`${API_BASE}/api/profiles/${id}`, {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`GET /api/profiles/${id} ${res.status}: ${await res.text()}`);
  return res.json();
}

async function patchUserBrowsers(id, browsers) {
  const res = await fetch(`${API_BASE}/api/profiles/${id}`, {
    method: "PATCH",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ browsers }),
  });
  if (!res.ok) throw new Error(`PATCH /api/profiles/${id} ${res.status}: ${await res.text()}`);
  return res.json();
}

async function createProfile(token, { name, notes, workspaceId, folderId, browserType, osType, coreVersion }) {
  const body = {
    name,
    notes,
    tags: ["NEW"],
    workspace_id: workspaceId,
    folder_id: folderId,
    browser_type: browserType,
    os_type: osType,
    core_version: coreVersion,
    times: 1,
    parameters: {
      flags: {
        audio_masking: "mask",
        fonts_masking: "mask",
        geolocation_masking: "mask",
        geolocation_popup: "prompt",
        graphics_masking: "mask",
        graphics_noise: "mask",
        localization_masking: "mask",
        media_devices_masking: "mask",
        navigator_masking: "mask",
        ports_masking: "mask",
        proxy_masking: "disabled",
        screen_masking: "mask",
        timezone_masking: "mask",
        webrtc_masking: "mask",
      },
      storage: { is_local: false, save_service_worker: false },
    },
  };

  const res = await fetch(`${MLX_BASE}/profile/create`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`create ${res.status}: ${await res.text()}`);
  return res.json();
}

function extractNewProfileId(createResult) {
  const data = createResult?.data;
  if (!data) return null;
  if (Array.isArray(data.ids) && data.ids.length) return data.ids[0];
  if (Array.isArray(data.profile_ids) && data.profile_ids.length) return data.profile_ids[0];
  if (typeof data === "string") return data;
  if (Array.isArray(data) && data.length) return typeof data[0] === "string" ? data[0] : data[0]?.id ?? null;
  return data.id ?? data.profile_id ?? null;
}

async function main() {
  const {
    MLX_EMAIL,
    MLX_PASSWORD,
    WORKSPACE_ID,
    FOLDER_ID,
    BROWSER_TYPE = "mimic",
    OS_TYPE = "windows",
    CORE_VERSION = "130",
    PROFILES_FILE = "profiles.json",
    CREATE_DELAY_MS = "2000",
  } = process.env;

  const delayMs = Number(CREATE_DELAY_MS) || 0;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const missing = Object.entries({ MLX_EMAIL, MLX_PASSWORD, WORKSPACE_ID, FOLDER_ID })
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (missing.length) {
    console.error(`Missing required .env values: ${missing.join(", ")}`);
    process.exit(1);
  }

  const file = path.resolve(PROFILES_FILE);
  const entries = JSON.parse(await readFile(file, "utf8"));
  if (!Array.isArray(entries)) {
    console.error(`${PROFILES_FILE} must contain a JSON array`);
    process.exit(1);
  }

  console.log(`Signing in as ${MLX_EMAIL}...`);
  const { token: initialToken, refreshToken } = await signIn(MLX_EMAIL, MLX_PASSWORD);
  console.log(`Switching to workspace ${WORKSPACE_ID}...`);
  const token = await switchWorkspace(initialToken, MLX_EMAIL, refreshToken, WORKSPACE_ID);

  for (let i = 0; i < entries.length; i++) {
    if (i > 0 && delayMs > 0) await sleep(delayMs);

    const entry = entries[i];
    const id = typeof entry === "string" ? entry : entry?.id;
    if (!id) {
      console.log(`[${i + 1}] skipped: missing id -> ${JSON.stringify(entry)}`);
      continue;
    }

    let user;
    try {
      user = await getUser(id);
    } catch (err) {
      console.error(`[${i + 1}/${entries.length}] FAILED to fetch user ${id}: ${err.message}`);
      continue;
    }

    const fullName = `${user.firstName ?? ""} ${user.lastName ?? ""}`.trim();
    if (!fullName) {
      console.log(`[${i + 1}/${entries.length}] skipped: user ${id} has no firstName/lastName`);
      continue;
    }

    if ((user.browsers ?? []).some((b) => b.provider === "multilogin")) {
      console.log(`[${i + 1}/${entries.length}] skipped: ${fullName} (${id}) already has a multilogin browser`);
      continue;
    }

    console.log(`[${i + 1}/${entries.length}] Creating profile: ${fullName} [id=${id}]`);
    let result;
    try {
      result = await createProfile(token, {
        name: fullName,
        notes: id,
        workspaceId: WORKSPACE_ID,
        folderId: FOLDER_ID,
        browserType: BROWSER_TYPE,
        osType: OS_TYPE,
        coreVersion: Number(CORE_VERSION),
      });
    } catch (err) {
      console.error(`    FAILED to create multilogin profile: ${err.message}`);
      continue;
    }

    const profileId = extractNewProfileId(result);
    if (!profileId) {
      console.error(`    created but couldn't extract profile_id from response: ${JSON.stringify(result)}`);
      continue;
    }
    console.log(`    ok -> ${profileId}`);

    const nextBrowsers = [...(user.browsers ?? []), { browserId: profileId, provider: "multilogin" }];
    try {
      await patchUserBrowsers(id, nextBrowsers);
      console.log(`    assigned to user ${id}`);
    } catch (err) {
      console.error(`    FAILED to assign browser to user ${id}: ${err.message}`);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
