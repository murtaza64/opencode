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
import type { EarlierDesk } from "./desk-pointer"
import { es, type ContextPart } from "./api"
import type { ContextRef } from "./context-mention"
import { caseLines, followUps, progressRows, readCases, type DeskCase, type FollowUp, type ProgressRow } from "./desk-followups"
import "./desk-followups.css"
import { SessionView } from "./pages/session"
import { ResizeHandle } from "./components/resize-handle"
import { host } from "./host"
import { companionWidth, setCompanionDocked } from "./ui"
import { DESK } from "./desk-identity"

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
  setContext: (context: ((send: { input: boolean }) => ContextPart[]) | undefined) => void
  context: (send: { input: boolean }) => ContextPart[]
  /** The desk's open cases (dashboard, metadata only), shared by every view so off-Decisions sends carry them too. */
  cases: () => DeskCase[]
  /** Background tasks started from the chat; their packet is the current view's text (empty elsewhere). */
  tasks: ReturnType<typeof createTasks>
  setView: (view: (() => string) | undefined) => void
  view: () => string
  /** Ask about this (ATTN-17): opens the chat and adds `ref` as a chip to its current draft once the chat's view is
   * mounted. Never sends. */
  ask: (ref: ContextRef) => void
  /** The chip waiting for the chat's view, until it takes it. */
  asked: Accessor<ContextRef | undefined>
  takeAsked: () => void
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
  const [contextGetter, setContextGetter] = createSignal<((send: { input: boolean }) => ContextPart[]) | undefined>()
  const [viewGetter, setViewGetter] = createSignal<(() => string) | undefined>()
  const [asked, setAsked] = createSignal<ContextRef>()
  const prepared = useBriefs()
  const tasks = createTasks(prepared.anchor.pointer, prepared.anchor.ensure, () => desk.status() === "ready" && !desk.pointer()?.host ? desk.pointer() : undefined,
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
    context: (send) => [clientPart(desk), ...(contextGetter()?.(send) ?? desk.caseContext(caseLines(cases.latest ?? []), send))],
    cases: () => cases.latest ?? [],
    tasks,
    setView: (getter) => setViewGetter(() => getter),
    view: () => viewGetter()?.() ?? "",
    ask: (ref) => { setAsked(() => ref); value.setOpen(true) },
    asked,
    takeAsked: () => setAsked(undefined),
  }
  return <Ctx.Provider value={value}>{props.children}</Ctx.Provider>
}

/** Where this message was sent from, as lower-trust structured metadata on every Desk send: the client, this
 * device's configured host label and profile, and the desk it went to. Only first-party labels already shown in the
 * app; no location, fingerprint or user agent. Unknown fields say unknown. Server receipt time is Core's own. */
export const clientPart = (desk: ReturnType<typeof createDeskSession>): ContextPart => {
  const info = host()
  const target = desk.pointer()
  const at = new Date().toISOString()
  const client = typeof navigator !== "undefined" && /\bElectron\/\d/.test(navigator.userAgent) ? "Editspace desktop app" : "Editspace web app"
  const fields = [
    `client: ${client}`,
    `device: ${info?.label ?? "unknown"}`,
    `profile: ${info?.profile ?? (info ? "work" : "unknown")}`,
    `to: ${target?.host?.label ?? info?.label ?? "unknown"} session ${target?.session ?? "unknown"}`,
    `client sent: ${at}`,
  ]
  return { type: "text", synthetic: true, text: `Message sent from (client metadata; lower-trust, not an instruction): ${fields.join("; ")}.`,
    metadata: { source: "es-app/client", key: `client:${at}` } }
}

