import { NonNegativeInt } from "@opencode-ai/core/schema"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Schema } from "effect"
import { SessionRunState } from "./run-state"
import { MessageID } from "./schema"

export const RestartID = SessionV1.RestartContinuation.fields.restartID

export const Outcome = Schema.Literals([
  "scheduled",
  "duplicate",
  "running",
  "advanced",
  "complete",
  "failed",
  "uncertain",
  "archived",
  "child",
  "superseded",
  "mismatch",
  "stale",
  "capacity",
])
export type Outcome = typeof Outcome.Type

export const ContinuePayload = Schema.Struct({
  restartID: RestartID,
  anchorMessageID: MessageID,
  capturedAt: NonNegativeInt,
}).annotate({ identifier: "SessionRestartContinueInput" })
export type ContinuePayload = typeof ContinuePayload.Type

export const ContinueResult = Schema.Struct({
  outcome: Outcome,
  marker: Schema.optional(SessionV1.RestartContinuation),
}).annotate({ identifier: "SessionRestartContinueResult" })
export type ContinueResult = typeof ContinueResult.Type

export const Status = Schema.Struct({
  marker: Schema.optional(SessionV1.RestartContinuation),
  later: Schema.Boolean,
}).annotate({ identifier: "SessionRestartStatus" })
export type Status = typeof Status.Type

// Markers are the idempotency record, so none is ever dropped; an anchor that has absorbed this many
// restarts without progress refuses new ones instead of forgetting an earlier restart ID.
export const MAX_MARKERS = 8
export type Reason = NonNullable<SessionV1.RestartContinuation["reason"]>

export type Decision =
  | { readonly outcome: "advanced" | "complete" | "failed" | "stale" | "capacity" }
  | { readonly outcome: "scheduled" | "uncertain"; readonly marker: SessionV1.RestartContinuation; readonly anchor: SessionV1.WithParts }

/**
 * Decide what one controlled restart may do for one Session, from durable evidence only.
 *
 * The anchor is the newest message captured just before the restart; anything written since (a
 * prompt, a retry, another continuation) means the Session moved on. A tool call on the anchor that
 * was pending or running, or that a shutdown cancelled, has an unknown effect — it may have partly
 * or fully run — so that is checked before any path that could resume: such an anchor is recorded as
 * uncertain and left idle for a human, never settled, replayed, or handed to the model to guess
 * about. A non-abort error is a failed turn and belongs to Retry. Otherwise a turn continues only
 * from a boundary whose effects are all durable: a promoted prompt, completed tool results, or
 * provider output that a regenerated turn may replace. An abort stamped before the restart (possibly
 * a human stop) and an anchor dated in the future, after which no new row could sort, are uncertain.
 * Callers check for an existing marker with this restart ID first.
 */
export function decide(input: {
  payload: ContinuePayload
  now: number
  anchor: SessionV1.WithParts | undefined
  newest: { byTime: MessageID | undefined; byInsertion: MessageID | undefined }
  turn: { user: SessionV1.User | undefined; assistant: SessionV1.WithParts | undefined }
  pendingInput: boolean
}): Decision {
  const anchor = input.anchor
  if (!anchor) return { outcome: "stale" }
  if (input.newest.byTime !== anchor.info.id || input.newest.byInsertion !== anchor.info.id) return { outcome: "advanced" }
  if ((anchor.info.restarts?.length ?? 0) >= MAX_MARKERS) return { outcome: "capacity" }
  const result = (outcome: "scheduled" | "uncertain", interruptedTools: number, reason?: Reason): Decision => ({
    outcome,
    anchor,
    marker: {
      restartID: input.payload.restartID,
      outcome,
      ...(reason ? { reason } : {}),
      interruptedTools,
      time: input.now,
    },
  })
  const unknown = anchor.parts.filter(
    (part) =>
      part.type === "tool" &&
      (part.state.status === "pending" ||
        part.state.status === "running" ||
        (part.state.status === "error" && part.state.metadata?.interrupted === true)),
  ).length
  if (anchor.info.time.created > input.now) return result("uncertain", unknown, "out-of-order")
  if (unknown > 0) return result("uncertain", unknown, "interrupted-tool")

  const assistant = input.turn.assistant?.info.role === "assistant" ? input.turn.assistant.info : undefined
  const parts = input.turn.assistant?.parts ?? []
  if (SessionRunState.completedTurn(input.turn.user, assistant, parts, true)) {
    const natural = SessionRunState.completedTurn(input.turn.user, assistant, parts)
    if (!natural || !input.pendingInput) return { outcome: "complete" }
    return result("scheduled", 0)
  }

  if (anchor.info.role === "assistant" && anchor.info.error) {
    if (anchor.info.error.name !== "MessageAbortedError") return { outcome: "failed" }
    // Only an abort stamped inside the restart window is the restart's own shutdown.
    if ((anchor.info.time.completed ?? 0) < input.payload.capturedAt) return result("uncertain", 0, "aborted")
  }
  return result("scheduled", 0)
}

/**
 * The rows to write for a decision: the marker on the anchor and, when an unfinished assistant step
 * is resumed, that step closed exactly as a graceful abort leaves it. Its completed tool results stay
 * in model history; a step with no tool calls is regenerated instead of prefilled.
 */
export function settle(decision: Extract<Decision, { outcome: "scheduled" | "uncertain" }>, now: number): SessionV1.Info {
  const info = decision.anchor.info
  const restarts = [...(info.restarts ?? []), decision.marker]
  if (info.role !== "assistant" || decision.outcome !== "scheduled" || info.time.completed) return { ...info, restarts }
  return {
    ...info,
    restarts,
    error: info.error ?? new SessionV1.AbortedError({ message: "Interrupted by an OpenCode daemon restart" }).toObject(),
    time: { ...info.time, completed: now },
  }
}

export * as SessionRestart from "./restart"
