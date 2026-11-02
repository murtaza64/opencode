import type { MailMessage } from "./api"

// Message ticks (DOUBLE-TICK, android-ops specs/DOUBLE-TICK.md). One state per own message, from durable evidence
// only: sending (local, no receipt yet) -> sent (durable receipt) -> delivered (promoted into the transcript) -> read
// (this session's Core time.turn.started after the promotion). Not sent / not confirmed is "failed". Read is never
// inferred from fetches, polls or time.updated: without a later turn start a delivered message stays delivered.

export type Tick = "sending" | "sent" | "delivered" | "read" | "failed"
const RANK: Record<Tick, number> = { failed: -1, sending: 0, sent: 1, delivered: 2, read: 3 }

/** The later of two states; a failure only replaces a state that never left this device. */
export const laterTick = (a: Tick | undefined, b: Tick) => !a ? b : b === "failed" ? (a === "sending" ? b : a) : a === "failed" ? b : RANK[b] > RANK[a] ? b : a

const time = (at: number | undefined) => at === undefined || !Number.isFinite(at) ? "" : new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })

/** A transcript user message: delivered at its promotion, read once a turn started after that promotion. */
export const transcriptTick = (input: { promotedAt: number; turnStarted?: number }): { tick: Tick; label: string } => {
  const read = input.turnStarted !== undefined && input.turnStarted > input.promotedAt
  return read
    ? { tick: "read", label: `Delivered ${time(input.promotedAt)} · read ${time(input.turnStarted)}` }
    : { tick: "delivered", label: `Delivered ${time(input.promotedAt)} · not read yet` }
}

/** An outgoing bubble that has not reached the transcript: sending, sent (with its delivery), or not sent. */
export const bubbleTick = (input: { status: "sending" | "pending" | "unknown" | "absent" | "accepted"; delivery?: "queue" | "steer"; at?: number }): { tick: Tick; label: string } => {
  if (input.status === "sending") return { tick: "sending", label: "Sending" }
  if (input.status === "absent") return { tick: "failed", label: "Not sent" }
  if (input.status === "unknown") return { tick: "failed", label: "Not confirmed" }
  const how = input.delivery === "steer" ? " · steer, not yet delivered" : input.delivery === "queue" ? " · queued, not yet delivered" : ""
  return { tick: "sent", label: `Sent ${time(input.at)}${how}`.replace(/ $/, "") }
}

/** A mail sent row: stored or admitted (sent), presented or handled (delivered, never read or done), or failed. */
export const mailTick = (state: string): { tick: Tick; label: string } => {
  if (state === "failed") return { tick: "failed", label: "Mail delivery failed" }
  if (["presented", "read", "handled"].includes(state))
    return { tick: "delivered", label: state === "handled" ? "Mail delivered and acknowledged; not proof the work started" : "Mail delivered to the recipient agent" }
  if (state.startsWith("recorded only")) return { tick: "sent", label: "Mail recorded, recipient not woken" }
  if (state === "mixed states") return { tick: "sent", label: "Mail sent; recipients are in different states" }
  return { tick: "sent", label: state === "delivery state not loaded" ? "Mail sent; delivery state not loaded" : `Mail sent; ${state}` }
}

export type { MailMessage }
