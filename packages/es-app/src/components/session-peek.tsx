/* Sidebar hover card: hover or focus a session row (expanded list or compact
 * rail) and a compact card opens off the row's inline-end edge with the
 * session's own persisted TODO list and one context number (tokens of the
 * latest completed turn). The list is watched only while the card is open:
 * one snapshot read, then the shared todo.updated stream; nothing polls.
 * One card per sidebar, delegated from the nav so pinned/unpinned/archived
 * rows all behave alike; it never changes row layout. Phones have no hover:
 * the session's own Todos panel is the touch equivalent. */
import { createEffect, createMemo, createSignal, For, on, onCleanup, Show } from "solid-js"
import { Portal } from "solid-js/web"
import type { Todo } from "@opencode-ai/sdk/v2"
import { ago, useDashboard, type SessionRow } from "../state"
import { compactTokens, contextUsage } from "../context-usage"
import { host } from "../host"
import { cancelInsights, sessionInsights } from "../session-insights"

const LIMIT = 5
const glyph = (status: string) => status === "completed" ? "✓" : status === "in_progress" ? "•" : status === "cancelled" ? "-" : " "
// In progress first, then pending in list order; finished items collapse to a count.
const order = (todos: readonly Todo[]) => {
  const open = [...todos.filter((todo) => todo.status === "in_progress"), ...todos.filter((todo) => todo.status === "pending")]
    .filter((todo) => todo.content.trim())
  return { shown: open.slice(0, LIMIT), more: Math.max(0, open.length - LIMIT), done: todos.filter((todo) => todo.status === "completed").length }
}

const WIDTH = 268
const GAP = 6
const OPEN_DELAY = 180
const CLOSE_DELAY = 160

type Anchor = { el: HTMLElement; row: SessionRow }

export const peekAttrs = (s: SessionRow) => ({ "data-peek-id": s.id, "data-peek-dir": s.directory })

export function SessionPeek(props: { container: () => HTMLElement | undefined }) {
  const { activity, sessionRows, dotFor, laneOwners } = useDashboard()
  const todos = activity.todos
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
  const insightsState = createMemo(() => {
    const r = row()
    return r ? sessionInsights(r.id, r.directory, r.updated) : null
  })
  const insights = () => insightsState()?.()
  // One number from the cached insights read; no provider limit, no breakdown.
  const usage = createMemo(() => contextUsage(insights()?.value?.latest ?? null, undefined))
  // Facts already in the dashboard store or the card's one cached insights read; missing ones are omitted.
  const facts = createMemo(() => {
    const r = row()
    if (!r) return []
    const parentID = activity.session(r.id)?.parentID
    const parent = parentID ? activity.session(parentID)?.title || parentID : undefined
    const lane = laneOwners().find((owner) => owner.owner === r.id || owner.owner.endsWith(`:${r.id}`))?.lane
    const current = host()
    const cost = insights()?.value?.cost
    const u = usage()
    return [
      ["Project", r.project],
      ["Lane", lane],
      ["Host", current && (current.remote || current.hosts.length > 1) ? current.label : undefined],
      ["Parent", parent],
      ["Updated", r.updated ? ago(r.updated) : undefined],
      ["Cost", cost != null && cost > 0 ? `$${cost.toFixed(2)} this session` : undefined],
      ["Context", u ? (u.limit ? `${compactTokens(u.tokens)} of ${compactTokens(u.limit)} tokens` : `${compactTokens(u.tokens)} tokens, last turn`) : undefined],
    ].filter((fact): fact is [string, string] => !!fact[1])
  })
  // Watch the row's TODOs only while its card is open.
  createEffect(() => {
    const r = row()
    if (r) onCleanup(todos.watch(r.id, r.directory))
  })
  const entry = () => { const r = row(); const value = r ? todos.get(r.id) : undefined; return value?.directory === r?.directory ? value : undefined }
  const list = createMemo(() => order(entry()?.todos ?? []))
  // State only what was observed: the agent's status and when the list was read or updated.
  const basis = () => {
    const r = row()
    const status = r ? activity.status(r.id) : undefined
    const agent = status === "busy" || status === "retry" ? "agent busy" : status === "idle" ? "agent idle" : "status unknown"
    const value = entry()
    const seen = value?.at ? `updated ${ago(value.at)}` : "list read on open"
    return `${agent} · ${seen}${value?.state === "error" ? " · may be outdated" : ""}`
  }

  // Screen readers announce the card for the focused or hovered row.
  createEffect(() => {
    const target = anchor()?.el.querySelector<HTMLElement>("a") ?? anchor()?.el
    if (!target) return
    target.setAttribute("aria-describedby", "session-peek")
    onCleanup(() => target.removeAttribute("aria-describedby"))
  })

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
          <Show when={facts().length}>
            <dl class="peek-facts">
              <For each={facts()}>{([label, value]) => <><dt>{label}</dt><dd><bdi dir="auto">{value}</bdi></dd></>}</For>
            </dl>
          </Show>
          <Show when={entry()?.state !== "loading" || entry()?.todos.length} fallback={<div class="dim peek-todo-state">Checking TODOs…</div>}>
            <Show when={entry() && !(entry()!.state === "error" && !entry()!.todos.length)} fallback={<div class="dim peek-todo-state">TODOs unavailable</div>}>
              <Show when={list().shown.length || list().done} fallback={<div class="dim peek-todo-state">No TODO list</div>}>
                <ul class="peek-todos" aria-label={`TODOs, ${list().done} done`}>
                  <For each={list().shown}>{(todo) => (
                    <li data-status={todo.status}>
                      <span class="peek-todo-glyph" role="img" aria-label={todo.status.replace("_", " ")}>[{glyph(todo.status)}]</span>
                      <bdi dir="auto">{todo.content}</bdi>
                    </li>
                  )}</For>
                  <Show when={list().more}><li class="dim peek-todo-more">+{list().more} more</li></Show>
                  <Show when={list().done}><li class="dim peek-todo-done"><span class="peek-todo-glyph" aria-hidden="true">✓</span>{list().done} done</li></Show>
                </ul>
                <div class="peek-todo-basis">{basis()}</div>
              </Show>
            </Show>
          </Show>
        </div>
      </Portal>
    )}</Show>
  )
}
