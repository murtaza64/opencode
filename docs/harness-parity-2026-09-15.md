# Harness Parity, 2026-09-15

## Decision

- **P0a: Aside / Steer / Queue.** Murtaza's incidental "what's state of v2" question displaced the main task. An aside is human-to-agent input, not an agent asking the human a question. It needs a concurrent, tool-free call over a context snapshot, isolated from the parent transcript, draft, abort signal, and execution state. Only explicit promotion may affect the parent.
- **P0b: Nonblocking agent-to-user questions.** Accept immediately, persist question IDs and pending state, continue independent work, and deliver a later answer as new user input. Silence, preselection, skipping, and elapsed time never authorize dependent work.
- Keep the OpenCode client/server deployment, `oc-server`, TUI, and es workflow. Add small V1/TUI seams now and share durable contracts with V2 where practical. Native V2 is a migration candidate, not a ready whole-product replacement.
- Existing hooks, compaction, plans, snapshots, skills, MCP, and experimental background subagents are not missing from V1. The consequential gaps are interaction isolation, durable human input, reliable background delivery, and execution recovery. See the matrix and source map below.

## Release Baselines

| Surface | Observed baseline | Interpretation / evidence |
| --- | --- | --- |
| Installed fork | `1.18.18` | Observed with `opencode --version`; not replaced during this investigation. |
| Fork work preserved | `38a144411010e6e0ee65fd945f3d4e8b401b1071` | Merged with upstream without conflicts in isolated jj workspace `harness-sync`. New concurrent default-workspace work is not included. |
| Fetched upstream `dev` | `e03db9bc6908f75c9334d8aa997deeaac81c0298`, September 14, 21:41:36 UTC | [Official commit][oc-head]; `jj log --count` found 299 commits beyond the fork's ancestry; previous common ancestor `2cba7e227d68a7e7e4a2aa9c85b808e8ecb14daf`. |
| Latest public OpenCode release | `1.18.31`, September 14 | [Release][oc-release]; merged `packages/opencode/package.json:3` and `packages/core/package.json:3` agree. |
| OpenCode `v2.0.0` | Tag exists; no corresponding GitHub release observed | [Tag][oc-v2-tag] versus [releases][oc-releases]. A tag or native V2 source namespace does not establish a shipped V2 product. |
| Claude Code latest CLI | `2.1.272`, September 15, 00:42:25 UTC | [Release][c-release]; latest substantive notes are [2.1.271][c-substantial]. |
| Claude Code stable channel | `2.1.236`, release August 19 | [Stable channel][c-stable] was behind latest. CLI version is not Desktop or SDK version. |
| Codex stable CLI/runtime | `0.154.0`, September 9, 22:35:38 UTC | [Release][k-release]; stable tagged code is the comparator source baseline. |
| Codex prerelease | `0.155.0-alpha.6`, September 15, 02:00:26 UTC | [Alpha][k-alpha], not proof of stable capability. |
| Codex Desktop / Python SDK | Desktop changelog `26.908`, September 11; Python SDK `0.154.0`, September 10 | [Changelog][k-changes] / [SDK release][k-python]; separate publication and delivery surfaces. |

Keep four gates separate: installed executable and daemon build; merged source and flags; client UI and model-catalog exposure; account/provider/OS/cloud rollout. None implies the next. Model choice alone does not supply question delivery, persistence, scheduling, sandboxing, or another harness's clients. [Claude availability][c-availability], [Codex maturity][k-maturity], [Codex catalog][k-catalog].

## Execution Boundaries

- The current TUI calls legacy `session.prompt`, which posts `/session/{sessionID}/message`; es-app posts `/session/{id}/prompt_async`. Both execute V1. Importing the legacy SDK's `/v2` namespace does **not** select native V2. Source S1.
- Native V2 posts `/api/session/{sessionID}/prompt`, mounted alongside V1. Its admission writes a durable inbox input before an advisory wake; execution promotes inputs at provider-turn boundaries. Source S2.
- V2 steer joins at a safe boundary; queue waits until continuation would otherwise end. Durable events replay, but execution ownership is process-local. Stored inputs/events are not automatic crash recovery. Sources S2-S3.
- V2 still lacks the native task/MCP tool path, V1 instruction-loading parity, and V1 lifecycle-hook parity. Manual `compact`, `wait`, direct `session.shell` and `session.skill` APIs return `OperationUnavailableError`; automatic compaction and model-facing Bash/Skill tools exist. Sources S4, S7-S8.
- Both question implementations await an in-memory `Deferred`. Other already-started tools may finish, but the question blocks the next provider turn. Event delivery and HTTP reply routes do not make the model-facing question asynchronous or its pending state restart-safe. Source S5.
- V1 background tasks are flag-gated. Follow-ups chain after the current job segment, not live steering; completion injects a synthetic parent prompt, with injection errors ignored. Merged task code propagates child assistant/tool failures, but that is not durable result delivery. Source S6.

## Capability Matrix

