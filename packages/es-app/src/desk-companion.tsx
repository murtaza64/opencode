/* The Front desk chat as a companion pane beside any main view (persistent-nav layout, dotfiles#240).
 * One desk session for the whole app, mounted once: closing the pane hides it without unmounting, so
 * the draft, caret, scroll position, pending sends and a dictation target survive. Whether it is open
 * is remembered separately beside work views (Decisions, map, surfaces) and beside a transcript. */
import { createContext, createEffect, createSignal, Show, useContext, type Accessor, type ParentProps } from "solid-js"
import { useLocation } from "@solidjs/router"
import { Icon } from "@opencode-ai/ui/icon"
import { useDashboard } from "./state"
import { createDeskSession } from "./desk-session"
import type { ContextPart } from "./api"
import { SessionView } from "./pages/session"

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
  const close = () => {
    const focused = !!section?.contains(document.activeElement)
    chat.setOpen(false)
    if (focused) queueMicrotask(() => document.querySelector<HTMLElement>("[data-nav=front-desk]")?.focus())
  }
  return <aside ref={section} class="desk-companion" classList={{ closed: !chat.open(), sheet: narrow(), overlay: floating() && !narrow() }} aria-label="Front desk chat" aria-hidden={!chat.open()}>
    <div class="desk-companion-in desk-chat">
      <Show when={chat.desk.error()}><div class="home-warning" role="alert">{chat.desk.error()}</div></Show>
      <Show when={target()} keyed fallback={<DeskStart desk={chat.desk} directory={chat.directory()} />}>
        {(current) => <SessionView sessionID={current.session} directory={current.directory} embedded context={chat.context} onSent={chat.desk.sent}
          headerStart={<button class="header-icon desk-chat-hide" aria-label="Close Front desk chat" title="Close Front desk chat" onClick={close}>
            <Icon name="chevron-down" size="small" /></button>} />}
      </Show>
    </div>
  </aside>
}
