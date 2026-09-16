# Background task lifecycle

- Enable in an isolated process with `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true`. The default remains foreground-only.
- `task({ description, prompt, subagent_type, background: true })` returns a child Session ID immediately. Initial dispatch also returns `runId` identifying this process-local job generation.
- Completion, failure, and permission/question waits send synthetic parent notices with child ID and `run_id`. Notices grant no approval. Resolve requests through the existing permission/question UI.
- `task_status({ task_id, action: "inspect" | "cancel" })` inspects or cancels a direct child in the caller's directory. Cancellation returns its outcome; it does not wake a stopped parent.
- Resume with `task_id` and the same agent. Missing IDs fail without replacement. Running updates execute sequentially; they are not queue/steer delivery modes.
- Revoked parent denies or changed inherited external-directory grants reject resume. Reconcile the child's scope while idle before retrying. Existing child restrictions are preserved.

## Restart contract

Jobs, subscriptions, and notice delivery are process-local. No replay, delivery retry, or exactly-once guarantee is provided. A persisted child without a current job reports `unknown`, including on cancel; that does not mean completed or successfully cancelled. Inspect its transcript and reconcile uncertain effects before explicitly resuming.

## Isolated walkthrough

Run from `packages/opencode`; fixtures use temporary storage and a local canned HTTP provider, then clean up.

1. Run `bun test test/session/prompt.test.ts -t "native background lifecycle proof|cancelling an extension" --timeout 20000`.
2. The first case holds a child on a real question, asserts independent parent output before answering, then asserts one correlated completion notice and inherited edit denial.
3. The second case extends a running child, cancels while the extension awaits a question, and checks the real runner is idle with no pending question.
4. Run `bun test test/tool/task.test.ts test/background/job.test.ts --timeout 30000`; inspect/cancel ownership, duplicate-request notices, capability gating, and explicit resume are covered.
5. From `packages/core`, run `bun test test/background-job.test.ts --timeout 30000` for generation correlation and registry loss without replay.

## Coordinated rollout

After source review, the coordinator can include this change in a candidate, run the walkthrough there, checkpoint active sessions, and obtain approval for activation. Enable the existing flag only in that approved daemon process. Verify `/experimental/capabilities` reports background support and the model tool schema contains `background` plus `task_status`. Explicitly resume checkpointed sessions after restart; do not assume automatic continuation.

This source change does not activate the daemon. Durable notice storage, restart reconciliation, and remote execution ownership remain separate work.