Classification describes the specific mechanism: **Present** = implemented at the stated surface; **Partial** = narrower semantics; **Experimental** = explicit preview/flag or unfinished native execution path; **External** = supplied by es, deployment tooling, or another product; **Missing** = no equivalent found in the audited native paths, not a claim about every third-party plugin. Claude/Codex product gates remain applicable.

| Capability | Claude Code | Codex | OpenCode V1 + fork | Native V2 | Evidence |
| --- | --- | --- | --- | --- | --- |
| Human aside | Present: terminal `/btw`, context-aware, tool-free, outside main conversation | Present: `/side` or `/btw`, ephemeral fork | Missing: isolated aside contract | Missing: steer is parent input, not aside | [C][c-interactive], [K][k-commands]; S1-S2 |
| Steer versus queue | Present: mid-turn input, queue withdrawal, explicit interrupt | Present: Enter steers, Tab queues; `expectedTurnId` | Partial: ordinary prompt submission, no explicit equivalent durable delivery contract | Present in source: separate durable steer/queue | [C][c-interactive], [K][k-server]; S1-S3 |
| Async human questions | Partial: blocking `AskUserQuestion`; headless defer pauses workflow | Present, catalog-gated: immediate acceptance; answer is later user message | Missing: question tool waits | Missing: question tool waits | [C][c-input], [K][k-async]; S5 |
| Structured blocking questions | Present: choices, multi-select, free text | Experimental blocking `request_user_input`, separate from shipped async tool | Present, client/flag-gated | Present, pending state memory-only | [C][c-tools], [K][k-blocking]; S4-S5 |
| Plans and review gate | Present: plan mode and approval/revision | Present: plan mode and plan events | Present: plan agent; experimental `plan_exit` exposure | Partial: agent/permission machinery; `plan_exit` absent | [C][c-modes], [K][k-commands]; S4, S9 |
| Foreground subagents | Present: isolated contexts, custom agents | Present: delegated threads and follow-ups | Present: task sessions with permissions/depth | Missing: task leaf not ported | [C][c-agents], [K][k-agents]; S4, S6 |
| Background subagents | Present; persistent agent view is research preview | Present: multiagent threads, dashboards | Experimental: background flag, completion notification | Missing from built-in execution tools | [C][c-agent-view], [K][k-agents]; S4, S6 |
| Mailbox / teams | Present messaging; teams experimental | Present inter-agent follow-ups; not an es claim system | External es orchestration; no native durable mailbox | Missing native mailbox | [C][c-messaging], [C teams][c-teams], [K][k-agents]; S4, S6, S13 |
| Generic background shell/MCP | Present: background commands/MCP, bounded monitors | Present shell sessions; no blanket equivalent for every MCP call | Missing first-class generic lifecycle; subagent job support is narrower | Missing: Bash waits for completion | [C][c-tools], [K][k-server]; S6, S10 |
| Declarative multiagent workflows | Present: dynamic workflows, limits; no arbitrary mid-run human stages | Partial: delegation, plans, headless APIs | External es; Experimental confined MCP code mode, not equivalent workflow engine | Partial extension primitives; no task/code-mode parity | [C][c-workflows], [K][k-headless]; S4, S11, S13 |
| Goals / automatic continuation | Present `/goal`, transcript-based evaluator | Present persisted goals and continuation | Missing native goal evaluator | Missing native goal evaluator | [C][c-goals], [K][k-goals]; S2, S4, S13 |
| Schedules / event triggers | Present local loops/Desktop; cloud routines research preview | External product: Desktop schedules, eligible web/mobile triggers | External scheduler/agent orchestration; no native schedule engine | Missing native schedule engine | [C][c-schedules], [C cloud][c-routines], [K][k-scheduled]; S13 |
| Lifecycle hooks | Present; agent-based handlers experimental | Present command/MCP hooks; async command restrictions | Present plugin lifecycle hooks; not identical event vocabulary | Partial plugin API, not V1 hook parity | [C][c-hooks], [K][k-hooks]; S7 |
| OS sandbox / approvals | Present opt-in Bash sandbox, not whole harness | Present platform sandbox, separate approval policy | Partial approvals; Missing native OS sandbox | Partial permission assertions; host-authority Bash | [C][c-sandbox], [K][k-sandbox]; S10 |
| Model-reviewed approvals | Present separate safety classifier; eligibility gates | Present optional `auto_review`; reviewer defaults to human | Missing equivalent reviewer: TUI auto mode directly approves requests | Permission machinery does not establish reviewer parity | [C][c-modes], [K][k-approval]; S14 |
| Instructions / auto-memory | Present hierarchical instructions and default auto-memory | Present instructions; stable memory feature off by default | Present instructions; Missing built-in auto-memory, external skills possible | Partial instruction loading; Missing built-in auto-memory | [C][c-memory], [K][k-memory]; S8 |
| Compaction | Present automatic/manual/selective | Present automatic/manual; context-management experiment separate | Present automatic/manual and plugin hooks | Partial: automatic present, manual API unavailable | [C][c-checkpoints], [K][k-server]; S7-S8 |
| History / resume / crash recovery | Present saved sessions; interrupted processes not restored | Present saved threads/resume; live processes separate | Partial: saved history plus External restart re-prompt | Partial: durable input/events, explicit resume, no crash auto-recovery | [C][c-sessions], [K][k-server]; S2-S3, S12 |
| File checkpoints / rewind | Present, with shell/subagent/external-effect exclusions | Partial: history revert, worktree snapshots; not universal per-tool undo | Present snapshots/revert; jj correctness not established here | Present source snapshot/revert path, not whole-client parity | [C][c-checkpoints], [K][k-worktrees]; S9 |
| Worktree / lane ownership | Present worktree isolation; teams not automatically isolated | Present Desktop; CLI worktrees experimental/off | External es jj lanes, claims, parked review; fork umbrella view | External es remains authority; no replacement established | [C][c-worktrees], [K][k-worktrees]; S13 |
| MCP / skills / plugins | Present, with transport/auth/tool-search gates | Present; IDE plugin support differs from app/CLI | Present; Experimental code mode/deferred discovery | Partial skills/plugin registration; missing MCP runtime parity | [C][c-mcp], [K][k-mcp]; S4, S7, S11 |
| MCP elicitation | Present forms/URL interactions | Present separate MCP elicitation request flow | Missing: client elicitation capability disabled | Missing general MCP runtime | [C][c-mcp], [K][k-server]; S11 |
| Client/server / remote | Present local CLI/SDK; Remote Control/cloud account-gated | Experimental app-server/remote protocol despite first-party use | Present oc-server, TUI, es-app; deployment-owned networking | Present native API source; client migration incomplete | [C][c-remote], [K][k-server]; S1-S2, S12 |
| Visibility / operational state | Present status, tasks, usage, OTel; traces beta | Present item events, status, doctor, OTel | Present session/tool UI; External es fleet state; Partial durable background visibility | Present replayable events; Partial end-to-end job visibility | [C][c-monitoring], [K][k-advanced]; S3, S6, S12-S13 |
| Effective context/tool inspection | Present `/context`, tool visibility | Present effective/bundled model catalog inspection | Partial `debug agent` and token sidebar; not full effective-request inspection | Context records exist; complete inspector not established | [C][c-interactive], [K][k-commands]; S15 |
| Browser previews / computer use | Desktop previews; computer use research preview with OS/account gates | Product-specific browser/preview/computer-use features | External integrations possible; no equivalent bundled flow established in tool audit | No equivalent bundled flow established | [C][c-desktop], [C computer][c-computer], [K][k-news]; S4 |

