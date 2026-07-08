# Substrate/process split, lane provider contract, umbrella project identity

Status: accepted (grilled 2026-07-08, two parallel sessions, synthesized)

The fork integrates with the editspace machinery along a hard layer split:
the **workspace substrate** (sidecar layout, jj workspaces, lane records,
lane lifecycle) is consumable by opencode; the **process layer** (claims,
tracker states, parked/landed, spawn protocol, probes) stays out of opencode
indefinitely. Integration is by **contract, not binary**: a Lane Provider
Contract (create/list/close, JSON I/O) implemented round 1 by shelling out
to `es` from the fork daemon. opencode MAY absorb the substrate later behind
the same contract, with `es` becoming a daemon client.

**Lane model (ratified):** a lane is a workstream containing 1..N repo
checkouts; claims/records/close are lane-level; a session sits in at most
one lane; lanes exist independently of sessions. Rejected: lane = single jj
workspace with session-anchored identity — it ties process state to
ephemeral session IDs, dissolves location-based labeling, and is
structurally incompatible with session mobility (moving a session into a
lane presupposes the lane exists without it).

**Identity (ratified): the editspace IS the project.** Sessions anywhere
under an umbrella root resolve to the umbrella's project; identity is
umbrella-driven, never VCS-driven. Lane sessions keep their **write-boundary
anchor at the lane root** (not the individual repo checkout, not the
sidecar/editspace root) — one boundary per workstream, so sibling lanes,
mirrors/caches, the default workspace, and the tracker are external
(tracker writes via allow-list). The lane root need not be a git or jj
repo; anchoring is pure path containment.

Rejected alternatives: wrapping upstream's workspace adapters for lanes
(rows are project-scoped; revisit only for upstream workspace UI
affordances); reimplementing lanes inside the fork; per-repo project
identity for lane sessions (multi-repo lanes would scatter across cache
repos' projects and today's sidecar-anchored gate leaves all lanes mutually
writable — the motivating defect).

Consequences: stock project scoping shows lane sessions natively once
identity lands; the umbrella listing remains for labels and cross-root
views; `external_directory` becomes a real cross-lane guard, which is what
makes lock retirement (ADR 0002) safe.
