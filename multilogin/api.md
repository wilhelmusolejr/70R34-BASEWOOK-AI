# Profile Vault API

REST API for the Profile Vault dashboard. Backs the React frontend and is intended to be consumed by external automation agents (Codex, Claude, scripts).

- **Base URL (dev):** `http://localhost:4000`
- **Base URL (prod):** same origin as the frontend (server in `server/` serves both `dist/` and `/api`)
- **Content type:** `application/json` (file uploads use `multipart/form-data`)
- **Auth:** none enforced at the HTTP layer. Role-based gating happens client-side via `pv_session` in localStorage. Treat all endpoints as world-writable on the server.
- **IDs:** every entity uses MongoDB `_id` (24-char hex `ObjectId`). There is no numeric `id` field. The response shape often exposes both `_id` and `id` — they are the same value.

---

## Conventions

### Error shape

All errors are JSON with a `message` field:

```json
{ "message": "Profile not found" }
```

Common status codes:

| Code | Meaning |
|------|---------|
| 400  | Validation error (bad id, missing field, bad enum) |
| 404  | Resource not found |
| 409  | Duplicate (unique constraint violation) |
| 500  | Server error / DB / upstream API failure |
| 502  | Upstream `ipinfo.io` unreachable (proxy-log only) |

### Pagination & filters

`GET /api/profiles` and `GET /api/proxies` accept `?limit=N` (1–500). Proxies also accept `?skip=N`. Profiles also accept `?random=1` (with `limit`) for sampled output and `?status=<status>` for status filtering.

### Image URLs

Image responses include `filename` (e.g. `/images/abcd.png`). Prepend the API base URL to fetch the binary. The dev endpoint `GET /api/dev/images` lists files in the `public/images` dir.

### File uploads

Endpoints that accept images use `multipart/form-data` with field name `images` (repeat for multiple files). Sibling text fields are passed as form fields. JSON-shaped form fields (e.g. `assetTypes`, `imageTypes`) must be JSON-stringified arrays.

---

## Health & dev

### `GET /api/health`
Returns `{ "ok": true }`. Use as a liveness probe.

### `GET /api/dev/images`
Lists files in `public/images/`. Response: `{ files: [{ name, size, mtime }] }`.

---

## Auth — `/api/auth`

> No tokens or sessions. Login simply returns a sanitized user object; the frontend stores it in localStorage. There is no logout endpoint.

### `POST /api/auth/register`
Create a guest user.

**Body:**
```json
{ "username": "alice", "password": "secret" }
```

**Returns 201:**
```json
{ "user": { "id": "...", "username": "alice", "role": "guest", "profiles": [] } }
```

Errors: `400` missing fields, `409` username taken.

### `POST /api/auth/login`
**Body:** `{ "username": "...", "password": "..." }`
**Returns 200:** `{ "user": { id, username, role, profiles } }`
Errors: `400` missing, `401` invalid credentials.

### `PATCH /api/auth/users/:userId/profiles/:profileId`
Update assignment status of one of a user's assigned profiles.

**Body:** `{ "assignmentStatus": "pending" | "completed" }`
**Returns 200:** `{ "user": {...} }`
Errors: `400` bad status, `404` user or assignment not found.

---

## Profiles — `/api/profiles`

The central entity. Full schema lives in `server/src/models/Profile.js`. Every field has a default, so creating a profile only requires `firstName` + `lastName`.

### Status enum
`Available | Need Setup | Pending Profile | Active | Flagged | Banned | Ready | Delivered`

### Read shape (after `formatProfile`)

Reads include populated extras that don't exist on the raw document:

- `linkedPage` — full populated Page (or `null`)
- `linkedProxy` — full populated Proxy from singular `proxyId` (or `null`)
- `proxies[].proxyId` — populated to a Proxy object on read; must be sent back as a string id on write
- `images[].imageId` — populated Image object on read
- `createdBy` — `{ id, username, role }` or `null`
- `pageId` and `proxyId` are coerced to string ids in the response even though Mongoose populated them

### `GET /api/profiles`
List profiles.

**Query params:**
- `status` — must match the enum above
- `limit` — 1–500
- `random=1` (or `random=true`) — sample randomly. Requires `limit`.

**Returns:** `Profile[]` (formatted).

### `GET /api/profiles/:id`
Single profile, fully populated (page assets, page posts, proxy, proxies, images, createdBy).

### `POST /api/profiles`
Create one profile.

