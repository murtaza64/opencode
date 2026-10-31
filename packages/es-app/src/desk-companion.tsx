/* The Front desk chat as a companion pane beside any main view (persistent-nav layout, dotfiles#240).
 * One desk session for the whole app, mounted once: closing the pane hides it without unmounting, so
 * the draft, caret, scroll position, pending sends and a dictation target survive. Whether it is open
 * is remembered separately beside work views (Decisions, map, surfaces) and beside a transcript. */
import { createContext, createEffect, createResource, createSignal, For, onCleanup, Show, useContext, type Accessor, type ParentProps } from "solid-js"
import { A, useLocation } from "@solidjs/router"
import { Icon } from "@opencode-ai/ui/icon"
import { ago, sessionHref, useDashboard } from "./state"
import { useBriefs } from "./desk-briefs"
import { createTasks, deskTasksSupported, type TaskJob } from "./desk-tasks"
import { getComposer } from "./composer"
import { createDeskSession } from "./desk-session"
import { es, type ContextPart } from "./api"
import { caseLines, followUps, progressRows, readCases, type DeskCase, type FollowUp, type ProgressRow } from "./desk-followups"
import "./desk-followups.css"
import { SessionView } from "./pages/session"
import { ResizeHandle } from "./components/resize-handle"
import { companionWidth, setCompanionDocked } from "./ui"

export type CompanionKind = "work" | "session"
export const companionKind = (pathname: string): CompanionKind => pathname.startsWith("/session/") ? "session" : "work"

const KEY = { work: "es-app:companion:work", session: "es-app:companion:session" } as const
const DEFAULT = { work: true, session: false } as const
const NARROW = "(max-width: 900px)"
// Below this width the companion cannot sit beside the queue and a readable item, so it floats over the
// main view (a docked overlay, or a full sheet when narrow) and opens only on request, never by default.
const FLOATING = "(max-width: 1199px)"
const media = (query: string) => {
  const [matches, setMatches] = createSignal(typeof matchMedia === "function" && matchMedia(query).matches)
  if (typeof matchMedia === "function") matchMedia(query).addEventListener("change", (event) => setMatches(event.matches))
  return matches
}
const stored = (kind: CompanionKind) => {
  try {
    const value = localStorage.getItem(KEY[kind])
    return value === null ? DEFAULT[kind] : value === "1"
  } catch {
    return DEFAULT[kind]
  }
}

type DeskChat = {
  desk: ReturnType<typeof createDeskSession>
  directory: Accessor<string | undefined>
  open: Accessor<boolean>
  setOpen: (open: boolean) => void
  // The Decisions view supplies its queue/selection context while mounted; other views send none.
  setContext: (context: (() => ContextPart[]) | undefined) => void
  context: () => ContextPart[]
  /** The desk's open cases (dashboard, metadata only), shared by every view so off-Decisions sends carry them too. */
  cases: () => DeskCase[]
  /** Background tasks started from the chat; their packet is the current view's text (empty elsewhere). */
  tasks: ReturnType<typeof createTasks>
  setView: (view: (() => string) | undefined) => void
  view: () => string
}

const Ctx = createContext<DeskChat>()