## Why Asides Derail Work

V1 persists a new question in the parent's transcript, selects the latest user message, and associates subsequent assistant messages with it. Once an assistant answer finishes without pending tool calls, the loop can exit; it does not independently verify that an earlier requested task is complete. This explains susceptibility to the observed failure, not a trace-level reconstruction of the running session. `packages/opencode/src/session/prompt.ts:1057,1096,1111-1129,1188`.

This upstream merge adds `session/prompt/gpt-astra.txt:27`, telling agents to answer mid-task questions briefly in commentary and continue. `session/system.ts:36` selects it for matching GPT-6 model IDs. That is a useful prompt-level mitigation, not enforced aside isolation or a continuation guarantee. Provider/model routing and higher-priority instructions still matter.

The other directly relevant upstream change makes `task` propagate child assistant/tool errors rather than reporting an empty successful result. It does not add reliable completion delivery. Existing experimental background subagents and V2 durable inputs predate this sync; they should not be credited as newly added features. Source S6.

## P0a: Aside Contract

Use three explicit input intents, visible before submit: **Aside** asks about current work without changing it; **Steer** changes current work at a safe boundary; **Queue** requests a later task. Do not infer intent from punctuation or silently treat all busy-session input as steering.

- Capture immutable context at an identified parent message/event boundary. Include committed conversation and an explicitly labeled activity snapshot; do not expose a half-written provider request as stable context.
- Run the aside concurrently with a separate request ID and cancellation scope. Advertise no tools and reject attempted tool execution in the host. No task delegation, shell, MCP, execution hooks, parent compaction, or parent prompt admission.
- Show the snapshot time/boundary so "current state" is not mistaken for live verification. A tool-free answer may say the snapshot is insufficient; obtaining new evidence requires an explicit tool-using action.
- Keep the parent transcript, unfinished composer text, attachments, cursor, active turn, and abort state unchanged. Aside failures, closing the panel, or cancellation must not cancel/finalize the parent.
- Only an explicit **Promote** action may submit selected side content, with a visible choice of Steer or Queue. Show exactly what will be sent; deduplicate retries. Do not inject the side answer as a hidden task-completion prompt.
- Implement a separate server operation plus a TUI panel/command, not a plugin that rewrites the parent prompt. Reuse provider configuration and a read-only context projection, not `SessionPrompt.loop` or ordinary tool-enabled `task`. V2 must share the isolation contract, not merely rename its steer endpoint. Sources S1-S2, S6.

