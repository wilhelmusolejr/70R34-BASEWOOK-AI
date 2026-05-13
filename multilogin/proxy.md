# Browser Profile Proxy Setup

How proxies are selected, validated, and bound to anti-detect browser profiles in
this project. All logic lives in `utils/browserManager.js` and is invoked by
`create-profile.js`.

## Two providers, two flows

| Provider | Proxy source | Bind point |
|----------|--------------|------------|
| **Hidemium** | Pulled from our own user API (`/api/proxies?status=pending`) and tested before assignment | Embedded in the Hidemium profile body at creation time (`body.proxy = "HTTP|host|port|user|pass"`) |
| **Multilogin X** | Generated on-demand from MLX's proxy service (`profile-proxy.multilogin.com/v1/proxy/connection_url`) | Written to the MLX profile via `POST /profile/partial_update` with a flat top-level `proxy` block |

The chosen provider is set by `BROWSER_PROVIDER=hidemium|multilogin` in `.env`.

## Hidemium proxy flow (the main path used by `create-profile.js`)

### 1. Pull a batch of pending proxies

`fetchPendingProxies(limit, country)` calls:

```
GET {USER_API_BASE_URL}/api/proxies?status=pending&limit=10&country=US
```

The API filters by country server-side, so we only get candidates that *claim* to
be in the required country.

### 2. Test each candidate through `ipinfo.io`

`testProxy(proxyString)` (browserManager.js:105) opens an `axios.get` to
`https://ipinfo.io/json` *through* the proxy, with a 20-second timeout. It does
NOT use a Playwright page — it's a Node-side HTTP test before the browser ever
launches.

Proxy string format expected here is **colon-separated**: `host:port:user:pass`.
That gets parsed into axios's proxy config shape via `parseProxyString`.

Outcomes:

- **Fetch fails (timeout, ECONN, auth):** mark the proxy `dead` via
  `PATCH /api/proxies/{proxyId}` and continue to the next candidate. Dead proxies
  are removed from the pending pool permanently.
