/* Sidebar hover card: hover or focus a session row (expanded list or compact
 * rail) and a compact card opens off the row's inline-end edge with exact
 * cumulative cost, latest-turn context (ring = exact %, segments = estimated
 * composition), completed turn count and the session model (plus the latest
 * turn's model when it differs). One card per sidebar, delegated from the
 * nav so pinned/unpinned/archived rows all behave alike; it never changes
 * row layout, so pinned rows keep their position under activity. */
import { createEffect, createMemo, createResource, createSignal, on, onCleanup, Show } from "solid-js"
import { Portal } from "solid-js/web"
import { useDashboard, type SessionRow } from "../state"
import { compactTokens, contextUsage, usageLevel } from "../context-usage"
import { compositionSlices } from "../context-composition"
import { cancelInsights, providersFor, sessionInsights } from "../session-insights"
import { ContextDonut, CompositionDots } from "./context-viz"

const WIDTH = 268
const GAP = 6
const OPEN_DELAY = 180
const CLOSE_DELAY = 160

type Anchor = { el: HTMLElement; row: SessionRow }

export const peekAttrs = (s: SessionRow) => ({ "data-peek-id": s.id, "data-peek-dir": s.directory })

export function SessionPeek(props: { container: () => HTMLElement | undefined }) {
  const { activity, sessionRows, dotFor } = useDashboard()
  const [anchor, setAnchor] = createSignal<Anchor | null>(null)
  const [tick, setTick] = createSignal(0)
  const [height, setHeight] = createSignal(150)
  let openTimer: ReturnType<typeof setTimeout> | undefined
  let closeTimer: ReturnType<typeof setTimeout> | undefined
  let card: HTMLDivElement | undefined

  const rowFor = (el: HTMLElement): SessionRow | undefined => {
    const id = el.dataset.peekId
    const dir = el.dataset.peekDir ?? ""
    if (!id) return
    return sessionRows().find((s) => s.id === id && s.directory === dir) ?? sessionRows().find((s) => s.id === id)
  }
  const resolve = (target: EventTarget | null): Anchor | null => {
    if (!(target instanceof Element)) return null
    const el = target.closest<HTMLElement>("[data-peek-id]")
    if (!el) return null
    const row = rowFor(el)
    return row ? { el, row } : null
  }
  const open = (hit: Anchor, immediate: boolean) => {
    clearTimeout(closeTimer)
    if (anchor()?.el === hit.el) return
    clearTimeout(openTimer)
    if (immediate) return setAnchor(hit)
    openTimer = setTimeout(() => setAnchor(hit), OPEN_DELAY)
  }
  const close = () => {
    clearTimeout(openTimer)
    clearTimeout(closeTimer)
    const current = anchor()
    if (current) {
      const state = insightsState()
      if (state?.().loading) cancelInsights(current.row.id, current.row.directory)
    }
    setAnchor(null)
  }
  const scheduleClose = () => {
    clearTimeout(openTimer)
    clearTimeout(closeTimer)
    closeTimer = setTimeout(close, CLOSE_DELAY)
  }

  createEffect(on(() => props.container(), (nav) => {
    if (!nav) return
    const over = (e: MouseEvent) => {
      const hit = resolve(e.target)
      if (hit) open(hit, false)
    }
    const out = (e: MouseEvent) => {
      const el = anchor()?.el ?? (resolve(e.target)?.el)
      if (!el) return
      const next = e.relatedTarget
      if (next instanceof Node && (el.contains(next) || card?.contains(next))) return
      scheduleClose()
    }
    const focusIn = (e: FocusEvent) => {
      const hit = resolve(e.target)
      if (hit) open(hit, true)
    }
    const focusOut = (e: FocusEvent) => {
      const next = e.relatedTarget
      if (next instanceof Node && (anchor()?.el.contains(next) || card?.contains(next))) return
      scheduleClose()
    }
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape" && anchor()) {
        e.preventDefault()
        close()
      }
    }
    const reposition = () => {
      const el = anchor()?.el
      if (!el) return
      if (!el.isConnected) return close()
      const r = el.getBoundingClientRect()
      if (r.bottom < 0 || r.top > window.innerHeight) return close()
      setTick((t) => t + 1)
    }
    nav.addEventListener("mouseover", over)
    nav.addEventListener("mouseout", out)
    nav.addEventListener("focusin", focusIn)
    nav.addEventListener("focusout", focusOut)
    nav.addEventListener("click", close)
    window.addEventListener("keydown", key)
    window.addEventListener("scroll", reposition, { passive: true, capture: true })
    window.addEventListener("resize", reposition)
    onCleanup(() => {
      nav.removeEventListener("mouseover", over)
      nav.removeEventListener("mouseout", out)
      nav.removeEventListener("focusin", focusIn)
      nav.removeEventListener("focusout", focusOut)
      nav.removeEventListener("click", close)
      window.removeEventListener("keydown", key)
      window.removeEventListener("scroll", reposition, { capture: true })
      window.removeEventListener("resize", reposition)
      clearTimeout(openTimer)
      clearTimeout(closeTimer)
    })
  }))

  // the live session list refreshes under the card; re-read the row by identity
  const row = createMemo(() => {
    const a = anchor()
    if (!a) return null
    return sessionRows().find((s) => s.id === a.row.id && s.directory === a.row.directory) ?? a.row
  })
  const global = () => {
    const r = row()
    return r ? activity.session(r.id) : undefined
  }
  const insightsState = createMemo(() => {
    const r = row()
    return r ? sessionInsights(r.id, r.directory, r.updated) : null
  })
  const insights = () => insightsState()?.()
  const [providers] = createResource(() => row()?.directory, (directory) => providersFor(directory))
  const usage = createMemo(() => contextUsage(insights()?.value?.latest ?? null, providers()))
  const slices = createMemo(() => compositionSlices(insights()?.value?.composition, usage()?.tokens))
  const cost = () => global()?.cost ?? insights()?.value?.cost ?? null
  const sessionModel = () => global()?.model?.id ?? insights()?.value?.sessionModel ?? undefined
  const latestModel = () => insights()?.value?.latest?.modelID
  const degraded = () => {
    const v = insights()?.value
    return !!v && v.source !== "dashboard"
  }

  createEffect(() => {
    anchor()
    if (!card) return
    const observer = new ResizeObserver(() => { if (card) setHeight(card.offsetHeight) })
    observer.observe(card)
    setHeight(card.offsetHeight)
    onCleanup(() => observer.disconnect())
  })

  const placement = createMemo(() => {
    tick()
    const a = anchor()
    if (!a) return null
    const r = a.el.getBoundingClientRect()
    const rtl = getComputedStyle(a.el).direction === "rtl"
    const after = rtl ? r.left - WIDTH - GAP : r.right + GAP
    const before = rtl ? r.right + GAP : r.left - WIDTH - GAP
    const fits = (x: number) => x >= 4 && x + WIDTH <= window.innerWidth - 4
    const side = fits(after) ? "end" : fits(before) ? "start" : "end"
    const left = side === "end" ? (fits(after) ? after : Math.max(4, Math.min(after, window.innerWidth - WIDTH - 4))) : before
    const top = Math.max(4, Math.min(r.top - 4, window.innerHeight - height() - 8))
    return { left, top, side }
  })

  return (
    <Show when={row()}>{(r) => (
      <Portal>
        <div ref={card} class="session-peek" role="tooltip" id="session-peek"
          style={{ left: `${placement()?.left ?? 0}px`, top: `${placement()?.top ?? 0}px`, width: `${WIDTH}px` }}
          data-side={placement()?.side ?? "end"}
          onMouseEnter={() => clearTimeout(closeTimer)} onMouseLeave={scheduleClose}>
          <div class="peek-title">
            <span class={`dot ${dotFor(r())}`} />
            <span class="peek-title-text">{r().title || r().id}</span>
          </div>
          <div class="peek-body">
            <ContextDonut percent={usage()?.percent ?? null} tokens={usage()?.tokens ?? null} slices={slices()} />
            <dl class="peek-facts">
              <dt>cost</dt>
              <dd class="mono" data-fact="cost">{cost() != null ? `$${cost()!.toFixed(2)}` : "unknown"}</dd>
              <dt>turns</dt>
              <dd class="mono" data-fact="turns">{insights()?.value?.turns != null ? insights()!.value!.turns : insights()?.loading && !insights()?.value ? "…" : "unknown"}</dd>
              <dt>model</dt>
              <dd class="mono peek-model" data-fact="model">{sessionModel() ?? "unknown"}</dd>
              <Show when={latestModel() && latestModel() !== sessionModel()}>
                <dt>latest</dt>
                <dd class="mono peek-model" data-fact="latest">{latestModel()}</dd>
              </Show>
            </dl>
          </div>
          <div class="peek-context" classList={{ warn: usageLevel(usage()?.percent) === "warn", high: usageLevel(usage()?.percent) === "high" }}>
            <Show when={usage()} fallback={
              <span class="dim">{insights()?.loading && !insights()?.value ? "loading context…" : "latest turn context unknown"}</span>
            }>{(u) => (
              <span>
                <span class="mono">ctx {compactTokens(u().tokens)}</span>
                <Show when={u().limit} fallback={<span class="dim"> · limit unknown</span>}>
                  <span class="dim"> / {compactTokens(u().limit!)}</span>
                </Show>
                <span class="dim"> · exact, latest turn</span>
              </span>
            )}</Show>
          </div>
          <Show when={slices().length}>
            <CompositionDots slices={slices()} />
            <div class="ctx-caption">
              estimated from visible {insights()?.value?.composition?.basis === "since_compaction" ? "content since last compaction" : "history"} · not provider attribution
            </div>
          </Show>
          <Show when={degraded() && !insights()?.loading}>
            <div class="ctx-caption peek-degraded">
              {insights()?.value?.source === "tail" ? "insights API offline: turns and composition unavailable" : insights()?.value?.error ?? "insights unavailable"}
            </div>
          </Show>
        </div>
      </Portal>
    )}</Show>
  )
}
