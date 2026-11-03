import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { useNavigate } from "@solidjs/router"
import { entityView, mentionRef, parseEntityHref, type EntityRef, type EntityStores, type EntityView } from "../entity-ref"
import { useDeskQueue } from "../desk-queue"
import { personas } from "../desk-identity"
import { sessionHref, useDashboard } from "../state"

// Entity tokens (chip design r4, ux-feel opencode-mail-tool-review rev 4): one text-height token per Surface, decision
// or agent mention, with the state inside the token (stale dot, other-host glyph, dashed missing). <EntityToken> is the
// component adopters use; <EntityRefs> turns links and known @mentions in rendered message markdown into tokens and
// shows the shared card on hover, focus or long-press. Never inside code, tool output or the composer.

const NS = "http://www.w3.org/2000/svg"
const STROKES: Record<string, string> = {
  board: '<rect x="2.25" y="2.75" width="11.5" height="10.5" rx="1.5"/><path d="M2.25 6h11.5M6 6v7.25"/>',
  dopen: '<path d="M8 1.75 14.25 8 8 14.25 1.75 8Z"/><circle cx="8" cy="8" r="1.1" fill="currentColor"/>',
  dans: '<path d="M8 1.75 14.25 8 8 14.25 1.75 8Z"/><path d="m5.6 8 1.6 1.6 3.2-3.2"/>',
  dgone: '<path d="M8 1.75 14.25 8 8 14.25 1.75 8Z"/><path d="M5.5 8h5"/>',
  qmark: '<circle cx="8" cy="8" r="6.25"/><path d="M6.2 6.2a1.9 1.9 0 1 1 2.6 1.75c-.5.25-.8.6-.8 1.15v.4"/>',
  host: '<rect x="2" y="3" width="12" height="8" rx="1.25"/><path d="M5.5 13.5h5M8 11v2.5"/>',
}
const glyph = (name: string) => {
  const svg = document.createElementNS(NS, "svg")
  svg.setAttribute("viewBox", "0 0 16 16")
  svg.setAttribute("fill", "none")
  svg.setAttribute("stroke", "currentColor")
  svg.setAttribute("stroke-width", "1.5")
  svg.setAttribute("stroke-linecap", "round")
  svg.setAttribute("stroke-linejoin", "round")
  svg.setAttribute("aria-hidden", "true")
  svg.setAttribute("class", "g")
  svg.innerHTML = STROKES[name]!
  return svg
}
const span = (className: string, text?: string) => {
  const el = document.createElement("span")
  el.className = className
  if (text !== undefined) el.textContent = text
  return el
}

/** The token's DOM, shared by the component and the markdown decorator so both look and read the same. */
export const tokenElement = (view: EntityView, tag: "span" | "a" = "span") => {
  const el = document.createElement(tag)
  const kind = view.ref.kind === "surface" ? "s" : view.ref.kind === "decision" ? "d" : "m"
  el.className = ["eref", kind, view.state === "missing" ? "missing" : "", view.me ? "me" : "", kind === "m" && view.state === "missing" ? "unk" : ""].filter(Boolean).join(" ")
  el.dataset.entity = JSON.stringify(view.ref)
  if (view.decision) el.dataset.s = view.decision.status
  el.setAttribute("aria-label", view.label)
  el.title = view.title
  if (tag === "span") { el.setAttribute("role", "link"); el.tabIndex = 0 }
  if (kind === "m") {
    const avatar = span(`av${view.avatar?.url ? " img" : ""}`)
    avatar.setAttribute("aria-hidden", "true")
    if (view.avatar?.url) { const img = document.createElement("img"); img.src = view.avatar.url; img.alt = ""; img.referrerPolicy = "no-referrer"; avatar.append(img) }
    else avatar.textContent = view.avatar?.initials ?? "?"
    el.append(avatar)
  } else el.append(glyph(view.state === "missing" ? "qmark" : kind === "s" ? "board" : view.decision?.status === "withdrawn" ? "dgone" : view.decision && view.decision.status !== "open" && view.decision.status !== "snoozed" ? "dans" : "dopen"))
  const title = span("et", view.title)
  title.dir = "auto"
  el.append(title)
  if (view.section) el.append(span("esec", `› ${view.section}`))
  if (view.decision?.answer) el.append(span("eans", view.decision.answer))
  if (view.state === "stale") { const mark = span("emk warn"); mark.setAttribute("aria-hidden", "true"); el.append(mark) }
  if (view.host) { const host = span("eh"); host.setAttribute("aria-hidden", "true"); host.append(glyph("host")); el.append(host) }
  return el
}

/** The stores entity refs resolve against: only what the app already holds. */
export const useEntityStores = () => {
  const queue = useDeskQueue()
  const dashboard = useDashboard()
  return createMemo<EntityStores>(() => ({
    here: window.location.host,
    surfaces: queue.surfaces.list(),
    decisions: queue.attention.snapshot()?.value.records ?? [],
    lanes: ((dashboard.state()?.threads ?? []) as { lanes?: { lane: string; owner?: string; activity?: string }[]; title?: string }[])
      .flatMap((thread) => (thread.lanes ?? []).map((lane) => ({ editspace: dashboard.state()?.editspace ?? "", lane: lane.lane, owner: lane.owner, activity: lane.activity, title: thread.title }))),
    personas: personas(),
    hostLabel: (id) => dashboard.work.feeds().find((feed) => feed.host.id === id)?.host.label,
  }))
}

/** A resolved reference as a token (adopters: decision routing, needs-you rows, mail rows, composer chips). */
export const EntityToken = (props: { entity: EntityRef }) => {
  const stores = useEntityStores()
  return <>{tokenElement(entityView(props.entity, stores()))}</>
}

