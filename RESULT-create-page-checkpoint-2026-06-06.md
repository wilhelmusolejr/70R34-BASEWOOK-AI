# Create-Page Checkpoint Analysis — June 6, 2026

**Question:** On June 6, 15+ profiles got checkpointed ("banned") on `create_page`,
while 30+ others created Pages fine. Earlier runs had no bans. What's the real driver?

> **CORRECTION NOTE:** An earlier version of this document concluded the bans were
> driven mainly by **account age**. Further analysis of the May 31 → June 5 runs
> **disproves that.** The real driver is **how many Pages are created per session/day**.
> The same young accounts that were banned on June 6 created Pages cleanly on June 5.
> This document has been rewritten to reflect the corrected, evidence-backed conclusion.

---

## TL;DR (read this first)

- **The driver is per-session / per-day page-creation VOLUME**, not account age and not
  the specific accounts.
- **Every run that created ≤ ~18 Pages had 0 bans** — across May 19, June 1–5, and the
  warmup runs. Example: `engage-and-add-20260605-084056` created **14 Pages → 14 successes,
  0 bans.**
- **The only run with mass bans created 61 Pages in one 8-hour session** —
  `auto-engage-20260606` → **20 checkpoints (33%)**, and the ban rate *climbed through the
  session* (~9% in the first third → ~59% in the last third).
- **Natural experiment (the proof):** the youngest cohorts (`6a1a5acd`, `6a1aeafc`,
  `6a1a6d48`) created Pages **successfully on June 5** in the 14-Page run, then were
  **banned on June 6** in the 61-Page run. Same accounts, one day apart. **Only the volume
  changed.** → Age is not the cause.
- **Three distinct outcomes after the "Create Page" commit** (don't conflate them):
  1. **SUCCESS** — FB serves the contact form → Steps 2–5 → Page URL saved.
  2. **NO-FORM** — Page committed but no contact form appears. **Mostly benign** (it shows
     up even on the *first* Page of a session), likely an FB flow variant. Not a ban.
  3. **CHECKPOINT** — redirected to `checkpoint/1501092823525282` → account flagged
     `Need Checking`. **This is the "ban."**
- **What changed on June 6:** dropping the age gate + raising the `chance` + pool
  auto-assign + 50+ Active profiles in one loop = **61 Page creations in a single session**,
  far past FB's tolerance. Previous sessions stayed ≤18 and flew under the radar.

---

## The evidence — page volume per session vs ban rate

Every page-creating run, by volume and outcome:

| Run (session) | Pages committed | Success | No-form | **Checkpoint (ban)** | **% ban** |
|---|---:|---:|---:|---:|---:|
| warmup 05-19 (×3) | 1 / 1 / 9 | ~all | 1 | **0** | **0%** |
| engage-and-add 06-01 | 1 | 1 | 0 | **0** | **0%** |
| engage-and-add 06-02 | 1 | 1 | 0 | **0** | **0%** |
| engage-and-add 06-04-101206 | 6 | 4 | 2 | **0** | **0%** |
| engage-and-add 06-05 (×3 small) | 1 / 1 / 3 | ~all | 0 | **0** | **0%** |
| **engage-and-add 06-05-084056** | **14** | **14** | 0 | **0** | **0%** |
| warmup 06-03-205431 | 18 | 12 | 6 | **0** | **0%** |
| warmup 06-04-060323 | 6 | 1 | 3 | 1 | 17% |
| **auto-engage 06-06-053445** | **61** | 34 | 7 | **20** | **33%** |

**The line is stark:** ≤18 Pages/session → essentially 0 bans. 61 Pages/session → 33% bans.
The single low-volume run that had a ban (warmup 06-04, 1 of 6) is a small-sample one-off.

### Within the 61-Page run, the ban rate rises as volume accumulates

| Window | Pages committed | Checkpoints | Ban rate |
|---|---:|---:|---:|
| 13:15 → 16:18 (first ~32) | 32 | 3 | **~9%** |
| 16:38 → 20:49 (last ~29) | 29 | 17 | **~59%** |

So even within one session, the first ~25–30 Pages were mostly fine and the danger zone
opened up after that. This is a cumulative rate limit, not a fixed on/off cap.

---

## The proof that it's NOT account age — June 5 vs June 6

The youngest accounts (the cohorts that got banned on June 6) **created Pages successfully
the day before**, in the low-volume June 5 session:

| Cohort | June 5 (14-Page session) | June 6 (61-Page session) |
|---|---|---|
| `6a1a5acd` | **4 successes** (Sara Ferrari, Alessia Barbieri, Massimiliano Bernardini, Rocco Leone) | **3/3 banned** (Sergio Marino, Iolanda Ferraro, Giacomo Bertolini) |
| `6a1aeafc` | **1 success** (Letizia Bellini) | **3/3 banned** (Noemi De Santis, Valentina Sanna, Giacomo Giordano) |
| `6a1a6d48` | **7 successes** | mixed (4 success, 2 ban) |

Same accounts, ~24 hours apart, opposite outcomes. Account age was effectively unchanged.
**The only variable that changed was how many Pages the session created (14 → 61).**

> The "age gradient" seen *within* the June 6 run was an artifact of batch ordering: the
> batch processes accounts oldest → youngest, so the youngest happened to run **last —
> exactly when cumulative session volume (and therefore ban probability) was highest.**
> Age correlated with the bans only because it correlated with *position in the volume
> ramp*, not because age itself causes the ban.

---

## What the failure looks like (per profile)

Every banned profile followed the same script in its `session.log`:

```
Starting: create_page
  [create_page] Assigned Page "…" from pool ...
  [create_page] Clicking "Create Page" to commit page creation...
  [create_page] Page committed — entering post-create phase (per-field retry).
  [onboarding] stamped pageSetAt = ...                          ← Page exists FB-side
  [create_page] Post-create email field not found within 15s ... ← FB served NO contact form
  [checkpoint] dumped HTML/PNG → .../checkpoint-post-create_page-...
Checkpoint hit during create_page — skipping remaining steps for this profile
Profile <id> status -> "Need Checking"
```

All bans were the **same** checkpoint: `checkpoint/1501092823525282` (FB's page-creation
gate), firing ~10–60 s after that account's own commit click. 11 of the 15 were caught by
`create_page`; 4 surfaced one step later on `switch_profile` (its `locator.waitFor: Timeout`
header is **misleading** — same checkpoint, just detected one step later).

### The 15 flagged profiles (all June 6, all checkpoint `1501092823525282`)

| Profile ID | Name | Caught at | Session length |
|---|---|---|---|
| `…224852c` | Ilaria Rizzi | create_page | 25m 26s |
| `…224852e` | Bernardo Gentile | create_page | 33m 11s |
| `…224852f` | Tiziano Marra | create_page | 32m 10s |
| `…2248530` | Flavia Damiani | create_page | 28m 32s |
| `…2249390` | Letizia Cattaneo | create_page | 26m 02s |
| `…2249397` | Dario Damiani | create_page | 33m 11s |
| `…2249399` | Massimo Mancini | switch_profile* | 29m 54s |
| `…224c339` | Sergio Marino | create_page | 30m 46s |
| `…224c340` | Iolanda Ferraro | switch_profile* | 30m 38s |
| `…224c342` | Giacomo Bertolini | create_page | 32m 23s |
| `…224c503` | Camilla Cossu | create_page | 30m 32s |
| `…224c509` | Delia Colombo | switch_profile* | 32m 30s |
| `…0141e17d` | Valentina Sanna | create_page | 34m 25s |
| `…0141e17e` | Noemi De Santis | switch_profile* | 32m 60s |
| `…0141e180` | Giacomo Giordano | create_page | 30m 18s |

\* = same page-creation checkpoint, surfaced on the next step.

---

## Supporting findings

**First-time failure.** None of the 15 had ever committed a Page before June 6 — earlier
attempts were skipped (age guard, then `chance` roll) or no-op'd (no `linkedPage` before
pool auto-assign existed). June 6 was their first real attempt — in a 61-Page session.