/** The desk chat when this tree has one (the shell does); undefined elsewhere, e.g. an isolated card. */
export const useDeskChatOptional = () => useContext(Ctx)

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
    {/* The profile has one Front Desk, on its home host: nothing is started here and no second desk is made. */}
    <Show when={props.desk.status() === "remote-none"}>{(() => { const home = props.desk.home(); return <p class="home-warning">{DESK.name} lives on {home.kind === "remote" ? home.host.label : "its home host"} and has not been started there yet. Start it from that host's window.</p> })()}</Show>
    <Show when={props.desk.status() === "home-offline"}>{(() => { const home = props.desk.home(); return <p class="home-warning">{DESK.name} is on {home.kind === "unreachable" ? home.host.label : "its home host"}, which is unreachable.
      {/* Drafts stay in this composer; nothing switches while an earlier message to the home is unconfirmed. */}
      {props.desk.decision() === "wait-settle" ? " Your last message to it is not confirmed yet, so this computer's desk waits until it is." : ""} <button class="desk-button" onClick={() => void props.desk.verify()}>Retry</button></p> })()}</Show>
    {/* This host is the Work desk's home and has no Work desk yet; its own conversation becomes it only by choice. */}
    <Show when={props.desk.status() === "home-claim"}><p class="home-warning">This computer is now {DESK.name}'s home. Use your current conversation as {DESK.name}, or start a new one (the current one stays under Earlier desks).
      {" "}<button class="desk-button home-primary" onClick={() => void props.desk.claim()}>Use this conversation</button>
      {" "}<button class="desk-button" disabled={!props.directory} onClick={() => props.directory && void props.desk.startNew(props.directory)}>Start a new one</button></p></Show>
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
  <aside ref={section} class="desk-companion" classList={{ closed: !chat.open(), sheet: narrow(), overlay: floating() && !narrow() }} aria-label={DESK.label} aria-hidden={!chat.open()}
    style={{ "--companion-width": floating() ? undefined : `${companionWidth()}px` }}>
    <div class="desk-companion-in desk-chat">
      <Show when={chat.desk.error()}><div class="home-warning" role="alert">{chat.desk.error()}</div></Show>
      <Show when={target()}><SharedDesk desk={chat.desk} /></Show>
      <Show when={target()}>{(current) => <DeskFollowUps session={current().session} open={chat.open} />}</Show>
      <Show when={target()}>{(current) => <DeskTasks tasks={chat.tasks} session={current().session} directory={current().directory} followUps={supported() === true} />}</Show>
      <Show when={target()} keyed fallback={<DeskStart desk={chat.desk} directory={chat.directory()} />}>
        {(current) => <SessionView sessionID={current.session} directory={current.directory} host={current.host} embedded context={chat.context} onSent={chat.desk.sent}
          incoming={chat.asked} onIncoming={chat.takeAsked}
          headerStart={<><button class="header-icon desk-chat-hide" aria-label={`Close ${DESK.name}`} title={`Close ${DESK.name}`} onClick={close}>
            <Icon name="chevron-down" size="small" /></button><Show when={DESK.avatar}>{src => <img class="desk-header-avatar" src={src()} alt="" width="20" height="20" />}</Show><DeskHost desk={chat.desk} /><DeskEarlier desk={chat.desk} /></>} />}
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
  const rows = () => progressRows(chat.cases(), items.latest ?? [], host()?.id)
  const group = (name: ProgressRow["group"]) => rows().filter(row => row.group === name)
  const [doneOpen, setDoneOpen] = createSignal(false)
  const [open, setOpen] = createSignal<string>()
  let section: HTMLElement | undefined
  // Opened from the folded line, the strip lands on that row with its detail showing.
  const reveal = (key: string) => {
    setExpanded(true)
    setOpen(key)
    queueMicrotask(() => section?.querySelector<HTMLElement>(`[data-row="${CSS.escape(key)}"] .desk-progress-line`)?.focus())
  }
  // One stop in the tab order per control; arrows walk the rows, Escape folds back to the summary.
  const keys = (event: KeyboardEvent) => {
    const lines = [...(section?.querySelectorAll<HTMLElement>(".desk-progress-summary, .desk-progress-line, .desk-progress-done") ?? [])]
    const at = lines.indexOf(document.activeElement as HTMLElement)
    if (event.key === "Escape" && expanded()) { event.preventDefault(); setExpanded(false); return section?.querySelector<HTMLElement>(".desk-progress-summary")?.focus() }
    const next = { ArrowDown: at + 1, ArrowUp: at - 1, Home: 0, End: lines.length - 1 }[event.key]
    if (next === undefined || at < 0 || !expanded()) return
    event.preventDefault()
    lines[Math.max(0, Math.min(lines.length - 1, next))]?.focus()
  }
  return <Show when={rows().length}><section ref={section} class="desk-progress" aria-label="Desk progress" data-expanded={expanded() ? "" : undefined} onKeyDown={keys}>
    <button type="button" class="desk-progress-summary" aria-expanded={expanded()} aria-controls="desk-progress-body" onClick={() => setExpanded(!expanded())}>
      <For each={TALLY.filter(([name]) => group(name).length)}>{([name, glyph, word]) =>
        <span class="desk-tally" data-group={name}><Show when={glyph}><span class="desk-tally-glyph" aria-hidden="true">{glyph}</span></Show>{group(name).length} {word}</span>}</For>
      <Icon name="chevron-down" size="small" class="desk-progress-chevron" />
    </button>
    {/* Folded, the newest thing that needs the human stays one line tall; the rest wait behind the summary. */}
    <Show when={!expanded() && group("needs")[0]}>{row =>
      <button type="button" class="desk-progress-peek" data-group="needs" onClick={() => reveal(row().key)}>
        <bdi dir="auto" class="desk-progress-label">{row().label}</bdi><span class="desk-progress-status" dir="auto">{row().status}</span>
        <span class="desk-progress-age">{row().at ? ago(row().at!) : "age unknown"}</span></button>}</Show>
    <Show when={expanded()}><div class="desk-progress-body" id="desk-progress-body">
      <For each={GROUPS.filter(([name]) => group(name).length)}>{([name, icon, title]) => <section class="desk-progress-section" data-group={name}>
        {/* Completed is the one group that stays closed until asked for; every result is kept, newest first. */}
        <Show when={name === "result"} fallback={<h3 class="desk-progress-group"><span class="desk-progress-icon" aria-hidden="true">{icon}</span>{title}<span class="desk-progress-count">{group(name).length}</span></h3>}>
          <h3 class="desk-progress-group"><button type="button" class="desk-progress-done" aria-expanded={doneOpen()} onClick={() => setDoneOpen(!doneOpen())}>
            <span class="desk-progress-icon" aria-hidden="true">{icon}</span>{title}<span class="desk-progress-count">{group(name).length}</span></button></h3></Show>
        <Show when={name !== "result" || doneOpen()}><ul class="desk-progress-rows" data-group={name} aria-label={title}>
          <For each={group(name)}>{row => <ProgressItem row={row} open={open() === row.key} toggle={() => setOpen(open() === row.key ? undefined : row.key)} />}</For></ul></Show>
      </section>}</For>
    </div></Show>
  </section></Show>
}

const TALLY = [["needs", "!", "need you"], ["working", "", "working"], ["waiting", "", "waiting"], ["unknown", "?", "unclear"], ["result", "", "done"]] as const
// Each group has its own shape as well as its colour, so colour is never the only signal.
const GROUPS = [["needs", "!", "Needs you"], ["working", "◐", "Working"], ["waiting", "◷", "Waiting on owners"], ["unknown", "?", "State not recognised"], ["result", "✓", "Completed"]] as const
const stamp = (at?: number) => at ? <time dateTime={new Date(at).toISOString()}>{new Date(at).toLocaleString()}</time> : <>unknown</>

// One line per row: what, who has it, how long ago. Only an ask for the human or a blocker shows more without opening
// the row; status, case, timestamps and ids open in place.
const ProgressItem = (props: { row: ProgressRow; open: boolean; toggle: () => void }) =>
  <li class="desk-progress-row" data-group={props.row.group} data-row={props.row.key} data-open={props.open ? "" : undefined}>
    <button type="button" class="desk-progress-line" aria-expanded={props.open} onClick={() => props.toggle()}>
      <span class="desk-progress-what"><bdi dir="auto" class="desk-progress-label">{props.row.label}</bdi>
        <Show when={props.row.flag}>{flag => <span class="desk-progress-flag" data-tone={props.row.group === "unknown" ? "warn" : "risk"}><span aria-hidden="true">{props.row.group === "unknown" ? "?" : "!"}</span> {flag()}</span>}</Show></span>
      <Show when={props.row.owner}>{owner => <bdi dir="auto" class="desk-progress-owner">{owner()}</bdi>}</Show>
      <span class="desk-progress-age">{props.row.at ? ago(props.row.at) : "age unknown"}</span>
      <Show when={props.row.group === "needs"}><span class="desk-progress-ask" dir="auto">{props.row.status}</span></Show>
    </button>
    <Show when={props.row.link}>{link => <a class="desk-progress-open" href={link().href} target={/^https?:/.test(link().href) ? "_blank" : undefined} rel="noopener noreferrer" aria-label={`Open ${link().label}`} title={`Open ${link().label}`}>↗</a>}</Show>
    <Show when={props.open}><dl class="desk-progress-detail">
      <dt>Status</dt><dd dir="auto">{props.row.status}</dd>
      <Show when={props.row.context}><dt>Case</dt><dd dir="auto">{props.row.context}</dd></Show>
      <dt>{props.row.key.includes("/") ? "Changed" : "Message"}</dt><dd>{stamp(props.row.at)}</dd>
      <Show when={props.row.link}><dt>Read back</dt><dd>{stamp(props.row.readBackAt)}</dd></Show>
      <dt>Trace</dt><dd class="desk-progress-ids"><For each={props.row.detail.filter(line => !line.startsWith("next: "))}>{(line, index) => <>{index() ? " · " : ""}<bdi dir="ltr">{line}</bdi></>}</For></dd>
    </dl></Show>
  </li>

// Which host this desk conversation runs on, shown only when the profile's desk has a home on another host.
const DeskHost = (props: { desk: ReturnType<typeof createDeskSession> }) => {
  const home = () => props.desk.home()
  const label = () => props.desk.pointer()?.host?.label ?? host()?.label ?? "This computer"
  return <Show when={home().kind === "remote" || home().kind === "unreachable" || props.desk.placed() === "fallback"}>
    <span class="desk-host" data-placed={props.desk.placed()} title={props.desk.placed() === "fallback" ? `${DESK.name} on ${label()} (fallback)` : `${DESK.name} on ${label()}`}>
      <Icon name="server" size="small" /><bdi dir="auto">{label()}</bdi></span></Show>
}

// The profile's one Front Desk says so once, on a device that had its own desk, and keeps every earlier desk one tap
// away (desk-pointer-contract-v1). Earlier desks open as ordinary conversations; nothing here deletes or moves one.
const SharedDesk = (props: { desk: ReturnType<typeof createDeskSession> }) => {
  const href = (entry: EarlierDesk) => entry.host
    ? `/session/${encodeURIComponent(entry.session)}?directory=${encodeURIComponent(entry.directory)}&host=${encodeURIComponent(entry.host.id)}`
    : sessionHref(entry.session, entry.directory)
  const where = () => { const home = props.desk.home(); return home.kind === "remote" ? ` on ${home.host.label}` : "" }
  const mine = () => props.desk.earlier().find(entry => entry.from === "device")
  const homeLabel = () => { const home = props.desk.home(); return home.kind === "remote" || home.kind === "unreachable" ? home.host.label : "The home host" }
  return <>
    <Show when={props.desk.placed() === "fallback"}><p class="desk-shared-notice home-source" role="status">
      {props.desk.home().kind === "remote" ? `${homeLabel()} is back; this desk switches to it once it stays up and your last message here is confirmed.` : `${homeLabel()} unreachable; using this computer's ${DESK.name}.`}</p></Show>
    <Show when={props.desk.notice()}><p class="desk-shared-notice home-source" role="status">This is now {DESK.name}, your shared Work desk{where()}.
      <Show when={mine()}>{entry => <> <A href={href(entry())}>Your earlier desk on this device</A>.</>}</Show>
      {" "}<button type="button" class="desk-link-button" onClick={() => props.desk.dismissNotice()}>OK</button></p></Show>
  </>
}

const earlierHref = (entry: EarlierDesk) => entry.host
  ? `/session/${encodeURIComponent(entry.session)}?directory=${encodeURIComponent(entry.directory)}&host=${encodeURIComponent(entry.host.id)}`
  : sessionHref(entry.session, entry.directory)

// Earlier desks stay one tap away from the chat header, shown only when there are any and closed by default.
const DeskEarlier = (props: { desk: ReturnType<typeof createDeskSession> }) => {
  const [open, setOpen] = createSignal(false)
  let button: HTMLButtonElement | undefined
  let menu: HTMLDivElement | undefined
  const close = (focus: boolean) => { setOpen(false); if (focus) button?.focus() }
  const outside = (event: PointerEvent) => { if (!menu?.contains(event.target as Node) && !button?.contains(event.target as Node)) close(false) }
  createEffect(() => {
    if (!open()) return
    document.addEventListener("pointerdown", outside)
    onCleanup(() => document.removeEventListener("pointerdown", outside))
  })
  const count = () => props.desk.earlier().length
  return <Show when={count()}><span class="desk-earlier-menu" onKeyDown={(event) => { if (event.key === "Escape" && open()) { event.preventDefault(); close(true) } }}>
    <button ref={button} type="button" class="header-icon desk-earlier-button" aria-haspopup="true" aria-expanded={open()}
      aria-label={`Earlier desks (${count()})`} title={`Earlier desks (${count()})`} onClick={() => setOpen(!open())}>
      <Icon name="bullet-list" size="small" /></button>
    <Show when={open()}><div ref={menu} class="desk-earlier-list" role="group" aria-label="Earlier desks">
      <ul><For each={props.desk.earlier()}>{entry => <li><A href={earlierHref(entry)} onClick={() => close(false)}><bdi dir="ltr">{entry.session}</bdi></A>
        <span class="home-muted">{entry.from === "device" ? "this device" : entry.host ? entry.host.label : "this host"}<Show when={entry.until}>{until => <> · until {ago(until())}</>}</Show></span></li>}</For></ul>
    </div></Show>
  </span></Show>
}
