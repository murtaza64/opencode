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
import type { ContextPart } from "./api"
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
    context: () => contextGetter()?.() ?? [],
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
  // Background tasks appear only against a Core that records the question without answering it.
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
      <Show when={supported() ? target() : undefined}>{(current) => <DeskTasks tasks={chat.tasks} view={chat.view} session={current().session} directory={current().directory} />}</Show>
      <Show when={target()} keyed fallback={<DeskStart desk={chat.desk} directory={chat.directory()} />}>
        {(current) => <SessionView sessionID={current.session} directory={current.directory} embedded context={chat.context} onSent={chat.desk.sent}
          headerStart={<button class="header-icon desk-chat-hide" aria-label="Close Front desk chat" title="Close Front desk chat" onClick={close}>
            <Icon name="chevron-down" size="small" /></button>} />}
      </Show>
    </div>
  </aside>
  </>
}

// Background tasks started from the chat: "Ask in background" takes what is typed in the composer, shows a
// receipt at once and leaves the chat free; each finished result is added to the asking conversation once.
const DeskTasks = (props: { tasks: ReturnType<typeof createTasks>; view: () => string; session: string; directory: string }) => {
  const composer = () => getComposer(props.session, props.directory)
  const [notice, setNotice] = createSignal("")
  const ask = async (again?: string) => {
    const asked = Date.now()
    const text = again ?? composer().state.task.text
    if (!text.trim()) return setNotice("Type a question in the chat box first.")
    const started = await props.tasks.start(text, props.view())
    if ("error" in started) return setNotice(started.error ?? "")
    if (again === undefined) composer().setText("")
    setNotice("")
    requestAnimationFrame(() => props.tasks.rendered(started.id!, asked, started.packetBytes!))
  }
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
  return <div class="desk-tasks" aria-label="Background tasks">
    <button type="button" class="desk-button" title="Run what you typed as a background check; keep chatting meanwhile" onClick={() => void ask()}>Ask in background</button>
    <Show when={props.tasks.jobs().some(job => job.state.state === "unconfirmed")}><button type="button" class="desk-button" onClick={() => void props.tasks.confirm()}>Confirm task start</button></Show>
    <Show when={notice() || props.tasks.error()}><span class="home-muted" role="status">{notice() || props.tasks.error()}</span></Show>
    <ul><For each={props.tasks.jobs().slice(0, 5)}>{job => <li class="desk-task home-source" data-state={job.state.state}>
      <span>Background · <bdi dir="auto">{job.meta.question.slice(0, 80)}</bdi> · {ago(job.meta.asked)} · {label(job)}<Show when={job.meta.initiatingSession !== props.session}> · asked in an earlier conversation</Show></span>
      <Show when={!job.id.startsWith("local:") && job.state.state !== "starting" && job.state.state !== "unconfirmed"}> <A href={sessionHref(job.id, job.directory)}>Task thread</A></Show>
      {/* Adds what is typed to this running task; it reaches the task at its next safe step. */}
      <Show when={job.state.state === "running" || job.state.state === "delegated"}> <button type="button" class="desk-link-button" title="Send what you typed to this task as a follow-up" onClick={() => void follow(job)}>Add to this task</button></Show>
      {/* A stopped or failed task is never rerun on its own; asking again starts a new task. */}
      <Show when={job.state.state === "failed" || job.state.state === "unknown"}> <button type="button" class="desk-link-button" onClick={() => void ask(job.meta.question)}>Ask again</button></Show>
    </li>}</For></ul>
  </div>
}
