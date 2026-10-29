import { createMemo, createSignal, For, Show, type ComponentProps, type JSX } from "solid-js"
import type { Part, ToolPart } from "@opencode-ai/sdk/v2"
import { getToolInfo, Message, type ToolRenderers } from "@opencode-ai/session-ui/message-part"
import { Icon } from "@opencode-ai/ui/icon"
import { runSummary, toolOutcome, type ToolRunGroup } from "../transcript-groups"
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
  /** Icon-first while closed (human #420 preview): one icon per call, the call count, and any failure or uncertainty in words. */
  compact?: boolean
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
  // One icon per call, in order; a call that has not loaded is an unknown icon, never dropped.
  const icons = createMemo(() => props.run.members.map((member) => {
    const part = members().get(member.partID)?.part
    return part
      ? { key: member.partID, tool: part.tool, status: toolOutcome(part), icon: getToolInfo(part.tool, part.state.input).icon }
      : { key: member.partID, tool: "unknown", status: "unknown" as const, icon: "help" }
  }))
  const compact = () => !!props.compact && !props.open && !props.selectedPart
  let summaryButton: HTMLButtonElement | undefined
  // The deterministic facts: the closed row, or the compact strip's preview.
  const facts = () => <>
    <span class="tool-run-kind"><bdi dir="auto">{props.run.members.length} tool calls</bdi></span>
    <span class="tool-run-tools" dir="ltr" title={summary().tools}>{summary().tools}</span>
    <span class="tool-run-sizes" dir="ltr" title={`${sizes().label}\n${SIZE_LEGEND}`}>
      {/* Each bin is unbreakable, so wrapping happens only between bins. */}
      <For each={sizes().labels}>{(bin, index) => <>{index() ? " · " : ""}<span class="tool-run-bin">{bin}</span></>}</For>
    </span>
    <Show when={summary().notes.length}><span class="tool-run-notes" dir="auto">{summary().notes.join(" · ")}</span></Show>
    <Show when={summary().span}>{(span) => <span class="tool-run-span" dir="ltr" title={summary().spanLabel}>{span()}</span>}</Show>
  </>
  return <section class="tool-run" data-tool-run={props.run.key} data-open={props.open ? "true" : undefined}
    data-compact={compact() ? "true" : undefined} data-filament-anchor={props.run.key}
    data-timeline-part-ids={props.run.members.map((member) => member.partID).join(",")} aria-label={`${props.run.members.length} tool calls`}
    onKeyDown={(event) => {
      // Escape closes an opened run from anywhere inside it and returns focus to its summary.
      if (event.key !== "Escape" || !props.open || event.defaultPrevented) return
      event.preventDefault()
      props.onToggle(false)
      summaryButton?.focus()
    }}>
    <button class="tool-run-summary" ref={summaryButton} aria-expanded={props.open} aria-controls={id()} aria-label={label()} onClick={() => props.onToggle(!props.open)}>
      <span class="tool-run-disclosure" aria-hidden="true">›</span>
      <Show when={compact()} fallback={facts()}>
        <span class="tool-run-icons" aria-hidden="true">
          <For each={icons()}>{(item) => <span class="tool-run-icon" data-tool={item.tool} data-status={item.status}><Icon name={item.icon as never} size="normal" /></span>}</For>
        </span>
        <span class="tool-run-count" aria-hidden="true">{props.run.members.length} calls</span>
        {/* Failure and uncertainty stay in words beside the icons, never only in colour or on hover. */}
        <Show when={summary().notes.length}><span class="tool-run-state" dir="auto" aria-hidden="true">{summary().notes.join(" · ")}</span></Show>
        {/* The remaining facts show on hover and keyboard focus. */}
        <span class="tool-run-preview" aria-hidden="true">{facts()}</span>
      </Show>
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

/** Any tool call without its own renderer (question, todo) renders icon-first in the human #420 preview. */
export const iconEligible = (part: Part, renderTools?: ToolRenderers): part is ToolPart =>
  part.type === "tool" && !renderTools?.[part.tool]

const STATE_WORDS = { ok: "", failed: "failed", interrupted: "interrupted", unfinished: "running", "unknown-exit": "exit unknown" } as const

// One call, icon first. A call that failed, was interrupted, is running or has an unknown exit says so in words
// beside its icon, with what it ran. Hover and keyboard focus show its facts; Enter or click opens the original chip.
export const ToolChip = (props: { message: ComponentProps<typeof Message>["message"]; part: ToolPart; renderTools?: ToolRenderers }) => {
  const [open, setOpen] = createSignal(false)
  const info = createMemo(() => getToolInfo(props.part.tool, props.part.state.input))
  const summary = createMemo(() => runSummary([props.part]))
  const size = createMemo(() => sizeDistribution([toolMagnitude(props.part)]).bins[0]?.size ?? "?")
  const status = createMemo(() => toolOutcome(props.part))
  // A short reason in words, so a failure reads without colour: the tool's error line or its exit code.
  const reason = createMemo(() => {
    const state = props.part.state
    if (state.status === "error") return state.error.split("\n")[0]!.slice(0, 120)
    const exit = state.status === "completed" ? state.metadata?.exit : undefined
    return typeof exit === "number" && exit !== 0 ? `exit ${exit}` : undefined
  })
  const label = () => [info().title, STATE_WORDS[status()], info().subtitle, reason(), `size ${size()}`, summary().spanLabel].filter(Boolean).join(", ")
  let button: HTMLButtonElement | undefined
  return <span class="tool-chip" data-compact={open() ? undefined : "true"} data-open={open() ? "true" : undefined} data-status={status()}
    data-timeline-part-id={props.part.id} data-filament-anchor={props.part.id}
    onKeyDown={(event) => {
      if (event.key !== "Escape" || !open() || event.defaultPrevented) return
      event.preventDefault()
      setOpen(false)
      button?.focus()
    }}>
    <button class="tool-chip-summary" ref={button} aria-expanded={open()} aria-label={label()} aria-busy={status() === "unfinished" ? "true" : undefined}
      onClick={() => setOpen(!open())}>
      <span class="tool-run-icon" data-tool={props.part.tool} data-status={status()} aria-hidden="true"><Icon name={info().icon as never} size="normal" /></span>
      {/* What ran stays legible beside the icon; a failure, uncertainty or running call leads with that word. */}
      <span class="tool-chip-state" data-status={status()} aria-hidden="true">
        {[STATE_WORDS[status()], info().subtitle, reason()].filter(Boolean).join(" · ")}
      </span>
      <Show when={!open()}>
        <span class="tool-run-preview" aria-hidden="true">
          <span class="tool-run-kind"><bdi dir="auto">{info().title}</bdi></span>
          <Show when={info().subtitle}><span class="tool-run-tools" dir="auto">{info().subtitle}</span></Show>
          <span class="tool-run-sizes" dir="ltr">{size()}</span>
          <Show when={summary().span}>{(span) => <span class="tool-run-span" dir="ltr">{span()}</span>}</Show>
        </span>
      </Show>
    </button>
    <Show when={open()}>
      <div class="tool-chip-member"><Message message={props.message} parts={[props.part]} activityRows renderTools={props.renderTools} /></div>
    </Show>
  </span>
}
