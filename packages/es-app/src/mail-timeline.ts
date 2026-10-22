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

// Only runtime decision observations prove scheduling; admission/status cannot.
export const mailWakeObservations = (delivery?: MailDelivery) =>
  delivery?.wake_observations?.filter(observation =>
    (observation?.outcome === "scheduled" || observation?.outcome === "coalesced") &&
    Number.isSafeInteger(observation.observedAt) && observation.observedAt >= 0 &&
    Number.isFinite(new Date(observation.observedAt).getTime())) ?? []

export const mailWake = (delivery?: MailDelivery) => {
  const observations = mailWakeObservations(delivery)
  if (observations.some(observation => observation.outcome === "scheduled")) return "Execution scheduled"
  if (observations.some(observation => observation.outcome === "coalesced")) return "Coalesced · already active"
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
  return [
    ...visible.map((message) => {
      // Promoted mail sits where the model received it; its send time is shown as metadata.
      const timestamp = message.time.created
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

export type MailCause = {
  ids: string[]
  kinds: { kind: string; human: boolean; catchUp: boolean; count: number }[]
  senders: string[]
  sentFrom?: number
  sentTo?: number
  promotedAt: number
}

const mailSource = (message: Message) => {
  if (!mailSourceID(message) || !("source" in message)) return
  return message.source as { id: string; sender: string; kind?: string; relationship?: string }
}

// Consecutive promoted mail that is the parent run of an assistant message was that provider
// turn's input. Summarize it at the run's last mail, directly before the turn it caused.
export const mailCauses = (rows: TimelineRow[], records: Map<string, MailMessage>) => {
  const transcript = rows.flatMap((row) => row.type === "transcript" ? [row.message] : [])
  const causes = new Map<string, MailCause>()
  transcript.forEach((message, index) => {
    const next = transcript[index + 1]
    if (!mailSource(message) || next?.role !== "assistant" || next.parentID !== message.id) return
    const run: Message[] = []
    for (let at = index; at >= 0 && mailSource(transcript[at]!); at--) run.unshift(transcript[at]!)
    const sent = run.flatMap((item) => {
      const record = records.get(mailSource(item)!.id)
      const at = record ? mailSentAt(record) : Number.NaN
      return Number.isFinite(at) ? [at] : []
    })
    causes.set(message.id, {
      ids: run.map((item) => mailSource(item)!.id),
      kinds: run.reduce<MailCause["kinds"]>((kinds, item) => {
        const source = mailSource(item)!
        const record = records.get(source.id)
        const kind = source.kind ?? record?.kind ?? "mail"
        const human = kind === "answer" && record?.from === "human"
        const catchUp = source.relationship === "handoff-catch-up"
        const same = kinds.find((entry) => entry.kind === kind && entry.human === human && entry.catchUp === catchUp)
        return same
          ? kinds.map((entry) => entry === same ? { ...entry, count: entry.count + 1 } : entry)
          : [...kinds, { kind, human, catchUp, count: 1 }]
      }, []),
      senders: [...new Set(run.map((item) => mailSource(item)!.sender))],
      ...(sent.length ? { sentFrom: Math.min(...sent), sentTo: Math.max(...sent) } : {}),
      promotedAt: run[0]!.time.created,
    })
  })
  return causes
}
