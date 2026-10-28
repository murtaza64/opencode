/* Rects for the nodes the adapter produced, read from attributes the transcript already renders
 * (`data-find-message`, `data-timeline-part-id(s)`, `data-filament-icon`, the permission banner /
 * question card, the `.thinking` tail). Coordinates are CSS px in scroll-content space (relative
 * to the transcript's content origin), which the canvas shares; scrolling therefore needs no
 * re-measurement, only a translate at draw time.
 *
 * Measurement is cached per element: a node is re-read only when its element is new, when the
 * MutationObserver reports a change inside it, or on a layout change (resize). All reads happen
 * together in one pass before any style write, so no forced synchronous layout occurs mid-frame. */
import type { Node } from "./adapter"

export type Rect = { x: number; y: number; w: number; h: number; cx: number; cy: number }
export type Layout = {
  w: number
  h: number
  sign: 1 | -1
  // Physical x of the thread, in the gutter the transcript reserves while the filament is on.
  gx: number
  // Content-space rects (y grows with scroll content, not the viewport).
  rects: Map<string, Rect>
  // Node ids whose anchor is a compact tool-run strip (members share one row; draw one ring per run).
  compact: Map<string, string>
  // Node ids whose anchor is the tool/mail icon itself (icon-first rows): the flow lights that element.
  icons: Map<string, Rect>
  composerTop: number
  thinking?: Rect
  // Current scroll offset; viewport-space y = content y - scrollTop.
  scrollTop: number
}

const sel = (node: Node) => node.anchor === "message" ? `[data-find-message="${CSS.escape(node.id)}"] [data-component="user-message"], [data-find-message="${CSS.escape(node.id)}"]`
  : node.anchor === "part" ? `[data-timeline-part-id="${CSS.escape(node.id)}"], .tool-run[data-filament-anchor][data-timeline-part-ids*="${CSS.escape(node.id)}"], [data-timeline-part-ids*="${CSS.escape(node.id)}"]`
  : `.question-round[data-question-request="${CSS.escape(node.id)}"], .banner.permission`

type Entry = { el: HTMLElement; rect: Rect; icon?: Rect; compact?: string; version: number }

export const createMeasurer = (transcript: HTMLElement, gutter: number) => {
  const cache = new Map<string, Entry>()
  // Bumped by the owner on any mutation/resize that can move content; entries below it re-read.
  let layoutVersion = 1
  const dirtyIds = new Set<string>()
  let allDirty = true

  // Content-space rect: viewport rect shifted by the scroll offset and relative to the content origin.
  const toContent = (r: DOMRect, origin: DOMRect, scrollTop: number): Rect => {
    const x = r.left - origin.left
    const y = r.top - origin.top + scrollTop
    return { x, y, w: r.width, h: r.height, cx: x + r.width / 2, cy: y + r.height / 2 }
  }

  return {
    // The owner's MutationObserver reports the elements it saw change; map them to node ids lazily.
    invalidate(target?: globalThis.Node) {
      if (!target) { allDirty = true; return }
      // characterData mutations report the Text node; anchors are elements, so start from its parent.
      const from = target.nodeType === 1 ? (target as Element) : target.parentElement
      if (!from) { allDirty = true; return }
      // Walk up to the nearest anchored element so a text delta inside a part dirties that part only.
      const host = from.closest<HTMLElement>("[data-timeline-part-id], [data-timeline-part-ids], [data-find-message], [data-question-request], .banner.permission, .thinking")
      if (!host) { allDirty = true; return }
      for (const [id, entry] of cache) if (entry.el === host || host.contains(entry.el) || entry.el.contains(host)) dirtyIds.add(id)
      // A host that is not cached yet may belong to a node measured next time; cheap to mark all once.
      if (![...cache.values()].some((e) => e.el === host || e.el.contains(host) || host.contains(e.el))) allDirty = true
    },
    resized() { layoutVersion += 1; allDirty = true },
    measure(nodes: readonly Node[]): Layout {
      const scrollTop = transcript.scrollTop
      const origin = transcript.getBoundingClientRect()
      const rtl = getComputedStyle(transcript).direction === "rtl"
      const inner = transcript.querySelector<HTMLElement>(".transcript-inner")?.getBoundingClientRect() ?? origin
      const rects = new Map<string, Rect>()
      const compact = new Map<string, string>()
      const icons = new Map<string, Rect>()
      const live = new Set<string>()
      for (const node of nodes) {
        live.add(node.id)
        let entry = cache.get(node.id)
        const stale = !entry || allDirty || dirtyIds.has(node.id) || entry.version !== layoutVersion || !entry.el.isConnected
        if (stale) {
          const el = entry?.el.isConnected && !allDirty && !dirtyIds.has(node.id) ? entry.el : transcript.querySelector<HTMLElement>(sel(node))
          if (!el) { cache.delete(node.id); continue }
          const r = el.getBoundingClientRect()
          const iconEl = el.querySelector<HTMLElement>(`[data-filament-icon="${CSS.escape(node.id)}"], [data-filament-icon]`)
          entry = {
            el,
            rect: toContent(r, origin, scrollTop),
            icon: iconEl ? toContent(iconEl.getBoundingClientRect(), origin, scrollTop) : undefined,
            compact: el.classList.contains("tool-run") && el.dataset.compact === "true" ? (el.dataset.filamentAnchor ?? el.dataset.toolRun ?? el.dataset.timelinePartIds ?? node.id) : undefined,
            version: layoutVersion,
          }
          cache.set(node.id, entry)
        }
        rects.set(node.id, entry!.rect)
        if (entry!.icon) icons.set(node.id, entry!.icon)
        if (entry!.compact) compact.set(node.id, entry!.compact)
      }
      for (const id of cache.keys()) if (!live.has(id)) cache.delete(id)
      dirtyIds.clear()
      allDirty = false
      const thinkingEl = transcript.querySelector<HTMLElement>(".thinking")
      return {
        w: transcript.clientWidth,
        h: transcript.clientHeight,
        sign: rtl ? -1 : 1,
        gx: rtl ? inner.right - origin.left + gutter / 2 : inner.left - origin.left - gutter / 2,
        rects,
        compact,
        icons,
        composerTop: transcript.clientHeight,
        thinking: thinkingEl ? toContent(thinkingEl.getBoundingClientRect(), origin, scrollTop) : undefined,
        scrollTop,
      }
    },
    // Scroll-only update: same rects, new offset; no DOM reads beyond scrollTop.
    scrolled(layout: Layout): Layout {
      return { ...layout, scrollTop: transcript.scrollTop }
    },
    size: () => cache.size,
  }
}
