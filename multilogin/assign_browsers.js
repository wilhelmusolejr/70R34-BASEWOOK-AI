import { readFile } from "node:fs/promises";
import path from "node:path";
import "dotenv/config";

const API_BASE = process.env.API_BASE ?? "https://7or34.space";
const PROFILE_IDS_FILE = process.env.PROFILE_IDS_FILE ?? "profile_ids.json";
const STATUSES = ["Need Setup", "Active"];
const DRY_RUN = process.argv.includes("--dry-run");

async function api(method, path, body) {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: body == null ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${method} ${path} ${res.status}: ${await res.text()}`);
  return res.json();
}

const raw = await readFile(path.resolve(PROFILE_IDS_FILE), "utf8");
const entries = JSON.parse(raw);
const byName = new Map();
const dupes = new Set();
for (const { fullName, profile_id } of entries) {
  if (!fullName || !profile_id) continue;
  const key = fullName.trim().toLowerCase();
  if (byName.has(key)) dupes.add(key);
  else byName.set(key, profile_id);
}
for (const key of dupes) byName.delete(key);

const seenIds = new Set();
const users = [];
for (const status of STATUSES) {
  const list = await api("GET", `/api/profiles?status=${encodeURIComponent(status)}&limit=500`);
  for (const u of list) {
    if (seenIds.has(u.id)) continue;
    seenIds.add(u.id);
    users.push(u);
  }
}
console.log(`Fetched ${users.length} users in statuses: ${STATUSES.join(", ")}`);

const todo = users.filter(
  (u) => !(u.browsers ?? []).some((b) => b.provider === "multilogin"),
);
console.log(`${todo.length} users still need a multilogin browser assignment`);

let assigned = 0;
let missing = 0;
let dupSkipped = 0;
for (const u of todo) {
  const fullName = `${u.firstName ?? ""} ${u.lastName ?? ""}`.trim();
  const key = fullName.toLowerCase();
  const selectedEmail = (u.emails ?? []).find((e) => e.selected)?.address ?? "(no selected email)";

  if (dupes.has(key)) {
    console.log(`  SKIP dup name "${fullName}" (${selectedEmail})`);
    dupSkipped++;
    continue;
  }
  const profileId = byName.get(key);
  if (!profileId) {
    console.log(`  MISS no multilogin profile for "${fullName}" (${selectedEmail})`);
    missing++;
    continue;
  }

  const nextBrowsers = [...(u.browsers ?? []), { browserId: profileId, provider: "multilogin" }];
  if (DRY_RUN) {
    console.log(`  DRY  "${fullName}" (${selectedEmail}) <- ${profileId}`);
  } else {
    await api("PATCH", `/api/profiles/${u.id}`, { browsers: nextBrowsers });
    console.log(`  OK   "${fullName}" (${selectedEmail}) <- ${profileId}`);
  }
  assigned++;
}

console.log(`\nDone. assigned=${assigned} missing=${missing} dupSkipped=${dupSkipped}${DRY_RUN ? " (dry run)" : ""}`);
