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
| Land and activate tested modes | [#89](https://github.com/murtaza64/dotfiles/issues/89) | orchestrator / mode authors | Landed vxurq/59a41; daemon 1.18.31 active, new web UI port 3181 |
| Native nonblocking delegation | [#97](https://github.com/murtaza64/dotfiles/issues/97) | background-delegation-native-task-lifecycle-97 | Explicitly resumed after checkpointed restart; WIP rnoov |
| Session-opening latency | [#96](https://github.com/murtaza64/dotfiles/issues/96) | session-latency | Parked tuymo/d5bb1 preserved; author resumed for new cold-instance stall |
| Transcript session links and tooltips | [#98](https://github.com/murtaza64/dotfiles/issues/98) | session-links | Dispatched from lane root after repo-instance bootstrap timeout |
| Electron shell | [#95](https://github.com/murtaza64/dotfiles/issues/95) | electron-shell | Parked ntrvp/8a604, native preview; not landed |
| Visual j/k, logical gj/gk, relative line numbers | [#94](https://github.com/murtaza64/dotfiles/issues/94) | visual-vim | Parked wyzxx/dcbea, separate preview; not landed |
| Footer mode placement and Queue-only agent selection | [#89](https://github.com/murtaza64/dotfiles/issues/89) | tui-composer / web-composer | Web nllvl and TUI yottw landed in vxurq |
| Compact web controls and Alt+M | [#91](https://github.com/murtaza64/dotfiles/issues/91) | web-composer | Landed in vxurq |
| Safe es lifecycle / explicit input CLI | [#88](https://github.com/murtaza64/dotfiles/issues/88) | orchestration-fixes | Parked separately; needs compatible daemon |
| Service packaging | [#83](https://github.com/murtaza64/dotfiles/issues/83) | es-app-service | Parked separately |

## Integration Baseline

- Landed `vxurq/59a41` combines `wlrvm`, web footer `nllvl`, and TUI footer `yottw`, plus the Aside active-agent fix. Combined checks: 33 backend tests, 258 TUI passes/1 skip, 132 web tests, desktop/mobile browser checks and package typechecks passed.
- `povur` already includes the harness sync, Aside/input APIs, permission regression, original TUI/web composer work and integration fixes.
- Later default-workspace attention changes and the interrupt/resume nudge are not included merely because their files exist. Inspect their ready revisions first.
- Old pending-gates and session-search lane records need reconciliation with actual ancestry; do not land their code twice or delete their directories blindly.
- Binary and running daemon are 1.18.31. Live mode capabilities and desktop/mobile UI verified on port 3181. Default port 3100 remains on its old source to preserve in-memory drafts; serving merge tynop is parked separately.
- Aside now prefers the captured Session agent while retaining filtered history and explicit override precedence. The regression failed before the fix and passed afterward; independent review found no issues.

Machine-local session IDs, callback details and preview process ownership are kept in the coordinator lane's handoffs and issue comments.
