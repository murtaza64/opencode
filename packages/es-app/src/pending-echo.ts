export const pendingEcho = (
  submission: { text: string; status: string; after?: string } | null | undefined,
  messages: readonly { id: string; role: string; text?: string }[],
): boolean =>
  !!submission && !messages.some((message) =>
    message.role === "user" && message.id > (submission.after ?? "") && message.text === submission.text,
  )
