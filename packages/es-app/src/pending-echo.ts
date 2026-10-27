/** Whether a normal Send still needs its own outgoing bubble, i.e. the transcript does not show it yet.
 * A send carrying its client message ID is matched by that ID only: it is the canonical message's ID,
 * so attached context parts, identical earlier text and clock differences between client and host
 * cannot hide or keep the bubble. Older saved sends without an ID fall back to the typed text of a
 * user message after the send boundary (synthetic context parts excluded). */
export const pendingEcho = (
  submission: { text: string; status: string; after?: string; messageID?: string } | null | undefined,
  messages: readonly { id: string; role: string; text?: string }[],
): boolean => {
  if (!submission) return false
  if (submission.messageID) return !messages.some((message) => message.id === submission.messageID)
  return !messages.some((message) =>
    message.role === "user" && message.id > (submission.after ?? "") && message.text === submission.text,
  )
}
