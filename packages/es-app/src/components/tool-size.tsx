import { createMemo } from "solid-js"
import type { ToolPart } from "@opencode-ai/sdk/v2"
import { chars, magnitudeLabel, magnitudeRange, SIZE_LEGEND, toolMagnitude } from "../tool-magnitude"

// One chip gets its own class; a multi-call chip (context group) gets the span.
export const ToolSize = (props: { parts: ToolPart[] }) => {
  const view = createMemo(() => {
    const items = props.parts.map(toolMagnitude)
    if (items.length === 1) {
      const item = items[0]!
      if (item.kind === "sized") return { state: item.size, rank: item.rank, text: item.size, label: magnitudeLabel(item) }
      return { state: item.kind, rank: -1, text: item.kind === "running" ? "…" : "?", label: magnitudeLabel(item) }
    }
    return rangeView(items)
  })
  return <span class="tool-size" data-size={view().state} role="img" aria-label={view().label}
    title={`${view().label}\n${SIZE_LEGEND}`} style={{ "--tool-size-rank": String(view().rank + 1) }}>
    <span class="tool-size-text" aria-hidden="true">{view().text}</span>
    <span class="tool-size-bar" aria-hidden="true" />
  </span>
}

export const rangeView = (items: ReturnType<typeof toolMagnitude>[]) => {
  const range = magnitudeRange(items)
  const running = items.some((item) => item.kind === "running")
  if (!range) return {
    state: running ? "running" : "unknown", rank: -1, text: running ? "…" : "?",
    label: running ? "Size not known yet: tools are running" : "Size unknown for these tool calls",
  }
  const text = range.low === range.high ? range.low : `${range.low}–${range.high}`
  const unknown = range.unknown ? `; ${range.unknown} call(s) ${running ? "running or " : ""}not sized` : ""
  return {
    state: range.high, rank: range.rank, text,
    label: `Size ${text} across ${items.length} tool calls: ~${chars(range.chars)} characters total${unknown}`,
  }
}
