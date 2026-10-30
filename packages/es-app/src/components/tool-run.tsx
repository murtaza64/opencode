import { createEffect, createMemo, createSignal, For, onCleanup, Show, type Accessor, type ComponentProps, type JSX } from "solid-js"
import type { Part, ToolPart } from "@opencode-ai/sdk/v2"
import { getToolInfo, Message, type ToolRenderers } from "@opencode-ai/session-ui/message-part"
import { Icon } from "@opencode-ai/ui/icon"
import { runSummary, toolOutcome, type ToolRunGroup } from "../transcript-groups"
import { SIZE_LEGEND, sizeDistribution, toolMagnitude, type ToolMagnitude } from "../tool-magnitude"
import { editSummary, fileName, isEditTool, type EditSummary } from "../tool-edit"
import { callCard, STATE_WORDS, toolGlyph } from "../tool-call"

const STRIP_ICONS = 12

// The one icon of a call: Filament lights this element (data-filament-icon), never a glyph beside it. Its box is
// fixed, so a tier change while a call streams never moves the row; the glyph inside scales with the call's known
// input + output size (data-size), and an unknown size stays neutral rather than reading as small.
const ToolIcon = (props: { partID: string; tool: string; status: string; icon: string; magnitude?: ToolMagnitude }) =>
  <span class="tool-run-icon" data-tool={props.tool} data-status={props.status} data-filament-icon={props.partID}
    data-size={props.magnitude?.kind === "sized" ? props.magnitude.size : "unknown"} aria-hidden="true">
    <Icon name={(isEditTool(props.tool) ? "pencil-line" : props.icon) as never} size="normal" />
  </span>

/** "a.ts +3 −1", "3 files +12 −4", or just the file name(s) when the tool reported no counts. */
export const editText = (edit: EditSummary) => {
  const name = edit.files.length === 1 ? fileName(edit.files[0]!.path) : `${edit.files.length} files`
  return edit.additions === undefined ? name : `${name} +${edit.additions} −${edit.deletions}`
}

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
  /** Icon-first while closed: one icon per call, the call count, and any failure or uncertainty in words. */
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
      ? { key: member.partID, tool: part.tool, status: toolOutcome(part), icon: toolGlyph(part.tool, part.state.input, getToolInfo(part.tool, part.state.input).icon), magnitude: toolMagnitude(part) }
      : { key: member.partID, tool: "unknown", status: "unknown" as const, icon: "help", magnitude: undefined }
  }))
  // At most STRIP_ICONS icons, failures and unfinished calls first so they are never the ones hidden; the rest
  // are counted ("+N") and every call is listed when the group opens.
  const shown = createMemo(() => {
    const all = icons()
    if (all.length <= STRIP_ICONS) return all
    const keep = new Set([...all.filter((item) => item.status !== "ok"), ...all].slice(0, STRIP_ICONS).map((item) => item.key))
    return all.filter((item) => keep.has(item.key))
  })
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
          <For each={shown()}>{(item) => <ToolIcon partID={item.key} tool={item.tool} status={item.status} icon={item.icon} magnitude={item.magnitude} />}</For>
          {/* Hidden calls light this count instead of an icon (Filament anchors on data-filament-icons). */}
          <Show when={icons().length - shown().length}>{(more) => <span class="tool-run-more"
            data-filament-icons={icons().filter((item) => !shown().includes(item)).map((item) => item.key).join(",")}>+{more()}</span>}</Show>
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

/** Any tool call without its own renderer (question, todo) renders icon-first. */
export const iconEligible = (part: Part, renderTools?: ToolRenderers): part is ToolPart =>
  part.type === "tool" && !renderTools?.[part.tool]

