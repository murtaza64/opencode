# #144 — OpenCode / es-app latency and transient-error profile

Date: 2026-10-05 19:45–20:30Z. Lane `runtime-profile`. Investigation only; nothing restarted, no writes to user sessions, no transcript bodies retained.
Issue: https://github.com/murtaza64/dotfiles/issues/144. Prior: #96 (session opening), #113 (send-to-first-text).

## System under test

| Hop | Identity |
|---|---|
| daemon :4096 | `~/.local/bin/opencode` SHA256 `d432e96a…` (the rolled-back backend), PID 84745, up 1h45m at start, RSS 1.0–5.3 GB, 45–200 % CPU idle-from-my-side. Log `log/opencode.log` frozen at 220,000,892 bytes since 18:11:41Z (size cap) — **no daemon logs for the last 2 h**. |
| web :3181 | vite preview (node), serving-modes lane; `/oc`,`/es` HTTP/1.1 proxies + WebSocket event mux |
| native :60302 | installed Electron, renderer PID 54017 at **~100 % CPU / 1.4 GB continuously**; es-desktop node http proxy (HTTP/1.1, no mux) |
| dashboard :7777 | es-dashboard PID 54573 (50–80 % CPU). A second, orphaned es-dashboard PID 40311 (1h32m old, no listener, still polling the daemon and still holding the native app's two `/es` SSE streams) exited on its own at ~19:54Z. |
| DB | `opencode.db` 17.4 GB, WAL mode, 1248 sessions (641 roots), 249 k messages |

## Harness (`docs/research/profile-144/`)

- `hops.sh N` — per-hop curl timings, bodies to `/dev/null`, p50/p95 vs budget. Red on non-200 or p95 > budget.
- `stall.sh DUR` — daemon event-loop stall detector (`/global/health` at 5 Hz) with CPU/RSS of daemon/dashboard/renderer per stall. Red on ≥ 1 s.
- `correlate.sh DUR` — 1 Hz health/CPU/RSS/events-per-second table.
- `nav.mjs` — Playwright against live :3181, GET-only (route interception aborts anything else), measures route→transcript paint, per-bucket request counts/bytes/queue time, long tasks, heap, DOM, and scans for the five error banners. `--ua-electron` forces the native-`EventSource` path; `--tabs N` shares one connection pool. Red on any banner or 4xx/5xx.

Repro of the headline:
```sh
export PLAYWRIGHT_DIR=/Users/murtaza/opencode/node_modules/.bun/@playwright+test@1.59.1/node_modules/@playwright/test
export ES_APP_URL=http://127.0.0.1:3181 SMALL=<id>@<dir> LARGE=<id>@<dir>
node docs/research/profile-144/nav.mjs --rounds 1 --ua-electron --tabs 2   # all four banners within 60 s
```
Fixtures used: small = 11-message root session; large = 774-message / 2962-part orchestrator session (9.3 MB JSON). Sanitized counter logs: `lanes/runtime-profile/handoffs/profile-144-evidence/`.

## Baseline numbers

Per hop (curl, N=5–10):

| Request | direct daemon | via :3181 |
|---|---|---|
| `/global/health` | 1 ms p50 | — |
| session list `limit=1600` (1248 rows, 966 KB) | 25–51 ms p50, **980 ms p95** | 23 ms p50 |
| `/es/api/state` | 39–51 ms | 47 ms |
| messages small (35 KB) | 4–14 ms p50 | 5 ms p50, **1034 ms p95** |
| messages large (9.3 MB) | 86–430 ms warm, 0.6–1.5 s cold | 136–876 ms |

Proxy overhead is nil; the tail latency is the daemon stalling, independent of request size.

Daemon event-loop stalls (`/global/health`, which does no work):

| Window | Condition | Result |
|---|---|---|
| 90 s | quiet | 3 stalls (308/525/823 ms) |
| 240 s | quiet | 203/210 < 50 ms, one 1071 ms; RSS swung 1.9 → 5.3 GB |
| 180 s | one browser tab opening small/large sessions | stalls 4.7 s, 6.3 s, 6.5 s; RSS 3.6 → 1.3 GB across them |
| 45 s | 3 sequential large fetches | third fetch **TTFB 40.5 s**; health stalled 10.1 s at **1.4 % daemon CPU** |
| 900 s (6 min captured) | mixed | 15 stalls ≥ 1 s (max 6.0 s); several at 1.7–8 % CPU, several at 95–195 % CPU |

Not deterministically reproducible: a later identical sequence of 4 large fetches ran 60–1100 ms each, and 3 concurrent large fetches finished in 0.6 s with one 530 ms hiccup.

Browser (Chrome, web :3181 WebSocket-mux path, 1 tab):

| Phase | paint | requests | notes |
|---|---|---|---|
| cold load, small | 130 ms after shell | **762** (232 status, 460 permission/question, 16 list pages, 1.5 MB) | sidebar activity fan-out |
| nav → large | 1.0–1.7 s | 7.9 MB fetched **twice** per navigation | 39 k DOM nodes, long tasks 0.8–1.6 s (max ~1 s), heap → 420 MB after 8 navs |
| nav → small | 150–280 ms | ~20 | fine |
| 20 s idle | — | **743** (28 list pages = 7 × `allSessions` ≈ 1.8 MB) | re-fetch on every `session.updated` |

Browser, Electron-UA (native `EventSource`, 4 SSE streams in the HTTP/1.1 pool):

| Tabs | result |
|---|---|
| 1 | request queueing 1.2–6.6 s on every navigation; large paint **12.0 s**, small 2.1–2.2 s; no banners |
| 2 (shared pool) | **all four banners** ("Could not load session relationships", "Session connection lost", "Unable to load session", "Unable to refresh activity"); paint timeouts at 60 s; 0 bytes transferred for messages |

Live native corroboration (read-only `lsof`, no CDP attach): renderer held exactly **6 established connections to :60302** — the Chromium per-origin cap — 4 outbound daemon upstreams, 2 to the dead dashboard 40311.

`summaryPatches=false` on daemon `d432`: 410-message session returned 99.77 MB with and without the flag; 4571 diffs all carrying `patch` (79.6 MB). **Not honored** (source has the projection at `packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts:115`; the installed binary predates it). The 774-message session has no patches, so the flag is irrelevant there.

Dashboard → daemon: 285 polled directories across 8 editspaces (`_session_dirs`, `bin/es-dashboard:277`) × 4 endpoints ≈ **1,148 requests per 45 s poll** (`poll_loop` :2127), plus a full `collect_sessions` for the editspace on **every** `session.status`/`session.idle`/permission event (`event_loop` :2238). Observed bursts of up to 92 concurrent daemon connections (httpx pool cap 100). Correlation with health: one 264 ms stall per ~90-connection burst; the daemon absorbs these. Measured-minor.

## Where each symptom originates

- **"Could not load session relationships"** — `packages/es-app/src/state.tsx:91`, set when `oc.allSessions(false)` throws. `allSessions` (`src/api.ts:67`) is 4 sequential pages (200/400/800/1600, 2.1 MB); any thrown fetch fails the chain. Triggered by connection-pool starvation (banner reproduced) and would also fire on a daemon socket close; not by slowness alone.
- **"Session connection lost. Reconnecting..."** — `src/live-session.ts:322`, `source.onerror` of the per-directory `/oc/event` SSE. In Electron this is a native `EventSource` (`src/event-source.ts:162`) competing for pool slots. Reproduced.
- **"Unable to load session"** — `live-session.ts:181`; the three-way snapshot load (`session`, `messages`, `status`) failed/aborted. Reproduced under starvation.
- **"Unable to refresh activity…"** — `src/session-activity.ts:192`; per-directory status/permission/question fan-out rejected. Reproduced.
- "Session could not be reached" verbatim does not exist in es-app or es-desktop source; nearest are the banners above and es-desktop's `{"error":"Attached service unavailable"}` 502 (`packages/es-desktop/src/server.ts:140`), emitted when the upstream `request()` errors — i.e. the daemon closing a socket mid-request during a stall. Directory/identity routing was not implicated: every probed session resolved on first request.

## Hypotheses

| # | Hypothesis | Verdict | Evidence |
|---|---|---|---|
| H1 | Electron's HTTP/1.1 per-origin 6-connection pool is saturated by 4 persistent `EventSource` streams, so ordinary requests queue and a second window starves everything | **Confirmed** | `--ua-electron --tabs 2` → all banners; 1 tab → 1–6.6 s queueing, 12 s large paint; live renderer at 6/6 connections |
| H2 | Sidebar activity machinery is request-amplifying: ~700 requests per load and per 30 s, plus a 2 MB `allSessions` refetch on every `session.updated` | **Confirmed** | 762 cold / 743 per 20 s idle; `session-activity.ts:203-265`, `state.tsx:86` |
| H3 | Daemon event loop stalls (0.5–40 s) are independent of request size and hit every client | **Confirmed as phenomenon; cause unattributed** | health stalls at 1–8 % CPU (blocked, not computing) and at 100–195 % CPU (GC/serialization); RSS churn 1–5 GB; stripped binary, no logs since 18:11Z |
| H4 | Dashboard poll fan-out (1,148 req/45 s, 90-connection bursts, event-triggered full re-collects) is a major daemon load | **Plausible, measured minor** | bursts correlate with ≤ 264 ms stalls only |
| H5 | Large transcripts cost client-side (parse+render), not transport | **Confirmed** for the 774-msg session: 9.3 MB in 0.1–0.5 s, 1–1.7 s to paint with 0.6–1 s long tasks; double fetch per navigation (`live-session.ts:314-318` refreshes on SSE open) |
| H6 | `summaryPatches=false` ignored by installed daemon; 61 MB-class sessions still ship patches | **Confirmed** (99.77 MB both ways) |
| H7 | Live native renderer's constant 100 % CPU is H2 + H5 + global/directory SSE reducers over a 1248-row session list | Plausible, **not measured** (no CDP attach to the user's window) |