### Acceptance Scenarios

Run after implementation against a disposable server/database and temporary lane, never the production daemon. Use a controllable provider fixture for concurrency assertions and a manual TUI pass for draft/focus behavior. These are acceptance procedures, not claims that new commands already exist.

1. Start parent work with a tool held on a test latch. Type an unsent draft with an attachment. Open Aside and ask "what's state of v2". Answer must render before releasing the parent tool; parent transcript and draft remain byte-for-byte unchanged. Release the latch; the original task continues to completion.
2. Make the aside provider emit a tool call. Assert no tool executor or side-effecting hook runs, no parent user message is added, and the side panel reports the unsupported action. Parent execution remains active.
3. Cancel an aside, close its panel, then force an aside timeout. In each case assert the parent cancellation signal remains unset and no parent completion/abort event is produced by that action. Repeat while the parent naturally finishes; side UI must not reopen or restart it.
4. Let the parent advance after snapshot capture. Ask for progress and check the visible snapshot boundary. Promote a selected exchange as Steer, retry the same submission, and assert one admitted parent input at the next safe boundary. Repeat with Queue and assert admission does not change the current task's continuation order.
5. Disconnect/reconnect the client with both composers populated. Restore the parent draft and identify side state accurately, including an unavailable/expired side result if necessary. Reconnection must not implicitly promote, rerun, or abort either request.

## P0b: Async Question Contract

Codex's current `request_user_input_async` validates questions, emits an async agent-message item, and immediately returns `{"accepted":true}`. The answer arrives as a **new user message**, not through a later wait tool or completion of the original tool call. `phase: "final_answer"` on the item does not mean `turn/completed`. Exposure is root-agent/model-catalog-gated; the old `send_async_message` feature flag is removed/no-op. [Handler][k-async], [registration][k-registration], [protocol][k-items].

The structured tool shipped in `0.153.0`; `0.154.0` added the inline terminal editor with draft preservation and disconnected editing. `send_message_to_user_async` is a separate, catalog-gated attention/update tool, not the question tool. Shared protocol support does not establish the first Desktop editor release. [0.153.0][k-153], [0.154.0][k-release], [update handler][k-update], [flags][k-flags].

Claude's ordinary `AskUserQuestion` blocks by default. Optional `askUserQuestionTimeout` submits selected answers or returns judgment to Claude after inactivity; permission and plan approvals do not auto-approve on idle. Headless/SDK defer pauses and resumes the workflow. Neither is the requested keep-working contract. Experimental teammate plans may be approved by the lead agent rather than a human: delegated review, not implied user consent. [Claude input][c-input], [tools][c-tools], [teams][c-teams].

- Add a distinct async-question tool; retain blocking questions for genuine dependencies. Return acceptance only after durable creation. Persist ID, session/location ownership, originating tool/message, question/options, timestamps, and pending/answered/skipped/cancelled state.
- Deliver answers through ordinary durable user-input admission with explicit question correlation. Serialize answer/skip races and deduplicate retries; do not depend on a surviving `Deferred` or reconstruct authoritative pending state solely from a client event cache.
- Continue independent work immediately. Dependent work stays blocked by its actual missing input or permission gate. No answer, an option highlight, a timeout, or a message from another agent is approval.
- Give TUI and es-app a pending-question inbox with choices, free text, answer/queue/skip, and origin labels. Preserve the main composer, attachments, cursor, and navigation. Offline editing is allowed; delivery state must distinguish unsent from accepted.
- Reconnect and daemon restart must recover pending/answered state and answer delivery without duplication. Question durability does not imply automatic resumption of interrupted tools or approval requests.
- Keep policy and identity server-side, with thin V1 and V2 adapters. Do not imitate Codex catalog flags as a generic OpenCode toggle; verify behavior and tool availability on each configured provider/model. Source S5; [Codex catalog][k-catalog].

### Acceptance Scenarios

1. Have a fixture provider ask "Which environment?" and then perform an independent read. Withhold the answer. Assert acceptance and a durable pending ID before the read/next provider turn, without waiting for a human response.
2. Leave a parent draft and attachment in the composer. Answer the question with free text, then retry after simulating a lost acknowledgement. Assert one correlated user input, one terminal question transition, and an unchanged draft.
3. Ask two questions, answer out of order, skip one, and submit a duplicate/stale answer. Assert correct IDs, visible conflict/terminal outcomes, and no accidental answer substitution. Another session/location must not answer the request.
4. Restart only the disposable daemon after question acceptance, then reconnect and answer. Pending state must survive; the answer remains deliverable exactly once. Do not claim the interrupted provider/tool automatically resumed.
5. Ask for authorization to perform a protected write while independent reads remain. Advance a fake clock, preselect an option, skip, and send an unrelated aside. None may authorize the write. An explicit valid approval must still pass the separate permission mechanism.
6. Disconnect while editing an answer. Preserve both drafts; disable delivery or visibly retain an unsent outbox until reconnect. Replay question events and confirm no duplicate cards, sends, inferred approvals, or false turn-completed state.

