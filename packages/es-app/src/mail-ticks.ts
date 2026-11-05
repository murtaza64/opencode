import type { MailDelivery, MailWakeState, MailWakeStatus } from "./api"
import { clockTime } from "./local-time"
import type { Tick } from "./message-ticks"

// Mail ticks (Loupe ux-feel/artifacts/mail-ticks.md, DD #414/#415). One glyph slot per outgoing mail, from delivery
// evidence only:
//   ✓  grey    sending: recorded, not yet in the recipient's inbox (no delivery row, or queued for the runtime)
//   ✓✓ grey    inbox: admitted into the recipient session's durable inbox, or a passive copy recorded for it
//   ✓✓ accent  presented: shown to the recipient agent in a turn (`presented_at`); never "done" or "seen in the app"
//   !  red     failed
// The dashboard's typed `tick` (es.mail.wake/v1) wins when present; older dashboards fall back to state words.
// Handled, request ids and wake observations stay in the expansion; the wake cue moves into the hover.

export type MailLevel = "sending" | "inbox" | "presented" | "failed"
const RANK: Record<Exclude<MailLevel, "failed">, number> = { sending: 0, inbox: 1, presented: 2 }
const TICK: Record<MailLevel, Tick> = { sending: "sent", inbox: "delivered", presented: "read", failed: "failed" }

/** The evidence a tick reads from one delivery; `MailDelivery` fits, and so does a send-time line. */
export type TickDelivery = Pick<MailDelivery, "recipient" | "state"> & Partial<Pick<MailDelivery, "mode" | "error" | "presented_at" | "presented_ms" | "wake" | "tick">>

export const mailLevel = (delivery: TickDelivery): MailLevel => {
  const state = delivery.state ?? ""
  if (delivery.error || delivery.tick === "failed" || /fail|error|undeliver|reject|expired|dead|bounce/i.test(state)) return "failed"
  if (delivery.tick === "presented" || delivery.presented_at != null || delivery.presented_ms != null || ["presented", "read", "handled"].includes(state)) return "presented"
  if (delivery.tick === "admitted" || delivery.tick === "recorded" || delivery.mode === "passive" || delivery.mode === "mute"
    || ["admitted", "offered", "observed", "recorded"].includes(state) || state.startsWith("recorded only")) return "inbox"
  return "sending"
}

const WAITS: Partial<Record<MailWakeState, (agent: string) => string>> = {
  caused: (agent) => ` · woke ${agent}`,
  joined: (agent) => ` · ${agent} was working`,
  none: (agent) => ` · waits for ${agent}'s next turn`,
}

/** One recipient's line for the hover and accessible name. */
export const mailLevelLabel = (delivery: TickDelivery, agent: string) => {
  const level = mailLevel(delivery)
  const state = delivery.state ?? ""
  if (level === "failed") return `Not delivered to ${agent}${delivery.error ? `: ${delivery.error.split("\n")[0]!.slice(0, 120)}` : ""}`
  if (level === "presented") {
    const at = delivery.presented_ms ?? delivery.presented_at
    const time = at == null ? "" : clockTime(at)
    return `Read by ${agent}${time ? ` · ${time}` : ""}`
  }
  if (level === "inbox") {
    const passive = delivery.mode === "passive" || delivery.mode === "mute" || delivery.tick === "recorded" || state.startsWith("recorded")
    const wake = delivery.wake ?? (passive ? "none" : undefined)
    return `In ${agent}'s inbox${wake ? WAITS[wake]?.(agent) ?? "" : ""}`
  }
  if (["retired", "superseded"].includes(delivery.tick ?? state)) return `Withdrawn before ${agent} read it`
  if (state === "queued" || delivery.tick === "queued" || state === "admission pending") return `Sending · queued until ${agent} is free`
  return "Sending"
}

/** The chip's one tick for every recipient: a failure shows, otherwise the lowest state wins. Several recipients
 * list one line each in the hover. `name` turns a recipient into the agent's display name. */
export const outgoingMailTick = (deliveries: readonly TickDelivery[], name: (recipient: string) => string = (recipient) => recipient,
  suffix = ""): { tick: Tick; label: string; level: MailLevel } => {
  if (!deliveries.length) return { tick: TICK.sending, label: "Sending", level: "sending" }
  const levels = deliveries.map(mailLevel)
  const level = levels.includes("failed") ? "failed"
    : levels.reduce<Exclude<MailLevel, "failed">>((low, item) => RANK[item as Exclude<MailLevel, "failed">] < RANK[low] ? item as Exclude<MailLevel, "failed"> : low, "presented")
  const lines = deliveries.map((delivery) => mailLevelLabel(delivery, name(delivery.recipient)))
  const label = deliveries.length === 1 ? lines[0]! : lines.map((line, index) => `${name(deliveries[index]!.recipient)}: ${line}`).join("\n")
  return { tick: TICK[level], label: `${label}${suffix}`, level }
}

/** A sent mail whose delivery receipt this page cannot read: sent, never claimed to be in the inbox. */
export const lostReceiptTick = (why: string): { tick: Tick; label: string; level: MailLevel } =>
  ({ tick: TICK.sending, label: `Sent · delivery receipt not available (${why})`, level: "sending" })

/** Incoming mail for this session that its agent has not been shown yet (Loupe: unread = presented_at null). */
export const mailUnread = (deliveries: readonly MailDelivery[], sessionID: string | undefined) => {
  const own = deliveries.filter((delivery) => delivery.session === sessionID)
  return own.length > 0 && own.every((delivery) => mailLevel(delivery) === "inbox")
}

/** The line under an unread chip, from the dashboard's wake state only (never an invented time). */
export const unreadWakeLine = (input: { status?: MailWakeStatus; unavailable?: boolean; deliveries: readonly MailDelivery[]; sessionID?: string; now: number }) => {
  const picking = input.deliveries.some((delivery) => delivery.session === input.sessionID && (delivery.wake === "caused" || delivery.wake === "joined"))
  if (picking) return "Agent is picking this up"
  const status = input.status
  if (!status) return input.unavailable ? "Next wake not available" : undefined
  if (status.state === "scheduled" && status.next?.at_ms != null) return `Agent wakes ${wakeIn(status.next.at_ms, input.now)}`
  if (status.state === "waiting-idle") return "Agent wakes when it is free"
  if (status.state === "paused") return "Agent paused · no wake scheduled"
  if (status.state === "blocked") return status.next?.reason === "lane-parked" || status.next?.reason === "lane-paused"
    ? "Agent paused · no wake scheduled" : `Blocked: ${blockedReason(status.next?.reason)}`
  return "No wake scheduled · read on the agent's next turn"
}

const wakeIn = (at: number, now: number) => {
  const seconds = Math.round((at - now) / 1000)
  if (seconds <= 0) return "now"
  if (seconds < 60) return `in ${seconds} s`
  return `in ${Math.round(seconds / 60)} min`
}

export const blockedReason = (reason: string | undefined) => !reason ? "unknown"
  : reason === "no-owner-session" ? "no agent owns this lane"
  : reason.startsWith("lane-") ? `lane ${reason.slice(5)}`
  : reason
