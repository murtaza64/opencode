# Session mobility: project move, lane sessions, move-into-lane

Status: ready-for-agent

Grilled 2026-07-08 (forked session pair; synthesis closed both grills).
Decision record: docs/adr/0001. Glossary: CONTEXT.md "Fork:" section
(Project Move, Directory Move, Lane, Umbrella Project). Builds on the
session-umbrella round (prds/session-umbrella.md, issues 01-05 landed).

## Problem Statement

Work starts where it starts, not where it belongs. An investigation begun in
one project turns out to belong in another repo/editspace; an interactive
session in a shared checkout wants to start making changes and needs lane
isolation. Today the only options are a handoff (lossy, ceremonial) or a
fresh session (loses everything). Lanes can only be created via the `es`
CLI, outside the TUI where the need arises.

## Solution

Three umbrella-gated TUI palette commands:

1. **Move session to project** — continue the current session under a new
   directory in another project/umbrella, history intact.
2. **New lane session** — create a lane and open a fresh interactive session
   in it: parallelism without agent orchestration.
3. **Move session to new lane** — the composition: an exploration session
   that now wants to write gets a lane and moves into it.

## User Stories

1. As an operator, I want to move a session to another project, so that an
   investigation continues where it belongs without a handoff.
2. As an operator, I want the moved session to keep its message history and
   todos, so that nothing is lost in the move.
3. As an operator, I want the move to inject context (old cwd, new cwd, my
   one-line reason), so that the agent understands its relocation.
4. As an operator, I want the source session archived with a `→ moved to
   <target>` title marker, so that pickers don't show a dead twin.
5. As an operator, I want a "new lane session" command that prompts for a
   lane name, so that I get isolated parallel work in two keystrokes.
6. As an operator, I want the new lane session to appear in the umbrella
   picker with its lane chip, so that no extra plumbing is needed.
7. As an operator, I want "move session to new lane" to default the lane
   name to the slugified session title, so that the common case is one Enter.
8. As an operator, I want these commands hidden outside umbrellas, so that
   stock projects see stock behavior (same gating rule as chips).
9. As the es machinery, I want opencode creating lanes through a contract
   rather than reimplementing them, so that lane semantics stay in one place.

## Implementation Decisions

- **Project Move = fork-continuation**: deep-copy history into a new session
  at the target directory (upstream `Session.fork` already crosses projects
  when the calling instance is rooted there); inject move context into the
  continuation; archive the source with a title marker. Upstream's
  same-project `MoveSession` ("Directory Move") is not touched and not used
  for this.
- **What carries**: message history + move context + todos (fork does not
  copy todos — copy the todo rows keyed by the new session id). Nothing
  else: no uncommitted-changes transfer, no pins.
- **Move-context shape**: system-reminder in the upstream `moveReminderText`
  style, extended with provenance and reason: previous cwd, new cwd,
  optional operator-supplied one-liner. Exact wording at implementation.
- **Lane creation via Lane Provider Contract** (ADR 0001): round 1 = fork
  daemon shells out to `es lane create` with JSON output; lane workspace
  paths are deterministic. Lane-record ownership for interactive sessions:
  create-then-chown to the new session id via es (`--owner`, dotfiles-side
  PRD); acceptable two-step.
- **Dialogs**: "Move session to project" lists umbrella roots from
  umbrellas.json plus a free-text path row; lane-name prompts are editable,
  never silently auto-generated.
- **Work Item Refs**: display only in round 1 (resolve refs for
  picker/status context via the Tracker Adapter, dotfiles-side). No
  claim-from-TUI yet.

## Testing Decisions

- HTTP seam (round-1 pattern): fork-continuation route tested like
  httpapi-umbrella.test.ts — fixture instances across two directories,
  assert history deep-copy, todo carry, source archival + title marker,
  move-context part present in the new session.
- Pure seams: slugify/default-lane-name and move-context assembly as pure
  functions with unit tests (TUI util test pattern).
- Lane Provider Contract: contract-level test with a fake `es` binary on
  PATH (fixture script emitting JSON), asserting create/open flow without
  real editspaces.

## Out of Scope

- Uncommitted-changes transfer in any form (revisit only with evidence).
- Claim-from-TUI ("new lane session from frontier issue") — flagged next
  step, separate issue after round 1.
- Full tracker lifecycle from the TUI — never.
- Upstream workspace-adapter integration for lanes (revisit only for their
  workspace UI affordances).
- Pins, session settings, or any state beyond history + todos + context.

## Further Notes

- All three commands share the umbrella-gating helper introduced for chips.
- Feature 3 is thin composition: contract create + Project Move; it must not
  grow its own pathway.
- es-side counterpart work (JSON outputs, --owner, umbrella entry on
  es create) is tracked in the dotfiles PRD, not here.