## Remaining Priorities

| Priority | Addition / boundary | Required proof |
| --- | --- | --- |
| P1 | Durable background result inbox/outbox, observable delivery failures, cancellation and follow-up ordering; then generic shell/MCP jobs | Kill/reconnect around completion, retry delivery once, preserve parent ordering, expose failed notification. Do not mistake current `Effect.ignore` injection for reliable delivery. S6. |
| P1 | V2 parity gates before client migration: MCP/task, instruction sources, lifecycle hooks, manual compaction/wait, direct shell/skill APIs, provider coverage | Run equivalent V1/V2 scenarios with the actual configured instructions/tools; no silent loss of work-machine rules. S4-S8. |
| P1 | Explicit recovery protocol with interrupted/unknown outcomes and safe retry decisions | Crash during admission, tool execution, and result publication. Reconcile side effects before retry; `oc-server revive` remains a re-prompt, not recovery proof. S3, S12. |
| P1 | Audit daemon access and sandbox boundaries | Check effective bind/auth/firewall before remote use; test file/network denial in an isolated environment if adding an OS sandbox. S10, S12. |
| P1 | MCP elicitation and explicit reviewed-approval modes | Exercise server-initiated input and cancellation; never label unconditional auto-approval as model-reviewed approval. S11, S14. |
| P2 | Agent mailbox and attention view, integrated with es identities | Durable delivery/correlation without letting peer messages transfer claims or grant human approval. S6, S13. |
| P2 | Optional memory extraction, goals, schedules, richer telemetry | Explicit retention, provenance, budgets, stop conditions, and scheduler ownership; keep external es functionality rather than duplicating it. S8, S13. |

## Advisory Path

1. Coordinate integration of the verified, parked merge with the active default-workspace session. Install/restart remains a separate human-gated operation; this report does not certify production deployment.
2. Build P0a first, then P0b on the supported V1 client/server path. Use additive modules and small route/tool/TUI registration points; write shared schemas and persistence contracts where both engines can consume them.
3. Keep es lanes, tracker claims, review/parked semantics, and orchestration authority in es. Keep umbrella identity and labels in the server API, not duplicated in each client. Current code derives labels from declared roots and canonical layouts; the older PRD's fully enumerated mapping description is not the current implementation. S13.
4. Follow the fork PRD's upstream-first and extension-first rules. Generic interaction/persistence changes should be upstream-shaped; es-specific policy remains an extension. No parallel question or session store owned only by TUI. `prds/session-umbrella.md:73-100`.
5. Consider native V2 only as its parity gates close. Durable steer/queue is useful work to reuse, not sufficient reason to switch the entire TUI, oc-server deployment, and es-app now.
6. Optionally investigate a Codex app-server backend behind a narrow adapter. It also has a client/server architecture, but official docs call app-server/WebSocket experimental and unsupported for production. Validate version-matched schemas, auth/provider entitlements, history ownership, tools, approvals, aside semantics, and es metadata. Do not assume drop-in compatibility or stability. [App-server][k-server].

## Source Map

Paths and line numbers below refer to this merged OpenCode tree unless explicitly prefixed `dotfiles:`. Official upstream links pin the fetched revision where useful; fork-only behavior is evidenced by local source, not attributed to upstream. Sources were re-read in the merge workspace, including the changed task failure propagation.

