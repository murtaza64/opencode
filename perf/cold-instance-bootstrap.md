# Cold Instance Bootstrap (#96 Followup)

## Live Evidence: 2026-09-16

- Coordinator reported a fresh `session-links` repo instance: `POST /session` exceeded 10 s; subsequent `GET /session/status?directory=...` exceeded 30 s with zero bytes. Warm orchestrator route remained healthy at 107 ms.
- Logs: instance creation at 17:41:58.026Z, bootstrap at 17:41:58.378Z, local config at 17:41:59.191Z. No intervening bootstrap-stage timing identifies the wait.
- A repo-scoped session appeared at 17:49:28.797Z, approximately 7m30s later. It may be the original timed-out POST finishing; caller identity is not proven. This was reported immediately to the owner to avoid treating the directory as empty or blindly retrying creation.
- Local config `package.json` and `package-lock.json` mtimes are 17:49:28Z, correlating recovery with dependency installation finishing.
- This lane's first bounded probe, at approximately 17:49:48Z: previously stalled directory returned 200 in 3.4 ms; warm control 200 in 6.5 ms. Recovery preceded this lane's probe. No live mutation or recovery action was performed.

## Operational Recovery

- No intervention was needed once the scoped read returned 200. Recheck existing session metadata before retrying a timed-out create; timeout does not prove non-admission.
- `POST /instance/dispose` is not an escape hatch for pending bootstrap: `InstanceContextMiddleware` awaits `InstanceStore.load()` before dispatching its handler.
- Direct `disposeDirectory()` and `reload()` also await the pending entry. Do not recommend either as cancellation of in-flight bootstrap.
- Request cancellation stops that waiter, not the process-scoped initialization fiber. Other directories can remain usable. An isolated InstanceStore regression verifies this behavior.
- No supported, proven per-directory cancellation route was found for an indefinitely pending boot. If it recurs, collect phase/network/lock evidence and escalate to the owner; do not delete locks, bypass plugin initialization, globally dispose, or restart.
- Coordinator was notified through the current-owner helper. No worker was spawned by this lane, no other lane was mutated, and no permission policy was changed.

## Ranked Causes

1. Registry/audit I/O during config dependency installation: consistent with cold-only delay and package/lockfile timestamps.
2. Waiting on another installer holding the directory's `EffectFlock` lock.
3. External plugin initialization or a config hook waiting on I/O.

The exact live cause remains unproven. Existing logs do not separate package fetches, audit requests, lock waits, or plugin initialization.

## Reproduced Source Defect

`Config.loadInstanceState` starts dependency installation; `Plugin.init` waits for it when external plugins exist. `Npm.install` calls Arborist `reify`, which awaits `auditReport` even though OpenCode never reads or reports that result. A slow audit endpoint can therefore hold cold instance admission after ordinary package retrieval is available. The core test preload disables auditing, so existing installer tests did not exercise this path.

The new regression uses the real installer, an in-memory synthetic package archive, a loopback registry, temporary caches, and isolated/restored npm configuration. Its audit endpoint waits on a gate. The assertion races install completion against arrival of the audit request; no elapsed-time assumption is required.

- Baseline: fails with `Expected: "installed"; Received: "audit"`. Cleanup releases the gate and lets the original installation settle.
- Fixed: installs and verifies package contents; only the package tarball is requested. Also passes when the invoking environment sets `NPM_CONFIG_OFFLINE=true`.
- Fix: force `audit: false` in the options used by both the Arborist constructor and `reify`. Explicit inherited audit settings are intentionally overridden for these internal installs. Other npm settings and package installation remain in force; plugin imports/config hooks and permission initialization are still awaited.
- This removes one demonstrated cold-bootstrap wait. It is not proof that auditing caused the live 7m30s incident, nor a general bound on network-dependent bootstrap.

## Verification

From `packages/core`:

```sh
bun test test/npm.test.ts test/npm-config.test.ts test/npm-audit.test.ts
NPM_CONFIG_OFFLINE=true bun test test/npm-audit.test.ts
bun typecheck
```

10 tests passed; injected-offline regression passed; typecheck passed. The final isolated regression was rerun against the old behavior and failed, then passed with the fix restored.

From `packages/opencode`:

```sh
bun test --timeout 30000 test/project/instance.test.ts
bun typecheck
```

10 InstanceStore tests passed, including cancellation during gated bootstrap, retry sharing the original boot, and independent-directory progress. Typecheck passed.

Independent review found inherited npm configuration could defeat fixture isolation. The fixture now clears/restores npm environment settings, uses empty temporary user/global config files, and uses `Bun.Archive` instead of an external `tar` command.

## Delivery

- New child of parked `tuymo/d5bb193`; the reviewed browser fix is preserved.
- Source change is internal Npm behavior; no public HTTP/schema change or code generation.
- Automated loopback-registry test is the walkthrough; no new UI surface.
- No production install/restart, live DB write, global disposal, lock deletion, push, or landing.
