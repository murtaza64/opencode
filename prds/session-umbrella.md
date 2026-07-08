# Session umbrella: es-defined project grouping (fork round 1)

Status: ready-for-agent

Grilled 2026-07-08 (dotfiles lane opencode-inconsistency-investigation-fork-decision).
Evidence base: dotfiles sidecar `issues/editspace/09-*.md` (session discovery
mechanism, picker-leak experiment matrix), manadj ADR 0028 amendment (permission
incident), source dives against v1.17.10.

## Problem Statement

opencode derives project identity from the git VCS root and pins each session to
its creation directory. Murtaza's workflow (editspace sidecars, jj lane
workspaces) fights this constantly:

- An embedded `.editspace/` sidecar is its own VCS root, so the agent fleet
  becomes a SEPARATE project from the repo — sessions are visible or invisible
  depending on which directory the TUI happens to be opened in.
- jj non-default workspaces (lanes) have no `.git`, so lane sessions fragment
  further instead of grouping with their repo.
- Clients disagree about scope: the TUI seeds project-wide but live-inserts any
  session from the daemon-wide event firehose (cross-project leak, diagnosed
  2026-07-08); the web app lists by exact directory and sees no fleet at all.
- A session's CWD is visible only at session start (otherwise buried in the
  sidebar), so a picker full of near-identically-named fleet sessions is
  disorienting.

The fundamental mismatch: to Murtaza, "repo + sidecar + all lanes" is ONE
project; to opencode it is N projects, and no client can show the whole.

## Solution

Fork opencode (murtaza64/opencode, working copy `~/opencode`) and make session
grouping follow an explicitly declared **umbrella**: an es-authored mapping that
declares which directories form one logical project and what each member is
(repo root, sidecar, lane <name>). The server exposes the umbrella as an
additive listing capability; the TUI picker shows the same grouped session
universe from any member directory, with each session's membership labeled; a
persistent status-bar element always shows the attached session's CWD.

Where the TUI is opened affects only the default new-session directory — never
visibility.

## User Stories

1. As a human operator, I want the session picker opened anywhere inside an
   umbrella (repo root, sidecar, lane workspace) to show the same session
   universe, so that discovery does not depend on where I launched the TUI.
2. As a human operator, I want fleet sessions grouped and labeled by lane, so
   that I can tell agents apart at a glance.
3. As a human operator, I want my own repo-root sessions foregrounded and
   distinct from the agent fleet, so that my work is not buried by agents.
4. As a human operator, I want each picker entry to show which umbrella member
   it belongs to, so that near-identical session titles stay distinguishable.
5. As a human operator, I want the attached session's CWD permanently visible
   at the bottom of the screen, so that I never have to open the sidebar to
   know where a session operates.
6. As an orchestrator (es machinery), I want one API call that returns the
   whole umbrella's sessions, so that liveness checks and fleet queries stop
   silently missing lane sessions.
7. As the es CLI, I want to declare umbrella membership in a mapping file that
   I own and update on lane create/close, so that grouping policy stays in the
   tool that has the knowledge.
8. As a human operator, I want labels (repo root / sidecar / lane name) carried
   in the es mapping, so that the picker never re-derives what a directory is
   from heuristics.
9. As a human operator, I want sessions from outside the umbrella excluded from
   the default picker view, so that unrelated daemon-wide sessions no longer
   leak in (present-day insert-path bug).
10. As a human operator working in a repo without es machinery, I want behavior
    to remain stock opencode, so that the fork changes nothing where no
    umbrella is declared.
11. As the fork maintainer, I want all umbrella code in new modules with tiny
    registration seams into upstream files, so that monthly rebases onto
    upstream releases stay cheap.
12. As the fork maintainer, I want any fix upstream could plausibly accept
    built upstream-shaped and submitted, so that the fork's permanent delta
    converges to only what upstream would never take.

## Implementation Decisions

Decisions fixed during the grill:

- **Full fork, not TUI-only.** Murtaza does not care about keeping a stock
  daemon; server-side changes are in scope. Rebase debt paid ~monthly against
  upstream releases.