const MENTION = /(^|[\s(])@([A-Za-z][\w.-]{1,40})(?![\w.-])/g
const SKIP = "code, pre, kbd, samp, textarea, .eref, .ticket-ref, .session-ref, .utc-time"

/** Turns Surface and decision links, and known @mentions, in rendered message markdown into tokens; one shared card. */
export const EntityRefs = (props: { container: () => HTMLElement | undefined }) => {
  const stores = useEntityStores()
  const navigate = useNavigate()
  const [card, setCard] = createSignal<{ view: EntityView; rect: DOMRect }>()
  const decorate = () => {
    const root = props.container()
    if (!root) return
    const current = stores()
    for (const anchor of root.querySelectorAll<HTMLAnchorElement>('[data-component="markdown"] a[href]:not([data-eref])')) {
      if (anchor.closest(SKIP)) continue
      anchor.dataset.eref = "seen"
      const ref = parseEntityHref(anchor.getAttribute("href") ?? "", current.here)
      if (!ref) continue
      const view = entityView({ ...ref, label: anchor.textContent?.trim() || undefined }, current)
      const token = tokenElement(view, "a")
      token.setAttribute("href", anchor.getAttribute("href")!)
      token.dataset.eref = "token"
      anchor.replaceWith(token)
    }
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        MENTION.lastIndex = 0
        if (!MENTION.test(node.nodeValue ?? "")) return NodeFilter.FILTER_SKIP
        const parent = node.parentElement
        return parent?.closest('[data-component="markdown"]') && !parent.closest(SKIP) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP
      },
    })
    const texts: Text[] = []
    for (let node = walker.nextNode(); node; node = walker.nextNode()) texts.push(node as Text)
    for (const text of texts) {
      const value = text.nodeValue ?? ""
      const fragment = document.createDocumentFragment()
      let last = 0
      MENTION.lastIndex = 0
      for (let match = MENTION.exec(value); match; match = MENTION.exec(value)) {
        const ref = mentionRef(match[2]!, current)
        if (!ref) continue
        const start = match.index + match[1]!.length
        fragment.append(document.createTextNode(value.slice(last, start)))
        fragment.append(tokenElement(entityView(ref, current)))
        last = start + match[2]!.length + 1
      }
      if (!last) continue
      fragment.append(document.createTextNode(value.slice(last)))
      text.replaceWith(fragment)
    }
  }
  const viewOf = (el: Element) => {
    const raw = (el as HTMLElement).dataset.entity
    if (!raw) return undefined
    try { return entityView(JSON.parse(raw) as EntityRef, stores()) } catch { return undefined }
  }
  const open = (el: HTMLElement) => {
    const view = viewOf(el)
    if (!view) return
    if (view.href) return navigate(view.href)
    const owner = view.ref.kind === "agent" ? stores().lanes.find((lane) => lane.lane === view.ref.id)?.owner : undefined
    if (owner) navigate(sessionHref(owner))
  }
  onMount(() => {
    const root = props.container()
    if (!root) return
    const observer = new MutationObserver(() => requestAnimationFrame(decorate))
    observer.observe(root, { childList: true, subtree: true })
    decorate()
    const show = (event: Event) => {
      const el = (event.target as Element | null)?.closest?.(".eref") as HTMLElement | null
      if (!el) return
      const view = viewOf(el)
      if (view) setCard({ view, rect: el.getBoundingClientRect() })
    }
    const hide = (event: Event) => { if ((event.target as Element | null)?.closest?.(".eref")) setCard(undefined) }
    const key = (event: KeyboardEvent) => {
      const el = (event.target as Element | null)?.closest?.(".eref[role=link]") as HTMLElement | null
      if (el && event.key === "Enter") { event.preventDefault(); open(el) }
      if (event.key === "Escape") setCard(undefined)
    }
    const click = (event: MouseEvent) => {
      const el = (event.target as Element | null)?.closest?.(".eref[role=link]") as HTMLElement | null
      if (el) open(el)
    }
    root.addEventListener("mouseover", show)
    root.addEventListener("focusin", show)
    root.addEventListener("mouseout", hide)
    root.addEventListener("focusout", hide)
    root.addEventListener("keydown", key)
    root.addEventListener("click", click)
    onCleanup(() => {
      observer.disconnect()
      root.removeEventListener("mouseover", show)
      root.removeEventListener("focusin", show)
      root.removeEventListener("mouseout", hide)
      root.removeEventListener("focusout", hide)
      root.removeEventListener("keydown", key)
      root.removeEventListener("click", click)
    })
  })
  return <Show when={card()}>{(value) => <div class="eref-card" role="tooltip" data-kind={value().view.ref.kind}
    style={{ "inset-block-start": `${value().rect.bottom + 6}px`, "inset-inline-start": `${Math.max(8, value().rect.left)}px` }}>
    <div class="eref-card-head"><b dir="auto">{value().view.title}</b><span class="dim">{value().view.ref.kind === "surface" ? "Surface" : value().view.ref.kind === "decision" ? "Decision" : value().view.ref.kind === "agent" ? "Agent" : "Session"}</span></div>
    <dl><For each={value().view.rows}>{([name, text]) => <><dt>{name}</dt><dd dir="auto">{text}</dd></>}</For></dl>
    <Show when={value().view.preview}><p class="eref-card-preview" dir="auto">{value().view.preview}</p></Show>
    <p class="eref-card-foot">{value().view.ref.kind === "decision" ? "Enter opens the decision · it is never answered from here" : "Enter opens · Esc closes"}</p>
  </div>}</Show>
}
