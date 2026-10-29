/* Unified navigation (dotfiles#240, slice 1): a Needs you band at the top of the sidebar, then Pinned, then
 * four browse tabs (Surfaces | Agents | Decisions | PRs), each with its own filter. The band is never
 * filtered by a tab. Everything here reuses existing reads (the desk queue, surfaces, dashboard PRs);
 * opening a decision or surface goes to the Front desk with it selected. */
import { createMemo, createSignal, For, Show, type JSX } from "solid-js"
import { A, useLocation } from "@solidjs/router"
import { useDeskQueue } from "../desk-queue"
import { useDashboard } from "../state"
import { surfaceKey, surfaceProblem, type Surface } from "../surfaces"
import { needsYou } from "../needs-you"
import { workCountLabel, workSurfaces, type WorkEntry } from "../work-queue"
import { HostGlyph } from "./icons"
import { PrList, sortPrs } from "./pr"

export type NavTab = "surfaces" | "agents" | "decisions" | "prs"
const TAB_KEY = "es-app:nav-tab"
const TABS: [NavTab, string][] = [["surfaces", "Surfaces"], ["agents", "Agents"], ["decisions", "Decisions"], ["prs", "PRs"]]
const BAND_LIMIT = 8

const storedTab = (): NavTab => {
  try {
    const value = localStorage.getItem(TAB_KEY)
    return TABS.some(([id]) => id === value) ? value as NavTab : "agents"
  } catch {
    return "agents"
  }
}
const [tab, setTabState] = createSignal<NavTab>(storedTab())
export const navTab = tab
const setTab = (next: NavTab) => {
  setTabState(next)
  try { localStorage.setItem(TAB_KEY, next) } catch { /* kept for this page */ }
}

const itemHref = (key: string) => `/?item=${encodeURIComponent(key)}`
const matches = (text: string, needle: string) => text.toLocaleLowerCase().includes(needle.trim().toLocaleLowerCase())

// Router prefix matching would mark every "/?item=" link active; only the open item is.
const useOpenItem = () => {
  const location = useLocation()
  return (key: string) => location.pathname === "/" && new URLSearchParams(location.search).get("item") === key
}
// Every entry opens in this window; another Work host's detail and actions go through that host (work-remote.tsx).
const DecisionRow = (props: { entry: WorkEntry }) => {
  const open = useOpenItem()
  const series = () => props.entry.item?.series
  const glyph = () => props.entry.kind === "permission" ? "!" : props.entry.kind === "failure" ? "×" : props.entry.kind === "review" ? "Try" : "?"
  // Read out as what it asks: a review is something ready to try.
  const spoken = () => props.entry.kind === "review" ? "ready to try" : props.entry.kind
  return <Show when={props.entry.host} fallback={
    <A href={props.entry.href} activeClass="" classList={{ active: open(props.entry.key) }} aria-current={open(props.entry.key) ? "page" : undefined} class="nav-item nav-decision" data-kind={props.entry.kind} data-nav-item={props.entry.key}>
      <span class="nav-kind" aria-hidden="true">{glyph()}</span>
      <span class="nav-title" dir="auto">{series() ? `${series()!.title} (${series()!.answered}/${series()!.live})` : props.entry.title}</span>
      <span class="sr-only">, {spoken()}</span>
      <Show when={props.entry.project}><span class="session-project">{props.entry.project}</span></Show>
    </A>}>
    <A href={props.entry.href} activeClass="" class="nav-item nav-decision host-decision" classList={{ stale: props.entry.stale, active: open(props.entry.key) }} aria-current={open(props.entry.key) ? "page" : undefined} data-kind={props.entry.kind} data-nav-item={props.entry.key}
      aria-label={`${props.entry.title}, ${spoken()}, on ${props.entry.hostLabel}${props.entry.stale ? ", last known" : ""}`}
      title={props.entry.stale ? `${props.entry.hostLabel} not current; last-known decision` : `${props.entry.title} — on ${props.entry.hostLabel}`}>
      <span class="nav-kind" aria-hidden="true">{glyph()}</span>
      <HostGlyph host={props.entry.host!} />
      <span class="nav-title" dir="auto">{props.entry.title}</span>
      <span class="session-project">{props.entry.hostLabel}</span>
    </A>
  </Show>
}
// Another Work host's Surface, opened in this window and framed through that host; a link Surface says it is served there only.
const HostSurfaceRow = (props: { entry: WorkEntry }) => {
  const open = useOpenItem()
  const ownOnly = () => props.entry.remote?.kind === "surface" && props.entry.remote.frame === "own-host-only"
  return <A href={props.entry.href} activeClass="" class="nav-item nav-surface host-surface" classList={{ stale: props.entry.stale, active: open(props.entry.key) }}
    aria-current={open(props.entry.key) ? "page" : undefined} data-nav-item={props.entry.key}
    aria-label={`${props.entry.title}, surface, on ${props.entry.hostLabel}${props.entry.stale ? ", last known" : ""}${ownOnly() ? ", opens on that computer only" : ""}`}
    title={props.entry.stale ? `${props.entry.hostLabel} not current; last-known surface` : `${props.entry.title} — on ${props.entry.hostLabel}`}>
    <span class="nav-kind" aria-hidden="true">▢</span>
    <HostGlyph host={props.entry.host!} />
    <span class="nav-title" dir="auto">{props.entry.title}</span>
    <span class="session-project">{props.entry.hostLabel}</span>
  </A>
}
const SurfaceRow = (props: { surface: Surface; fresh?: boolean }) => {
  const open = useOpenItem()
  return <A href={itemHref(surfaceKey(props.surface.id))} activeClass="" classList={{ active: open(surfaceKey(props.surface.id)), fresh: !!props.fresh }} aria-current={open(surfaceKey(props.surface.id)) ? "page" : undefined} class="nav-item nav-surface" data-nav-item={surfaceKey(props.surface.id)}>
    <span class="nav-kind" aria-hidden="true">▢</span>
    <span class="nav-title" dir="auto">{props.surface.title}</span>
    <Show when={props.fresh}><span class="sr-only">, new delivery</span></Show>
    <span class="session-project">{surfaceProblem(props.surface.health) ?? props.surface.owner}</span>
  </A>
}

