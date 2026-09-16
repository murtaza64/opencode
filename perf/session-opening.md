# Session Opening (#96)

## Scope

- es-app reconciles snapshots by ID instead of remounting the transcript.
- Shared tool rendering emits `data-tool`; es-app no longer scans all parts and DOM nodes on every transcript mutation.
- Full history, reconnect resnapshots, event replay, and existing pagination contracts remain unchanged.
- No server or TUI production changes. Their reported multi-second latency was not reproduced.

## Measurements

2026-09-16, macOS arm64, Bun 1.3.14, Node 26.4.0, local Chrome, Vite development server. Baseline production code: `rrppn` / `69cc9`. Three same-process browser navigations per run, after opening an empty session to load application modules.

Synthetic browser history: 400 messages, 800 completed tools, 600 reasoning parts, 6,886,162 JSON bytes. Both snapshots still return the entire history. No live transcripts were copied into fixtures.

| Metric, ms | Baseline runs | Fixed runs |
| --- | --- | --- |
| Latest content + two animation frames | 831 / 961 / 825 | 800 / 773 / 903 |
| Browser check completion | 2186 / 2484 / 2466 | 1048 / 851 / 1004 |
| Initial history HTTP response | 24 / 25 / 19 | 26 / 22 / 19 |
| Follow-up history HTTP response | 267 / 1065 / 1064 | 188 / 318 / 336 |

`latest_frame_ms` is a DOM-sentinel/double-animation-frame proxy, not a compositor timestamp. Its ranges overlap: these runs do not establish a material first-frame improvement. `check_complete_ms` includes Playwright polling/assertions and driver round trips; it is not application-ready or server latency. Browser HTTP timings also include local main-thread scheduling. The measurable improvement is reduced work after initial content appears, not reduced payload size.

A Chrome CPU sample with snapshot reconciliation alone still attributed 666 ms to `stampTools`; emitting the attribute during rendering removes that function and observer. The sample also identified remaining ticket-reference scans and layout work, left unchanged.

### Live Read-Only Requests

- Example long session: 395 messages, 6.76 MB. Full HTTP/body/JSON parse: 184 ms first sample, 88 ms repeat. Latest 100 messages: 2.26 MB, approximately 26 ms warm.
- Other sampled histories: 1 message / 955 bytes; 11 / 259 KB; 107 / 2.82 MB. History requests approximately 3-57 ms; metadata 2-32 ms.
- Long-session todo, diff, status, permission, and question reads: approximately 0-2 ms warm.
- Sampled existing directories may already have been bootstrapped. These are first/repeated requests from the probe, not proven cold-daemon measurements. No daemon restart, live DB mutation, or stress test was performed.

Bounded metadata-only probe, with `SESSION_ID` and `DIRECTORY` supplied by the operator:

```sh
curl --silent --get --output /dev/null \
  --data-urlencode "directory=$DIRECTORY" --data-urlencode 'limit=100' \
  --write-out 'status=%{http_code} ttfb=%{time_starttransfer} total=%{time_total} bytes=%{size_download}\n' \
  "http://127.0.0.1:4096/session/$SESSION_ID/message"
```

### TUI

Real Session component/provider stack; synthetic 100-message, 200-tool, 140-reasoning-part, 2,058,129-byte response; 100x48 terminal; injected 40 ms transport delay.

| Run | Cold fixture mount to visible sentinel | Cached route reopenings |
| --- | --- | --- |
| 1 | 598 ms | 406 / 411 / 399 ms |
| 2 | 443 ms | 426 / 440 / 367 ms |

Cold excludes process/module startup. Default collapsed reasoning; sentinel visibility does not establish syntax-highlighter completion. All history and parts remained present, one `limit=100` request, no cached-reopen refetches or mutations. Multi-second TUI opening remains unexplained.

## Reproduce

Install with `bun install --frozen-lockfile` in the lane root. Never resolve dependencies through another checkout.

From `packages/es-app`:

```sh
node test/session-opening.browser.mjs
OPENING_BUDGET_MS=1500 node test/session-opening.browser.mjs
OPENING_PROFILE=1 node test/session-opening.browser.mjs
node test/session-opening.browser.mjs --serve
```

The budget is an optional local diagnostic, not a machine-independent CI threshold. `--serve` prints a free local URL backed only by synthetic fixture data. Stop with Ctrl-C. The browser harness requires local Chrome and uses the workspace Playwright dependency.

From `packages/tui`:

```sh
OPENCODE_TUI_SESSION_BENCH=1 bun test --timeout 30000 test/cli/tui/session-aside.test.tsx --test-name-pattern 'diagnostic: synthetic'
```

## Verification

- Before fix: store identity regression failed; final browser harness failed because reconnect detached the retained text node.
- After fix: browser harness passes full-history/part counts, latest content in viewport, authoritative removal/update, retained text node and expanded tool state across snapshot refresh, and mobile overflow checks.
- `packages/es-app`: `bun test --conditions=browser ./src` (131 passed); `bun run test:browser` (passed composer, reconnect, mobile/RTL scenarios).
- `packages/opencode`: `bun test --timeout 30000 test/server/session-messages.test.ts test/server/httpapi-session.test.ts` (26 passed, including full history, pagination and errors).
- `packages/session-ui`: `bun test src --only-failures` (83 passed).
- `packages/tui`: `bun test --timeout 30000 test/cli/tui/session-aside.test.tsx` (29 passed, diagnostic skipped); opt-in benchmark passed twice.
- Package `bun typecheck` passed in es-app, session-ui, and tui; es-app `bun run build` passed.
- Independent review found no production regression. Corrected its misleading `settled_ms` metric naming and added part-removal and expanded-tool-state coverage.

## Remaining Limits

- No claim that server latency or TUI opening is fixed. Actual cold instance bootstrap and the user's exact slow TUI session require a separate reproduction.
- Browser measurements use a development build, local transport, synthetic content, and an already-loaded application. They do not establish production percentiles.
- Existing initial SSE-open resnapshot is preserved to cover the pre-subscription event gap. Rendering still mounts complete history; ticket-reference scans, layout, and initial mount cost remain.
- No push, landing, global install, or live restart.
