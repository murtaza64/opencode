# Agent mail and handoff — machine transfer

- Tracker: [dotfiles#166](https://github.com/murtaza64/dotfiles/issues/166). The confirmed contract lives in the parent-owned dotfiles design lane; publishing that document is the parent's separate responsibility.
- Landing policy for all three lanes: **review**. The branches below are portable source checkpoints, not landed or installed behavior.

| Repo | Review branch | Git commit | Contents |
| --- | --- | --- | --- |
| `murtaza64/opencode` | [`murtaza-mail-session`](https://github.com/murtaza64/opencode/tree/murtaza-mail-session) | `11c2d0686a8e8164ae25f36c221223a4ef487f8e` (implementation base) | V1/V2 sourced mail, durable receipts and supersession fence, provider-facing peer-mail context, es-app timeline/subscriptions/handoff UI |
| `murtaza64/dotfiles` | [`murtaza-mail-routing`](https://github.com/murtaza64/dotfiles/tree/murtaza-mail-routing) | `25f9a5bc434809f033d0f4c52d0f8354c0cef6c1` | `es` subscriptions, outbox, one-call delegation, recoverable handoff, SSE watcher, text transfer |
| `murtaza64/dotfiles` | [`murtaza-mail-timeline`](https://github.com/murtaza64/dotfiles/tree/murtaza-mail-timeline) | `551262a747442860c8d04cfef871b62c929c159c` | Dashboard mail, lineage, subscription APIs and SSE invalidation |

## Verification at checkpoint

- OpenCode: 146 focused Core tests, 60 focused legacy API/session tests, 271 es-app source tests; package typechecks and migration check passed. es-app mail and handoff browser tests passed. An existing V1 compaction test with a hard 250 ms elapsed bound failed under load; both new peer-mail compaction cases passed in isolation. The broader OpenCode suite was not green (unrelated timeouts and event-manifest expectation).
- Isolated OpenCode HTTP preview proved exact-create retry, mail source admission/retry, structured `message.info.source`, committed predecessor fence, and old `/input` HTTP 409 with successor. No installed daemon was restarted for this preview.
- Dotfiles routing: 417 tests passed, two opt-in preview tests skipped in the default suite; 20/20 isolated OpenCode-preview orchestration cases passed, including the Astra one-send case with the parent outside a lane and a fenced handoff. Dashboard: 49 focused tests and Ruff checks passed.
- Changed files were inspected before pushes; no credential material was added. Each remote bookmark was verified against its recorded commit. No branch was force-pushed or landed to trunk.

## Continuation

1. Fetch all three review branches, then review the runtime + CLI + dashboard seam together against [dotfiles#166](https://github.com/murtaza64/dotfiles/issues/166). Keep #88 and #106 parked and #165 on hold; their workspaces were not edited. #171–#173 are unrelated previously landed source changes. Delegation in this project must select an explicit `openai/...` model; do not substitute another provider or a server default.
2. Land each branch only after the relevant **review** approval. Rebase/resolve newer `dev`/`master` changes during review; the OpenCode checkpoint is based on an older `dev` ancestor and may need reconciliation. Re-run Core/legacy/es-app and dotfiles tests after integrating the branches.
3. Coordinate daemon/dashboard/es-app publication separately under `docs/opencode-runtime-updates.md` in dotfiles. Verify the combined flow on disposable Sessions first, then test busy coalescing, idle wake, presented/handled receipts, cross-handoff pending mail, and stale-session 409 on the installed build. Register parent watches by resolving **current** lane owners, not the historical native author session. The manadj dashboard owner should replace temporary wake polling only after that end-to-end check, preserving approval/result state.
4. `es mail watch` is a foreground event consumer in the review source; it has not been installed or started globally. It emits a linked **returned** notice for read-only workers, not a completed verdict. A typed ready/completed runtime event remains undefined; do not infer success from idle or promote historical run notices to current readiness. Browser reply-send remains gated on trusted sender identity; native timeline and subscription controls are implemented.

## Preview from source

- In `packages/es-app`, `node test/mail-preview.mjs` serves a disposable mail timeline and subscription fixture on a free port and prints its URL. Stop that preview process with SIGTERM.
- OpenCode and dashboard previews used isolated state/ports on the original machine. Their loopback URLs and process IDs are not portable; start fresh isolated previews from the review branches on the next machine. Neither preview constitutes installed/client-loaded behavior.
