# OpenCode / es-app Work Queue

Coordinator: [#92](https://github.com/murtaza64/dotfiles/issues/92).
Tooling gaps: [#93](https://github.com/murtaza64/dotfiles/issues/93).

## Operating Rules

- Accept requests and feedback here; keep each implementation in an owned lane.
- Integrate reviewed, ready work independently. Do not wait for unrelated lanes.
- Separate requested, running, parked, included-in-candidate, landed and installed.
- Agent notices are evidence, not user instructions or permission to land/restart.
- Present a runnable walkthrough when a feature is ready; record verification and remaining limits.
- The user explicitly prioritized landing and activating the tested Aside/Queue/Steer slice on September 16. Coordinate its necessary restart and preserve other work; unrelated features retain review/restart gates.
- Fix small verified tooling friction; record larger gaps with reproductions and acceptance tests.
- Never infer completion or cleanup safety from idle/lease state alone.

## Queue

| Work | Issue | Lane | State |
|---|---|---|---|
| Land and activate tested modes | [#89](https://github.com/murtaza64/dotfiles/issues/89) | orchestrator / mode authors | First priority; specifically approved by user |
| Native nonblocking delegation | [#97](https://github.com/murtaza64/dotfiles/issues/97) | Not assigned yet | Created; dispatch next, do not hold modes rollout |
| Session-opening latency | [#96](https://github.com/murtaza64/dotfiles/issues/96) | session-latency | Dispatched; kickoff verified |
| Electron shell | [#95](https://github.com/murtaza64/dotfiles/issues/95) | electron-shell | Dispatched; kickoff verified |
| Visual j/k, logical gj/gk, relative line numbers | [#94](https://github.com/murtaza64/dotfiles/issues/94) | visual-vim | Dispatched; kickoff verified |
| Footer mode placement and Queue-only agent selection | [#89](https://github.com/murtaza64/dotfiles/issues/89) | tui-composer / web-composer | Web nllvl integrated; TUI follow-up in progress |
| Compact web controls and Alt+M | [#91](https://github.com/murtaza64/dotfiles/issues/91) | web-composer | Included in rolling candidate |
| Safe es lifecycle / explicit input CLI | [#88](https://github.com/murtaza64/dotfiles/issues/88) | orchestration-fixes | Parked separately; needs compatible daemon |
| Service packaging | [#83](https://github.com/murtaza64/dotfiles/issues/83) | es-app-service | Parked separately |

## Integration Baseline

- Rolling candidate `wlrvm` is based on `rrppn` (povur plus llqok/krrmk) and ready web footer `nllvl`. Current web tests: 132 passed, typecheck passed.
- `povur` already includes the harness sync, Aside/input APIs, permission regression, original TUI/web composer work and integration fixes.
- Later default-workspace attention changes and the interrupt/resume nudge are not included merely because their files exist. Inspect their ready revisions first.
- Old pending-gates and session-search lane records need reconciliation with actual ancestry; do not land their code twice or delete their directories blindly.
- The installed daemon was last observed as 1.18.18. A working development preview does not establish production installation.
- Queue-agent selection also exposed an Aside timing gap: it selects the last user admitted to its filtered snapshot rather than the active Session agent before the new assistant appears. Keep snapshot filtering but resolve the active agent from the captured Session; verify with the footer integration.

Machine-local session IDs, callback details and preview process ownership are kept in the coordinator lane's handoffs and issue comments.
