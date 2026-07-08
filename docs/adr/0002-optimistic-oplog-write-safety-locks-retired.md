# Optimistic op-log write safety; advisory locks retired

Status: accepted (grilled 2026-07-08)

Concurrent-writer safety for agents in jj checkouts is **optimistic**: no
locks. Each session tracks a Baseline (jj op ID per (session, workspace));
a write against a workspace that advanced past the Baseline fails with a
Reorientation built from the op log (ops, touched files, recovery steps),
and the agent re-reads and retries. File-granular via op-range diffs where
cheap, workspace-granular fallback. The fork's file tools materialize jj
snapshots after mutations so the op log is complete ground truth — agent
writes otherwise create no ops until the next jj command.

The editspace-lock plugin's advisory writer-leases are **retired** once this
lands: their goal (agents not confusing each other in a shared checkout) is
served by lanes where discipline exists and by reorientation where it
doesn't. Rejected: promoting pessimistic leases into core — lease lifecycle,
holder identity, and timeout policy are heavy machinery; blocking buys
little when jj makes every divergence recoverable; and lease waits stall
unattended agents (deny-never-ask lesson, manadj ADR 0028).

Consequences: two writers interleaving produces failed-write reorientations,
not stalls or silent clobbers; misclassifying a bash command as mutating
costs a spurious reorientation, not a blocked write. Change discipline
(one jj change per unit of work) stays advisory in shared checkouts —
automation belongs to session-owned workspaces (future PRD).
