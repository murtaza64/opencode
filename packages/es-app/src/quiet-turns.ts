import type { Message, Part } from "@opencode-ai/sdk/v2"

// Quiet turns (porter-explicit-attention-chat-ux-20261103; front-desk policy: routine mail and service wakes end with
// no text). A turn is one input (a user message) and the assistant messages answering it. It is quiet when its input
// is not a human prompt (editspace mail or an all-synthetic wake) and its answer has no visible text and no error,
// and it has finished. Consecutive quiet turns fold into one row. A human prompt's turn is never quiet, so its reply
// always shows; a failure always shows. Decided from data (input source, part types, errors), never from wording.

export type QuietMember = { group: string; first: boolean; count: number; ids: string[] }

const visibleText = (parts: readonly Part[]) =>
  parts.some((part) => part.type === "text" && !part.synthetic && !part.ignored && /\S/.test(part.text))
const humanPrompt = (message: Message, parts: readonly Part[]) =>
  !("source" in message && message.source) && visibleText(parts) || parts.some((part) => part.type === "file")

export const quietTurns = (messages: readonly Message[], parts: (id: string) => readonly Part[], idle: boolean) => {
  type Turn = { ids: string[]; quiet: boolean }
  const turns: Turn[] = []
  for (const message of messages) {
    if (message.role === "user" || !turns.length) turns.push({ ids: [message.id], quiet: message.role === "user" && !humanPrompt(message, parts(message.id)) })
    else {
      const turn = turns.at(-1)!
      turn.ids.push(message.id)
      if (message.role === "assistant" && (message.error || visibleText(parts(message.id)))) turn.quiet = false
    }
  }
  // The last turn is quiet only once it has finished (idle), so a reply still streaming never folds.
  const last = turns.at(-1)
  if (last && !idle) last.quiet = false
  for (const turn of turns) if (turn.ids.length < 2) turn.quiet = false
  const members = new Map<string, QuietMember>()
  let index = 0
  while (index < turns.length) {
    if (!turns[index]!.quiet) { index++; continue }
    const run: Turn[] = []
    while (index < turns.length && turns[index]!.quiet) run.push(turns[index++]!)
    const ids = run.flatMap((turn) => turn.ids)
    ids.forEach((id, position) => members.set(id, { group: ids[0]!, first: position === 0, count: run.length, ids }))
  }
  return members
}

/** The newest time a turn with visible text (or an error) changed; quiet turns never count as unread. */
export const lastAudible = (messages: readonly Message[], quiet: ReadonlyMap<string, QuietMember>) =>
  messages.filter((message) => message.role === "assistant" && !quiet.has(message.id))
    .reduce((latest, message) => Math.max(latest, ("completed" in message.time ? message.time.completed : undefined) ?? message.time.created), 0)
