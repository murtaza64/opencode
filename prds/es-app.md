# es-app: editspace-native web frontend

Status: v1 landed 2026-08-04 (iterating). Spike gate PASSED — see ADR 0003.
Beyond the v1 scope below, landed iterations added: vim modal input
(normal/insert, core motions/operators, ^u/^d/^n/^p/Tab nav, floating
composer), baymax design language (dark flat palette, octicon PR rows,
colored tool names), model-per-turn dropdown, image paste, context gauge,
session sidebars, unread tracking.

Grilled 2026-08-04 (api-testing dashboard session, light grill). Decision
record: fork ADR 0003 (custom shell over patching packages/app). Sibling:
dotfiles `prds/es-dashboard.md` (the Python dashboard server this shell
consumes) and its Thread model (dotfiles CONTEXT.md). Fork context: ADR
0001 (umbrella = project identity), `prds/session-umbrella.md`.

## Problem Statement

Orchestrating parallel agents across an editspace spans three surfaces:
the es dashboard (attention queue, threads, PRs — read-only), the TUI
(chat, permission/question replies), and JIRA/GitHub. The stock web app
served by the daemon lists sessions by exact directory — it "sees no
fleet at all" (session-umbrella PRD) — and knows nothing of editspaces,
threads, lanes, or tickets. There is no single place to see what needs
you, read what an agent actually did, and answer it.

## Solution

A new fork package `packages/es-app`: a Solid+Vite browser shell that is
editspace-native from the first screen.

- **Compose, don't rewrite**: `@opencode-ai/sdk` (v2) for daemon
  transport, `@opencode-ai/session-ui` + `@opencode-ai/ui` for transcript
  rendering (message parts, streaming markdown, diffs). The es dashboard
  server (`:7777`) stays as-is and becomes the editspace-data API.
- **Home = the dashboard**: attention queue + thread cards rendered by
  the shell.
- **Thread → conversation**: a card opens its session's live transcript
  (SSE-streamed parts) with scrollback.
- **Chat**: prompt input on any session via `prompt_async`, defaulting to
  the session's existing agent/model (no pickers).
- **Act inline**: permission replies (once/always/reject) and question
  replies from the attention queue and the session view — the two
  human-gates that currently force a trip back to the TUI.
- **Session picker**: `/umbrella/session` (fork route; raw fetch like the
  TUI, it may be absent from the generated SDK) for editspace-wide
  sessions the dashboard doesn't card.

One shell instance = one editspace, mirroring the dashboard.

## User stories

1. As Murtaza, I open one page and see everything that needs me across
   the editspace's agents, ranked.
2. From an attention item, I read the relevant conversation — live if the
   agent is mid-turn — without opening a terminal.
3. I answer a pending permission or question directly from the queue.
4. I reply to an idle session ("looks good, also handle X") from the
   thread card, and the session resumes with its own agent/model.
5. I browse all sessions in the editspace (umbrella-wide), not just those
   with lane/ticket cards.

## Explicitly deferred

- Spawning lanes/sessions from the UI (`es agent spawn` stays CLI)
- Diff/review views, file tree, terminal
- Multi-editspace switching in one shell instance
- Model/agent pickers, session management (archive, share, fork)
- Porting the dashboard collectors to TS (Python server stays)

## Risks / gates

- **Spike gate (~1 day)**: render one real transcript with `session-ui`
  components outside `packages/app`'s context providers. If they're
  entangled beyond extraction, fall back to fork-patching `packages/app`
  (ADR 0003 alternative).
- Cross-origin: browser shell on its own port talking to `:4096` and
  `:7777`. The stock app supports user-configured server URLs, so daemon
  CORS is expected to work; else serve the built shell from the dashboard
  server and proxy.
- Upstream churn: `session-ui`/`ui`/`sdk` move fast; the shell must pin
  to the fork workspace versions (bun workspace deps), rebased with the
  fork.

## Verification (v1)

- Open shell against api-testing: attention queue matches the dashboard;
  cards open transcripts that match the TUI's rendering
- Watch a busy session stream live; scrollback intact
- Answer a real permission and a real question from the shell; agent
  proceeds
- Prompt an idle session from the shell; reply lands (visible in TUI)
