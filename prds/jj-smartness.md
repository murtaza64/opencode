# jj smartness: op-log write safety, orientation, umbrella project identity

Status: ready-for-agent

Grilled 2026-07-08. Decision records: docs/adr/0002 (optimistic write
safety, locks retired), docs/adr/0001 (umbrella project identity, lane-root
anchoring). Glossary: CONTEXT.md "Fork:" section (Baseline, Orientation,
Reorientation, Umbrella Project). Prior art superseded: the editspace-lock
plugin (~/dotfiles/opencode/plugins/editspace-lock.ts) — advisory leases,
regex bash classification, drift injection via chat.message.

## Problem Statement

Agents in jj checkouts are jj-blind. They don't know what change they're on,
can't tell when another agent or the operator mutated the working copy under
them (no cross-process staleness guard exists in the file tools at all), and
after compaction or resume they reorient from compressed memory instead of
VCS reality. The lock plugin papers over the concurrency slice with advisory
leases that stall unattended agents and parse bash with regexes. Separately,
sessions in lane workspaces anchor their permission boundary at the wrong
place (the sidecar or editspace root), leaving sibling lanes mutually
writable — the gate is inert exactly where agents collide.

## Solution

Phase 1 — jj-smart agents in existing checkouts: the fork's file tools
materialize jj snapshots after mutations; each session keeps a per-workspace
op-log Baseline; writes against a drifted workspace fail with a
Reorientation (ops since baseline, touched files, recovery); the same
Orientation payload is injected at turn start on drift, on session resume,
and post-compaction; the payload always shows the current change so change
discipline becomes advisory-but-informed. Locks retire.

Phase 2 — identity (behind a fork flag until proven on the live fleet):
sessions under an umbrella resolve to the umbrella's project; lane sessions
anchor their write boundary at the lane root. The editspace is the project.

## User Stories

1. As an agent, I want my write to fail with an op-log explanation when the
   file changed since I last read it, so that I never clobber concurrent
   work or act on stale reads.
2. As an agent, I want that failure to tell me which ops ran and which files
   they touched, so that recovery is re-reading the right things, not
   guessing.
3. As an agent, I want an orientation at turn start when my workspace
   drifted, so that I stop trusting stale context before acting.
4. As an agent resuming after idle/reattach, I want the same orientation,
   so that a stale morning session doesn't act on yesterday's world.
5. As an agent after compaction, I want current jj state (change ID,
   description, status, recent ops) injected, so that I reorient against
   reality rather than my compressed memory.
6. As an agent, I want every orientation to show the change I'm on and
   whether it's described, so that one-change-per-issue discipline is
   informed rather than blind.
7. As an operator running two sessions in one checkout, I want the second
   writer to get a failed write + guidance instead of a 180s lease stall,
   so that nothing hangs.
8. As an operator, I want my own jj commands (undo, new, rebase) to surface
   to the agent as drift, so that I can reshape the repo mid-session safely.
9. As a lane agent (phase 2), I want my write boundary at my lane root, so
   that sibling lanes, mirrors, and the default workspace are external and
   guarded.
10. As an operator (phase 2), I want lane sessions to belong to the
    editspace's project, so that stock project scoping matches semantics.
11. As an agent in a non-jj repo, I want all of this to no-op, so that
    nothing changes outside jj checkouts.

## Implementation Decisions

- **Snapshot materialization**: edit/write/bash tools trigger a working-copy
  snapshot after mutations in jj workspaces — the op log becomes complete
  ground truth; an agent's own mutations advance its own Baseline.
- **Baseline**: per (session, jj workspace) — one session may straddle
  several workspaces (multi-repo lanes). Advances only on delivered
  Orientation or own mutation; never silently. Persisted server-side
  (survives daemon restarts; the resume trigger depends on it).
- **Staleness check**: on write, compare workspace op head to Baseline;
  file-granularity via op-range diffs where cheap, workspace-granularity
  fallback. Optimistic — no locks anywhere (ADR 0002).
- **One Orientation builder, four triggers**: failed write, turn-start
  drift, session resume, post-compaction. Workspace-scoped in round 1.
- **Bash classification**: reuse the read-only-command heuristic from the
  lock plugin; misclassification now costs a spurious reorientation, not a
  blocked write.
- **Change discipline**: advisory only (orientation shows the current
  change; agent guidance says `jj new` before distinct work). No automatic
  `jj new` in shared checkouts — automation belongs to session-owned
  workspaces (future PRD).
- **Phase 2 identity**: umbrella-driven resolution (project = umbrella's
  project; anchor = lane root for lane sessions, stock elsewhere), fork
  flag gated; jj detection plays no role in identity. Tracker writes from
  lanes flow through an external_directory allow-list.
- **jj detection**: a fork service (find .jj, workspace root, colocated or
  not); used by op-log machinery and, cosmetically, the TUI VCS slot
  (change ID/bookmark instead of git branch).
- Fork hygiene per sidecar AGENTS.md: new fork modules; upstream files
  touched only at marked seams (tool layer, orientation injection points,
  resolver for phase 2).

## Testing Decisions

- Op-log machinery: integration tests against real jj repos in tmpdirs
  (jj CLI available in dev env) — create drift via out-of-band jj ops and
  file writes, assert refused writes, reorientation content, baseline
  advancement rules.
- Orientation builder: pure function over op-log/status inputs → payload;
  unit tests (TUI util pattern applies server-side too).
- Phase 2 resolution: HTTP-seam tests per round-1 pattern — fixture
  umbrella + lane layout, assert project identity, worktree anchor, and
  external_directory verdicts for sibling-lane and tracker paths.
- Non-jj repos: explicit no-op coverage in each seam test.

## Out of Scope

- Locks in any form (retirement plan: plugin drops leases+drift once phase
  1 lands; EDITSPACE_AGENT_ID env injection survives until absorbed).
- Automated `jj new` / auto-scoping (future session-owned-workspaces PRD,
  with agent-tied jj workspaces superseding lane creation mechanics).
- Cross-workspace awareness in payloads — trunk bookmark movement noted as
  a future orientation enrichment.
- Teaching upstream's snapshot/undo system jj (undo unused; disabled for
  jj workspaces if it misbehaves).
- git repos: no equivalent op-log machinery attempted.

## Further Notes

- Agent attribution of foreign ops is best-effort in round 1 (op metadata +
  active-session correlation); do not overpromise "who" — "what and when"
  is the contract.
- The umbrella listing and chips (session-umbrella round) are unaffected;
  phase 2 makes stock scoping match them for lanes.
- Multi-repo editspaces: current derivation bug filed as
  issues/session-umbrella/07 (labels only; membership correct).