**Body:** any subset of profile fields plus optional `userId` (the creator). If `userId` resolves to a user with `role: "maker"`, the new profile is forced to `status: "Pending Profile"`. Duplicate selected-email check (`emails[].selected: true`) returns `409`.

**Returns 201:** `{ profile, user }` — `user` is the refreshed creator (or `null`).

### `POST /api/profiles/bulk`
Create many profiles in one shot.

**Body:**
```json
{
  "profiles": [{ "firstName": "...", "lastName": "..." }, ...],
  "userId": "<optional creator id>"
}
```

`insertMany` is `ordered: false` — partial success is possible. Maker users get all profiles forced to `Pending Profile`.

**Returns 201:** `{ created: <count>, profiles: [...], user }`.

### `PUT /api/profiles/:id`
Full overwrite (Mongoose `overwrite: true`). Use only if you intend to replace the entire document.

### `PATCH /api/profiles/:id`
Partial update. Body is run through `normalizeProfilePayload`:
- `pageId`, `proxyId`, `createdBy` empty/null strings → `null`.
- `proxies[]` entries are flattened to `{ proxyId: "<id-string>", assignedAt }` — populated objects are accepted.

Returns the fully populated formatted profile.

### `DELETE /api/profiles/:id`
Returns `204` on success.

### `DELETE /api/profiles/:id/images/:imageId`
Unassign an image from a profile (does not delete the Image doc). Cleans `image.usedBy`, `image.annotations`, and any HumanAsset's `numberProfileUsing` if the profile no longer references that asset.

### `POST /api/profiles/:id/tracker`
Append a tracker log entry.

**Body:** `{ "date": "YYYY-MM-DD" (optional, defaults to today in Asia/Manila), "note": "..." }`
**Returns 201:** populated profile.

### `POST /api/profiles/:id/proxies`
Create a Proxy doc and attach it to this profile's `proxies[]` array.

**Body:**
```json
{
  "entry": "host:port[:user:pass]",
  "type": "residential" | "isp" | "datacenter" | "mobile",
  "protocol": "http" | "https" | "socks5" | null,
  "status": "pending" | "active" | "inactive" | "dead" | "expired",
  "label": "...",
  "country": "...",
  "city": "...",
  "source": "...",
  "notes": "...",
  "tags": ["..."]
}
```

`type` is required. `entry` must be `host:port` minimum.
**Returns 201:** populated profile. `409` if a proxy with the same `host:port:user:pass` already exists.

### `POST /api/profiles/:id/proxy-log`
Append an IP-info entry to `proxyLog[]`. If `body.ip` is empty, the server resolves the request IP and queries `ipinfo.io`. Otherwise the body is treated as the source.

**Body (manual):**
```json
{ "ip": "1.2.3.4", "city": "...", "region": "...", "country": "...", "loc": "...", "org": "...", "postal": "...", "timezone": "..." }
```

**Returns 201:** populated profile. `502` if `ipinfo.io` is unreachable and no fallback IP is available.