- **Fork hygiene rules (binding):** extension-first — absorbed features live in
  new files/packages; touches to upstream files are confined to small,
  greppable registration seams. Upstream-first triage — before a feature lands
  in the fork, classify whether upstream could accept it; if plausibly yes,
  build upstream-shaped and submit, carrying it in the fork only while pending.
- **Umbrella definition is explicit and es-authored** (not inferred, not
  upstream-native nesting). es maintains a mapping file consumed by the server;
  the fork carries the mechanism, es owns the policy. Each member entry carries
  a label (repo root / sidecar / lane <name>). Inference from `.editspace`
  layout is a possible later fallback for non-es repos, not round 1.
- **The umbrella lives server-side** as an additive listing capability (new
  route or listing parameter), not client-side aggregation — so the TUI, the
  web app (later), and es orchestration queries all benefit from one
  implementation point. Chosen explicitly to let the fork absorb more es
  machinery over time (editspace concept, lanes, agent spawning).
- **Picker grouping**: mine (repo root) / fleet-by-lane / other members; same
  view from any member directory; grouping logic extracted as a pure function
  consuming sessions + umbrella labels.
- **Status bar**: persistent session-CWD element at the bottom of the screen.
- **jj support collapses into the umbrella.** With membership declared
  explicitly, project identity no longer depends on VCS detection; lane
  workspaces group correctly without teaching opencode about jj. Murtaza does
  not use opencode's undo, so git-based snapshot semantics in jj repos are not
  a requirement. No jj-specific work in round 1.
- **Logistics** (done during bootstrap): fork murtaza64/opencode; working copy
  at `~/opencode` (jj colocated, upstream remote tracked); embedded editspace
  sidecar + issue tracker; fork binary will replace the brew install (brew
  formula retired to avoid stale-binary shadowing); daemon supervised by a
  LaunchAgent pointing at the fork build.

## Testing Decisions

Two seams, approved 2026-07-08:

- **HTTP API seam (existing, highest).** The umbrella listing is tested the way
  the existing server HTTP tests work: serve the API routes against a fixture
  instance/database, write a fixture umbrella mapping, create sessions across
  member directories, and assert the merged + labeled result — and that
  non-members are excluded. All server behavior (mapping parse, merge, labels,
  boundaries) tests through this seam. Prior art: the existing httpapi session
  tests in the server test suite.
- **Pure grouping util seam (new, TUI).** Picker grouping is a pure function
  (sessions + labels in, grouped/ordered options out) tested like the existing
  TUI util tests. The picker component stays a thin consumer.
- Good tests assert external behavior (API responses, grouping output), never
  implementation details. Status-bar CWD is trivial rendering — no dedicated
  tests. No TUI end-to-end/screenshot infrastructure exists upstream and round
  1 does not justify building it.

## Out of Scope

- **Global attach** (attaching to sessions outside the umbrella with a
  "leaving the tree" indicator) — deferred to a later round; it requires the
  TUI's per-process instance context to swap per-session, a separable refactor.
- **Web app umbrella UI** — the server route will serve it eventually; no web
  client work in round 1.
- **Permission-system fixes** (inert `edit` deny rules, `external_directory`
  direction, deny-never-ask) — separate track; upstream bug report owed.
- **prompt_async silent-failure surfacing, picker insert-path project guard,
  web app scope fix** — upstream-PR track per the upstream-first rule, not
  umbrella features.
- **Config/agent hot-reload** (daemon restart kills sessions) — future
  absorption candidate.
- **jj cosmetics** (change ID in status bar, jj-based diffs) and snapshot/undo
  correctness in jj repos.

## Further Notes

- The picker-leak mechanism (diagnosed 2026-07-08, v1.17.10): the picker
  freezes its display order at open time but live-inserts any session arriving
  on the unfiltered daemon-wide event stream into its backing store with no
  project guard; the event endpoint the TUI uses has zero per-connection
  filtering. The umbrella route plus story 9 replaces this accident with
  declared scope. Full trace in dotfiles sidecar issue 09.
- Upstream velocity is high (multiple releases since v1.17.10 in days) and the
  hot zones (session service, TUI packaging) refactor frequently — the
  extension-first rule exists because of this.
- The es-side mapping writer (update on lane create/close) is es work tracked
  in the dotfiles project, not this repo.
