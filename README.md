# 70R34 BASEWOOK AI — Automation Platform

A Node.js backend that receives JSON task commands and executes automation sequences across multiple BASEWOOK accounts **in parallel** using [Hidemium](https://hidemium.io) anti-detect browser profiles controlled via Playwright + CDP.

---

## Table of Contents

- [How It Works](#how-it-works)
- [Prerequisites](#prerequisites)
- [Server Setup](#server-setup)
- [Configuration](#configuration)
- [Running the Platform](#running-the-platform)
- [Task Workflow](#task-workflow)
- [Available Actions](#available-actions)
- [API Reference](#api-reference)
- [Environment Variables](#environment-variables)
- [Project Structure](#project-structure)

---

## How It Works

```
HTTP POST /execute  →  runner.js (recursive step walker)
                            ↓
                    browserManager.js
                            ↓
              Hidemium API → open profile → CDP port
                            ↓
                    Playwright connects via CDP
                            ↓
              action handlers run on each browser in parallel
```

1. You send a **JSON task** to `POST /execute` (or edit `tasks.json` and run `npm run task`)
2. The runner opens N Hidemium profiles in parallel via the Hidemium local API
3. Each profile gets its own Playwright `page` object connected over CDP
4. The step tree is walked **recursively** — navigators change the page, leaves act on it
5. Each browser runs independently; one crash does not stop the others

---

## Prerequisites

| Requirement | Notes |
|---|---|
| **Node.js 18+** | [nodejs.org](https://nodejs.org) |
| **Hidemium** | Must be installed and running on the same machine. [hidemium.io](https://hidemium.io) |
| **Hidemium profiles** | Profiles must exist and be **logged into BASEWOOK** before running tasks |
| **Hidemium API token** | Settings → Generate token inside Hidemium |
| **GitHub Models token** *(optional)* | Only needed for AI-generated share messages |

---

## Server Setup

### 1. Clone the repository

```bash
git clone https://github.com/wilhelmusolejr/70R34-BASEWOOK-AI.git
cd 70R34-BASEWOOK-AI
```

### 2. Install dependencies

```bash
npm install
```

### 3. Configure Hidemium API token

Open `utils/browserManager.js` and replace the token on line 11:

```js
const API_TOKEN = "YOUR_HIDEMIUM_TOKEN_HERE";
```

### 4. Add your Hidemium profile IDs

Edit `config/profiles.json`. Add one entry per BASEWOOK account:

```json
[
  { "id": "your-profile-uuid-1", "port": 9222, "label": "Account 1" },
  { "id": "your-profile-uuid-2", "port": 9223, "label": "Account 2" }
]
```

> **How to find the UUID:** Open Hidemium → right-click a profile → Copy UUID.
> The `port` field is currently unused (ports are assigned dynamically by Hidemium), but keep it for reference.

### 5. Create the `.env` file *(optional — only for AI share messages)*

```bash
cp .env.example .env   # or create manually
```

```env
GITHUB_MODELS_TOKEN=your_github_pat_here
GITHUB_MODELS_MODEL=openai/gpt-4.1
GITHUB_MODELS_BASE_URL=https://models.github.ai/inference/chat/completions
GITHUB_MODELS_API_VERSION=2026-03-10
```

---

## Configuration

### `config/profiles.json`

Maps your Hidemium profiles to the runner. The runner picks profiles in order from index 0 up to the `browsers` count in your task.

```json
[
  { "id": "local-fd2ca2e6-...", "port": 9222, "label": "US Account 1" },
  { "id": "local-ab3cd4e5-...", "port": 9223, "label": "US Account 2" }
]
```

### `utils/browserManager.js`

The **only** file that talks to Hidemium. If you change the Hidemium API address (default `http://127.0.0.1:2222`) or token, edit it here.

---

## Running the Platform

### Option A — HTTP Server (recommended for production)

```bash
npm start
# Server runs on http://localhost:3000
```

Send tasks via `curl` or any HTTP client:

```bash
curl -X POST http://localhost:3000/execute \
  -H "Content-Type: application/json" \
  -d '{
    "taskId": "t1",
    "browsers": 2,
    "steps": [
      {
        "type": "homepage_interaction",
        "steps": [
          { "type": "scroll", "params": { "duration": 15 } },
          { "type": "like_posts", "params": { "count": 3 } }
        ]
      }
    ]
  }'
```

### Option B — Direct task file (development / one-off runs)

Edit `tasks.json` with your task, then:

```bash
npm run task
```

No server needed. Output goes directly to the terminal.

---

## Task Workflow

### Task shape

```json
{
  "taskId": "unique-id",
  "browsers": 10,
  "concurrency": 3,
  "steps": [ ...steps ]
}
```

- **`browsers`** — total number of profiles to run the task across
- **`concurrency`** — how many browsers run at the same time (optional, defaults to `browsers` — all at once). Use this to cap parallel load on low-spec machines.

### Step shape

```json
{
  "type": "action_name",
  "params": { },
  "steps": [ ]
}
```

- **`type`** — which action to run (see [Available Actions](#available-actions))
- **`params`** — action-specific parameters (all optional params have defaults)
- **`steps`** — child steps that run **after** this action completes on the same page

### Two kinds of actions

| Kind | What it does | Examples |
|---|---|---|
| **Navigator** | Changes what page the browser shows | `visit_profile`, `homepage_interaction` |
| **Leaf** | Acts on whatever page is currently open | `add_friend`, `like_posts`, `scroll` |

### Workflow example — visit profile, add friend, then go home and like posts

```json
{
  "taskId": "engagement-run",
  "browsers": 5,
  "steps": [
    {
      "type": "visit_profile",
      "params": { "url": "https://www.basewook.com/john.smith" },
      "steps": [
        { "type": "add_friend" }
      ]
    },
    {
      "type": "homepage_interaction",
      "steps": [
        { "type": "scroll", "params": { "duration": 20 } },
        { "type": "like_posts", "params": { "count": 5 } }
      ]
    }
  ]
}
```

Each of the 5 browsers runs this entire sequence independently and in parallel.

---

## Available Actions

### Navigators

| Action | Params | Description |
|---|---|---|
| `homepage_interaction` | *(none)* | Navigate to BASEWOOK home feed |
| `visit_profile` | `url` (string) | Navigate to a profile page |

### Feed Actions

| Action | Params | Description |
|---|---|---|
| `scroll` | `duration` (seconds, default 30), `direction` (`down`/`up`) | Scroll the current feed |
| `like_posts` | `count` (default 1) | Like N posts on the current feed |
| `share_posts` | `count` (default 1), `userIdentity` (string), `message` (string) | Share N posts. `userIdentity` triggers AI message generation; `message` is static override |
| `share_post` | `url` (string), `userIdentity` (string), `message` (string) | Share a specific post by URL |

### Profile Actions

| Action | Params | Description |
|---|---|---|
| `add_friend` | *(none)* | Send a friend request on the current profile page |
| `setup_about` | See CLAUDE.md | Fill all About sections (bio, city, work, education, etc.) |
| `setup_avatar` | `photoUrl` (string), `description` (string, optional) | Upload a profile picture from URL |
| `setup_cover` | `photoUrl` (string) | Upload a cover photo from URL |

### Utility

| Action | Params | Description |
|---|---|---|
| `wait` | `duration` (ms) | Pause for a fixed duration |

---

## API Reference

### `POST /execute`

**Request body:**

```json
{
  "taskId": "string (required)",
  "browsers": "number >= 1 (required)",
  "steps": "array of step objects (required)"
}
```

**Success response `200`:**

```json
{
  "taskId": "t1",
  "results": [
    { "profileId": "local-fd2ca2e6-...", "status": "success" },
    { "profileId": "local-ab3cd4e5-...", "status": "error", "error": "message" }
  ]
}
```

**Error response `400/500`:**

```json
{ "error": "description" }
```

---

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `GITHUB_MODELS_TOKEN` | No | — | GitHub PAT for AI share message generation |
| `GITHUB_MODELS_MODEL` | No | `openai/gpt-4.1` | Model to use for generation |
| `GITHUB_MODELS_BASE_URL` | No | `https://models.github.ai/inference/chat/completions` | API endpoint |
| `GITHUB_MODELS_API_VERSION` | No | `2026-03-10` | API version header |

---

## Project Structure

```
70R34-BASEWOOK-AI/
├── server.js               # Express entry point — POST /execute
├── runner.js               # Recursive step executor (core engine)
├── run-task.js             # CLI runner — reads tasks.json directly
├── tasks.json              # Editable task file for manual runs
├── config/
│   └── profiles.json       # Hidemium profile UUIDs
├── schemas/
│   └── actionSchemas.js    # Param shapes for all actions
├── actions/                # One file per action handler
│   ├── homepage_interaction.js
│   ├── visit_profile.js
│   ├── scroll.js
│   ├── like_posts.js
│   ├── share_posts.js
│   ├── share_post.js
│   ├── add_friend.js
│   ├── setup_about.js
│   ├── setup_avatar.js
│   └── setup_cover.js
└── utils/
    ├── browserManager.js   # Hidemium API + CDP connection (only file that knows Hidemium)
    ├── humanBehavior.js    # Anti-detection: humanClick, humanType, humanWait
    ├── generateMessage.js  # GitHub Models API — AI share message generation
    └── claudeApi.js        # Post context extraction helper
```

---

## Important Notes

- **Hidemium must be running** before starting the server — the platform connects to already-open profiles
- **Profiles must be logged into BASEWOOK** — the platform does not handle login
- **One crash does not stop others** — each browser runs in isolation via `Promise.allSettled`
- **Network errors are retried** — up to 3 attempts with 60s wait (covers proxy drops)
- **Anti-detection is built in** — all actions use human-like mouse movement, typing delays, and randomized waits via `utils/humanBehavior.js`
