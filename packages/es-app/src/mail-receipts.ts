import { createContext, createResource, createSignal, useContext, type Accessor } from "solid-js"
import type { ToolPart } from "@opencode-ai/sdk/v2"
import type { MailMessage, MailTimeline } from "./api"
import { canonicalMail, mailLocation } from "./mail-timeline"
import { shellProgram } from "./tool-call"

// Mail a tool call sent (Laptop2627), from the transport's own receipt line in the call's output, never from the
// command text: `es mail send` prints `sent <id> (<kind>) <from> -> <to>` only once the dashboard stored the mail.
// The delivery word comes from that mail's dashboard record; without the record, no state is claimed.

export type MailReceipt = { id: string; kind: string; from: string; to: string }
const RECEIPT = /^sent (\S+#\d+) \(([\w-]+)\) (\S+) -> (\S+)$/gm

export const mailReceipts = (part: ToolPart): MailReceipt[] => {
  if (part.tool !== "bash" && part.tool !== "shell") return []
  if (part.state.status !== "completed" && part.state.status !== "error") return []
  const input = part.state.input as Record<string, unknown> | undefined
  const command = typeof input?.command === "string" ? input.command : ""
  // Only an `es mail` call can carry a mail receipt; the same text from anything else is not one.
  if (!command.split(/&&|\|\||;|\n|\|/).some((segment) => { const [program, sub] = shellProgram(segment); return program === "es" && sub === "mail" })) return []
  const output = part.state.status === "completed" && typeof part.state.output === "string" ? part.state.output : ""
  return [...output.matchAll(RECEIPT)].map((match) => ({ id: match[1]!, kind: match[2]!, from: match[3]!, to: match[4]! }))
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
export type MailRecordsValue = { record: (id: string) => MailMessage | undefined; complete: (id: string) => boolean; want: (receipt: MailReceipt) => void }

/** Receipts of a record, or undefined when this page has not read them: no record, or a record from a feed that
 * omits other sessions' receipts and shows none. */
const readReceipts = (records: MailRecordsValue, id: string) => {
  const found = records.record(id)
  return found && (records.complete(id) || found.deliveries.length) ? found.deliveries : undefined
}

/** The row's words: who was mailed and, only from read receipts, each delivery's exact state. A receipt without its
 * record stays "reported sent"; a record whose receipts were not read says "delivery not read". */
export const mailSentText = (receipts: readonly MailReceipt[], records: MailRecordsValue) => {
  const recipients = [...new Set(receipts.map((receipt) => receipt.to))]
  const loaded = receipts.every((receipt) => records.record(receipt.id))
  const words = receipts.flatMap((receipt) => readReceipts(records, receipt.id)?.map((delivery) => deliveryWord(delivery.state, delivery.error)) ?? ["delivery not read"])
  const unique = [...new Set(words)]
  const state = words.includes("failed") ? "failed" : unique.length === 1 ? unique[0]! : unique.length ? "mixed states" : "no deliveries recorded"
  return { text: `Mail ${loaded ? "sent" : "reported sent"} to ${recipients.join(", ")}`, state,
    detail: receipts.map((receipt) => {
      const found = records.record(receipt.id)
      const deliveries = readReceipts(records, receipt.id)
      const each = !found ? "not found in this session's mail on its host" : !deliveries ? "recipient receipts not read" : deliveries.map((delivery) => {
        const word = deliveryWord(delivery.state, delivery.error)
        const meaning = word === "failed" ? delivery.error ?? delivery.state : MEANING[delivery.state] ?? "state not described"
        return `${delivery.recipient} ${word} (${meaning})`
      }).join(", ") || "no deliveries recorded"
      return `${receipt.id} ${receipt.kind} to ${receipt.to}: ${each}`
    }) }
}

/** This page's mail records by id; tool rows outside a session page see none. */
export const MailRecords = createContext<MailRecordsValue>({ record: () => undefined, complete: () => false, want: () => undefined })
export const useMailRecords = () => useContext(MailRecords)

/** Receipt records for one session's tool rows, read from the session's own host (`prefix` "" here, `/hosts/<id>`
 * for another Work host): its mail scope plus, on demand, the full feed of each lane a receipt names as sender.
 * Nothing is read until a tool row shows a mail receipt; then reads happen when the scope or `revision` changes or a
 * row asks for a lane or id not read yet, never on a timer. */
export const createMailReceiptRecords = (input: { prefix: string; directory: string; session: string; revision: Accessor<unknown>
  editspaces: Accessor<{ name: string; root: string }[] | undefined> }) => {
  const [lanes, setLanes] = createSignal<ReadonlySet<string>>(new Set())
  const [missing, setMissing] = createSignal(0)
  const asked = new Set<string>()
  const feed = (es: string, scope: string) => fetch(`${input.prefix}/es/api/mail?es=${encodeURIComponent(es)}&${scope}`, { credentials: "include" })
    .then((response) => response.ok ? response.json() as Promise<MailTimeline> : undefined, () => undefined)
  const [read] = createResource(() => {
    const scope = mailLocation(input.directory, input.editspaces() ?? [], input.session)
    return scope && (lanes().size > 0 || missing() > 0) && { scope, lanes: [...lanes(), ...(scope.lane ? [scope.lane] : [])], revision: input.revision(), missing: missing() }
  }, async ({ scope, lanes }) => {
    const [own, ...full] = await Promise.all([feed(scope.name, `session=${encodeURIComponent(input.session)}`),
      ...[...new Set(lanes)].map((lane) => feed(scope.name, `lane=${encodeURIComponent(lane)}`))])
    const records = new Map<string, { message: MailMessage; complete: boolean }>()
    own?.messages.forEach((message) => records.set(message.id, { message: canonicalMail(message), complete: false }))
    // A lane feed carries every recipient's receipts for that lane's mail.
    full.forEach((timeline) => timeline?.messages.forEach((message) => records.set(message.id, { message: canonicalMail(message), complete: true })))
    return records
  })
  const value: MailRecordsValue = {
    record: (id) => read.latest?.get(id)?.message,
    complete: (id) => !!read.latest?.get(id)?.complete,
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
