/* Filament overlay for the session page. Props are the page's existing signals; the component
 * adds no fetches or polling. One canvas, fixed over the transcript box; a rAF loop that rests
 * whenever nothing is in motion, never runs hidden, and stops entirely under reduced motion
 * (which gets the static state badge instead). */
import { createEffect, createMemo, createSignal, on, onCleanup, onMount, Show } from "solid-js"
import type { Message, Part } from "@opencode-ai/sdk/v2"
import { describe, diff, snapshot, type Snapshot } from "./adapter"
import { measure, type Layout } from "./geometry"
import { chooseBackend, createPainter, type Painter } from "./paint"
import { createScene } from "./scene"
import { filamentHud, reducedMotion } from "./flag"
import "./filament.css"

const GUTTER = 28

export const Filament = (props: {
  messages: () => readonly Message[]
  parts: (messageID: string) => readonly Part[]
  status: () => string
  pending: () => readonly { kind: "permission" | "question"; request: { id: string } }[]
  subagents: () => number
  transcript: () => HTMLDivElement | undefined
}) => {
  let canvas!: HTMLCanvasElement
  let badge: HTMLDivElement | undefined
  const reduced = reducedMotion()
  const [backend, setBackend] = createSignal<{ backend: "webgl2" | "canvas2d"; renderer: string }>({ backend: "canvas2d", renderer: "" })
  const [phase, setPhase] = createSignal("idle")
  const [label, setLabel] = createSignal("")
  const [hud, setHud] = createSignal("")
  let painter: Painter | undefined
  let scene: ReturnType<typeof createScene> | undefined
  let previous: Snapshot | undefined
  let current: Snapshot | undefined
  let layout: Layout | undefined
  let pendingDeltas: ReturnType<typeof diff> = []
  let raf = 0
  let lastTs = 0
  let dirty = true
  const intervals: number[] = []
  const cpu: number[] = []
  const box = { x: 0, y: 0, w: 0, h: 0, scale: 1 }

  // Reactive part of the pipeline: a new snapshot per store update, deltas queued for the loop.
  const snap = createMemo(() => snapshot({ messages: props.messages(), parts: props.parts, status: props.status(), pending: props.pending(), subagents: props.subagents() }))
  createEffect(on(snap, (next) => {
    previous = current
    current = next
    pendingDeltas = pendingDeltas.concat(diff(previous, next))
    setPhase(next.phase)
    setLabel(describe(next, Date.now()))
    wake()
  }))

  // The canvas lives INSIDE the scroller as a sticky, zero-height first child: it is scroll content,
  // so macOS rubber-band overscroll translates it together with the rows it annotates. A fixed
  // overlay would stay put while the content bounced.
  let holder!: HTMLDivElement
  // The sticky holder sits at the scroller's content start, which the transcript's padding offsets
  // from the scrollport edge until it sticks; the canvas cancels whatever offset the holder has now.
  const align = (el: HTMLElement, r = el.getBoundingClientRect()) => {
    const hr = holder.getBoundingClientRect()
    const rtl = getComputedStyle(el).direction === "rtl"
    canvas.style.top = `${r.top + el.clientTop - hr.top}px`
    canvas.style.left = `${rtl ? r.right - el.clientLeft - el.clientWidth - hr.left : r.left + el.clientLeft - hr.left}px`
  }
  const place = () => {
    const el = props.transcript()
    if (!el) return
    if (holder.parentElement !== el) el.prepend(holder)
    // Sticky offset cancels the scroller's top padding so the canvas origin is the scrollport's top edge.
    const r = el.getBoundingClientRect()
    align(el, r)
    const scale = Math.min(devicePixelRatio, 1.5)
    box.x = r.left; box.y = r.top; box.w = el.clientWidth; box.h = el.clientHeight; box.scale = scale
    canvas.style.width = `${box.w}px`
    canvas.style.height = `${box.h}px`
    const w = Math.round(box.w * scale), h = Math.round(box.h * scale)
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h }
    if (badge) { badge.style.top = `${r.top + 8}px`; badge.style.insetInlineEnd = `${Math.max(0, innerWidth - r.right + 12)}px` }
    dirty = true
    wake()
  }

  const wake = () => {
    dirty = true
    if (!raf && !document.hidden) raf = requestAnimationFrame(frame)
  }

  const frame = (ts: number) => {
    raf = 0
    const el = props.transcript()
    if (!el || !painter || !scene || !current) return
    const start = performance.now()
    if (lastTs) { intervals.push(ts - lastTs); if (intervals.length > 180) intervals.shift() }
    const wall = lastTs ? Math.min(100, ts - lastTs) : 16
    lastTs = ts
    // Layout can settle after the ResizeObserver's last report (footer/composer reflow): re-place
    // whenever the scrollport size the canvas was sized for no longer matches.
    if (el.clientWidth !== box.w || el.clientHeight !== box.h) place()
    if (dirty || !layout) { align(el); layout = measure(el, canvas, current.nodes, GUTTER) }
    dirty = false
    if (pendingDeltas.length) { scene.absorb(pendingDeltas, layout, ts); pendingDeltas = [] }
    const moving = scene.render(current, layout, { now: ts, wall, reduced, hidden: document.hidden })
    cpu.push(performance.now() - start); if (cpu.length > 180) cpu.shift()
    if (filamentHud()) setHud(hudText())
    if (reduced) { lastTs = 0; return }
    if (moving && !document.hidden) raf = requestAnimationFrame(frame)
    else lastTs = 0
  }

  const q = (arr: number[], p: number) => { if (!arr.length) return 0; const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]! }
  const hudText = () => {
    const long = intervals.filter((x) => x > 33.4).length
    return [
      `filament · ${current?.phase} · ${label()}`,
      `backend ${backend().backend} · ${backend().renderer.slice(0, 48)}`,
      `nodes ${current?.nodes.length ?? 0} measured ${layout?.rects.size ?? 0} prims ${painter?.count() ?? 0}`,
      `rAF p50 ${q(intervals, 0.5).toFixed(1)} p95 ${q(intervals, 0.95).toFixed(1)} max ${q(intervals, 1).toFixed(1)}ms long ${long}/${intervals.length}`,
      `js/frame p50 ${q(cpu, 0.5).toFixed(2)} p95 ${q(cpu, 0.95).toFixed(2)}ms · loop ${raf ? "running" : "resting"} · ${reduced ? "reduced" : "full"} · dpr ${devicePixelRatio}`,
    ].join("\n")
  }

  onMount(() => {
    // The transcript is a later sibling; its ref lands before effects run, but guard a frame anyway.
    if (!props.transcript()) { requestAnimationFrame(() => props.transcript() && place()) }
    const chosen = chooseBackend()
    setBackend(chosen)
    try {
      painter = createPainter(canvas, chosen.backend)
    } catch (e) {
      setBackend({ backend: "canvas2d", renderer: `fallback: ${String((e as Error).message)}` })
      painter = createPainter(canvas, "canvas2d")
    }
    scene = createScene(painter)
    const ro = new ResizeObserver(place)
    const el = props.transcript()
    const inner = el?.querySelector(".transcript-inner")
    if (el) { ro.observe(el); el.dataset.filament = "1"; el.addEventListener("scroll", wake, { passive: true }) }
    if (inner) ro.observe(inner)
    // Content changes that move rects without a store update (markdown settling, chips opening).
    const mo = new MutationObserver(wake)
    if (el) mo.observe(el, { childList: true, subtree: true, attributes: true, attributeFilter: ["aria-expanded", "data-status", "data-open"] })
    addEventListener("resize", place)
    const vis = () => { if (document.hidden) { cancelAnimationFrame(raf); raf = 0; lastTs = 0 } else { place() } }
    document.addEventListener("visibilitychange", vis)
    place()
    onCleanup(() => {
      cancelAnimationFrame(raf)
      ro.disconnect()
      mo.disconnect()
      removeEventListener("resize", place)
      document.removeEventListener("visibilitychange", vis)
      el?.removeEventListener("scroll", wake)
      holder.remove()
      if (el) delete el.dataset.filament
      painter?.destroy()
    })
    // Test hook: deterministic reads for the browser check.
    ;(window as unknown as { __filament?: unknown }).__filament = {
      phase: () => current?.phase,
      running: () => Boolean(raf),
      backend: () => backend(),
      stats: () => ({ frames: intervals.length, p95: q(intervals, 0.95), long: intervals.filter((x) => x > 33.4).length, cpuP50: q(cpu, 0.5) }),
      measured: () => layout?.rects.size ?? 0,
      box: () => ({ ...box }),
      // Canvas vs the transcript's content column: both are scroll content, so overscroll moves them together.
      attached: () => { const c = canvas.getBoundingClientRect(); const el = props.transcript()!; const i = el.querySelector(".transcript-inner")!.getBoundingClientRect(); return { canvasTop: c.top, innerTop: i.top, scrollTop: el.scrollTop, transcriptTop: el.getBoundingClientRect().top } },
      energy: () => scene?.energyNow() ?? 0,
      debug: () => { const el = props.transcript()!; const cs = getComputedStyle(el); const r = (x: Element) => { const b = x.getBoundingClientRect(); return [b.left, b.top, b.width, b.height].map(Math.round) }
        return { transcript: r(el), holder: r(holder), canvas: r(canvas), client: [el.clientLeft, el.clientTop, el.clientWidth, el.clientHeight], scroll: el.scrollTop, pad: [cs.paddingInlineStart, cs.paddingBlockStart], display: cs.display, holderParent: holder.parentElement === el, canvasStyle: [canvas.style.left, canvas.style.top, canvas.style.width, canvas.style.height] } },
    }
  })

  return <>
    <div ref={holder} class="filament-holder" aria-hidden="true"><canvas ref={canvas} class="filament-canvas" data-backend={backend().backend} /></div>
    <Show when={reduced}>
      <div ref={(el) => (badge = el)} class="filament-static" data-phase={phase()} role="status" aria-live="polite">{label()}</div>
    </Show>
    <Show when={filamentHud()}><div class="filament-hud" aria-hidden="true">{hud()}</div></Show>
  </>
}