- **Fetch succeeds but country ≠ requireCountry:** skip the proxy, **leave it
  pending** (it might match another user's needs). Don't mark dead.
- **Fetch succeeds and country matches:** mark `active` with `lastKnownIp`,
  assign to the user, return.

### 3. Batch loop — 5 rounds × 10 proxies = 50 max

`selectWorkingProxy` (browserManager.js:202) loops up to `MAX_PROXY_BATCHES = 5`
times, pulling fresh batches of `PROXY_BATCH_SIZE = 10` each round. If all 50
candidates fail or no more pending proxies exist, it throws
`No working US proxy found after 5 batches of 10`.

### 4. Link the working proxy to the user record

`assignProxyToUser` (browserManager.js:176) appends `{ proxyId, assignedAt }` to
the user's `proxies[]` array via:

```
PATCH {USER_API_BASE_URL}/api/profiles/{userId}
{ "proxies": [...existingEntries, { "proxyId": "...", "assignedAt": "ISO" }] }
```

Existing entries are preserved verbatim — the embedded shape in the user
document is just `{ proxyId, assignedAt }`, not the full proxy credentials.

### 5. Embed the proxy in the Hidemium profile body

The proxy gets reformatted from colon-separated to **pipe-separated with the
protocol prefix**:

```javascript
const [host, port, proxyUser, proxyPass] = proxy.split(':');
body.proxy = `HTTP|${host}|${port}|${proxyUser}|${proxyPass}`;
```

That's Hidemium's required format. Colon-separated will be silently rejected.

The full creation request:

```
POST http://127.0.0.1:2222/create-profile-custom?is_local=true
Authorization: Bearer <static token>
{
  "name": "<firstName> <lastName>",
  "proxy": "HTTP|host|port|user|pass",
  "os": "win", "osVersion": "10|11", "browser": "chrome", "version": "136",
  "canvas": "noise",
  "language": "en-US",
  "StartURL": "https://outlook.com",
  ... (fingerprint fields)
}
```

Hidemium uses the proxy's IP to auto-derive the profile's timezone and geolocation
(part of why proxy country must match the persona's country — otherwise FB sees
a US-named persona browsing from a Vietnam IP with a US timezone, which is a
major flag).

### 6. Save the IP info as a profile note

After creation, `POST /update-note` writes a multiline string with
`ip / hostname / city / region / country / loc / org / postal / timezone` to the
Hidemium profile note. This isn't functional — it's just visible in the Hidemium
UI for debugging. (Note can't be set on `create-profile-custom` itself — must be
a separate call.)

### 7. Link the browser to the user

```
PATCH {USER_API_BASE_URL}/api/profiles/{userId}
{ "browsers": [{ "browserId": "<uuid>", "provider": "hidemium" }] }
```

Now `openBrowserForUser(userId)` can find the profile by matching
`provider === BROWSER_PROVIDER`.

## Why test through axios, not Playwright?

Speed and isolation. The proxy test happens *before* Hidemium even creates the
profile. If we waited until the browser launched, we'd burn a profile slot on
every dead proxy. The axios-through-proxy test is ~20s max and validates both
reachability and country in one call.

(Note: this is the *opposite* of what `actions/check_ip.js` does at runtime —
that uses `page.evaluate(fetch)` because the request must travel through the
browser's CDP-bound proxy. At profile-creation time we don't have a browser
yet, so axios is correct.)

## Multilogin proxy flow (different shape)

MLX profiles already exist in the dashboard (we don't yet create them in code —
see `create-profile.js` TODO). When opening fails with
`GET_PROXY_CONNECTION_IP_ERROR`, `rotateMultiloginProxy` (browserManager.js:560)
recovers:

1. `POST /profile/metas` → read the profile's current proxy
2. Parse the proxy username for location tags (it's encoded as
   `..._multilogin_com-country-us-region-west_virginia-sid-XXX-filter-medium`)
3. `POST /v1/proxy/connection_url` with the same country/region/city → get a
   fresh IP with the same geo
4. `POST /profile/partial_update` with the **flat top-level** `proxy` block
   (NOT `parameters.proxy` — MLX silently no-ops that shape)

The rotation runs between retry attempts inside `openMultiloginProfile`, and is
followed by a stop call to clear any half-running profile state on the MLX
agent.

## Proxy lifecycle states

In our user API the `status` field on `/api/proxies` records:

- `pending` — never tested, or tested and works but country didn't match this
  user's need
- `active` — tested OK, currently assigned to a user, `lastKnownIp` set
- `dead` — failed the ipinfo test (timeout, auth, ECONN) — never reused

Country mismatch leaves a proxy `pending` rather than burning it, because
another user with a different `requireCountry` might still want it.

## Constants & env

| Constant / env | Value | Where |
|----------------|-------|-------|
| `BROWSER_PROVIDER` | `hidemium` or `multilogin` | `.env` |
| `USER_API_BASE_URL` | base URL for our user/proxy API | `.env` |
| `PROXY_BATCH_SIZE` | `10` | browserManager.js:33 |
| `MAX_PROXY_BATCHES` | `5` | browserManager.js:34 |
| `requireCountry` | default `'US'` | `createProfile` opts |
| Hidemium API | `http://127.0.0.1:2222` | browserManager.js:17 |
| MLX launcher | `https://launcher.mlx.yt:45001` | browserManager.js:25 |
| MLX proxy gen | `https://profile-proxy.multilogin.com/v1/proxy/connection_url` | browserManager.js:27 |

## Things that will bite you

- **Proxy string format:** axios expects `host:port:user:pass` (colon).
  Hidemium expects `HTTP|host|port|user|pass` (pipe + protocol). The
  reformat happens at browserManager.js:316-317. Don't shortcut it.
- **MD5 password for MLX signin:** `crypto.createHash('md5').update(password).digest('hex')` is
  required despite some MLX docs saying plaintext works.
- **MLX workspace token:** the plain signin token gets 403 on the launcher.
  You must do the second `/user/refresh_token` POST with `workspace_id` to get
  the workspace-scoped bearer.
- **Proxy country must match persona country:** mismatch → FB notices the
  timezone/IP/persona divergence and flags the account.
- **Don't reuse dead proxies:** the `dead` status is permanent in our schema.
  Don't write a "re-test dead proxies" loop without a separate flag.
- **Hidemium profile creation will succeed without a proxy** — `createProfile`
  catches the `selectWorkingProxy` throw and continues. Check logs for
  `Proceeding without proxy` if a profile seems geo-broken.