// One call, icon first. A call that failed, was interrupted, is running or has an unknown exit says so in words
// beside its icon, with what it ran. Hover and keyboard focus show its compact card; Enter or click opens the original chip.
export const ToolChip = (props: { message: ComponentProps<typeof Message>["message"]; part: ToolPart; renderTools?: ToolRenderers }) => {
  const [open, setOpen] = createSignal(false)
  const [watching, setWatching] = createSignal(false)
  const now = useClock(watching)
  const info = createMemo(() => getToolInfo(props.part.tool, props.part.state.input))
  const card = createMemo(() => callCard(props.part, info().title, now()))
  const summary = createMemo(() => runSummary([props.part]))
  const magnitude = createMemo(() => toolMagnitude(props.part))
  const size = createMemo(() => sizeDistribution([magnitude()]).bins[0]?.size ?? "?")
  const status = createMemo(() => toolOutcome(props.part))
  const edit = createMemo(() => editSummary(props.part))
  // An edit names its file and confirmed line counts in place of the generic subtitle.
  const what = () => { const value = edit(); return value ? editText(value) : info().subtitle }
  // A short reason in words, so a failure reads without colour: the tool's error line or its exit code.
  const reason = createMemo(() => {
    const state = props.part.state
    if (state.status === "error") return state.error.split("\n")[0]!.slice(0, 120)
    const exit = state.status === "completed" ? state.metadata?.exit : undefined
    return typeof exit === "number" && exit !== 0 ? `exit ${exit}` : undefined
  })
  const label = () => [info().title, STATE_WORDS[status()], what(), reason(), `size ${size()}`, summary().spanLabel].filter(Boolean).join(", ")
  let button: HTMLButtonElement | undefined
  return <span class="tool-chip" data-compact={open() ? undefined : "true"} data-open={open() ? "true" : undefined} data-status={status()}
    data-timeline-part-id={props.part.id} data-filament-anchor={props.part.id}
    onPointerEnter={() => setWatching(true)} onPointerLeave={() => setWatching(false)} onFocusIn={() => setWatching(true)} onFocusOut={() => setWatching(false)}
    onKeyDown={(event) => {
      if (event.key !== "Escape" || !open() || event.defaultPrevented) return
      event.preventDefault()
      setOpen(false)
      button?.focus()
    }}>
    <button class="tool-chip-summary" ref={button} aria-expanded={open()} aria-label={label()} aria-busy={status() === "unfinished" ? "true" : undefined}
      onClick={() => setOpen(!open())}>
      <ToolIcon partID={props.part.id} tool={props.part.tool} status={status()} icon={toolGlyph(props.part.tool, props.part.state.input, info().icon)} magnitude={magnitude()} />
      {/* What ran stays legible beside the icon; a failure, uncertainty or running call leads with that word. */}
      <span class="tool-chip-state" data-status={status()} aria-hidden="true">
        {[STATE_WORDS[status()], what(), reason()].filter(Boolean).join(" · ")}
      </span>
      <Show when={!open()}><CallCard card={card()} /></Show>
    </button>
    <Show when={open()}>
      <div class="tool-chip-member">
        {/* Every file an edit touched, with its own confirmed counts; the original chip follows with the diff. */}
        <Show when={(edit()?.files.length ?? 0) > 1}>
          <ul class="tool-chip-files" aria-label="Files changed">
            <For each={edit()!.files}>{(file) => <li><bdi dir="ltr">{file.path}</bdi>
              <Show when={file.additions !== undefined}><span class="tool-chip-counts" dir="ltr"> +{file.additions} −{file.deletions}</span></Show></li>}</For>
          </ul>
        </Show>
        <Message message={props.message} parts={[props.part]} activityRows renderTools={props.renderTools} />
      </div>
    </Show>
  </span>
}

type Card = ReturnType<typeof callCard>

// The compact hover/focus card (CHAT-26): state and title, a description only when the call has one, actual
// duration and labelled sizes. The command itself is the row's text or its expanded details, never repeated here.
const CallCard = (props: { card: Card }) =>
  <span class="tool-run-preview tool-call-card" aria-hidden="true">
    <span class="tool-run-kind"><bdi dir="auto">{props.card.head}</bdi></span>
    <Show when={props.card.description}><span class="tool-call-description" dir="auto">{props.card.description}</span></Show>
    <Show when={props.card.time}><span class="tool-run-span" dir="ltr">{props.card.time}</span></Show>
    <span class="tool-run-sizes" dir="ltr">{props.card.sizes}</span>
  </span>

// Running time ticks only while a card can be seen (pointer over or focus inside), so idle rows never re-render.
const useClock = (watching: Accessor<boolean>) => {
  const [now, setNow] = createSignal(Date.now())
  createEffect(() => {
    if (!watching()) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    onCleanup(() => clearInterval(timer))
  })
  return now
}

/** Consecutive tool calls of a live turn from the first running one on (CHAT-23): one growing strip, one focusable icon per
 * call with its compact card on hover and focus, and the strip's running/failed counts in words. Arrow keys move
 * between icons; Enter or click opens that call's full details below the strip; Escape closes them. Each call keeps
 * its .tool-chip identity, so open state and timeline lookups work as for a single chip. */
