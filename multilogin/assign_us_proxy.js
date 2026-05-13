import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import "dotenv/config";

const MLX_BASE = "https://api.multilogin.com";
const PROXY_BASE = "https://profile-proxy.multilogin.com";
const API_BASE = process.env.API_BASE ?? "https://7or34.space";

const US_STATES = [
  "alabama", "alaska", "arizona", "arkansas", "california",
  "colorado", "connecticut", "delaware", "florida", "georgia",
  "hawaii", "idaho", "illinois", "indiana", "iowa",
  "kansas", "kentucky", "louisiana", "maine", "maryland",
  "massachusetts", "michigan", "minnesota", "mississippi", "missouri",
  "montana", "nebraska", "nevada", "new_hampshire", "new_jersey",
  "new_mexico", "new_york", "north_carolina", "north_dakota", "ohio",
  "oklahoma", "oregon", "pennsylvania", "rhode_island", "south_carolina",
  "south_dakota", "tennessee", "texas", "utah", "vermont",
  "virginia", "washington", "west_virginia", "wisconsin", "wyoming",
];

const md5 = (s) => createHash("md5").update(s).digest("hex");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const randomState = () => US_STATES[Math.floor(Math.random() * US_STATES.length)];

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

async function getProfileMetas(token, ids) {
  const res = await fetch(`${MLX_BASE}/profile/metas`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ ids }),
  });
  if (!res.ok) throw new Error(`profile/metas ${res.status}: ${await res.text()}`);
  const json = await res.json();
  return json?.data?.profiles ?? [];
}

async function generateMlxProxy(token, { country = "us", region, city, protocol = "socks5", sessionType = "sticky", count = 1 } = {}) {
  const body = { country, protocol, sessionType, count };
  if (region) body.region = region;
  if (city) body.city = city;
  const res = await fetch(`${PROXY_BASE}/v1/proxy/connection_url`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok && res.status !== 201) {
    throw new Error(`proxy/connection_url ${res.status}: ${await res.text()}`);
  }
  const json = await res.json();
  const list = json?.data ?? [];
  if (!list.length) throw new Error(`proxy/connection_url returned no proxies for region=${region}`);
  return list[0];
}

function parseProxyString(s) {
  const [host, portStr, username, password] = String(s).split(":");
  return { host, port: Number(portStr), username, password };
}

async function partialUpdateProxy(token, profileId, proxy, protocol) {
  const body = {
    profile_id: profileId,
    proxy: {
      host: proxy.host,
      port: proxy.port,
      type: protocol === "socks5" ? "socks5" : "http",
      username: proxy.username,
      password: proxy.password,
    },
    parameters: {
      flags: {
        proxy_masking: "custom",
      },
    },
  };
  const res = await fetch(`${MLX_BASE}/profile/partial_update`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`profile/partial_update ${res.status}: ${await res.text()}`);
  return res.json();
}

