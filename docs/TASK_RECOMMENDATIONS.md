# Task Recommendations — New Account Warm-Up

These guidelines apply when a task contains `setup_about`, `setup_avatar`, or
`setup_cover` — the presence of any of these signals a fresh, untrusted account.
Stack the wrong combination on day 1 and Facebook will checkpoint the profile
mid-session (see Emma Mitchell's `setup_avatar` checkpoint right after a
successful `setup_about`).

The TL;DR: **never run `setup_about` + `setup_avatar` + `setup_cover` in the
same session.** Spread them across days. The recommendations below name the
cheap-to-do steps you can run safely on day 1 and what to defer.

## Why this matters

Facebook's first-72h trust model weights:

- **Profile picture and cover photo uploads** as high-trust events. Doing both
  back-to-back on a brand-new account, immediately after filling out About,
  looks scripted — the exact behavior pattern automation tools produce.
- **Compound workload** (about + avatar + cover + page + posts + adds in one
  go) as a near-certain ban signal. Pacing matters more than total volume.
- **Uniform fleet timing** — N profiles starting the same task at the same
  second is detectable. Stagger.

`setup_about` alone is the lowest-risk of the three. `setup_avatar` and
`setup_cover` are the dangerous ones because they're media uploads on a
freshly-created account.

## Day-by-day staging

```
Day 1   : setup_about
Day 1-2 : home_feed × 2-3   (homepage_interaction → scroll)
Day 3   : setup_avatar
Day 3-4 : home_feed × 2-3
Day 5   : setup_cover
Day 5-6 : home_feed × 2-3
Day 7+  : add_friend × few
Day 10+ : setup_page_full
```

Rule of thumb: **one trust-heavy action per day, sandwiched in passive
browsing.** Reading the feed for ~5 minutes before and after a setup action
makes the timing distribution look like a real visit rather than a drive-by.

## What goes in a "new account day 1" task

```json
{
  "taskId": "warmup-day-1",
  "concurrency": 1,
  "steps": [
    { "type": "homepage_interaction",
      "steps": [{ "type": "scroll", "params": { "duration": 60 } }] },
    { "type": "wait", "params": { "min": 120, "max": 240 } },
    { "type": "setup_about" },
    { "type": "wait", "params": { "min": 180, "max": 300 } },
    { "type": "homepage_interaction",
      "steps": [
        { "type": "scroll", "params": { "duration": 45 } },
        { "type": "like_posts", "params": { "count": 1 } }
      ] }
  ]
}
```

Notice what's **not** there: no avatar, no cover, no page creation, no
friend requests. About fills metadata; the rest of the session looks like a
human reading the feed.

## What to do the day after `setup_about`

About is "done" enough overnight. Day 2 should be passive — feed scroll,
maybe one like — to let the trust score settle. **Don't** chain `setup_avatar`
the next morning. Wait at least 24h after about before any media upload, and
spread avatar/cover across two separate days.

```json
{
  "taskId": "warmup-day-2",
  "concurrency": 1,
  "steps": [
    { "type": "homepage_interaction",
      "steps": [
        { "type": "scroll", "params": { "duration": 90 } },
        { "type": "like_posts", "params": { "count": 2 } }
      ] }
  ]
}
```

## Setting up profile picture (day 3-ish)

Run `setup_avatar` **alone** for the trust-heavy action of the session.
Bracket it with feed activity so the upload isn't the first or last thing
the session does.

```json
{
  "taskId": "setup-avatar-day",
  "concurrency": 1,
  "steps": [
    { "type": "homepage_interaction",
      "steps": [{ "type": "scroll", "params": { "duration": 45 } }] },
    { "type": "wait", "params": { "min": 60, "max": 120 } },
    { "type": "setup_avatar" },
    { "type": "wait", "params": { "min": 120, "max": 240 } },
    { "type": "homepage_interaction",
      "steps": [{ "type": "scroll", "params": { "duration": 30 } }] }
  ]
}
```

## Setting up cover (day 5-ish)

Same shape as avatar day, with `setup_cover` instead. Don't combine them in
the same session — that's the exact pattern that triggers checkpoints.

```json
{
  "taskId": "setup-cover-day",
  "concurrency": 1,
  "steps": [
    { "type": "homepage_interaction",
      "steps": [{ "type": "scroll", "params": { "duration": 45 } }] },
    { "type": "wait", "params": { "min": 60, "max": 120 } },
    { "type": "setup_cover" },
    { "type": "wait", "params": { "min": 120, "max": 240 } },
    { "type": "homepage_interaction",
      "steps": [{ "type": "scroll", "params": { "duration": 30 } }] }
  ]
}
```

## What to avoid in the same task as a `setup_*` step

| Don't combine `setup_avatar` / `setup_cover` with | Why |
|---|---|
| `setup_about` (same session) | Compound workload — current Emma Mitchell checkpoint pattern |
| Each other | Two media uploads in one session on a new account = flag |
| `add_friend` | Friend requests from a profile with no photo are throttled and look spammy |
| `create_page` | Page creation is the highest-trust action; never on a same-day-as-uploads new account |
| `share_posts` × N | Sharing is fine in moderation, but not stacked on top of media uploads on day 1 |
| High concurrency (>2) | Fleet running identical setup at the same minute is detectable |

## What to do after a checkpoint

If a profile gets `CHECKPOINT detected` in its log:

1. **Stop running tasks** on that profile until it's manually resolved.
2. Open the profile in the anti-detect browser, complete FB's challenge by
   hand (ID upload, phone, friend tags — whatever it asks).
3. Wait 24-48h before resuming with passive feed activity only.
4. Don't retry the same step that triggered the checkpoint for at least a
   week — FB remembers the pattern.

The runner already short-circuits remaining steps when it sees `checkpoint`
in the URL (`runner.js`), so the rest of the session won't make things worse.

## Concurrency for warm-up days

Keep `concurrency: 1` for any task that contains a `setup_*` step. The point
of warm-up is to look like a single human, not a fleet. Stagger profile starts
across hours, not seconds — running 20 fresh accounts through `setup_about` at
the same minute defeats the purpose of the per-profile pacing.

For day 7+ engagement tasks (`like_posts`, `share_posts`, `add_friend`),
`concurrency: 2-3` is fine.

## Quick reference — what's "safe" for day 1

| Step | Safe day 1 on new account? |
|---|---|
| `homepage_interaction` + `scroll` | Yes |
| `like_posts` (1-2) | Yes, after some scroll |
| `setup_about` | Yes — but on its own |
| `search` + `scroll` | Yes |
| `setup_avatar` | **No — wait until day 3** |
| `setup_cover` | **No — wait until day 5** |
| `add_friend` | **No — wait until day 7** |
| `create_page` | **No — wait until day 10+** |
| `schedule_posts` | **No — needs a page first** |
| `share_posts` | Risky on day 1; safer from day 3 onward |