export const ToolStrip = (props: { message: ComponentProps<typeof Message>["message"]; parts: readonly ToolPart[]; renderTools?: ToolRenderers }) => {
  const [open, setOpen] = createSignal<ReadonlySet<string>>(new Set())
  const [active, setActive] = createSignal<string>()
  const [watching, setWatching] = createSignal(false)
  const now = useClock(watching)
  const buttons = new Map<string, HTMLButtonElement>()
  const byID = createMemo(() => new Map(props.parts.map((part) => [part.id, part] as const)))
  const ids = createMemo(() => props.parts.map((part) => part.id), [], { equals: (a, b) => a.length === b.length && a.every((id, index) => id === b[index]) })
  // One tab stop: the last focused call, else the first.
  const current = () => { const id = active(); return id && byID().has(id) ? id : ids()[0] }
  const words = createMemo(() => {
    const counts = new Map<string, number>()
    props.parts.forEach((part) => { const word = STATE_WORDS[toolOutcome(part)]; if (word) counts.set(word, (counts.get(word) ?? 0) + 1) })
    return [...counts].map(([word, count]) => `${count} ${word}`).join(" · ")
  })
  const toggle = (id: string) => setOpen((previous) => {
    const next = new Set(previous)
    if (!next.delete(id)) next.add(id)
    return next
  })
  const move = (event: KeyboardEvent) => {
    const list = ids()
    const index = list.indexOf(current() ?? "")
    // Escape on an opened call's icon closes its details, as on a single chip.
    if (event.key === "Escape" && open().has(current() ?? "") && !event.defaultPrevented) {
      event.preventDefault()
      toggle(current()!)
      return
    }
    const rtl = getComputedStyle(event.currentTarget as Element).direction === "rtl"
    const step = { ArrowRight: rtl ? -1 : 1, ArrowLeft: rtl ? 1 : -1 }[event.key]
    const target = event.key === "Home" ? 0 : event.key === "End" ? list.length - 1 : step === undefined ? -1 : Math.min(list.length - 1, Math.max(0, index + step))
    if (target < 0) return
    event.preventDefault()
    setActive(list[target])
    buttons.get(list[target]!)?.focus()
  }
  const label = () => [`${props.parts.length} tool calls`, words()].filter(Boolean).join(", ")
  return <div class="tool-strip" data-tool-strip={ids()[0]}
    onPointerEnter={() => setWatching(true)} onPointerLeave={() => setWatching(false)} onFocusIn={() => setWatching(true)} onFocusOut={() => setWatching(false)}>
    <div class="tool-strip-row">
      <div class="tool-strip-icons" role="toolbar" aria-label={label()} onKeyDown={move}>
        <For each={ids()}>{(id) => {
          // A streamed update replaces one part object: only that call's memos rerun, the other icons stay untouched.
          const part = createMemo(() => byID().get(id)!)
          const info = createMemo(() => getToolInfo(part().tool, part().state.input))
          const card = createMemo(() => callCard(part(), info().title, now()))
          const glyph = createMemo(() => toolGlyph(part().tool, part().state.input, info().icon))
          const magnitude = createMemo(() => toolMagnitude(part()))
          return <span class="tool-chip tool-strip-call" data-compact="true" data-status={card().status} data-timeline-part-id={id} data-filament-anchor={id}>
            <button class="tool-chip-summary" ref={(element) => buttons.set(id, element)} tabIndex={current() === id ? 0 : -1}
              aria-label={card().label} aria-expanded={open().has(id)} aria-controls={`tool-strip-member-${id}`} aria-busy={card().status === "unfinished" ? "true" : undefined}
              onFocus={() => setActive(id)} onClick={() => toggle(id)}>
              <ToolIcon partID={id} tool={part().tool} status={card().status} icon={glyph()} magnitude={magnitude()} />
              <CallCard card={card()} />
            </button>
          </span>
        }}</For>
      </div>
      <span class="tool-run-count" aria-hidden="true">{props.parts.length} calls</span>
      {/* Running and failed counts stay in words beside the icons, never only in colour or on hover. */}
      <Show when={words()}><span class="tool-strip-state" dir="auto" aria-hidden="true">{words()}</span></Show>
    </div>
    <For each={ids().filter((id) => open().has(id))}>{(id) =>
      <div class="tool-chip-member tool-strip-member" id={`tool-strip-member-${id}`} data-tool-strip-member={id}
        onKeyDown={(event) => {
          if (event.key !== "Escape" || event.defaultPrevented) return
          event.preventDefault()
          toggle(id)
          buttons.get(id)?.focus()
        }}>
        <Show when={byID().get(id)}>{(part) => <Message message={props.message} parts={[part()]} activityRows renderTools={props.renderTools} />}</Show>
      </div>
    }</For>
  </div>
}