- **S1, active clients:** `packages/tui/src/component/prompt/index.tsx:1095-1134`; `packages/sdk/js/src/v2/gen/sdk.gen.ts:3740-3786`; `packages/es-app/src/api.ts:48-79`. Ordinary submit adds parent input and clears the composer. [Upstream SDK][oc-sdk].
- **S2, native admission:** `packages/protocol/src/groups/session.ts:205-254`; `packages/core/src/session.ts:360-383,417-431`; `packages/core/src/session/input.ts:41-76`; `packages/opencode/src/server/routes/instance/httpapi/api.ts:81-86`; `packages/opencode/src/server/routes/instance/httpapi/server.ts:175-183`. [Upstream Session][oc-session].
- **S3, delivery/replay/recovery:** `packages/core/src/session/runner/llm.ts:390-412`; `packages/core/src/session/execution.ts:9-23`; `AGENTS.md:151-160`; tests `packages/core/test/session-runner.test.ts:1875-2000`, `packages/core/test/event.test.ts:422-458`. [Upstream runner][oc-runner].
- **S4, available tools:** `packages/opencode/src/tool/registry.ts:199-248,280-318`; `packages/core/src/tool/builtins.ts:18-47`; `packages/core/src/tool/registry.ts:50-81,106-120`. V2 registration extensibility exists; it does not port MCP/task itself. [Upstream built-ins][oc-builtins].
- **S5, questions:** `packages/opencode/src/question/index.ts:64-111,114-152`; `packages/opencode/src/tool/question.ts:22-40`; `packages/core/src/question.ts:65-107,112-145`; `packages/core/src/session/runner/llm.ts:284-307`; tests `packages/core/test/question.test.ts:37-122`, `packages/core/test/tool-question.test.ts:74-123`. [Upstream V2 question][oc-question].
- **S6, background lifecycle:** `packages/opencode/src/tool/task.ts:92-102,200-224,227-281,316-318`; `packages/core/src/background-job.ts:122,256-287`; `packages/opencode/src/background/job.ts:17-30`. Tests `packages/opencode/test/tool/task.test.ts:287-365,655-680,752-862,897-933` cover failure propagation, flag rejection, immediate launch, update ordering, and non-waiting parent injection. [Upstream task][oc-task].
- **S7, hooks:** `packages/plugin/src/index.ts:222-335`; `packages/opencode/src/session/tools.ts:99-129`; `packages/opencode/src/session/compaction.ts:373-379`; `packages/plugin/src/v2/effect/context.ts:12-22`; `packages/core/src/session/runner/llm.ts:421-438`. V2 plugin infrastructure is present, but these are not interchangeable lifecycle surfaces. [Upstream plugin API][oc-plugin].
- **S8, context:** `packages/opencode/src/session/instruction.ts:60-68,110-168,179-214`; `packages/core/src/instruction-context.ts:40-74`; `packages/core/src/session/compaction.ts:178-246`; `packages/core/src/session.ts:387-392,417-423`. Ambient files/configured instructions and summarization are not an automatic memory-extraction system. [Upstream instruction context][oc-instructions].
- **S9, plans/snapshots:** `packages/opencode/src/agent/agent.ts:156-180`; `packages/opencode/src/session/processor.ts:425-472`; `packages/core/src/session/revert.ts:27-95`; `prds/session-umbrella.md:106-110`. Snapshot existence does not establish shell-side-effect rollback or correctness for all jj workspaces. [Upstream revert][oc-revert].
- **S10, host execution:** `packages/opencode/src/tool/shell.ts:272-315,491-559`; `packages/core/src/tool/bash.ts:129-171`. Permission checks precede host subprocesses; V2 explicitly labels directory scanning advisory. [Upstream Bash][oc-bash].
- **S11, MCP/code mode:** `packages/opencode/src/tool/registry.ts:118-119,280-307`; `packages/opencode/src/tool/code-mode.ts:14-19,39-65`; `packages/opencode/src/session/tools.ts:136-139`; `packages/opencode/src/mcp/index.ts:39-48` disables elicitation/tasks. V2 omissions in S4. Confined orchestration/deferred catalog discovery is not an OS sandbox. [Upstream code mode][oc-code-mode].
- **S12, deployment/restart, external:** `dotfiles:bin/oc-server:71-158` snapshots busy top-level sessions and sends a continuation prompt after an intentional restart. `dotfiles:LaunchAgents/com.murtaza.opencode-server.plist:12-17` configures `0.0.0.0:4096`, despite `dotfiles:bin/oc-server:3` describing loopback-only operation. This is configured all-interface binding, **not proof of current network exposure**; effective listener, authentication, firewall and reachability were not tested here. [Restart source][df-restart], [LaunchAgent][df-launch].
- **S13, es authority/umbrella, external plus fork:** `dotfiles:docs/editspace-lanes.md:19-27,104-116,149,198-255`; `packages/opencode/src/fork/umbrella.ts:1-34,91-125`; `packages/opencode/src/server/routes/instance/httpapi/api.ts:77`; `prds/session-umbrella.md:87-100`. es already supplies isolated workspaces, claims, spawn/resume/wait and review handoff. Neither those nor daemon restart snapshots constitute native durable execution recovery. [es rules][df-es].
- **S14, auto-approval:** `packages/tui/src/context/sync.tsx:196-205` immediately replies `once` in auto mode; no model reviewer is invoked there.
- **S15, inspection:** `packages/opencode/src/cli/cmd/debug/agent.handler.ts:40-64`; `packages/tui/src/feature-plugins/sidebar/context.tsx:19-44`. Tool details and token totals are not a full effective prompt/context inspector.

## Other Harnesses

- Gemini CLI's opt-in checkpointing records a shadow Git snapshot, conversation, and pending tool call; `/restore` restores all three. Compare that explicit scope, not the word "checkpoint," with OpenCode and Codex. [Google source][g-checkpoint].
- Gemini's `--acp` is an editor-facing stdio protocol with client-proxied filesystem access; A2A remote subagents use agent cards. Neither is MCP or automatically equivalent to an app-server. These are two limited comparisons, not an exhaustive Gemini/Antigravity audit. [Google ACP][g-acp], [Google A2A][g-a2a].

## Evidence Limits