export const DeskChatProvider = (props: ParentProps) => {
  const dashboard = useDashboard()
  const location = useLocation()
  const desk = createDeskSession()
  const [open, setOpenState] = createSignal({ work: stored("work"), session: stored("session") })
  const floating = media(FLOATING)
  // A floating companion's open state is for this page only; it never changes the remembered docked state.
  const [floatingOpen, setFloatingOpen] = createSignal(false)
  const [contextGetter, setContextGetter] = createSignal<(() => ContextPart[]) | undefined>()
  const [viewGetter, setViewGetter] = createSignal<(() => string) | undefined>()
  const prepared = useBriefs()
  const tasks = createTasks(prepared.anchor.pointer, prepared.anchor.ensure, () => desk.status() === "ready" ? desk.pointer() : undefined,
    async () => { prepared.activate(); await prepared.waitReady() })
  // Cases are read once for the app, refreshed on mail and every minute.
  const [caseTick, setCaseTick] = createSignal(0)
  const caseTimer = setInterval(() => setCaseTick(value => value + 1), 60_000)
  onCleanup(() => clearInterval(caseTimer))
  const [cases] = createResource(() => [caseTick(), dashboard.mailRevision()] as const, () => readCases().catch(() => [] as DeskCase[]))
  const kind = () => companionKind(location.pathname)
  const directory = () => {
    const name = dashboard.editspace() ?? dashboard.editspaces()?.default
    return dashboard.editspaces()?.editspaces.find((item) => item.name === name)?.root
  }
  const value: DeskChat = {
    desk,
    directory,
    open: () => floating() ? floatingOpen() : open()[kind()],
    setOpen: (next) => {
      if (floating()) return setFloatingOpen(next)
      const current = kind()
      setOpenState((previous) => ({ ...previous, [current]: next }))
      try { localStorage.setItem(KEY[current], next ? "1" : "0") } catch { /* stays for this page */ }
    },
    setContext: (getter) => setContextGetter(() => getter),
    // The Decisions page sends its full view (cases included); every other view sends the cases alone.
    context: () => contextGetter()?.() ?? desk.caseContext(caseLines(cases.latest ?? [])),
    cases: () => cases.latest ?? [],
    tasks,
    setView: (getter) => setViewGetter(() => getter),
    view: () => viewGetter()?.() ?? "",
  }
  return <Ctx.Provider value={value}>{props.children}</Ctx.Provider>
}

export const useDeskChat = () => {
  const value = useContext(Ctx)
  if (!value) throw new Error("useDeskChat outside DeskChatProvider")
  return value
}

export const DeskStart = (props: { desk: ReturnType<typeof createDeskSession>; directory?: string }) =>
  <div class="desk-start">
    <Show when={props.desk.status() === "checking"}><p class="home-muted">Loading chat…</p></Show>
    <Show when={props.desk.status() === "unavailable"}><p class="home-warning">Could not load the chat. <button class="desk-button" onClick={() => void props.desk.verify()}>Check again</button></p></Show>
    {/* Confirm resends the identical create; Core returns the existing conversation if the first one landed. */}
    <Show when={props.desk.status() === "unconfirmed"}><p class="home-warning">Chat start not confirmed. <button class="desk-button" onClick={() => void props.desk.confirm()}>Confirm start</button></p></Show>
    <Show when={props.desk.status() === "missing"}><p class="home-warning">The saved chat no longer exists. <button class="desk-button" onClick={() => props.desk.forget()}>Clear</button></p></Show>
    <Show when={props.desk.status() === "none" || props.desk.status() === "creating"}>
      <button class="desk-button home-primary" disabled={!props.directory || props.desk.status() === "creating"} onClick={() => props.directory && void props.desk.start(props.directory)}>
        {props.desk.status() === "creating" ? "Starting…" : "Start chat"}</button>
      <p class="home-source">Read-only, in <bdi dir="ltr">{props.directory ?? "unknown"}</bdi></p>
    </Show>
  </div>

