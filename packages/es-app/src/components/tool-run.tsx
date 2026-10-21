import { createMemo, For, Show, type ComponentProps, type JSX } from "solid-js"
import type { Part } from "@opencode-ai/sdk/v2"
import { Message, type ToolRenderers } from "@opencode-ai/session-ui/message-part"
import { runSummary, type ToolRunGroup } from "../transcript-groups"
import { SIZE_LEGEND, sizeDistribution, toolMagnitude } from "../tool-magnitude"

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
  // Index each member message's parts once per update so large runs stay linear.
  const members = createMemo(() => {
    const indexes = new Map<string, Map<string, Part>>()
    const index = (messageID: string) => {
      const known = indexes.get(messageID)
      if (known) return known
      const created = new Map(props.parts(messageID).map((part) => [part.id, part] as const))
      indexes.set(messageID, created)
      return created
    }
    return new Map(props.run.members.flatMap((member) => {
      const message = props.message(member.messageID)
      const part = index(member.messageID).get(member.partID)
      return message && part?.type === "tool" ? [[member.partID, { member, message, part }] as const] : []
    }))
  })
  const byPart = createMemo(() => new Map(props.run.members.map((member) => [member.partID, member] as const)))
  const summary = createMemo(() => runSummary([...members().values()].map((item) => item.part)))
  // Members that have not loaded yet still count, as not sized, so bins sum to the run size.
  const sizes = createMemo(() => sizeDistribution([...[...members().values()].map((item) => toolMagnitude(item.part)),
    ...Array.from({ length: props.run.members.length - members().size }, () => ({ kind: "unknown" as const, reason: "call is not loaded" }))]))
  const label = () => [`${props.run.members.length} tool calls`, summary().tools, sizes().label, summary().spanLabel, ...summary().notes].filter(Boolean).join(", ")
  const id = () => `tool-run-${props.run.key.replace(/[^\w-]/g, "_")}`
  return <section class="tool-run" data-tool-run={props.run.key} data-open={props.open ? "true" : undefined}
    data-timeline-part-ids={props.run.members.map((member) => member.partID).join(",")} aria-label={`${props.run.members.length} tool calls`}>
    <button class="tool-run-summary" aria-expanded={props.open} aria-controls={id()} aria-label={label()} onClick={() => props.onToggle(!props.open)}>
      <span class="tool-run-disclosure" aria-hidden="true">›</span>
      <span class="tool-run-kind"><bdi dir="auto">{props.run.members.length} tool calls</bdi></span>
      <span class="tool-run-tools" dir="ltr" title={summary().tools}>{summary().tools}</span>
      <span class="tool-run-sizes" dir="ltr" title={`${sizes().label}\n${SIZE_LEGEND}`}>
        {/* Each bin is unbreakable, so wrapping happens only between bins. */}
        <For each={sizes().labels}>{(bin, index) => <>{index() ? " · " : ""}<span class="tool-run-bin">{bin}</span></>}</For>
      </span>
      <Show when={summary().notes.length}><span class="tool-run-notes" dir="auto">{summary().notes.join(" · ")}</span></Show>
      <Show when={summary().span}>{(span) => <span class="tool-run-span" dir="ltr" title={summary().spanLabel}>{span()}</span>}</Show>
    </button>
    <Show when={props.open}>
      <div class="tool-run-members" id={id()}>
        {/* Keyed by part ID so growing or merged runs keep mounted chips (and their open state). */}
        <For each={props.run.members.map((member) => member.partID)}>{(partID) => {
          const member = byPart().get(partID)!
          const item = createMemo(() => members().get(partID))
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