## Ranked fixes

| Rank | Fix | Seam | Impact | Effort | Risk | Verify | Restart |
|---|---|---|---|---|---|---|---|
| 1 | Route Electron events through the same WebSocket mux as web (es-desktop server already proxies; add the `/__es/events` capability + ws upgrade), or at minimum collapse the 4 SSE streams into 1 | `packages/es-desktop/src/server.ts`, `packages/es-app/src/event-source.ts:162` | Removes the reproduced banner cluster and 1–6 s queueing in native; largest user-visible win | M | low–med (ws upgrade handling in the protected origin) | `nav.mjs --ua-electron --tabs 2` green; live renderer < 6 connections | native relaunch only |
| 2 | Stop refetching `allSessions` on every `session.updated`; patch the in-memory row from the event, and bound the status/permission/question fan-out to directories visible in the sidebar (or one `/global` call) | `session-activity.ts:217-265`, `state.tsx:86-95` | ~740 req / 20 s → tens; cuts daemon load from every open tab and renderer CPU | M | low | `nav.mjs` idle-soak `api_total.n` < 50 | none (web bundle) |
| 3 | Single snapshot per navigation: skip the `refresh()` on SSE `onopen` when a load is already in flight for the same session | `live-session.ts:314-318,188-194` | halves large-session bytes/parse (7.9 MB × 2 → × 1) | S | low | `nav.mjs` `messages.n` == 1 | none |
| 4 | UI: distinguish "queued/slow" from "lost": show a non-error pending state until a fetch actually rejects; keep stale rows instead of blanking; back off `allSessions` retries | `state.tsx:91`, `live-session.ts:181,322` | removes alarming transient errors even before 1–3 land | S | low | banner scan in `nav.mjs` stays empty under `--tabs 2` | none |
| 5 | Dashboard: cap concurrent daemon requests (semaphore ~8), debounce event-triggered `collect_sessions` (≥ 2 s), and only poll editspaces with a live subscriber | `bin/es-dashboard:2127,2238,298` | removes 90-connection bursts; modest daemon relief | S | low | `lsof` dash→4096 max ≤ 8; `correlate.sh` no 264 ms burst stalls | dashboard restart |
| 6 | Daemon: add request-timing/stall instrumentation (log a warning when a tick exceeds 250 ms with the active route) and fix the 220 MB log cap/rotation | `packages/opencode/src` server/log | makes H3 attributable; no direct latency win | S | low | log advances past cap; stall warnings present | **daemon restart** |
| 7 | Activate a daemon build with the `summaryPatches` projection (already in source) | handler `session.ts:115` | 99 MB → ~20 MB for patch-heavy sessions | 0 (code exists) | activation risk per serving notes | hops.sh large on a patch-heavy session | **daemon restart** |
| 8 | Transcript virtualization / lazy part bodies for > 300-message sessions | es-app timeline | 1–1.7 s paint and 39 k DOM nodes → sub-second | L | med | `nav.mjs` large paint < 500 ms | none |

Confirmed bottlenecks: H1, H2, H5, H6. Plausible/unmeasured: H3's root cause, H4 beyond minor, H7, and send-to-first-text.

## Not measured

- Send-to-first-text breakdown (admission / runner preparation / provider stream / render): no disposable fixture was run inside the bounded window; #113's method stands. Nothing here contradicts it, and fixes 1–2 remove the client-side queueing that would mask provider latency in native.
- Live native renderer internals (no CDP attach to the user's window). Chrome-side numbers above are from a disposable headless profile against :3181.
- Daemon stall attribution (needs fix 6 or a symbolized build).

## Hygiene

Two raw message bodies and one raw event capture were briefly written to `/tmp` during early probing and removed (verified absent, no readers); all later probes used `/dev/null` bodies or in-memory counters. No prompts, replies, mutations, restarts or permission changes. The orphan dashboard 40311 exited on its own, not by this lane.
