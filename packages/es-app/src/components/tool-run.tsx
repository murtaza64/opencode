import { createMemo, For, Show, type ComponentProps, type JSX } from "solid-js"
import type { Part, ToolPart } from "@opencode-ai/sdk/v2"
import { Message, type ToolRenderers } from "@opencode-ai/session-ui/message-part"
import { runSummary, type ToolRunGroup } from "../transcript-groups"

// Collapsed by default. Members mount only while open, as their original chips.
// The summary is deterministic: tool names and counts, wall-clock span and
// failure counts read from the calls themselves.
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
  const summary = createMemo(() => runSummary(members().map((item) => item.part)))
  const label = () => [`${props.run.members.length} tool calls`, summary().tools, summary().span && `${summary().span} wall clock`,
    ...summary().notes].filter(Boolean).join(", ")
  const id = () => `tool-run-${props.run.key.replace(/[^\w-]/g, "_")}`
  return <section class="tool-run" data-tool-run={props.run.key} data-open={props.open ? "true" : undefined}
    data-timeline-part-ids={props.run.members.map((member) => member.partID).join(",")} aria-label={`${props.run.members.length} tool calls`}>
    <button class="tool-run-summary" aria-expanded={props.open} aria-controls={id()} aria-label={label()} onClick={() => props.onToggle(!props.open)}>
      <span class="tool-run-disclosure" aria-hidden="true">›</span>
      <span class="tool-run-kind"><bdi dir="auto">{props.run.members.length} tool calls</bdi></span>
      <span class="tool-run-tools" dir="ltr" title={summary().tools}>{summary().tools}</span>
      <Show when={summary().notes.length}><span class="tool-run-notes">{summary().notes.join(" · ")}</span></Show>
      <Show when={summary().span}>{(span) => <span class="tool-run-span" title="Wall clock from first call start to last call end">{span()}</span>}</Show>
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
