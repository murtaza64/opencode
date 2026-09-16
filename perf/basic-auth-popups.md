# es-app Basic Auth Popups (#99)

## Finding

A backend `401` carrying `WWW-Authenticate: Basic` passes through both es-app API proxies unchanged. Browser authentication handling runs before application error handling; a background fetch or EventSource can therefore produce native login UI. This is a reproduced proxy behavior, not evidence of a Firefox defect.

The specific request behind the user's historical popup remains unidentified. Current live observations did not reproduce a challenge.

## Live Observation: 2026-09-16

Read-only, no credentials supplied, no response bodies recorded:

| Listener | Observed paths | Result |
| --- | --- | --- |
| 4096 daemon | `/global/health`, `/session/status` in an existing warm directory, `/global/event` | 200, no challenge |
| 7777 dashboard | `/api/editspaces`, `/api/notifications`, `/api/state`, `/api/events` | 200, no challenge |
| 3100 old es-app | `/`, the above paths through `/oc` and `/es` | 200, no challenge |
| 3181 modes es-app | `/`, the above paths through `/oc` and `/es` | 200, no challenge |
| Both es-app listeners | `/favicon.ico` | 404, no challenge |

- SSE bodies were cancelled immediately after response headers.
- Process inspection confirmed 3100 is Vite dev and 3181 is Vite preview. Current inspected process metadata contained no `OPENCODE_SERVER_PASSWORD` environment assignment; secret values were never printed. This does not establish historical configuration.
- The modes preview log contained no `401`, `WWW-Authenticate`, or `Unauthorized` match. It is not a complete access log and cannot identify the earlier request.
- These were bounded path probes, not a HAR from the user's tab. They do not rule out other background resources or earlier authentication state.

## Source Trace

- `packages/opencode/src/server/routes/instance/httpapi/middleware/authorization.ts`: configured-auth failures produce a 401 with a Basic challenge for typed APIs, raw UI/documentation, and relevant PTY requests.
- `packages/server/src/middleware/authorization.ts`: V2 API auth failures also produce Basic challenges.
- Workspace proxy and hosted-UI fallback can preserve an upstream challenge; not every challenge must originate in the local password checker.
- `packages/es-app/vite.config.ts`: `/oc` strips its prefix and targets OpenCode; `/es` targets the dashboard. Vite preview inherits `server.proxy`. Both previously forwarded upstream challenge headers.

## Isolated Reproduction

Real Vite dev and a freshly built Vite preview proxy to a loopback authentication fixture. It protects session metadata, EventSource, and dashboard state. The browser runs the actual es-app in a separate profile; no user tabs or real prompts are involved.

| Browser-observed request | Before | After |
| --- | --- | --- |
| `/oc/session/ses_a` | 401 + Basic challenge | 401, challenge absent |
| `/oc/event` | 401 + Basic challenge | 401, challenge absent |
| `/es/api/state` | 401 + Basic challenge | 401, challenge absent |

- Chrome CDP `Fetch.authRequired`: all three paths before; none after, in both dev and preview. The baseline probe cancels the synthetic challenges so automation can continue.
- Firefox: dev and preview pass header checks and show the application HTTP 401 error. Native challenge events are not instrumented in Firefox; no claim of capturing the user's Firefox dialog.
- All three browser responses are awaited before assertions, avoiding early success while background requests remain pending.
- Default regression fails on the old behavior (`challengePresent: true`); passes after restoring the filter.

## Fix and Auth Contract

`api-proxy.ts` removes `www-authenticate` only from upstream 401 responses at the `/oc` and `/es` proxies. HTTP status, response body, other headers, and request credentials are preserved. This intentionally suppresses challenge-based negotiation at these application API proxies, including non-Basic challenge values.

Unauthorized clients still receive 401. Correct synthetic credentials still produce 200 through both proxies; 403 remains 403. Direct upstream access still returns its Basic challenge. Daemon authentication, plugin/permission policy, listeners, and exposure are not changed. The existing app error handling presents HTTP 401; this does not add an in-app credential-entry flow.

## Verification and Walkthrough

From `packages/es-app`:

```sh
node test/auth-proxy.browser.mjs
AUTH_BROWSER=firefox node test/auth-proxy.browser.mjs
node test/auth-proxy.browser.mjs --serve
bun test --conditions=browser ./src
bun typecheck
```

Use `PLAYWRIGHT_BROWSERS_PATH` for a lane-local Firefox installation when needed. Chrome uses the existing local Chrome channel. `--serve` prints a spare loopback preview URL whose protected synthetic upstream intentionally produces a visible application HTTP 401 error. Ctrl-C/SIGTERM closes the fixture and removes its temporary build.

- Chrome and Firefox proxy/browser runs passed dev and fresh preview modes.
- es-app: 131 unit tests passed; typecheck passed. The browser harness builds the current app into a temporary directory.
- `packages/opencode`: `bun test --timeout 30000 test/server/httpapi-authorization.test.ts` — 9 tests passed, including genuine auth rejection/challenges and authorized behavior.
- Review findings corrected: wait for every protected browser request; register cleanup before setup can fail, and clean up serve mode on termination.

## Remaining Evidence Needed

If the real popup recurs, record its timestamp and triggering request's origin/path, status, and challenge scheme only. Do not share Authorization, cookies, password/token values, or query strings containing credentials. That distinguishes this reproduced proxy edge from an unrelated resource challenge.

No live restart, global install, deployment, push, landing, or permission change. Earlier parked `tuymo` and `vkqol` revisions are preserved.