Research inputs: `claude-harness-inventory.md` and `codex-harness-inventory.md` beside this workspace in the parent scratch directory, read in full; their official citations are retained below rather than relying on temporary files for durable evidence. Competitor claims come from official docs/releases and Codex stable-tag source, not installed-client testing. Live docs and download channels can change.

This document re-audits merged source and relevant test definitions. Earlier baseline audits used the old root; the relevant registry, question and flag semantics remain in the merged paths, while task failure propagation changed. No full-suite pass, production deployment, paid-model behavior, or interactive TUI pass is claimed.

## Update Verification

- Parked locally in jj change `nuwwp`, workspace `harness-sync`; includes both original fork work and upstream `dev`. The default checkout advanced concurrently with sidebar-grouping work, so its checkout and `dev` bookmark were not moved. No push or global install occurred.
- `bun install --frozen-lockfile` succeeded with Bun `1.3.14`; the lockfile stayed unchanged. Husky's missing `.git` notice is expected in this jj non-default workspace.
- **915 tests passed, 1 skipped, 0 failed across 18 files.** Commands below ran from their package directories, using their isolated test preloads.
- `packages/opencode`: `bun run test test/server/httpapi-umbrella.test.ts test/tool/task.test.ts test/config/v2-compat.test.ts test/acp/config-option.test.ts test/acp/event.test.ts test/provider/transform.test.ts test/session/llm.test.ts test/session/prompt.test.ts` (745 pass, 1 skip); `bun run test test/mcp/session-recovery.test.ts test/session/tools.test.ts` (2 pass).
- `packages/tui`: `bun run test test/fork/umbrella.test.ts test/app-lifecycle.test.tsx` (8 pass).
- `packages/core`: `bun run test test/session-runner.test.ts test/database-migration.test.ts` (105 pass); `bun run test test/question.test.ts test/tool-question.test.ts test/event.test.ts test/background-job.test.ts` (55 pass).
- `bun typecheck` passed in `opencode`, `core`, `tui` and `es-app` packages.
- `OPENCODE_CHANNEL=prod OPENCODE_VERSION=1.18.31 bun run script/build.ts --single --skip-install --skip-embed-web-ui` built the Darwin ARM64 CLI; executable version smoke passed. Installed dependencies supplied the native build inputs; embedded upstream web UI was not built or verified.
- `bun run build` in `packages/es-app` initially failed on Vite's IIFE worker format. Adding `worker.format: "es"` fixed the production build; this three-line configuration change is the only manual code edit in the update.
- A disposable compiled-binary server bound an OS-selected loopback port with isolated HOME/XDG/database/config. Live HTTP checks passed for health/version, root/lane session creation/read, member labels, and identical umbrella listings from both directories. The smoke server was stopped; no production sessions or model calls were used.