**Control group is clean.** All 34 June-6 successes ran the full happy path (contact form →
Steps 2–5 → Page URL saved). Session lengths (24–51 min) overlap the failures' (25–34 min),
so session length/workload is not the differentiator. The split is binary at one instant
right after commit: FB serves either the form (success) or the checkpoint (ban).

**Probabilistic, not a per-account flag.** Siblings created in the same second, committing
2 minutes apart, split both ways — consistent with a rising-probability rate limit.

---

## Conclusion

> The bans are caused by **too many Pages created from the same fleet in one session/day**,
> not by account age or by anything specific to the 15 accounts. Sessions that created
> ≤ ~18 Pages had ~0% ban rate (including young accounts); the one session that created 61
> Pages had a 33% ban rate that climbed as the session went on. The same young accounts
> created Pages cleanly the day before in a 14-Page session. FB's `create_page` gate is a
> cumulative, per-day/per-fleet rate limit; once a session pushes past roughly the
> mid-20s–30 Pages, each additional Page is increasingly likely to be checkpointed.

---

## Recommendations

1. **Cap Pages created per day / per session.** This is the fix. Evidence says **≤ ~15–18
   Pages per session is safe (0 bans)**; 61 was catastrophic. Set a hard fleet-wide daily
   cap (start conservative, e.g. 15) and a per-session cap. Spread page creation across
   many days.
2. **Don't rely on the age gate for this.** Young accounts created Pages fine at low volume
   — age was not the cause. (An age gate may still be reasonable for general account
   warmth, but it will NOT prevent the volume-driven bans.)
3. **Throttle `create_page` specifically.** In the engage loop, gate Page creation behind a
   global daily counter (pages created today across the fleet) and stop creating once the
   cap is hit — rather than letting an 8-hour batch mint 61 Pages.
4. **Spread / randomize, and create early.** The first ~25–30 Pages of a session were the
   safe ones; do page creation in small, dedicated, early sessions rather than as the tail
   of a long 50-profile engage batch.
5. **Fix the misleading `switch_profile` tracker header** so checkpoint failures aren't
   mis-labeled as switch_profile timeouts (4 of the 15 were).
6. **Treat NO-FORM separately from CHECKPOINT** in tracking — NO-FORM is mostly a benign
   FB flow variant (committed Page, no contact form), not a ban. Conflating them inflates
   the apparent failure rate.

---

## How this was determined (sources)

- Per-profile `session.log` files across all run folders under `logs/`.
- Checkpoint HTML/PNG dumps (`checkpoint-post-create_page-*`, `checkpoint-step-switch_profile-*`),
  all embedding `url: …/checkpoint/1501092823525282/`.
- Tracker headers from `[trackerLog] Logged` lines.
- Per-run volume/outcome aggregate across `*setup-and-page*`, `*auto-engage*`,
  `*engage-and-add*` runs (the table above).
- June 5 vs June 6 cohort comparison (`engage-and-add-20260605-084056` vs
  `auto-engage-20260606-053445`).
- Run configs from `logs/auto-loop.log` and `task-daily-engage.json`
  (June 6: `concurrency=6`, `openStaggerSeconds=60`, status=`Active`).
