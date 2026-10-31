import { createContext, useContext } from "solid-js"
import type { ToolPart } from "@opencode-ai/sdk/v2"
import type { MailMessage } from "./api"
import { shellProgram } from "./tool-call"

// Mail a tool call sent (Laptop2627), from the transport's own receipt line in the call's output, never from the
// command text: `es mail send` prints `sent <id> (<kind>) <from> -> <to>` only once the dashboard stored the mail.
// The delivery word comes from that mail's dashboard record; without the record, no state is claimed.

export type MailReceipt = { id: string; kind: string; to: string }
const RECEIPT = /^sent (\S+#\d+) \(([\w-]+)\) \S+ -> (\S+)$/gm

export const mailReceipts = (part: ToolPart): MailReceipt[] => {
  if (part.tool !== "bash" && part.tool !== "shell") return []
  if (part.state.status !== "completed" && part.state.status !== "error") return []
  const input = part.state.input as Record<string, unknown> | undefined
  const command = typeof input?.command === "string" ? input.command : ""
  // Only an `es mail` call can carry a mail receipt; the same text from anything else is not one.
  if (!command.split(/&&|\|\||;|\n|\|/).some((segment) => { const [program, sub] = shellProgram(segment); return program === "es" && sub === "mail" })) return []
  const output = part.state.status === "completed" && typeof part.state.output === "string" ? part.state.output : ""
  return [...output.matchAll(RECEIPT)].map((match) => ({ id: match[1]!, kind: match[2]!, to: match[3]! }))
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

/** The row's words: who was mailed and, only from a loaded record, each delivery's exact state. A receipt without
 * its record on this host stays "reported sent", delivery not read. */
export const mailSentText = (receipts: readonly MailReceipt[], record: (id: string) => MailMessage | undefined) => {
  const recipients = [...new Set(receipts.map((receipt) => receipt.to))]
  const loaded = receipts.every((receipt) => record(receipt.id))
  const words = receipts.flatMap((receipt) => record(receipt.id)?.deliveries.map((delivery) => deliveryWord(delivery.state, delivery.error)) ?? ["delivery not read"])
  const unique = [...new Set(words)]
  const state = words.includes("failed") ? "failed" : unique.length === 1 ? unique[0]! : unique.length ? "mixed states" : "no deliveries recorded"
  return { text: `Mail ${loaded ? "sent" : "reported sent"} to ${recipients.join(", ")}`, state,
    detail: receipts.map((receipt) => {
      const found = record(receipt.id)
      const each = !found ? "delivery not read on this host" : found.deliveries.map((delivery) => {
        const word = deliveryWord(delivery.state, delivery.error)
        const meaning = word === "failed" ? delivery.error ?? delivery.state : MEANING[delivery.state] ?? "state not described"
        return `${delivery.recipient} ${word} (${meaning})`
      }).join(", ") || "no deliveries recorded"
      return `${receipt.id} ${receipt.kind} to ${receipt.to}: ${each}`
    }) }
}

/** This page's mail records by id; tool rows outside a session page see none. */
export const MailRecords = createContext<(id: string) => MailMessage | undefined>(() => undefined)
export const useMailRecords = () => useContext(MailRecords)
