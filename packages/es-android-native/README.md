# Desk — native Android client

Mobile-first Android app for the same product and backend as es-app: a personal front desk
over a fleet of agents. Kotlin + Jetpack Compose, no shared client code with es-app or the
WebView prototype. Application ID `ai.opencode.desk` (the WebView prototype keeps
`ai.opencode.editspace`).

## Design rationale

The desktop app is a workbench: sidebar of sessions, transcript, composer, panels. On a phone
the job is different. You are not operating agents; you are checking in. The three things a
check-in needs, in order:

1. Is anything waiting on me? (decisions and blockers, with enough to decide)
2. What is happening? (who is working, what changed)
3. Say something: ask the desk, start work, or steer one agent

So the information architecture is an inbox plus a messaging thread, not a dashboard.

- **Rows, not cards.** Every list is a full-bleed row with one colour rail or dot carrying the
  status. No bordered rectangles; the desktop's panels have no equivalent here.
- **One colour means one thing.** Amber = needs you. Red = blocked. Green = working.
  Violet = parked. Blue = the desk / your own words. OLED black behind everything.
- **Three text styles.** Title, Body, and a mono uppercase Label for metadata. Paths and
  commands use the same mono without the uppercase.
- **Progressive disclosure.** Home shows the top three decisions, the agents working now, and
  the last few decided items. Everything else is one tap deeper. Model and settings controls
  do not exist on the phone; the only settings surface is the connection label.
- **Native idioms.** Bottom `NavigationBar` for the three jobs, `ModalBottomSheet` for a
  decision (the list stays behind the scrim as context; drag or Back dismisses), predictive-back
  friendly single-activity stack, pull-to-refresh, IME-aware composers, edge-to-edge insets.
- **Cloudflare Access.** A gateway host behind Access answers with a redirect to
  `*.cloudflareaccess.com` or `WWW-Authenticate: Cloudflare-Access`; the client reports that as
  "behind Cloudflare Access" rather than offline. Connect accepts an optional service token
  (client ID + secret), stored in `EncryptedSharedPreferences`, sent as `CF-Access-Client-Id/Secret`
  only to the exact configured origin (scheme, host, port). Redirects are never followed.
- **Honest connection state.** Data stays visible when the gateway drops; the header says
  `offline · <reason>` and polling backs off. A lost pairing returns to the Connect screen.

Reference: manadj and manadj Android share one engine but the phone layout is redesigned around
the thumb (`~/manadj/android`). Same idea here: same contracts, different interaction model.
Like manadj Android, this app hand-rolls navigation and keeps all state in one ViewModel with
Compose state; unlike it, this app uses Material 3 components because inbox/sheet/nav idioms
are what Android users already know.

## Screens

| Screen | What it is |
|---|---|
| Connect | Gateway URL + pairing code. Stores the `es_remote` cookie in app-private prefs. |
| Desk (home) | Pulse line (working / need you / blocked / projects reachable), project filter chips (persisted), **Needs you** top 3, **Working now**, **Recently active**, **Decided**, docked composer. |
| Decision sheet | Kind chip, title, context (collapses past 5 lines), options as tall selectable rows with the recommendation marked, optional note, **Send to agent** (= `answer`), and under *More*: **Record only** (= `choose`), **Snooze 1h**, **Resolve**. Closed records show the outcome and delivery state. |
| Needs you | Open / Snoozed / History segments; unreachable projects called out. |
| Agents | Lanes grouped by project with live count. |
| Agent | Status line, current turn (elapsed, tool calls, running tool), plan (todos), pending inputs with Cancel, transcript tail (user bubbles, assistant prose with light markdown, tool runs folded into `bash ×7`), composer with **steer / queue** toggle and **Stop**. Opens at the newest message. |
| Desk conversation | The Front Desk session (`front-desk` agent). Created lazily with a client-chosen `ses_desk_…` id, one per paired gateway. Inputs go in as `queue`. Pending receipts render as bubbles with a sending state. |

## Contracts used

All traffic goes through the paired es gateway (`packages/es-desktop/src/server.ts`), default
`http://127.0.0.1:47120` over `adb reverse`. The client owns the gateway's rules: `Origin` on
every non-GET, `X-Attention-CSRF: 1` on attention writes, cookies persisted per host.

- Reads: `/es/api/editspaces`, `/es/api/state?es`, `/es/api/attention?view`,
  `/es/api/attention/session`, `/es/api/current-work`, `/oc/session/:id/{message,todo,input}`,
  `/es/api/notification-events` (SSE nudges → refetch; 20 s poll fallback, 5 s while offline).
- Writes: `POST /es/api/attention/session` (operator bootstrap, retried once on 401),
  `POST /es/api/attention/:id/commands` (`choose|answer|snooze|wake|resolve`, fresh `command_id`,
  `expected_revision`), `POST /oc/session/:id/input` (`{requestID, delivery, text}`),
  `DELETE /oc/session/:id/input/:rid`, `POST /oc/session/:id/abort`, `POST /oc/session`
  (client-chosen id, `agent: front-desk`).

Agents are derived from `/es/api/state` `threads[].lanes[]`: status is `busy` if any thread
session is live, `parked` from the lane record, else `idle`; the activity line is the lane's
`activity`, falling back to the lane name.

## Build, test, run

```sh
export JAVA_HOME=/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home ANDROID_HOME=~/Library/Android/sdk
./gradlew :app:assembleDebug            # app/build/outputs/apk/debug/app-debug.apk
ES_ANDROID_SERIAL=emulator-5590 node test/emulator.mjs   # fixture-backed behavioural run + screenshots
ES_ANDROID_SERIAL=emulator-5590 node test/realdata.mjs   # read-only run against :4096/:7777 via a throwaway gateway
```

`test/emulator.mjs` spawns `test/fixture.mjs` (a private stand-in for Core and the dashboard
in the verified live shapes) behind a real `es-android` gateway on a spare port, pairs a fresh
app install, then drives: pair → desk → decision sheet → answer → needs-you → agents → agent →
steer → stop → Back → desk composer → conversation. It asserts every write body the fixture
received and fails on any unknown route. Screenshots land in `dist/artifacts/`.

On the phone: `adb reverse tcp:47120 tcp:47120`, open Desk, enter the gateway URL and the
pairing code from the gateway's owner-only state file.

## What is real, what is not

- **Real:** everything rendered comes from the contracts above; both test runs exercise the
  same code paths. `test/realdata.mjs` screenshots show live sessions and real attention
  records (reads only).
- **Synthetic:** `test/fixture.mjs` data in `dist/artifacts/*.png` (titles like "Promote
  steers at tool boundaries").
- **Not implemented:** images/attachments in inputs; permission and question prompts (the API
  calls exist in `Api.kt`, no UI); desk briefs/visual evidence (needs `/oc/session/:id/children`
  through the gateway, see es-android `CONTRACTS.md` gaps); desk memory; push notifications or
  any background transport; TLS/tailnet; multi-gateway; Snooze picker beyond 1 h; receipt
  editing (`PATCH input`). Markdown in prose is limited to bold, inline code and headings.
- **Known rough edges:** `adb reverse` can be dropped by the shared adb server while other
  lanes run; the app surfaces that as `offline · Failed to connect`. The infinite status-dot
  pulse makes `uiautomator dump` slow (tests wait up to 60 s per step).