/** Mounted once in the shell, after the main content. */
export const DeskCompanion = () => {
  const chat = useDeskChat()
  const target = () => chat.desk.status() === "ready" ? chat.desk.pointer() : undefined
  let section: HTMLElement | undefined
  const narrow = media(NARROW)
  const floating = media(FLOATING)
  createEffect(() => { if (section) section.inert = !chat.open() })
  // Docked open: resizable from its inline-start edge, and the session info panel steps aside.
  const docked = () => chat.open() && !floating()
  createEffect(() => setCompanionDocked(docked()))
  onCleanup(() => setCompanionDocked(false))
  // Follow-ups to a running task need a Core that records them without answering them in the chat.
  const [supported] = createResource(() => target()?.directory, deskTasksSupported)
  const close = () => {
    const focused = !!section?.contains(document.activeElement)
    chat.setOpen(false)
    if (focused) queueMicrotask(() => document.querySelector<HTMLElement>("[data-nav=front-desk]")?.focus())
  }
  return <>
  <Show when={docked()}><ResizeHandle side="companion" /></Show>
  <aside ref={section} class="desk-companion" classList={{ closed: !chat.open(), sheet: narrow(), overlay: floating() && !narrow() }} aria-label="Front desk chat" aria-hidden={!chat.open()}
    style={{ "--companion-width": floating() ? undefined : `${companionWidth()}px` }}>
    <div class="desk-companion-in desk-chat">
      <Show when={chat.desk.error()}><div class="home-warning" role="alert">{chat.desk.error()}</div></Show>
      <Show when={target()}>{(current) => <DeskFollowUps session={current().session} open={chat.open} />}</Show>
      <Show when={target()}>{(current) => <DeskTasks tasks={chat.tasks} session={current().session} directory={current().directory} followUps={supported() === true} />}</Show>
      <Show when={target()} keyed fallback={<DeskStart desk={chat.desk} directory={chat.directory()} />}>
        {(current) => <SessionView sessionID={current.session} directory={current.directory} embedded context={chat.context} onSent={chat.desk.sent}
          headerStart={<button class="header-icon desk-chat-hide" aria-label="Close Front desk chat" title="Close Front desk chat" onClick={close}>
            <Icon name="chevron-down" size="small" /></button>} />}
      </Show>
    </div>
  </aside>
  </>
}

// Background tasks that already exist (started by an earlier build, another client or the dashboard). The chat
// has one Send; nothing here starts a task. Rows show each task's state, its thread, a confirm for a start whose
// answer was lost, and an explicit follow-up for a running task. Results reach the asking conversation once.
const DeskTasks = (props: { tasks: ReturnType<typeof createTasks>; session: string; directory: string; followUps: boolean }) => {
  const composer = () => getComposer(props.session, props.directory)
  const [notice, setNotice] = createSignal("")
  // Task track only (sending, registered, working, outcome); the question itself is a chat message with its own state.
  const label = (job: TaskJob) => job.state.state === "ready"
    ? props.tasks.outcome(job.id) ? "outcome · result added to the chat" : "finished · adding the result to the chat"
    // "sending" until Core has the task; "registered" only once its session exists durably and the model has not started.
    : ({ starting: "sending", unconfirmed: "start not confirmed", delegated: "registered", running: "working", failed: "failed", unknown: "stopped" } as const)[job.state.state]
  const follow = async (job: TaskJob) => {
    const result = await props.tasks.amend(job, composer().state.task.text)
    if ("error" in result) return setNotice(result.error ?? "")
    composer().setText("")
    setNotice("")
  }
  return <Show when={props.tasks.jobs().length}><div class="desk-tasks" aria-label="Background tasks">
    <Show when={props.tasks.jobs().some(job => job.state.state === "unconfirmed")}><button type="button" class="desk-button" onClick={() => void props.tasks.confirm()}>Confirm task start</button></Show>
    <Show when={notice() || props.tasks.error()}><span class="home-muted" role="status">{notice() || props.tasks.error()}</span></Show>
    <ul><For each={props.tasks.jobs().slice(0, 5)}>{job => <li class="desk-task home-source" data-state={job.state.state}>
      <span>Background · <bdi dir="auto">{job.meta.question.slice(0, 80)}</bdi> · {ago(job.meta.asked)} · {label(job)}<Show when={job.meta.initiatingSession !== props.session}> · asked in an earlier conversation</Show></span>
      <Show when={!job.id.startsWith("local:") && job.state.state !== "starting" && job.state.state !== "unconfirmed"}> <A href={sessionHref(job.id, job.directory)}>Task thread</A></Show>
      {/* Adds what is typed to this running task; it reaches the task at its next safe step. Needs a Core that records
        * the follow-up in the chat without answering it there. */}
      <Show when={props.followUps && (job.state.state === "running" || job.state.state === "delegated")}> <button type="button" class="desk-link-button" title="Send what you typed to this task as a follow-up" onClick={() => void follow(job)}>Add to this task</button></Show>
    </li>}</For></ul>
  </div></Show>
}