async function getUser(id) {
  const res = await fetch(`${API_BASE}/api/profiles/${id}`, {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`GET /api/profiles/${id} ${res.status}: ${await res.text()}`);
  return res.json();
}

function parseMlxProxyUsername(username) {
  const out = {};
  const u = String(username ?? "");
  const m = u.match(/country-([a-z]{2})/i);
  if (m) out.country = m[1].toLowerCase();
  const r = u.match(/region-([a-z0-9_]+?)(?=-(?:sid|filter|city|isp|session)\b|$)/i);
  if (r) out.region = r[1].toLowerCase();
  const c = u.match(/city-([a-z0-9_]+?)(?=-(?:sid|filter|region|isp|session)\b|$)/i);
  if (c) out.city = c[1].toLowerCase();
  return out;
}

function isUsProxy(proxyObj) {
  if (!proxyObj) return false;
  const country = (proxyObj.country ?? proxyObj.country_code ?? "").toString().toLowerCase();
  if (country === "us" || country === "usa" || country === "united_states") return true;
  const parsed = parseMlxProxyUsername(proxyObj.username);
  if (parsed.country === "us") return true;
  return false;
}

function metaProfileId(meta) {
  return meta?.profile_id ?? meta?.id ?? meta?.uuid ?? null;
}

function proxyLabel(proxyObj) {
  if (!proxyObj) return "no proxy";
  const parsed = parseMlxProxyUsername(proxyObj.username);
  const location = [parsed.country, parsed.region, parsed.city].filter(Boolean).join("/");
  return `${proxyObj.type ?? "unknown"}://${proxyObj.host ?? "?"}:${proxyObj.port ?? "?"}${location ? ` (${location})` : ""}`;
}

function verifyProxyMeta(meta) {
  const proxy = meta?.parameters?.proxy ?? null;
  const proxyMasking = meta?.parameters?.flags?.proxy_masking;
  const issues = [];

  if (!proxy) issues.push("missing proxy");
  else if (!isUsProxy(proxy)) issues.push(`proxy is not US: ${proxyLabel(proxy)}`);
  if (proxyMasking !== "custom") issues.push(`proxy_masking is ${proxyMasking ?? "missing"}`);

  return {
    ok: issues.length === 0,
    issues,
    proxy,
    proxyMasking,
  };
}

async function verifyProfileProxy(token, profileId) {
  const metas = await getProfileMetas(token, [profileId]);
  const meta = metas.find((m) => metaProfileId(m) === profileId);
  if (!meta) {
    return {
      ok: false,
      issues: ["profile/metas did not return this profile"],
      proxy: null,
      proxyMasking: undefined,
    };
  }
  return verifyProxyMeta(meta);
}

async function main() {
  const {
    MLX_EMAIL,
    MLX_PASSWORD,
    WORKSPACE_ID,
    PROFILES_FILE = "profiles.json",
    PROXY_PROTOCOL = "socks5",
    PROXY_DELAY_MS = "1500",
    DRY_RUN,
    LIMIT,
  } = process.env;

  const missing = Object.entries({ MLX_EMAIL, MLX_PASSWORD, WORKSPACE_ID })
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (missing.length) {
    console.error(`Missing required .env values: ${missing.join(", ")}`);
    process.exit(1);
  }

  const dryRun = DRY_RUN === "1" || DRY_RUN === "true";
  const delayMs = Number(PROXY_DELAY_MS) || 0;
  const limit = Number(LIMIT) > 0 ? Number(LIMIT) : 0;

  const file = path.resolve(PROFILES_FILE);
  let entries = JSON.parse(await readFile(file, "utf8"));
  if (!Array.isArray(entries)) {
    console.error(`${PROFILES_FILE} must contain a JSON array`);
    process.exit(1);
  }
  if (limit > 0) {
    console.log(`LIMIT=${limit} -> processing only first ${limit} entry(ies)`);
    entries = entries.slice(0, limit);
  }

  console.log(`Signing in as ${MLX_EMAIL}...`);
  const { token: initialToken, refreshToken } = await signIn(MLX_EMAIL, MLX_PASSWORD);
  console.log(`Switching to workspace ${WORKSPACE_ID}...`);
  const token = await switchWorkspace(initialToken, MLX_EMAIL, refreshToken, WORKSPACE_ID);

  const userIds = entries.map((e) => (typeof e === "string" ? e : e?.id)).filter(Boolean);

  const allMlxIds = [];
  const labelById = new Map();
  for (const userId of userIds) {
    let user;
    try {
      user = await getUser(userId);
    } catch (err) {
      console.error(`FAILED to fetch user ${userId}: ${err.message}`);
      continue;
    }
    const fullName = `${user.firstName ?? ""} ${user.lastName ?? ""}`.trim() || userId;
    const mlxIds = (user.browsers ?? [])
      .filter((b) => b.provider === "multilogin" && b.browserId)
      .map((b) => b.browserId);
    if (!mlxIds.length) {
      console.log(`skip: ${fullName} (${userId}) has no multilogin browser`);
      continue;
    }
    for (const id of mlxIds) {
      allMlxIds.push(id);
      labelById.set(id, fullName);
    }
  }

  if (!allMlxIds.length) {
    console.log("No multilogin profiles to process.");
    return;
  }

  console.log(`Fetching metas for ${allMlxIds.length} multilogin profile(s)...`);
  let metas = [];
  try {
    metas = await getProfileMetas(token, allMlxIds);
  } catch (err) {
    console.error(`FAILED to fetch profile/metas: ${err.message}`);
    process.exit(1);
  }
  const metaById = new Map();
  for (const m of metas) {
    const id = metaProfileId(m);
    if (id) metaById.set(id, m);
  }

  let updated = 0;
  let skipped = 0;
  let failed = 0;
  let maskingFixed = 0;
  let verified = 0;

  for (let i = 0; i < allMlxIds.length; i++) {
    if (i > 0 && delayMs > 0) await sleep(delayMs);

    const profileId = allMlxIds[i];
    const meta = metaById.get(profileId);
    const currentProxy = meta?.parameters?.proxy ?? null;
    const flags = meta?.parameters?.flags ?? {};
    const name = labelById.get(profileId) ?? profileId;
    const tag = `${name} [${profileId}]`;

    if (isUsProxy(currentProxy)) {
      if (flags.proxy_masking !== "custom") {
        console.log(`[${i + 1}/${allMlxIds.length}] fixing proxy masking (${flags.proxy_masking ?? "missing"} -> custom): ${tag}`);
        if (dryRun) {
          console.log("    DRY RUN: would re-apply current proxy with proxy_masking=custom");
        } else if (!currentProxy.host || !currentProxy.port || !currentProxy.username || !currentProxy.password) {
          console.error("    FAILED to update proxy masking: current proxy metadata is missing credentials");
          failed++;
          continue;
        } else {
          try {
            await partialUpdateProxy(token, profileId, currentProxy, currentProxy.type ?? PROXY_PROTOCOL);
            const verification = await verifyProfileProxy(token, profileId);
            if (!verification.ok) {
              console.error(`    FAILED verification after masking fix: ${verification.issues.join("; ")}`);
              failed++;
              continue;
            }
            console.log(`    verified -> ${proxyLabel(verification.proxy)}, proxy_masking=${verification.proxyMasking}`);
            maskingFixed++;
            verified++;
          } catch (err) {
            console.error(`    FAILED to update proxy masking: ${err.message}`);
            failed++;
            continue;
          }
        }
      } else {
        const verification = verifyProxyMeta(meta);
        if (!verification.ok) {
          console.error(`[${i + 1}/${allMlxIds.length}] FAILED verification: ${tag} -> ${verification.issues.join("; ")}`);
          failed++;
          continue;
        }
        console.log(`[${i + 1}/${allMlxIds.length}] skip (already US, verified): ${tag}`);
        verified++;
      }
      skipped++;
      continue;
    }

    const region = randomState();
    console.log(`[${i + 1}/${allMlxIds.length}] assigning US/${region}: ${tag}`);

    if (dryRun) {
      console.log(`    DRY RUN: would generate country=us region=${region} and update profile`);
      continue;
    }

    let proxyStr;
    try {
      proxyStr = await generateMlxProxy(token, { country: "us", region, protocol: PROXY_PROTOCOL });
    } catch (err) {
      console.error(`    FAILED to generate proxy: ${err.message}`);
      failed++;
      continue;
    }
    const parsed = parseProxyString(proxyStr);
    if (!parsed.host || !parsed.port) {
      console.error(`    FAILED to parse proxy string: ${proxyStr}`);
      failed++;
      continue;
    }

    try {
      await partialUpdateProxy(token, profileId, parsed, PROXY_PROTOCOL);
      const verification = await verifyProfileProxy(token, profileId);
      if (!verification.ok) {
        console.error(`    FAILED verification after update: ${verification.issues.join("; ")}`);
        failed++;
        continue;
      }
      console.log(`    ok -> ${parsed.host}:${parsed.port} (${region})`);
      console.log(`    verified -> ${proxyLabel(verification.proxy)}, proxy_masking=${verification.proxyMasking}`);
      updated++;
      verified++;
    } catch (err) {
      console.error(`    FAILED to update profile: ${err.message}`);
      failed++;
    }
  }

  console.log(`\nDone. updated=${updated} maskingFixed=${maskingFixed} skipped=${skipped} verified=${verified} failed=${failed}${dryRun ? " (dry run)" : ""}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
