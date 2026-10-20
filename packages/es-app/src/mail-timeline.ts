import type { Message } from "@opencode-ai/sdk/v2"
import type { MailDelivery, MailMessage, MailTimeline } from "./api"

export const mailLocation = (directory: string, editspaces: { name: string; root: string }[], sessionID?: string):
  { name: string; lane: string; session?: never } | { name: string; session: string; lane?: never } | undefined => {
  const matches = editspaces.flatMap((item) => {
    const root = item.root.replace(/\/+$/, "")
    const prefix = `${root}/lanes/`
    if (!directory.startsWith(prefix)) return []
    const lane = directory.slice(prefix.length).split("/")[0]
    return lane ? [{ name: item.name, lane, length: root.length }] : []
  }).sort((a, b) => b.length - a.length)
  if (matches[0]) return { name: matches[0].name, lane: matches[0].lane }
  const scope = editspaces.map(item => ({ ...item, anchor: item.root.replace(/\/+$/, "").replace(/\/\.editspace$/, "") }))
    .filter(item => directory === item.anchor || directory.startsWith(`${item.anchor}/`))
    .sort((a, b) => b.anchor.length - a.anchor.length)[0]
  return scope && sessionID ? { name: scope.name, session: sessionID } : undefined
}

export const mailTimestamp = (value: string | number) =>
  typeof value === "number" ? value : Date.parse(value)

export const mailSentAt = (message: MailMessage) => message.created_ms ?? mailTimestamp(message.ts)

export const mailSourceID = (message: Message) => {
  if (message.role !== "user" || !("source" in message)) return
  const source: unknown = message.source
  if (!source || typeof source !== "object" || !("type" in source) || source.type !== "editspace-mail" ||
    !("id" in source) || typeof source.id !== "string" ||
    !("sender" in source) || typeof source.sender !== "string" ||
    !("recipient" in source) || typeof source.recipient !== "string") return
  return source.id
}

export type MailInterval = { sessionID: string; lane?: string; from?: number; to?: number }

// Receipt/admission times never move historical source content into a new session.
export const mailForSession = (messages: MailMessage[], interval: MailInterval) =>
  messages.filter((message) => {
    const at = mailSentAt(message)
    if (interval.from !== undefined && !Number.isFinite(interval.from)) return false
    if (interval.to !== undefined && !Number.isFinite(interval.to)) return false
    if (!Number.isFinite(at) || (interval.from !== undefined && at < interval.from) ||
      (interval.to !== undefined && at >= interval.to)) return false
    const receipts = message.deliveries.filter((delivery) =>
      delivery.session && (interval.lane === undefined || delivery.recipient === interval.lane))
    if (message.direction === "received" && receipts.length)
      return receipts.some((delivery) => delivery.session === interval.sessionID)
    if (message.direction === "sent" && message.sender_session) return message.sender_session === interval.sessionID
    return true
  })

// These receipts prove input delivery, not an idle -> scheduled execution transition.
export const mailWake = (delivery?: MailDelivery) => {
  if (delivery?.mode === "passive" || delivery?.mode === "mute") return "Did not wake · passive"
  return "Wake/resume unknown"
}

type TimelineRow = { type: "transcript"; message: Message; timestamp: number } | { type: "mail"; message: MailMessage; timestamp: number }

export const mailRows = (messages: Message[], timeline: MailTimeline | undefined,
  previous: TimelineRow[] = [], interval?: MailInterval): TimelineRow[] => {
  const scoped = interval ? mailForSession(timeline?.messages ?? [], interval) : timeline?.messages ?? []
  const records = new Map(scoped.map(message => [message.id, message]))
  // Keep raw history intact. Mail with unavailable/old source time is not transcript content.
  const visible = interval ? messages.filter(message => {
    const id = mailSourceID(message)
    return !id || records.has(id)
  }) : messages
  const existing = new Map(previous.map((row) => [`${row.type}:${row.message.id}`, row]))
  const promoted = new Set(visible.flatMap((message) => {
    const id = mailSourceID(message)
    return id ? [id] : []
  }))
  const standalone = [...records.values()].filter((message) => !promoted.has(message.id))
  const times = new Map((timeline?.messages ?? []).map((message) => [message.id, mailSentAt(message)]))
  return [
    ...visible.map((message) => {
      const timestamp = times.get(mailSourceID(message) ?? "") ?? message.time.created
      const previous = existing.get(`transcript:${message.id}`)
      return previous?.message === message && previous.timestamp === timestamp
        ? previous : { type: "transcript" as const, message, timestamp }
    }),
     ...standalone.map((message) => {
       const previous = existing.get(`mail:${message.id}`)
       // Polls deserialize new objects; retain unchanged details/focus across replay.
       return previous && JSON.stringify(previous.message) === JSON.stringify(message)
         ? previous : { type: "mail" as const, message, timestamp: mailSentAt(message) }
     }),
  ].sort((a, b) => (a.timestamp - b.timestamp) || (a.type === b.type ? 0 : a.type === "transcript" ? -1 : 1))
}