// What the desk is waiting on: questions this conversation asked owners by mail, with delivery and the owner's
// answer, read from each project's mail timeline. Display only; the desk itself follows up when an answer wakes it.
const DeskFollowUps = (props: { session: string; open: () => boolean }) => {
  const dashboard = useDashboard()
  const [tick, setTick] = createSignal(0)
  const [expanded, setExpanded] = createSignal(false)
  // Mail events refresh the strip; the 30 s fallback runs only while the chat is open.
  createEffect(() => {
    if (!props.open()) return
    const timer = setInterval(() => setTick(value => value + 1), 30_000)
    onCleanup(() => clearInterval(timer))
  })
  const [items] = createResource(() => ({ session: props.session, names: dashboard.editspaces()?.editspaces.map(item => item.name) ?? [], tick: tick(), mail: dashboard.mailRevision() }),
    async input => (await Promise.all(input.names.map(name => es.mail(name, { session: input.session }).then(timeline => followUps(timeline, input.session), () => [] as FollowUp[])))).flat())
  const chat = useDeskChat()
  const rows = () => progressRows(chat.cases(), items.latest ?? [])
  const count = (group: ProgressRow["group"]) => rows().filter(row => row.group === group).length
  const completed = () => rows().filter(row => row.group === "result")
  // Folded: one summary line plus whatever needs the human. The conversation keeps the space.
  const shown = () => rows().filter(row => row.group === "needs" || expanded() && row.group !== "result")
  const summary = () => [count("needs") && `${count("needs")} need you`, count("progress") && `${count("progress")} in progress`,
    count("unknown") && `${count("unknown")} in an unknown state`, count("result") && `${count("result")} done`].filter(Boolean).join(" · ")
  return <Show when={rows().length}><section class="desk-progress" aria-label="Desk progress" data-expanded={expanded() ? "" : undefined}>
    <button type="button" class="desk-progress-summary" aria-expanded={expanded()} onClick={() => setExpanded(!expanded())}>
      <span class="ds-status-glyph" aria-hidden="true">{count("needs") ? "!" : count("progress") || count("unknown") ? "…" : "✓"}</span><span>{summary()}</span>
    </button>
    <Show when={shown().length || expanded() && completed().length}><div class="desk-progress-body">
      <Show when={shown().length}><ul class="desk-progress-rows"><For each={shown()}>{row => <ProgressItem row={row} />}</For></ul></Show>
      {/* Every result stays reachable here, newest first; closed until asked for. */}
      <Show when={expanded() && completed().length}><details class="desk-progress-completed">
        <summary>Completed ({completed().length})</summary>
        <ul class="desk-progress-rows"><For each={completed()}>{row => <ProgressItem row={row} />}</For></ul>
      </details></Show>
    </div></Show>
  </section></Show>
}

const ProgressItem = (props: { row: ProgressRow }) =>
  <li class="desk-progress-row" data-group={props.row.group}>
    <span class="desk-progress-line">
      <Show when={props.row.link} fallback={<bdi dir="auto" class="desk-progress-label">{props.row.label}</bdi>}>{link =>
        <a class="desk-progress-label" href={link().href} target="_blank" rel="noopener noreferrer"><bdi dir="auto">{props.row.label}</bdi></a>}</Show>
      <span class="desk-progress-status" dir="auto">{props.row.status} · {props.row.at ? ago(props.row.at) : "age unknown"}</span>
    </span>
    {/* Owners, sessions and mail ids are for tracing, one tap away. */}
    <details class="desk-progress-detail"><summary aria-label={`Details for ${props.row.label}`}>Details</summary>
      <Show when={props.row.context}><p dir="auto">{props.row.context}</p></Show>
      <p><For each={props.row.detail}>{(line, index) => <>{index() ? " · " : ""}<bdi dir="ltr">{line}</bdi></>}</For></p></details>
  </li>
