import { createMemo, For, Show, type ComponentProps, type JSX } from "solid-js"
import type { Part, ToolPart } from "@opencode-ai/sdk/v2"
import { Message, type ToolRenderers } from "@opencode-ai/session-ui/message-part"
import type { ToolRunGroup } from "../transcript-groups"
import { SIZE_LEGEND, toolMagnitude } from "../tool-magnitude"
import { rangeView } from "./tool-size"

// Collapsed by default. Members mount only while open, as their original chips.
// "Short" describes measured text size only, never safety or cost.
export const ToolRun = (props: {
  run: ToolRunGroup
  message: (id: string) => ComponentProps<typeof Message>["message"] | undefined
  parts: (messageID: string) => readonly Part[]
  open: boolean
  onToggle: (open: boolean) => void
  renderTools?: ToolRenderers
  selectedPart?: string
  excerpt?: JSX.Element
}) => {
  const members = createMemo(() => props.run.members.flatMap((member) => {
    const message = props.message(member.messageID)
    const part = props.parts(member.messageID).find((item): item is ToolPart => item.id === member.partID && item.type === "tool")
    return message && part ? [{ member, message, part }] : []
  }))
  const tools = createMemo(() => {
    const counts = new Map<string, number>()
    members().forEach((item) => counts.set(item.part.tool, (counts.get(item.part.tool) ?? 0) + 1))
    return [...counts].map(([tool, count]) => count > 1 ? `${tool} ×${count}` : tool).join(" · ")
  })
  const size = createMemo(() => rangeView(members().map((item) => toolMagnitude(item.part))))
  const id = () => `tool-run-${props.run.key.replace(/[^\w-]/g, "_")}`
  return <section class="tool-run" data-tool-run={props.run.key} data-open={props.open ? "true" : undefined}
    data-timeline-part-ids={props.run.members.map((member) => member.partID).join(",")} aria-label={`${members().length} short tool calls`}>
    <button class="tool-run-summary" aria-expanded={props.open} aria-controls={id()} onClick={() => props.onToggle(!props.open)}>
      <span class="tool-size" data-size={size().state} role="img" aria-label={size().label} title={`${size().label}\n${SIZE_LEGEND}`}
        style={{ "--tool-size-rank": String(size().rank + 1) }}>
        <span class="tool-size-text" aria-hidden="true">{size().text}</span>
        <span class="tool-size-bar" aria-hidden="true" />
      </span>
      <span class="tool-run-kind"><bdi dir="auto">{members().length} short tool calls</bdi></span>
      <span class="tool-run-tools" dir="ltr">{tools()}</span>
      <span class="tool-run-disclosure" aria-hidden="true">›</span>
    </button>
    <Show when={props.open}>
      <div class="tool-run-members" id={id()}>
        {/* Keyed by part ID so growing or merged runs keep mounted chips (and their open state). */}
        <For each={props.run.members.map((member) => member.partID)}>{(partID) => {
          const member = props.run.members.find((entry) => entry.partID === partID)!
          const item = createMemo(() => members().find((entry) => entry.member.partID === partID))
          const parts = createMemo(() => item() ? [item()!.part] : [], [], { equals: (a, b) => a[0] === b[0] })
          return <div class="tool-run-member" data-tool-run-member={member.partID} data-call-id={member.callID}
            data-message-id={member.messageID} data-find-selected={props.selectedPart === member.partID ? "true" : undefined}>
            <Show when={props.selectedPart === member.partID}>{props.excerpt}</Show>
            <Show when={item()?.message}>{(message) => <Message message={message()} parts={parts()} activityRows renderTools={props.renderTools} />}</Show>
          </div>
        }}</For>
      </div>
    </Show>
  </section>
}
