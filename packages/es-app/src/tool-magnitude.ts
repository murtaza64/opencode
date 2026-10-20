import type { ToolPart } from "@opencode-ai/sdk/v2"

// Rough visual magnitude of one tool call. The only evidence is persisted text
// length (tool input values + output/error text): a proxy for how much the call
// adds to context, not a price or a token count. Wall time is reported beside
// it but never changes the class, because it includes permission waits.
export const SIZE_CLASSES = ["XS", "S", "M", "L", "XL"] as const
export type SizeClass = (typeof SIZE_CLASSES)[number]
// Upper bounds in characters (exclusive); XL is everything at or above 30k.
export const SIZE_LIMITS = [1_000, 3_000, 10_000, 30_000] as const
export const SIZE_LEGEND = "Size = characters of tool input + output/error text: XS <1k · S <3k · M <10k · L <30k · XL ≥30k. " +
  "Not tokens or cost. Time is wall clock, may include permission waits, and does not affect size."

// Input walks stop after this many values so a deep or wide input cannot make a
// badge expensive. Strings are measured by length, never serialized.
const INPUT_NODES = 400
const INPUT_DEPTH = 6

export type ToolMagnitude =
  | { kind: "sized"; size: SizeClass; rank: number; input: number; output: number; partial: boolean; attachments: number; ms?: number }
  | { kind: "running"; ms?: number }
  | { kind: "unknown"; reason: string; ms?: number }

export const sizeClass = (chars: number) => {
  const rank = SIZE_LIMITS.findIndex((limit) => chars < limit)
  return rank < 0 ? SIZE_CLASSES.length - 1 : rank
}

export const toolMagnitude = (part: ToolPart): ToolMagnitude => {
  const state = part.state
  if (state.status === "pending") return { kind: "running" }
  if (state.status === "running") return { kind: "running" }
  const ms = elapsed(state.time.start, state.time.end)
  const input = cachedInput(`${part.id}\u0000${state.status}`, state.input)
  if (state.status === "error") return sized(input, state.error.length, 0, ms)
  // Compaction replaces old output, so the original size is no longer known.
  if (state.time.compacted) return { kind: "unknown", reason: "output was cleared by compaction", ms }
  if (typeof state.output !== "string") return { kind: "unknown", reason: "output is not available", ms }
  // A truncated shell result persisted only part of its output: the size is a lower bound.
  const truncated = state.metadata?.truncated === true
  return sized({ chars: input.chars, partial: input.partial || truncated }, state.output.length, state.attachments?.length ?? 0, ms)
}

export const magnitudeLabel = (magnitude: ToolMagnitude) => {
  const time = magnitude.ms === undefined ? "" : ` · ${duration(magnitude.ms)} wall time`
  if (magnitude.kind === "running") return "Size not known yet: tool is running"
  if (magnitude.kind === "unknown") return `Size unknown: ${magnitude.reason}${time}`
  const attachments = magnitude.attachments ? ` · ${magnitude.attachments} attachment(s) not counted` : ""
  return `Size ${magnitude.size}: ${magnitude.partial ? "at least " : "~"}${chars(magnitude.input + magnitude.output)} characters ` +
    `(input ${chars(magnitude.input)}, output ${chars(magnitude.output)})${magnitude.partial ? " · lower bound: input walk capped or output truncated" : ""}${attachments}${time}`
}

// Group summaries show the class span and the total characters of sized members.
export const magnitudeRange = (items: ToolMagnitude[]) => {
  const sized = items.flatMap((item) => item.kind === "sized" ? [item] : [])
  if (!sized.length) return
  const low = Math.min(...sized.map((item) => item.rank))
  const high = Math.max(...sized.map((item) => item.rank))
  return {
    low: SIZE_CLASSES[low]!,
    high: SIZE_CLASSES[high]!,
    rank: high,
    chars: sized.reduce((sum, item) => sum + item.input + item.output, 0),
    unknown: items.length - sized.length,
  }
}

export const chars = (value: number) => value < 1000 ? String(value) : `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}k`

export const duration = (ms: number) => {
  if (ms < 1000) return `${ms}ms`
  const seconds = ms / 1000
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${String(Math.round(seconds % 60)).padStart(2, "0")}s`
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`
}

const sized = (input: { chars: number; partial: boolean }, output: number, attachments: number, ms?: number): ToolMagnitude => {
  const rank = sizeClass(input.chars + output)
  return { kind: "sized", size: SIZE_CLASSES[rank]!, rank, input: input.chars, output, partial: input.partial, attachments, ms }
}

const elapsed = (start: unknown, end: unknown) =>
  typeof start === "number" && typeof end === "number" && Number.isFinite(start) && Number.isFinite(end) && end >= start
    ? end - start : undefined

// Finished tool inputs are immutable, so a bounded cache keeps whole-transcript
// passes (grouping on every streamed token) from re-walking them.
const inputCache = new Map<string, { chars: number; partial: boolean }>()
const cachedInput = (key: string, input: unknown) => {
  const hit = inputCache.get(key)
  if (hit) return hit
  const value = inputChars(input)
  if (inputCache.size >= 5000) inputCache.delete(inputCache.keys().next().value!)
  inputCache.set(key, value)
  return value
}

const inputChars = (input: unknown) => {
  const stack: { value: unknown; depth: number }[] = [{ value: input, depth: 0 }]
  let total = 0
  let nodes = 0
  while (stack.length) {
    if (++nodes > INPUT_NODES) return { chars: total, partial: true }
    const item = stack.pop()!
    const value = item.value
    if (typeof value === "string") total += value.length
    else if (typeof value === "number" || typeof value === "boolean") total += String(value).length
    else if (value && typeof value === "object") {
      if (item.depth >= INPUT_DEPTH) return { chars: total, partial: true }
      for (const key in value) {
        if (nodes + stack.length >= INPUT_NODES) return { chars: total, partial: true }
        stack.push({ value: (value as Record<string, unknown>)[key], depth: item.depth + 1 })
      }
    }
  }
  return { chars: total, partial: false }
}