[oc-head]: https://github.com/anomalyco/opencode/commit/e03db9bc6908f75c9334d8aa997deeaac81c0298
[oc-release]: https://github.com/anomalyco/opencode/releases/tag/v1.18.31
[oc-v2-tag]: https://github.com/anomalyco/opencode/tree/v2.0.0
[oc-releases]: https://github.com/anomalyco/opencode/releases
[oc-sdk]: https://github.com/anomalyco/opencode/blob/e03db9bc6908f75c9334d8aa997deeaac81c0298/packages/sdk/js/src/v2/gen/sdk.gen.ts
[oc-session]: https://github.com/anomalyco/opencode/blob/e03db9bc6908f75c9334d8aa997deeaac81c0298/packages/core/src/session.ts
[oc-runner]: https://github.com/anomalyco/opencode/blob/e03db9bc6908f75c9334d8aa997deeaac81c0298/packages/core/src/session/runner/llm.ts
[oc-builtins]: https://github.com/anomalyco/opencode/blob/e03db9bc6908f75c9334d8aa997deeaac81c0298/packages/core/src/tool/builtins.ts
[oc-question]: https://github.com/anomalyco/opencode/blob/e03db9bc6908f75c9334d8aa997deeaac81c0298/packages/core/src/question.ts
[oc-task]: https://github.com/anomalyco/opencode/blob/e03db9bc6908f75c9334d8aa997deeaac81c0298/packages/opencode/src/tool/task.ts
[oc-plugin]: https://github.com/anomalyco/opencode/blob/e03db9bc6908f75c9334d8aa997deeaac81c0298/packages/plugin/src/index.ts
[oc-instructions]: https://github.com/anomalyco/opencode/blob/e03db9bc6908f75c9334d8aa997deeaac81c0298/packages/core/src/instruction-context.ts
[oc-revert]: https://github.com/anomalyco/opencode/blob/e03db9bc6908f75c9334d8aa997deeaac81c0298/packages/core/src/session/revert.ts
[oc-bash]: https://github.com/anomalyco/opencode/blob/e03db9bc6908f75c9334d8aa997deeaac81c0298/packages/core/src/tool/bash.ts
[oc-code-mode]: https://github.com/anomalyco/opencode/blob/e03db9bc6908f75c9334d8aa997deeaac81c0298/packages/opencode/src/tool/code-mode.ts
[df-restart]: https://github.com/murtaza64/dotfiles/blob/master/bin/oc-server
[df-launch]: https://github.com/murtaza64/dotfiles/blob/master/LaunchAgents/com.murtaza.opencode-server.plist
[df-es]: https://github.com/murtaza64/dotfiles/blob/master/docs/editspace-lanes.md
[c-release]: https://github.com/anthropics/claude-code/releases/tag/v2.1.272
[c-substantial]: https://github.com/anthropics/claude-code/releases/tag/v2.1.271
[c-stable]: https://downloads.claude.ai/claude-code-releases/stable
[c-availability]: https://code.claude.com/docs/en/feature-availability
[c-interactive]: https://code.claude.com/docs/en/interactive-mode
[c-input]: https://code.claude.com/docs/en/agent-sdk/user-input
[c-tools]: https://code.claude.com/docs/en/tools-reference
[c-modes]: https://code.claude.com/docs/en/permission-modes
[c-agents]: https://code.claude.com/docs/en/sub-agents
[c-agent-view]: https://code.claude.com/docs/en/agent-view
[c-messaging]: https://code.claude.com/docs/en/cross-session-messaging
[c-teams]: https://code.claude.com/docs/en/agent-teams
[c-workflows]: https://code.claude.com/docs/en/workflows
[c-goals]: https://code.claude.com/docs/en/goal
[c-schedules]: https://code.claude.com/docs/en/scheduled-tasks
[c-routines]: https://code.claude.com/docs/en/routines
[c-hooks]: https://code.claude.com/docs/en/hooks
[c-sandbox]: https://code.claude.com/docs/en/sandboxing
[c-memory]: https://code.claude.com/docs/en/memory
[c-checkpoints]: https://code.claude.com/docs/en/checkpointing
[c-sessions]: https://code.claude.com/docs/en/sessions
[c-worktrees]: https://code.claude.com/docs/en/worktrees
[c-mcp]: https://code.claude.com/docs/en/mcp
[c-remote]: https://code.claude.com/docs/en/remote-control
[c-monitoring]: https://code.claude.com/docs/en/monitoring-usage
[c-desktop]: https://code.claude.com/docs/en/desktop
[c-computer]: https://code.claude.com/docs/en/computer-use
[k-release]: https://github.com/openai/codex/releases/tag/rust-v0.154.0
[k-153]: https://github.com/openai/codex/releases/tag/rust-v0.153.0
[k-update]: https://github.com/openai/codex/blob/rust-v0.154.0/codex-rs/core/src/tools/handlers/send_message_to_user_async.rs
[k-blocking]: https://github.com/openai/codex/blob/rust-v0.154.0/codex-rs/core/src/tools/handlers/request_user_input.rs
[k-flags]: https://github.com/openai/codex/blob/rust-v0.154.0/codex-rs/features/src/lib.rs
[k-alpha]: https://github.com/openai/codex/releases/tag/rust-v0.155.0-alpha.6
[k-changes]: https://developers.openai.com/codex/changelog/
[k-python]: https://github.com/openai/codex/releases/tag/python-v0.154.0
[k-maturity]: https://developers.openai.com/codex/feature-maturity/
[k-catalog]: https://github.com/openai/codex/blob/rust-v0.154.0/codex-rs/models-manager/models.json
[k-async]: https://github.com/openai/codex/blob/rust-v0.154.0/codex-rs/core/src/tools/handlers/request_user_input_async.rs
[k-registration]: https://github.com/openai/codex/blob/rust-v0.154.0/codex-rs/core/src/tools/spec_plan.rs
[k-items]: https://github.com/openai/codex/blob/rust-v0.154.0/codex-rs/app-server-protocol/src/protocol/v2/item.rs
[k-commands]: https://developers.openai.com/codex/developer-commands/
[k-server]: https://developers.openai.com/codex/app-server/
[k-agents]: https://developers.openai.com/codex/agent-configuration/subagents/
[k-headless]: https://developers.openai.com/codex/non-interactive-mode/
[k-goals]: https://developers.openai.com/codex/long-running-work/
[k-scheduled]: https://developers.openai.com/codex/automations/
[k-hooks]: https://developers.openai.com/codex/hooks/
[k-sandbox]: https://developers.openai.com/codex/sandboxing/
[k-memory]: https://developers.openai.com/codex/customization/memories/
[k-worktrees]: https://developers.openai.com/codex/environments/git-worktrees/
[k-mcp]: https://developers.openai.com/codex/extend/mcp/
[k-advanced]: https://developers.openai.com/codex/config-file/config-advanced/
[k-approval]: https://developers.openai.com/codex/sandboxing/auto-review/
[k-news]: https://developers.openai.com/codex/whats-new/
[g-checkpoint]: https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/checkpointing.md
[g-acp]: https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/acp-mode.md
[g-a2a]: https://github.com/google-gemini/gemini-cli/blob/main/docs/core/remote-agents.md
