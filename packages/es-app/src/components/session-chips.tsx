import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js"
import { findMentions, sessionLane } from "../session-mention"
import { useDashboard } from "../state"
import { invalidateTextareaLayout, textareaProbe } from "../textarea-layout"

export const SessionChips = (props: { target: HTMLTextAreaElement | undefined; text: string; selection: readonly [number, number] }) => {
  const { sessionRows, lineage, lineageOwners } = useDashboard()
  const [version, setVersion] = createSignal(0)
  createEffect(() => {
    const target = props.target
    if (!target) return
    const update = () => setVersion((value) => value + 1)
    const observer = new ResizeObserver(update)
    observer.observe(target)
    target.addEventListener("scroll", update)
    const fontsLoaded = () => { invalidateTextareaLayout(); update() }
    document.fonts.addEventListener("loadingdone", fontsLoaded)
    onCleanup(() => {
      observer.disconnect()
      target.removeEventListener("scroll", update)
      document.fonts.removeEventListener("loadingdone", fontsLoaded)
    })
  })
  const chips = createMemo(() => {
    version()
    const target = props.target
    if (!target) return []
    const mentions = findMentions(props.text)
    if (!mentions.length) return []
    // Each mention's own box only, not the whole draft's layout (DD #432). The first row's box is the token on one
    // row; a wrapped token shows only its first row, never a chip spanning the line break.
    const probe = textareaProbe(target)
    return mentions.flatMap((mention) => {
      if (props.selection[0] <= mention.end && props.selection[1] >= mention.start && document.activeElement === target) return []
      const box = probe.rects(mention.start, mention.end)[0]
      if (!box) return []
      const left = box.left - target.scrollLeft + target.clientLeft
      const top = box.top - target.scrollTop + target.clientTop
      if (top < 0 || top + box.height > target.clientHeight || left < 0 || left + box.width > target.clientWidth) return []
      const row = sessionRows().find((item) => item.id === mention.id)
      // Inset 1px so adjacent rows of pills never touch; the box still covers the token glyphs.
      return [{ mention, row, style: { left: `${left}px`, top: `${top + 1}px`, width: `${Math.max(0, box.width)}px`, height: `${box.height - 2}px`, "line-height": `${box.height - 2}px` } }]
    })
  })
  return <For each={chips()}>{(chip) => <span class="session-chip" data-unknown={!chip.row ? "1" : undefined}
    style={chip.style} title={chip.row ? `${chip.row.title}\n${chip.row.directory}` : chip.mention.id} dir="auto">
    <span class="session-chip-pill">
      <span class="session-chip-dot" data-live={chip.row?.live ? "1" : undefined} />
      <span class="session-chip-title">{chip.row?.title || chip.mention.id}</span>
      <Show when={chip.row}>{(row) => <span class="session-chip-meta">{sessionLane(row().id, lineage(), lineageOwners()) ?? (row().project || row().directory.split("/").filter(Boolean).at(-1) || row().directory)}</span>}</Show>
    </span>
  </span>}</For>
}
