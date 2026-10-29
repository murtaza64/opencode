import type { ContextPart } from "./api"

// Core's InputPayload.context limits (POST /session/:id/input): at most 8 items; text 1..4096, source 1..100 and
// key 1..500 characters. A plain idle send (prompt_async) has no such limits.
export const INPUT_CONTEXT = { items: 8, text: 4096, source: 100, key: 500 } as const

export const fitsInput = (part: ContextPart) =>
  part.text.length > 0 && part.text.length <= INPUT_CONTEXT.text &&
  part.metadata.source.length > 0 && part.metadata.source.length <= INPUT_CONTEXT.source &&
  part.metadata.key.length > 0 && part.metadata.key.length <= INPUT_CONTEXT.key

/**
 * The context one send carries. Chips the human chose always go, so the composer attaches them or refuses the send
 * with a reason; they are never dropped. Generated page context (the desk note, a surface) is orientation the app
 * adds on its own: it goes only where the composer can attach it and, for an input (queue or a busy steer), only
 * while it fits Core's input limits beside the chips. Otherwise the send goes without it, and its owner offers it
 * again on a later send because it was not delivered.
 */
export const sendContext = (input: { input: boolean; attaches: boolean; generated: readonly ContextPart[]; chips: readonly ContextPart[] }) => {
  if (!input.attaches) return [...input.chips]
  if (!input.input) return [...input.generated, ...input.chips]
  const room = Math.max(0, INPUT_CONTEXT.items - input.chips.length)
  return [...input.generated.filter(fitsInput).slice(0, room), ...input.chips]
}
