import type { Message } from "@opencode-ai/sdk/v2"
import type { MailMessage, MailTimeline } from "./api"

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
  const sidecar = editspaces.find((item) => item.root.endsWith("/.editspace") &&
    directory === item.root.slice(0, -"/.editspace".length))
  return sidecar && sessionID ? { name: sidecar.name, session: sessionID } : undefined
}

export const mailTimestamp = (value: string | number) =>
  typeof value === "number" ? value : Date.parse(value)

export const mailSourceID = (message: Message) => {
  if (message.role !== "user" || !("source" in message)) return
  const source: unknown = message.source
  if (!source || typeof source !== "object" || !("type" in source) || source.type !== "editspace-mail" ||
    !("id" in source) || typeof source.id !== "string" ||
    !("sender" in source) || typeof source.sender !== "string" ||
    !("recipient" in source) || typeof source.recipient !== "string") return
  return source.id
}

type TimelineRow = { type: "transcript"; message: Message; timestamp: number } | { type: "mail"; message: MailMessage; timestamp: number }

export const mailRows = (messages: Message[], timeline: MailTimeline | undefined,
  previous: TimelineRow[] = []): TimelineRow[] => {
  const existing = new Map(previous.map((row) => [`${row.type}:${row.message.id}`, row]))
  const promoted = new Set(messages.flatMap((message) => {
    const id = mailSourceID(message)
    return id ? [id] : []
  }))
  const standalone = (timeline?.messages ?? []).filter((message) => !promoted.has(message.id))
  const times = new Map((timeline?.messages ?? []).map((message) => [message.id, mailTimestamp(message.ts)]))
  return [
    ...messages.map((message) => {
      const timestamp = times.get(mailSourceID(message) ?? "") ?? message.time.created
      const previous = existing.get(`transcript:${message.id}`)
      return previous?.message === message && previous.timestamp === timestamp
        ? previous : { type: "transcript" as const, message, timestamp }
    }),
     ...standalone.map((message: MailMessage) => existing.get(`mail:${message.id}`)?.message === message
       ? existing.get(`mail:${message.id}`)!
       : { type: "mail" as const, message, timestamp: mailTimestamp(message.ts) }),
  ].sort((a, b) => (a.timestamp - b.timestamp) || (a.type === b.type ? 0 : a.type === "transcript" ? -1 : 1))
}
