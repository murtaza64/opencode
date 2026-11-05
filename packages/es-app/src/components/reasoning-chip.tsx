/* Reasoning parts as one quiet chip each, in the tool/mail chip style (Laptop .04.3). Collapsed while streaming and
 * after; the chip is the live indicator while its part streams, so the composer keeps only the session activity dot.
 * The reasoning text is Core's own; the chip adds no summary. The expanded/collapsed choice is remembered per part. */
import { createSignal, Show } from "solid-js"
import { registerPartComponent, type MessagePartProps } from "@opencode-ai/session-ui/message-part"
import { readPartText } from "@opencode-ai/session-ui/message-part-text"
import { useData } from "@opencode-ai/session-ui/context"
import { Markdown } from "@opencode-ai/session-ui/markdown"
import { Icon } from "@opencode-ai/ui/icon"
import type { AssistantMessage, ReasoningPart } from "@opencode-ai/sdk/v2"

// Persists across re-renders and new messages; keyed by the part id Core assigned.
const expanded = new Set<string>()

const ReasoningChip = (props: MessagePartProps) => {
  const data = useData()
  const part = () => props.part as ReasoningPart
  const text = () => readPartText(data.store.part_text_accum_delta, part())
  const streaming = () =>
    props.message.role === "assistant" &&
    typeof (props.message as AssistantMessage).time.completed !== "number" &&
    (part() as { time?: { end?: number } }).time?.end === undefined
  const [open, setOpen] = createSignal(expanded.has(part().id))
  const toggle = () => {
    const next = !open()
    setOpen(next)
    if (next) expanded.add(part().id)
    else expanded.delete(part().id)
  }
  return <Show when={text()}>
    <span class="reasoning-chip tool-chip" data-compact={open() ? undefined : "true"} data-open={open() ? "true" : undefined}
      data-timeline-part-id={part().id} data-streaming={streaming() ? "" : undefined}>
      <button type="button" class="reasoning-chip-summary tool-chip-summary" aria-expanded={open()}
        aria-label={streaming() ? "Reasoning, still thinking" : "Reasoning"} onClick={toggle}>
        <span class="tool-run-icon" data-tool="reasoning" data-status={streaming() ? "unfinished" : "completed"} aria-hidden="true">
          <Icon name="brain" size="small" />
        </span>
        <span class="reasoning-chip-label">{streaming() ? "Thinking" : "Reasoning"}</span>
        <Show when={streaming()}><span class="reasoning-chip-live" aria-hidden="true"><i /></span></Show>
        <span class="reasoning-chip-disclosure" data-open={open() ? "" : undefined} aria-hidden="true">›</span>
      </button>
      <Show when={open()}>
        <div class="reasoning-chip-member tool-chip-member">
          <Markdown text={text()} cacheKey={part().id} streaming={streaming()} />
        </div>
      </Show>
    </span>
  </Show>
}

registerPartComponent("reasoning", ReasoningChip)