### `GET /api/profiles/:id/images/download`
Streams a ZIP of all images attached to the profile (own `images`, plus the linked page's assets and post images). Content-type `application/zip`.

---

## Human Assets ("Images" in the UI) — `/api/human-assets`

> The frontend calls these "Images". The API and DB call them human assets. Don't mix terms within the same layer.

### Shape (after `formatHumanAsset`)

```jsonc
{
  "id": "ObjectId",
  "name": "Asset Name",
  "possibleProfiles": 0,             // numberPossibleProfile
  "usedBy": 2,                       // numberProfileUsing.length
  "numberProfileUsing": [{ ...populated Profile }],
  "images": [{                       // populated, plus mapImageDoc()
    "id": "...", "filename": "/images/...png",
    "annotation": "...", "type": "profile|cover|post|...",
    "sourceType": "scraped|ai-generated", "aiGenerated": false,
    "generationModel": null,
    "usedBy": [{ userId: { id, firstName, lastName, profileUrl } }],
    "annotations": [{ id, profileId, label, x, y, width, height }]
  }],
  "imageUsers":          { "<filename>": ["First Last", ...] },
  "annotationsByImage":  { "<filename>": [{ id, profileId, label, x, y, width, height }, ...] },
  "createdAt": "ISO", "updatedAt": "ISO"
}
```

### `GET /api/human-assets`
List all, sorted by `createdAt: -1`.

### `GET /api/human-assets/:id`
One asset, populated.

### `POST /api/human-assets`
Create an asset with one or more images. **`multipart/form-data`.**

**Form fields:**
| Field | Type | Notes |
|-------|------|-------|
| `name` | text | required |
| `numberPossibleProfile` | text (int) | optional |
| `imageAnnotation` | text | applied to each created Image |
| `imageSourceType` | text | `scraped` (default) or `ai-generated` |
| `aiGenerated` | text (`"true"`/`"false"`) | |
| `generationModel` | text | for AI assets |
| `imageTypes` | JSON-stringified array | one `type` per uploaded file (`"post"`, `"profile"`, `"cover"`, …). Defaults to `"post"`. |
| `numberProfileUsing` | text (CSV) or repeated field | profile ids that already use this asset |
| `images` | file (repeat) | required, ≥1 |

**Returns 201:** populated asset.

### `POST /api/human-assets/:id/images`
Append more images to an existing asset. Same form fields as `POST /api/human-assets` minus `name` / `numberPossibleProfile`. Updates `numberProfileUsing` as needed.

### `DELETE /api/human-assets/:id/images`
Remove images from the asset and delete their files.

**Body:** `{ "imageIds": ["...", "..."] }`
Removes from any Profile's `images[]`, deletes the Image docs, deletes the file on disk, recomputes `numberProfileUsing`.

### `POST /api/human-assets/:id/annotations`
Add a bounding-box annotation tying an image region to a profile.

**Body:** `{ imageId, profileId, label, x, y, width, height }`
Side-effects: pushes `image.annotations`, ensures `image.usedBy` and `humanAsset.numberProfileUsing` include the profile, ensures `profile.images[]` includes the image.

### `POST /api/human-assets/:id/assign-image`
Assign an existing image to a profile without an annotation.

**Body:** `{ imageId, profileId }`. Same side-effects as annotations minus the box.

### `GET /api/human-assets/:id/images/download`
Streams a ZIP of all the asset's images.

---

## Pages — `/api/pages`

Facebook page records. Each page can have a linked profile (the "owner"), a set of typed `assets` (profile/cover/post images attached at creation), and a `posts` array (text + images, can be AI-generated).

> **Note:** `linkedIdentities` is stored as an array on the model, but in practice only the first entry is used. The formatted response exposes it as a single `linkedIdentity`.

### Shape (after `formatPage`)

```jsonc
{
  "id": "ObjectId",
  "schemaVersion": 1,
  "pageName": "...",
  "pageId": "fb-page-id-string",
  "category": "...",
  "followerCount": 0, "likeCount": 0,
  "generationPrompt": "brand voice notes for AI post gen",
  "bio": "...",
  "linkedIdentity": { id, firstName, lastName, pageUrl } | null,
  "assets": [{
    "imageId": { ...populated Image },
    "type": "profile" | "cover" | "post",
    "postDescription": "...",
    "postedAt": null, "engagementScore": 0
  }],
  "posts": [{
    "id": "...", "post": "text...",
    "images": [{ ...populated Image }],
    "createdAt": "ISO", "updatedAt": "ISO"
  }],
  "createdAt": "ISO", "updatedAt": "ISO"
}
```

### `GET /api/pages`
List, sorted by `createdAt: -1`.

### `GET /api/pages/:id`
Populated page (with assets, posts, linkedIdentity).

### `POST /api/pages`
Create a page. **`multipart/form-data`.**

| Field | Type | Notes |
|-------|------|-------|
| `pageName` | text | required |
| `pageId` | text | external (Facebook) id, optional |
| `category` | text | |
| `followerCount`, `likeCount` | text (int) | |
| `generationPrompt` | text | seed prompt for post AI |
| `linkedIdentityId` | text | profile `_id`, optional |
| `bio` | text | |
| `engagementScore` | text (int) | applied to each created asset |
| `assetTypes` | JSON-stringified array | one type per uploaded image |
| `images` | file (repeat) | optional |

Side-effect: if `linkedIdentityId` is set, the linked Profile's `pageId` is updated to point at the new Page.

**Returns 201:** populated page.

### `PATCH /api/pages/:id`
Update the page's text fields and/or change the linked identity.

**Body keys (all optional):** `pageName`, `pageId`, `category`, `generationPrompt`, `followerCount`, `likeCount`, `bio`, `linkedIdentityId`. Setting `linkedIdentityId` to `""` clears it. Changing `bio` rewrites every asset's `postDescription` to the new bio.

When the linked identity changes, the **previous** profile's `pageId` is cleared (if it pointed at this page) and the new profile's `pageId` is set.

### `POST /api/pages/:id/posts`
Add a manual post. **`multipart/form-data`.**

**Form fields:** `post` (text), `images` (file, optional, repeat). At least one of the two must be present.

**Returns 201:** populated page.

### `POST /api/pages/:id/posts/generate`
Generate a single post via the GitHub Models endpoint and return it (does **not** save).

**Body:** `{ "instructions": "optional extra steering" }`
**Returns 200:** `{ "post": "...", "model": "..." }`
**Requires env:** `GITHUB_MODELS_TOKEN`. Optional: `GITHUB_MODELS_MODEL` (default `openai/gpt-4.1`), `GITHUB_MODELS_BASE_URL`, `GITHUB_MODELS_API_VERSION`.

### `POST /api/pages/:id/posts/bulk-generate`
Generate `count` posts (1–20) and **append them to the page**.

**Body:** `{ "count": 5, "instructions": "..." }`
**Returns 201:** `{ posts: ["..."], count, model, page: <formatted page> }`

### `POST /api/pages/:id/images`
Append images to the page's `assets`. **`multipart/form-data`.**

| Field | Type | Notes |
|-------|------|-------|
| `images` | file (repeat) | required, ≥1 |
| `assetTypes` | JSON-stringified array | one type per file |
| `postDescription` | text | falls back to `page.bio` |
| `engagementScore` | text (int) | |

If the page has no `bio` and `postDescription` is provided, the bio is updated.

### `GET /api/pages/:id/images/download`
ZIP of all images on the page (assets + post images).

---

## Proxies — `/api/proxies`

A pool of network proxies. Profiles reference them via singular `profile.proxyId` (primary) and array `profile.proxies[]` (all assignments).

### Enums

| Field | Allowed |
|-------|---------|
| `type` | `residential`, `isp`, `datacenter`, `mobile` (required) |
| `protocol` | `http`, `https`, `socks5`, or `null` |
| `status` | `pending`, `active`, `inactive`, `dead`, `expired` (default `pending`) |

### Shape (after `formatProxy`)

```jsonc
{
  "id": "ObjectId",
  "host": "gate.example.com", "port": 8080,
  "username": "user|null", "password": "pass|null",
  "source": "IPRoyal|null",
  "type": "residential",
  "protocol": "http|null",
  "label": "string|null",
  "status": "pending",
  "country": "US|null", "city": "NYC|null",
  "notes": "string|null",
  "tags": ["..."],
  "lastCheckedAt": "ISO|null",
  "lastKnownIp": "1.2.3.4|null",
  "expiresAt": "ISO|null",
  "cost": 12.5, "currency": "USD|null",
  "createdAt": "ISO", "updatedAt": "ISO"
}
```

### Uniqueness

Compound unique index on `{ host, port, username, password }`. Duplicates return `409`.

### `GET /api/proxies`
List proxies, sorted by `createdAt: -1`.

**Query params:** `status` (enum), `type` (enum), `limit` (1–500), `skip` (≥0).

### `GET /api/proxies/:id`
Single proxy.

### `POST /api/proxies/bulk`
Create many proxies in one shot. Used by the bulk-import flow.

**Body:**
```json
{
  "entries": ["host:port:user:pass", "host2:port2"],
  "type": "residential",
  "protocol": "http",
  "status": "pending",
  "source": "...", "country": "...", "city": "...",
  "notes": "...", "tags": ["..."]
}
```

`type` is required. Each entry is parsed as `host:port[:user:pass]`. Invalid lines are reported in `invalid[]` (not thrown). Insert is `ordered: false`, so duplicates from the unique index are surfaced per-entry.

**Returns 201:**
```json
{
  "created":      [<formatProxy>, ...],
  "createdCount": 12,
  "invalid":      [{ index, raw, reason }, ...]
}
```

### `PATCH /api/proxies/:id`
Partial update. Whitelisted fields:

- Strings (trimmed; empty → `null`): `host`, `source`, `label`, `country`, `city`, `notes`, `lastKnownIp`, `currency`
- Username/password (trim; empty → `null`)
- `port` (int 1–65535)
- Enums: `type`, `protocol` (`null` allowed), `status`
- `tags` (array of strings)
- `cost` (number, `null` allowed)
- Dates: `lastCheckedAt`, `expiresAt` (ISO; `null`/`""` clears)

`409` on duplicate `host:port:user:pass`. `400` on invalid enum/port/date/cost.

### Note on creating a proxy

There is **no** `POST /api/proxies` (single). To create one:
- For the pool: use `POST /api/proxies/bulk` with one entry.
- For a profile: use `POST /api/profiles/:id/proxies` (creates the Proxy and links it).

---

## Cross-cutting behaviors / gotchas

1. **`_id` is the only id.** Don't look for a numeric `id` field. The frontend treats `_id` and `id` as equivalent strings.
2. **Profile `pageId` ↔ Page `linkedIdentities` are kept in sync** by the `PATCH /api/pages/:id` and `POST /api/pages` handlers. If you change one directly, the other can drift.
3. **`proxies[]` is array (like images), `proxyId` is the primary singular.** Both can co-exist. The frontend's "primary proxy" pill reads from `proxyId`. Bulk operations on the pool don't touch profile assignments.
4. **Image uploads name files server-side.** Don't rely on uploaded `originalname`. The server renames to `image_<type>_<uuid><ext>` (human assets) or `page_<type>_<uuid><ext>` (page uploads).
5. **Maker role auto-status.** When `userId` belongs to a user with `role: "maker"`, both single and bulk profile creation force `status: "Pending Profile"`. Other roles use whatever the body says (or the default `Available`).
6. **Bulk create is best-effort.** `Profile.insertMany` and `Proxy.insertMany` both run with `ordered: false`. Some inserts can succeed while others fail.
7. **`PUT /api/profiles/:id` overwrites the document.** Use `PATCH` unless you mean it.
8. **No auth middleware.** Anyone who can reach the API can modify everything. Guest UI gating is a UX layer only.
9. **Proxy log uses `ipinfo.io`** when `body.ip` is empty. There is no API key — be mindful of rate limits.
10. **GitHub Models endpoint** is required for `posts/generate` and `posts/bulk-generate`. Set `GITHUB_MODELS_TOKEN` in `server/.env`.

---

## Quick reference — endpoint table

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/health` | Liveness |
| GET | `/api/dev/images` | List image files on disk |
| POST | `/api/auth/register` | Create guest user |
| POST | `/api/auth/login` | Verify credentials |
| PATCH | `/api/auth/users/:userId/profiles/:profileId` | Update assignment status |
| GET | `/api/profiles` | List (filter: status, limit, random) |
| GET | `/api/profiles/:id` | One, populated |
| POST | `/api/profiles` | Create one |
| POST | `/api/profiles/bulk` | Create many |
| PUT | `/api/profiles/:id` | Overwrite |
| PATCH | `/api/profiles/:id` | Update partial |
| DELETE | `/api/profiles/:id` | Delete |
| DELETE | `/api/profiles/:id/images/:imageId` | Unassign image |
| POST | `/api/profiles/:id/tracker` | Append tracker log |
| POST | `/api/profiles/:id/proxies` | Create proxy + attach |
| POST | `/api/profiles/:id/proxy-log` | Append IP-info entry |
| GET | `/api/profiles/:id/images/download` | ZIP of profile + page images |
| GET | `/api/human-assets` | List |
| GET | `/api/human-assets/:id` | One |
| POST | `/api/human-assets` | Create with images |
| POST | `/api/human-assets/:id/images` | Append images |
| DELETE | `/api/human-assets/:id/images` | Delete images |
| POST | `/api/human-assets/:id/annotations` | Add bbox annotation |
| POST | `/api/human-assets/:id/assign-image` | Assign image to profile |
| GET | `/api/human-assets/:id/images/download` | ZIP |
| GET | `/api/pages` | List |
| GET | `/api/pages/:id` | One |
| POST | `/api/pages` | Create with assets |
| PATCH | `/api/pages/:id` | Update |
| POST | `/api/pages/:id/posts` | Add manual post |
| POST | `/api/pages/:id/posts/generate` | AI-generate one (no save) |
| POST | `/api/pages/:id/posts/bulk-generate` | AI-generate N + save |
| POST | `/api/pages/:id/images` | Append assets |
| GET | `/api/pages/:id/images/download` | ZIP |
| GET | `/api/proxies` | List (filter: status, type, limit, skip) |
| GET | `/api/proxies/:id` | One |
| POST | `/api/proxies/bulk` | Create many |
| PATCH | `/api/proxies/:id` | Update partial |
