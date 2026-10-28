import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Schema } from "effect"
import { MessageID } from "./schema"

export const Outcome = Schema.Literals([
  "started",
  "busy",
  "waiting",
  "pending-input",
  "failed",
  "uncertain",
  "unanswered",
  "stale",
  "archived",
  "child",
  "superseded",
  "mismatch",
])
export type Outcome = typeof Outcome.Type

export const RequestID = SessionV1.NudgeMarker.fields.requestID

export const Payload = Schema.Struct({
  requestID: RequestID,
  observedMessageID: MessageID,
}).annotate({ identifier: "SessionNudgeInput" })
export type Payload = typeof Payload.Type

export const Result = Schema.Struct({
  outcome: Outcome,
  requestID: RequestID,
  /** The promoted Nudge message when a finished turn was continued with the fixed Nudge input. */
  messageID: Schema.optional(MessageID),
  /** Pending inputs the caller must deliver explicitly; Nudge never promotes or re-routes them. */
  requestIDs: Schema.optional(Schema.Array(Schema.String)),
}).annotate({ identifier: "SessionNudgeResult" })
export type Result = typeof Result.Type

/** The provider-visible text of the sourced Nudge input, shown under the lower-trust mail wrapper. */
export const TEXT = "Continue."
export const SENDER = "human (Nudge)"
export const KIND = "nudge"
export const inputRequestID = (requestID: string) => `nudge:${requestID}`

export type Decision =
  | { readonly outcome: Exclude<Outcome, "started" | "pending-input">}
  | { readonly outcome: "pending-input"; readonly requestIDs: readonly string[] }
  | { readonly outcome: "started"; readonly mode: SessionV1.NudgeMarker["mode"] }

/**
 * Decide what one explicit Nudge may do for an idle Session, from durable evidence only.
 *
 * `observedMessageID` is the tail the human saw; any newer row (by time or insertion) makes the request
 * stale, so a repeated click cannot start a second turn. Pending inputs are reported, never promoted:
 * the caller delivers them explicitly. A tail ending in tool results whose effects are durable resumes
 * with no message added. A tool that was pending or running, interrupted by Stop, or abandoned after a
 * restart has an unknown effect, so the tail is uncertain and goes to operator recovery; an aborted or
 * unfinished step is uncertain too. A naturally finished turn continues through one sourced Nudge input.
 */
export function decide(input: {
  observedMessageID: MessageID
  now: number
  tail: SessionV1.WithParts | undefined
  newestByInsertion: MessageID | undefined
  pendingRequestIDs: readonly string[]
}): Decision {
  const tail = input.tail
  if (!tail || tail.info.id !== input.observedMessageID || input.newestByInsertion !== tail.info.id) return { outcome: "stale" }
  if (input.pendingRequestIDs.length) return { outcome: "pending-input", requestIDs: input.pendingRequestIDs }
  const info = tail.info
  if (info.role === "user") return { outcome: "unanswered" }
  if (info.error && info.error.name !== "MessageAbortedError") return { outcome: "failed" }
  const tools = tail.parts.filter((part): part is SessionV1.ToolPart => part.type === "tool" && !part.metadata?.providerExecuted)
  // Rows written by the continued turn would sort before a tail stamped in the future.
  if (info.error || tools.some((part) => !durable(part)) || info.time.created > input.now) return { outcome: "uncertain" }
  if (info.structured !== undefined) return { outcome: "started", mode: "input" }
  if (!info.finish || info.finish === "unknown") return { outcome: "uncertain" }
  const last = tail.parts.findLast(meaningful)
  // A tail ending in prose is never resumed directly: the provider would read it as an assistant prefill.
  if (last?.type === "tool" && !last.metadata?.providerExecuted) return { outcome: "started", mode: "resume" }
  if (info.finish === "tool-calls") return { outcome: "uncertain" }
  return { outcome: "started", mode: "input" }
}

// Decided from typed state only: interrupted and abandoned errors are written by Stop and restart
// recovery, not returned by the tool, so their effect is unknown.
function durable(part: SessionV1.ToolPart) {
  if (part.state.status === "completed") return true
  if (part.state.status !== "error") return false
  return part.state.metadata?.interrupted !== true && part.state.metadata?.abandoned !== true && part.state.time.end > 0
}

function meaningful(part: SessionV1.Part) {
  if (part.type === "tool") return true
  if (part.type === "text" || part.type === "reasoning") return part.text.trim().length > 0
  return false
}

export * as SessionNudge from "./nudge"
