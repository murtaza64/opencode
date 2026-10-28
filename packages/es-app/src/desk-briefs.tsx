/* App-wide automatic preparation of readable briefs for open attention items. Mounted once in the
 * shell, so items are prepared while any page is open and Home or the desk can show them ready.
 * One job per item revision (Core child sessions are the record), no automatic retry of a failed
 * revision, at most MAX_RUNNING jobs at a time, and nothing runs while the setting is off. */
import { createContext, createEffect, createMemo, createSignal, onCleanup, useContext, type ParentProps } from "solid-js"
import { createAttention } from "./attention"
import { deskItems, type DeskItem } from "./desk"
import { briefAnchorID, createBriefAnchor, createBriefs, currentJob, hostModel, readHostModel, type DeskPointer } from "./desk-session"
import { useDashboard } from "./state"
import { readHost } from "./host"

const waitFor = (ready: () => boolean) => new Promise<void>(resolve => {
  const deadline = Date.now() + 10_000
  const check = () => ready() || Date.now() > deadline ? resolve() : setTimeout(check, 50)
  check()
})
const SETTING = "es-app:front-desk:auto-prepare"
// The newest few open items first, then the backlog one at a time: no burst on first run.
const FIRST = 5
const MAX_RUNNING = 2

const create = () => {
  const dashboard = useDashboard()
  // Automation-driven browsers (tests, agents) default to off so they never start model work unasked,
  // and so does a remote host: its model work starts only when chosen there. Off until the host is known.
  const [auto, setAutoRaw] = createSignal(localStorage.getItem(SETTING) === "on")
  if (localStorage.getItem(SETTING) === null && !navigator.webdriver) void readHost().then(value => { if (localStorage.getItem(SETTING) === null) setAutoRaw(!value.remote) })
  const setAuto = (value: boolean) => {
    localStorage.setItem(SETTING, value ? "on" : "off")
    setAutoRaw(value)
  }
  // All connected projects: a decision anywhere is prepared, whatever page is in view.
  // With automatic preparation off nothing is read until a brief is started by hand.
  // An unconfirmed start from an earlier page must be reconciled, so it counts as activity.
  // Background tasks live under the same parent, so a page that has started one keeps reading it.
  const [manual, setManual] = createSignal(localStorage.getItem("es-app:front-desk:brief-create:1") !== null || localStorage.getItem("es-app:front-desk:tasks-used:1") !== null)
  // A visible brief also activates reads, so existing results show even with automatic preparation off.
  const [viewers, setViewers] = createSignal(0)
  const active = () => auto() || manual() || viewers() > 0
  const attention = createAttention(() => undefined, { readOnly: true, enabled: auto })
  const items = createMemo(() => deskItems({
    records: attention.snapshot()?.value.records ?? [], attentionChecked: attention.snapshot()?.checked ?? 0,
    requests: [], failures: [], failuresChecked: 0, title: () => undefined, project: () => undefined,
  }))
  // Other surfaces (the desk) register their items so a manual start rechecks the right source.
  const [extra, setExtra] = createSignal<(() => DeskItem[])[]>([])
  const lookup = (key: string) => items().find(item => item.key === key) ?? extra().flatMap(list => list()).find(item => item.key === key)
  const track = (list: () => DeskItem[]) => {
    setExtra(previous => [...previous, list])
    onCleanup(() => setExtra(previous => previous.filter(item => item !== list)))
  }
  const anchor = createBriefAnchor(() => {
    if (!active()) return
    const name = dashboard.editspace() ?? dashboard.editspaces()?.default
    return dashboard.editspaces()?.editspaces.find(item => item.name === name)?.root
  })
  // Every project's anchor ID, so a brief prepared while another project was in view is found, not repeated.
  const [others, setOthers] = createSignal<DeskPointer[]>([])
  createEffect(() => {
    const roots = active() ? dashboard.editspaces()?.editspaces.map(item => item.root) ?? [] : []
    void Promise.all(roots.map(async root => ({ session: await briefAnchorID(root), directory: root }))).then(setOthers)
  })
  const briefs = createBriefs(anchor.pointer, lookup, anchor.ensure, others)
  // The host's desk model is read once per page; a host without a usable one prepares nothing automatically.
  createEffect(() => { if (active()) void readHostModel() })
  const unavailable = () => hostModel()?.available === false ? `Briefs unavailable on this host: ${hostModel()!.reason}.` : ""
  const jobFor = (item: DeskItem) => currentJob(briefs.jobs(), item)
  // Wait for a successful read of existing jobs so a reload never starts a second job for a revision.
  const loaded = () => anchor.checked() && (!anchor.pointer() || briefs.synced() === anchor.pointer()!.session)
  // One automatic attempt per item revision per page lifetime, whatever its outcome: no retry loops.
  const attempted = new Set<string>()
  createEffect(() => {
    if (!auto() || !loaded() || anchor.error() || hostModel()?.available !== true || attention.stale() || briefs.pending() || briefs.preparing()) return
    const running = briefs.jobs().filter(job => ["starting", "running"].includes(job.state.state)).length
    if (running >= (attempted.size < FIRST ? MAX_RUNNING : 1)) return
    const next = items().filter(item => !jobFor(item) && !attempted.has(`${item.key}\u0000${item.revision}`))
      .sort((a, b) => (b.record?.created_at ?? 0) - (a.record?.created_at ?? 0))[0]
    if (!next) return
    attempted.add(`${next.key}\u0000${next.revision}`)
    void briefs.start(next)
  })
  return {
    auto, setAuto, attention, items, anchor, jobFor, track, unavailable,
    /** Starts reading the shared parent (briefs and background tasks) without starting any job. */
    activate: () => setManual(true), waitReady: () => waitFor(anchor.ready),
    view: () => { setViewers(count => count + 1); onCleanup(() => setViewers(count => count - 1)) },
    briefs: {
      ...briefs,
      start: async (item: DeskItem) => { setManual(true); await waitFor(anchor.ready); return briefs.start(item) },
      confirm: async () => { setManual(true); await waitFor(anchor.ready); return briefs.confirm() },
    },
  }
}

const Ctx = createContext<ReturnType<typeof create>>()

export const BriefsProvider = (props: ParentProps) => <Ctx.Provider value={create()}>{props.children}</Ctx.Provider>

export const useBriefs = () => {
  const value = useContext(Ctx)
  if (!value) throw new Error("useBriefs outside BriefsProvider")
  return value
}