/** New decisions, permissions, failures and fresh requested deliverables, newest work first, bounded. */
const useWork = () => {
  const queue = useDeskQueue()
  const { work } = useDashboard()
  return createMemo(() => needsYou({ items: queue.items(), feeds: work.feeds(), fresh: queue.surfaces.deliverables().fresh }))
}
export const NeedsYouBand = () => {
  const all = useWork()
  const shown = () => all().entries.slice(0, BAND_LIMIT)
  const more = () => Math.max(0, all().entries.length - BAND_LIMIT)
  // "N+" with the hosts behind named, never a falsely complete count.
  return <Show when={all().entries.length || all().fresh.length}>
    <section class="needs-you-band" aria-label="Needs you">
      <div class="nav-heading">Needs you <span class="nav-heading-count" title={all().label.title}>{all().count ? all().label.text : ""}</span></div>
      <For each={shown()}>{entry => <DecisionRow entry={entry} />}</For>
      <For each={all().fresh}>{surface => <SurfaceRow surface={surface} fresh />}</For>
      <Show when={more()}><button type="button" class="link-button nav-more" onClick={() => setTab("decisions")}>{more()} more in Decisions</button></Show>
    </section>
  </Show>
}

/** The tab row and the Surfaces, Decisions and PRs panels; the Agents panel is the existing session list. */
export const NavTabs = (props: { agents: JSX.Element; agentsCount?: { text: string; title: string } }) => {
  const queue = useDeskQueue()
  const dashboard = useDashboard()
  const state = dashboard.state
  // Each tab keeps its own filter; switching tabs never changes another tab's filter.
  const [filters, setFilters] = createSignal<Record<Exclude<NavTab, "agents">, string>>({ surfaces: "", decisions: "", prs: "" })
  const filter = (id: Exclude<NavTab, "agents">) => filters()[id]
  const setFilter = (id: Exclude<NavTab, "agents">, value: string) => setFilters(previous => ({ ...previous, [id]: value }))
  const all = useWork()
  const decisions = createMemo(() => all().entries.filter(entry => matches(`${entry.title} ${entry.hostLabel ?? ""}`, filter("decisions"))))
  const surfaces = createMemo(() => {
    const split = queue.surfaces.deliverables()
    return [...split.fresh.map(surface => ({ surface, fresh: true })), ...split.earlier.map(surface => ({ surface, fresh: false })),
      ...queue.surfaces.boards().map(surface => ({ surface, fresh: false }))].filter(row => matches(row.surface.title, filter("surfaces")))
  })
  // Other Work hosts' Surfaces after this host's, each with its host; a host not current makes the count "N+".
  const hostSurfaces = createMemo(() => workSurfaces([], dashboard.work.feeds()))
  const hostSurfaceRows = createMemo(() => hostSurfaces().entries.filter(entry => matches(`${entry.title} ${entry.hostLabel ?? ""}`, filter("surfaces"))))
  const prs = createMemo(() => {
    const seen = new Set<string>()
    return sortPrs((state()?.threads ?? []).flatMap((thread: { prs?: { url: string; title?: string }[] }) => thread.prs ?? [])
      .filter((pr: { url: string }) => !seen.has(pr.url) && (seen.add(pr.url), true))
      .filter((pr: { url: string; title?: string }) => matches(`${pr.title ?? ""} ${pr.url}`, filter("prs"))))
  })
  const count = (id: NavTab) => id === "agents" ? props.agentsCount?.text : id === "decisions" ? all().decisions.text.replace(/^0$/, "") : id === "surfaces" ? workCountLabel({ ...hostSurfaces(), count: queue.surfaces.list().length + hostSurfaces().count }).text.replace(/^0$/, "") : id === "prs" ? prs().length : undefined
  const tabId = (id: NavTab) => `nav-tab-${id}`
  const FilterBox = (p: { id: Exclude<NavTab, "agents">; label: string }) =>
    <div class="search-box"><input class="search-input" type="search" placeholder={`filter ${p.label.toLowerCase()}…`} aria-label={`Filter ${p.label}`}
      value={filter(p.id)} onInput={event => setFilter(p.id, event.currentTarget.value)} onKeyDown={event => event.key === "Escape" && setFilter(p.id, "")} /></div>
  return <>
    <div class="nav-tabs" role="tablist" aria-label="Browse">
      <For each={TABS}>{([id, label]) =>
        <button type="button" role="tab" id={tabId(id)} aria-selected={tab() === id} aria-controls={`${tabId(id)}-panel`} tabindex={tab() === id ? 0 : -1}
          onClick={() => setTab(id)}
          onKeyDown={event => {
            // Arrow keys move between tabs in reading order (mirrored in RTL by the browser's layout direction).
            const rtl = event.currentTarget.matches(":dir(rtl)")
            const step = event.key === "ArrowRight" ? (rtl ? -1 : 1) : event.key === "ArrowLeft" ? (rtl ? 1 : -1) : 0
            if (!step) return
            event.preventDefault()
            const index = (TABS.findIndex(([value]) => value === tab()) + step + TABS.length) % TABS.length
            setTab(TABS[index][0])
            document.getElementById(tabId(TABS[index][0]))?.focus()
          }}>
          {/* The count keeps a fixed slot, so the tab does not change width as numbers change. */}
          <span class="nav-tab-label">{label}</span><span class="nav-tab-count" title={id === "agents" ? props.agentsCount?.title : undefined}>{count(id) || ""}</span>
        </button>}</For>
    </div>
    <div role="tabpanel" id={`${tabId(tab())}-panel`} aria-labelledby={tabId(tab())} class="nav-tab-panel">
      <Show when={tab() === "agents"}>{props.agents}</Show>
      <Show when={tab() === "decisions"}>
        <FilterBox id="decisions" label="Decisions" />
        <For each={decisions()} fallback={<div class="dim nav-empty">{filter("decisions") ? "no matches" : "Nothing needs you."}</div>}>{entry => <DecisionRow entry={entry} />}</For>
      </Show>
      <Show when={tab() === "surfaces"}>
        <FilterBox id="surfaces" label="Surfaces" />
        <For each={surfaces()} fallback={<Show when={!hostSurfaceRows().length}><div class="dim nav-empty">{filter("surfaces") ? "no matches" : queue.surfaces.error() ?? "No surfaces."}</div></Show>}>{row => <SurfaceRow surface={row.surface} fresh={row.fresh} />}</For>
        <For each={hostSurfaceRows()}>{entry => <HostSurfaceRow entry={entry} />}</For>
      </Show>
      <Show when={tab() === "prs"}>
        <FilterBox id="prs" label="PRs" />
        <div class="nav-prs"><Show when={prs().length} fallback={<div class="dim nav-empty">{filter("prs") ? "no matches" : "No pull requests in this view."}</div>}><PrList prs={prs()} compact /></Show></div>
      </Show>
    </div>
  </>
}
