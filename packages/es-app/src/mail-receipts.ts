import { createContext, createResource, createSignal, useContext, type Accessor } from "solid-js"
import type { ToolPart } from "@opencode-ai/sdk/v2"
import type { MailMessage, MailTimeline } from "./api"
import { canonicalMail, mailLocation } from "./mail-timeline"
import { shellProgram } from "./tool-call"

// Mail a tool call sent (Laptop2627), from the transport's own receipt in the call's output, never from the command
// text: `es mail send` prints `sent <id> (<kind>) <from> -> <to>` once the dashboard stored the mail, then one line per
// runtime delivery as it stood at send time (`  <recipient>: <state> (<request>)...`, `admission pending ...`, or
// `recorded only; recipient NOT woken (<why>)`). The row prefers the dashboard's current record; without it, the
// send-time lines are shown as such ("at send"), and without either it says the state was not loaded here.

/** One delivery as `es mail send` printed it at send time. */
export type SentDelivery = { recipient?: string; word: string; line: string }
export type MailReceipt = { id: string; kind: string; from: string; to: string; atSend: SentDelivery[] }
const SENT = /^sent (\S+#\d+) \(([\w-]+)\) (\S+) -> (\S+)$/

export const mailReceipts = (part: ToolPart): MailReceipt[] => {
  if (part.tool !== "bash" && part.tool !== "shell") return []
  if (part.state.status !== "completed" && part.state.status !== "error") return []
  const input = part.state.input as Record<string, unknown> | undefined
  const command = typeof input?.command === "string" ? input.command : ""
  // Only an `es mail` call can carry a mail receipt; the same text from anything else is not one.
  if (!command.split(/&&|\|\||;|\n|\|/).some((segment) => { const [program, sub] = shellProgram(segment); return program === "es" && sub === "mail" })) return []
  const output = part.state.status === "completed" && typeof part.state.output === "string" ? part.state.output : ""
  const receipts: MailReceipt[] = []
  for (const line of output.split("\n")) {
    const sent = SENT.exec(line)
    if (sent) { receipts.push({ id: sent[1]!, kind: sent[2]!, from: sent[3]!, to: sent[4]!, atSend: [] }); continue }
    const last = receipts.at(-1)
    if (!last || !line.startsWith("  ")) continue
    const delivery = sentDelivery(line.trim())
    if (delivery) last.atSend.push(delivery)
  }
  return receipts
}

/** A send-time delivery line: its recipient and one word for its state. */
const sentDelivery = (text: string): SentDelivery | undefined => {
  if (text.startsWith("recorded only")) return { word: /no runtime recipient/.test(text) ? "recorded only, no runtime recipient" : "recorded only, not woken", line: text }
  const match = /^([\w.-]+): (.+)$/.exec(text)
  if (!match) return undefined
  const rest = match[2]!
  if (rest.startsWith("recorded only")) return { recipient: match[1], word: "recorded only, not woken", line: rest }
  if (rest.startsWith("admission pending")) return { recipient: match[1], word: "admission pending", line: rest }
  // "admission (<req>): busy; admitted for its next turn"
  const busy = /^admission \([^)]*\): busy; (\w+)/.exec(rest)
  if (busy) return { recipient: match[1], word: busy[1]!, line: rest }
  const state = /^(\w+) \(/.exec(rest)
  return state ? { recipient: match[1], word: state[1]!, line: rest } : undefined
}

// The dashboard's delivery states, as words: the row shows the state itself, the card says what it does and does
// not mean. `handled` is the recipient's acknowledgment; it never claims the requested work started or finished.
const MEANING: Record<string, string> = {
  queued: "stored, not yet in the recipient's input",
  admitted: "in the recipient session's input",
  offered: "offered to the recipient's runtime",
  observed: "seen by the recipient's runtime",
  presented: "shown to the recipient agent",
  read: "read by the recipient",
  handled: "acknowledged by the recipient; not proof the work started",
}

/** The row's word for one delivery: the dashboard state itself, or failed. */
export const deliveryWord = (state: string, error?: string | null) => error || /fail|error/.test(state) ? "failed" : state

/** The mail records a page has read. `complete` is true only for a record read from a feed carrying every recipient's
 * receipts (a lane feed); a session feed carries only receipts addressed to that session, so a mail the session sent
 * may come back with none. `want` asks the page to read the receipt's sender lane once (no polling). */
export type MailRecordsValue = { record: (id: string) => MailMessage | undefined; complete: (id: string) => boolean; want: (receipt: MailReceipt) => void
  /** Why this page could not read the session's mail at all (a refused or failed read), or undefined. */
  unreadable?: () => string | undefined }

/** Receipts of a record, or undefined when this page has not read them: no record, or a record from a feed that
 * omits other sessions' receipts and shows none. */
const readReceipts = (records: MailRecordsValue, id: string) => {
  const found = records.record(id)
  return found && (records.complete(id) || found.deliveries.length) ? found.deliveries : undefined
}

/** The row's words: who was mailed and its delivery state, best evidence first: the dashboard's current receipts
 * (exact state), else what `es mail send` printed at send time (marked "at send"), else "delivery state not loaded"
 * (never "not read", which would read as the recipient's state). */
export const mailSentText = (receipts: readonly MailReceipt[], records: MailRecordsValue) => {
  const recipients = [...new Set(receipts.map((receipt) => receipt.to))]
  const unreadable = records.unreadable?.()
  const per = receipts.map((receipt) => {
    const current = readReceipts(records, receipt.id)
    if (current?.length) return { words: current.map((delivery) => deliveryWord(delivery.state, delivery.error)),
      detail: current.map((delivery) => {
        const word = deliveryWord(delivery.state, delivery.error)
        return `${delivery.recipient} ${word} (${word === "failed" ? delivery.error ?? delivery.state : MEANING[delivery.state] ?? "state not described"})`
      }).join(", ") }
    if (receipt.atSend.length) return { words: receipt.atSend.map((item) => item.word.startsWith("recorded only") ? item.word : `${item.word} at send`),
      detail: `${receipt.atSend.map((item) => `${item.recipient ? `${item.recipient}: ` : ""}${item.line}`).join("; ")} (as printed at send; ${
        unreadable ?? (current ? "no runtime delivery recorded since" : "current state not loaded here")})` }
    if (current) return { words: ["no deliveries recorded"], detail: "no runtime delivery recorded" }
    return { words: ["delivery state not loaded"], detail: unreadable ?? (records.record(receipt.id) ? "recipient receipts not loaded here" : "not in the mail this page has read") }
  })
  const words = per.flatMap((item) => item.words)
  const unique = [...new Set(words)]
  const state = words.includes("failed") ? "failed" : unique.length === 1 ? unique[0]! : "mixed states"
  return { text: `Mail sent to ${recipients.join(", ")}`, state, detail: receipts.map((receipt, index) => `${receipt.id} ${receipt.kind} to ${receipt.to}: ${per[index]!.detail}`) }
}

/** This page's mail records by id; tool rows outside a session page see none. */
export const MailRecords = createContext<MailRecordsValue>({ record: () => undefined, complete: () => false, want: () => undefined })
export const useMailRecords = () => useContext(MailRecords)

/** Receipt records for one session's tool rows, read from the session's own host (`prefix` "" here, `/hosts/<id>`
 * for another Work host): its mail scope plus, on demand, the full feed of each lane a receipt names as sender.
 * Nothing is read until a tool row shows a mail receipt; then reads happen when the scope or `revision` changes or a
 * row asks for a lane or id not read yet, never on a timer. */
export const createMailReceiptRecords = (input: { prefix: string; directory: string; session: string; revision: Accessor<unknown>
  editspaces: Accessor<{ name: string; root: string }[] | undefined>; host?: string }) => {
  const [lanes, setLanes] = createSignal<ReadonlySet<string>>(new Set())
  const [missing, setMissing] = createSignal(0)
  const asked = new Set<string>()
  const where = input.host ? `${input.host}'s mail` : "this host's mail"
  // A failed read is kept as its reason, so the row can say receipts were not readable rather than not read.
  const feed = (es: string, scope: string): Promise<MailTimeline | string> => fetch(`${input.prefix}/es/api/mail?es=${encodeURIComponent(es)}&${scope}`, { credentials: "include" })
    .then((response): Promise<MailTimeline | string> | string => response.ok ? response.json() as Promise<MailTimeline>
      : `${where} not readable from this window (HTTP ${response.status})`, () => `${where} could not be reached`)
  const [read] = createResource(() => {
    const scope = mailLocation(input.directory, input.editspaces() ?? [], input.session)
    return scope && (lanes().size > 0 || missing() > 0) && { scope, lanes: [...lanes(), ...(scope.lane ? [scope.lane] : [])], revision: input.revision(), missing: missing() }
  }, async ({ scope, lanes }) => {
    const [own, ...full] = await Promise.all([feed(scope.name, `session=${encodeURIComponent(input.session)}`),
      ...[...new Set(lanes)].map((lane) => feed(scope.name, `lane=${encodeURIComponent(lane)}`))])
    const records = new Map<string, { message: MailMessage; complete: boolean }>()
    if (typeof own !== "string") own?.messages.forEach((message) => records.set(message.id, { message: canonicalMail(message), complete: false }))
    // A lane feed carries every recipient's receipts for that lane's mail.
    full.forEach((timeline) => { if (typeof timeline !== "string") timeline?.messages.forEach((message) => records.set(message.id, { message: canonicalMail(message), complete: true })) })
    return Object.assign(records, { error: [own, ...full].every((value) => typeof value === "string") ? own as string : undefined })
  })
  const value: MailRecordsValue = {
    record: (id) => read.latest?.get(id)?.message,
    complete: (id) => !!read.latest?.get(id)?.complete,
    unreadable: () => (read.latest as { error?: string } | undefined)?.error,
    want: (receipt) => queueMicrotask(() => {
      // Each sender lane is read once; an id still missing after that triggers one more read of the same scope.
      if (!asked.has(`lane:${receipt.from}`) && /^[\w.-]+$/.test(receipt.from)) {
        asked.add(`lane:${receipt.from}`)
        return setLanes((previous) => new Set([...previous, receipt.from]))
      }
      if (read.loading || read.latest?.has(receipt.id) || asked.has(`id:${receipt.id}`)) return
      asked.add(`id:${receipt.id}`)
      setMissing((count) => count + 1)
    }),
  }
  return value
}
