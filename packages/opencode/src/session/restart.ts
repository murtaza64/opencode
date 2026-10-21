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

const MAX_MARKERS = 8
export type Reason = NonNullable<SessionV1.RestartContinuation["reason"]>

export type Decision =
  | { readonly outcome: "advanced" | "complete" | "failed" | "stale" }
  | { readonly outcome: "scheduled" | "uncertain"; readonly marker: SessionV1.RestartContinuation; readonly anchor: SessionV1.WithParts }

/**
 * Decide what one controlled restart may do for one Session, from durable evidence only.
 *
 * The anchor is the newest message captured just before the restart; anything written since (a
 * prompt, a retry, another continuation) means the Session moved on. A non-abort error is a failed
 * turn and belongs to Retry. A turn continues only from a boundary whose effects are all durable:
 * a promoted prompt, settled tool results, or provider output that a regenerated turn may replace.
 * A tool call that was pending or running when the process died has an unknown effect — it may have
 * partly or fully run — so it is never settled, replayed, or handed to the model to guess about; it
 * is recorded as uncertain and left idle for a human. The same holds for an abort stamped before
 * the restart (possibly a human stop, or a graceful cancel that interrupted a tool) and for an
 * anchor dated in the future, after which no new row could sort.
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
  const unsettled = anchor.parts.filter(
    (part) => part.type === "tool" && (part.state.status === "pending" || part.state.status === "running"),
  ).length
  const cancelled = anchor.parts.filter(
    (part) => part.type === "tool" && part.state.status === "error" && part.state.metadata?.interrupted === true,
  ).length
  if (anchor.info.time.created > input.now) return result("uncertain", unsettled + cancelled, "out-of-order")

  const assistant = input.turn.assistant?.info.role === "assistant" ? input.turn.assistant.info : undefined
  const parts = input.turn.assistant?.parts ?? []
  if (SessionRunState.completedTurn(input.turn.user, assistant, parts, true)) {
    const natural = SessionRunState.completedTurn(input.turn.user, assistant, parts)
    if (!natural || !input.pendingInput) return { outcome: "complete" }
    return result("scheduled", 0)
  }

  if (anchor.info.role === "assistant" && anchor.info.error) {
    if (anchor.info.error.name !== "MessageAbortedError") return { outcome: "failed" }
    // Only an abort stamped inside the restart window is the restart's own shutdown, and only a
    // shutdown that cancelled no tool leaves every effect durable.
    if ((anchor.info.time.completed ?? 0) < input.payload.capturedAt) return result("uncertain", cancelled, "aborted")
    if (cancelled > 0) return result("uncertain", cancelled, "interrupted-tool")
    return result("scheduled", 0)
  }
  if (unsettled > 0) return result("uncertain", unsettled, "interrupted-tool")
  return result("scheduled", 0)
}

/**
 * The rows to write for a decision: the marker on the anchor and, when an unfinished assistant step
 * is resumed, that step closed exactly as a graceful abort leaves it. Its completed tool results stay
 * in model history; a step with no tool calls is regenerated instead of prefilled.
 */
export function settle(decision: Extract<Decision, { outcome: "scheduled" | "uncertain" }>, now: number): SessionV1.Info {
  const info = decision.anchor.info
  const restarts = [...(info.restarts ?? []), decision.marker].slice(-MAX_MARKERS)
  if (info.role !== "assistant" || decision.outcome !== "scheduled" || info.time.completed) return { ...info, restarts }
  return {
    ...info,
    restarts,
    error: info.error ?? new SessionV1.AbortedError({ message: "Interrupted by an OpenCode daemon restart" }).toObject(),
    time: { ...info.time, completed: now },
  }
}

export * as SessionRestart from "./restart"
