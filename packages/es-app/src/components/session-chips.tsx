import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js"
import { findMentions, sessionLane } from "../session-mention"
import { useDashboard } from "../state"
import { invalidateTextareaLayout, textareaLayout } from "../textarea-layout"

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
    const points = textareaLayout(target).points
    return mentions.flatMap((mention) => {
      if (props.selection[0] <= mention.end && props.selection[1] >= mention.start && document.activeElement === target) return []
      const start = points.find((point) => point.pos === mention.start)
      const end = points.find((point) => point.pos === mention.end)
      if (!start) return []
      const last = points.findLast((point) => point.pos < mention.end && point.row === start.row)
      if (!last) return []
      // The next boundary measures the exact token width on one row; wrapped
      // tokens show only the first row, never a chip spanning the line break.
      const right = end?.row === start.row ? end.left : (points.find((point) => point.pos > last.pos && point.row === start.row)?.left ?? last.left + start.height * 0.6)
      const left = start.left - target.scrollLeft + target.clientLeft
      const top = start.top - target.scrollTop + target.clientTop
      if (top < 0 || top + start.height > target.clientHeight || left < 0 || left + right - start.left > target.clientWidth) return []
      const row = sessionRows().find((item) => item.id === mention.id)
      // Inset 1px so adjacent rows of pills never touch; the box still covers the token glyphs.
      return [{ mention, row, style: { left: `${left}px`, top: `${top + 1}px`, width: `${Math.max(0, right - start.left)}px`, height: `${start.height - 2}px`, "line-height": `${start.height - 2}px` } }]
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
