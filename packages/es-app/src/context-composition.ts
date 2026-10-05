/* Estimated context composition. Providers report one token total per turn,
 * never per-category attribution, so the breakdown here is an estimate from
 * the visible transcript: character counts per category (chars ÷ 4 ≈ tokens),
 * reconciled against the exact latest-turn total where that is known. One
 * category/colour mapping serves the hover donut and the right-panel bar. */

export type CompositionKey = "user_text" | "assistant_text" | "tool_metadata" | "tool_output" | "other"

export type CompositionChars = Record<CompositionKey, number>

export type Composition = {
  basis: "since_compaction" | "full_history"
  messages: number
  chars: CompositionChars
}

export const COMPOSITION_CATEGORIES: { key: CompositionKey; label: string; short: string; color: string }[] = [
  { key: "user_text", label: "user text", short: "user", color: "var(--blue)" },
  { key: "assistant_text", label: "assistant text", short: "assistant", color: "var(--mauve)" },
  { key: "tool_metadata", label: "tool calls", short: "calls", color: "var(--peach)" },
  { key: "tool_output", label: "tool output", short: "output", color: "var(--teal)" },
  { key: "other", label: "other / unattributed", short: "other", color: "var(--overlay1)" },
]

export const CHARS_PER_TOKEN = 4

const emptyChars = (): CompositionChars => ({ user_text: 0, assistant_text: 0, tool_metadata: 0, tool_output: 0, other: 0 })

const size = (value: unknown) => {
  if (value == null) return 0
  if (typeof value === "string") return value.length
  try {
    return JSON.stringify(value)?.length ?? 0
  } catch {
    return 0
  }
}

/** Messages still represented in the model's context: from the last completed
 * compaction summary onward (plus the retained tail when the compaction kept
 * one); the whole visible history when there is no completed summary. */
export const contextWindow = (messages: any[], parts: Record<string, any[]>) => {
  const summaryIndex = messages.findLastIndex((m) => m.role === "assistant" && m.summary && !m.error && m.time?.completed != null)
  if (summaryIndex < 0) return { basis: "full_history" as const, messages }
  const summary = messages[summaryIndex]
  const compaction = messages.findIndex((m) => m.id === summary.parentID)
  const tailStart = compaction >= 0
    ? (parts[messages[compaction].id] ?? []).find((p) => p.type === "compaction")?.tail_start_id
    : undefined
  const tailIndex = tailStart ? messages.findIndex((m) => m.id === tailStart) : -1
  const tail = tailIndex >= 0 && tailIndex < summaryIndex ? messages.slice(tailIndex, compaction >= 0 ? compaction : summaryIndex) : []
  return { basis: "since_compaction" as const, messages: [...tail, ...messages.slice(summaryIndex)] }
}

export const estimateComposition = (messages: any[], parts: Record<string, any[]>): Composition => {
  const window = contextWindow(messages, parts)
  const chars = emptyChars()
  for (const message of window.messages) {
    for (const part of parts[message.id] ?? []) {
      if (part.type === "text") {
        if (message.role === "user" && !part.synthetic) chars.user_text += size(part.text)
        else if (message.role === "assistant") chars.assistant_text += size(part.text)
        else chars.other += size(part.text)
        continue
      }
      if (part.type === "tool") {
        chars.tool_metadata += size(part.tool) + size(part.state?.input)
        if (part.state?.status === "completed") chars.tool_output += size(part.state.output)
        else if (part.state?.status === "error") chars.tool_output += size(part.state.error)
        continue
      }
      if (part.type === "reasoning") chars.other += size(part.text)
      else if (part.type === "file") chars.other += size(part.filename) + size(part.source?.text?.value)
    }
  }
  return { basis: window.basis, messages: window.messages.length, chars }
}

export type CompositionSlice = { key: CompositionKey; label: string; short: string; color: string; tokens: number; share: number }

/** Estimated token slices. With an exact latest-turn total, the visible
 * estimates are scaled into it and the remainder is "other / unattributed"
 * (system instructions, provider accounting, material not visible as parts);
 * without one, shares are of the visible content only. */
export const compositionSlices = (composition: Composition | null | undefined, exactTokens?: number | null): CompositionSlice[] => {
  if (!composition) return []
  const estimated = Object.fromEntries(
    COMPOSITION_CATEGORIES.map((c) => [c.key, Math.round(composition.chars[c.key] / CHARS_PER_TOKEN)]),
  ) as CompositionChars
  const visible = Object.values(estimated).reduce((a, b) => a + b, 0)
  const total = exactTokens != null && exactTokens > 0 ? exactTokens : visible
  if (total === 0) return []
  // visible estimates can overshoot the exact total (chars÷4 is coarse); squeeze them to fit
  const scale = exactTokens != null && exactTokens > 0 && visible > exactTokens ? exactTokens / visible : 1
  const tokens = Object.fromEntries(COMPOSITION_CATEGORIES.map((c) => [c.key, Math.round(estimated[c.key] * scale)])) as CompositionChars
  if (exactTokens != null && exactTokens > 0) {
    const attributed = Object.values(tokens).reduce((a, b) => a + b, 0) - tokens.other
    tokens.other = Math.max(0, exactTokens - attributed)
  }
  return COMPOSITION_CATEGORIES.map((c) => ({ ...c, tokens: tokens[c.key], share: tokens[c.key] / total }))
}

export const describeSlices = (slices: CompositionSlice[]) =>
  slices.filter((s) => s.tokens > 0).map((s) => `${s.label} ${Math.round(s.share * 100)}%`).join(", ")
