/* New session: a compact popover anchored to its sidebar button, so opening it
 * never displaces session rows. Project view preselects the current project;
 * All requires an explicit choice. Only a confirmed create response navigates. */
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js"
import { useNavigate } from "@solidjs/router"
import { oc, SessionCreateError } from "../api"
import { sessionHref, useDashboard } from "../state"

const projectDirectory = (root: string) => root.replace(/\/+$/, "").replace(/\/\.editspace$/, "")
// "lanes/<lane>/repos/<owner>/<repo>" reads as "<lane> · <repo>"; anything else by its basename
const workspaceLabel = (directory: string) => {
  const lane = /\/lanes\/([^/]+)(?:\/(.*))?$/.exec(directory)
  if (!lane) return directory.split("/").filter(Boolean).at(-1) ?? directory
  const tail = lane[2]?.split("/").filter(Boolean).at(-1)
  return tail && tail !== lane[1] ? `${lane[1]} · ${tail}` : lane[1]
}

export const NewSession = (props: { compact?: boolean }) => {
  const dashboard = useDashboard()
  const navigate = useNavigate()
  const [open, setOpen] = createSignal(false)
  const [project, setProject] = createSignal("")
  const [directory, setDirectory] = createSignal("")
  const [pending, setPending] = createSignal(false)
  const [error, setError] = createSignal("")
  const [anchor, setAnchor] = createSignal({ top: 0, start: 0 })
  let button: HTMLButtonElement | undefined
  let form: HTMLFormElement | undefined
  const projects = () => dashboard.editspaces()?.editspaces ?? []
  const current = () => dashboard.editspace() ?? dashboard.editspaces()?.default ?? dashboard.state()?.editspace ?? ""
  const selected = createMemo(() => projects().find((item) => item.name === project()))
  const directories = createMemo(() => {
    const item = selected()
    if (!item) return []
    const root = projectDirectory(item.root)
    return [root, ...dashboard.sessionRows()
      .filter((session) => (dashboard.allProjects() ? session.project === item.name : item.name === current()) &&
        session.directory.startsWith(`${item.root.replace(/\/+$/, "")}/lanes/`))
      .map((session) => session.directory)]
      .filter((value, index, values) => !!value && values.indexOf(value) === index)
  })
  // fixed positioning escapes the scrolling sidebar: below the expanded button, beside the mini
  // rail; clamped inside the viewport for 390px and RTL
  const place = () => {
    if (!button) return
    const rect = button.getBoundingClientRect()
    const rtl = getComputedStyle(button).direction === "rtl"
    const width = Math.min(320, window.innerWidth - 16)
    const beside = props.compact && window.innerWidth > 600 // the mini rail runs horizontally on phones
    const start = Math.max(8, Math.min(beside ? (rtl ? window.innerWidth - rect.left : rect.right) + 4 : rtl ? window.innerWidth - rect.right : rect.left,
      window.innerWidth - width - 8))
    // the button sits atop the sidebar, so only a very short viewport needs the form pulled up
    setAnchor({ top: Math.max(8, Math.min(beside ? rect.top : rect.bottom + 4, window.innerHeight - 190)), start })
  }
  const show = () => {
    const initial = dashboard.allProjects() ? "" : current()
    const item = projects().find((entry) => entry.name === initial)
    setProject(initial)
    setDirectory(item ? projectDirectory(item.root) : "")
    setError("")
    place()
    setOpen(true)
    queueMicrotask(() => form?.querySelector<HTMLElement>("select:not([disabled]), button[type=submit]")?.focus())
  }
  const close = (restoreFocus: boolean) => {
    setOpen(false)
    if (restoreFocus) button?.focus()
  }
  createEffect(() => {
    if (!open()) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return
      event.preventDefault()
      close(true)
    }
    // outside clicks dismiss; a pending create stays visible until it settles
    const onPointer = (event: PointerEvent) => {
      if (pending() || form?.contains(event.target as Node) || button?.contains(event.target as Node)) return
      close(false)
    }
    document.addEventListener("keydown", onKey)
    document.addEventListener("pointerdown", onPointer)
    window.addEventListener("resize", place)
    document.addEventListener("scroll", place, true)
    onCleanup(() => {
      document.removeEventListener("keydown", onKey)
      document.removeEventListener("pointerdown", onPointer)
      window.removeEventListener("resize", place)
      document.removeEventListener("scroll", place, true)
    })
  })
  const chooseProject = (name: string) => {
    setProject(name)
    const item = projects().find((entry) => entry.name === name)
    setDirectory(item ? projectDirectory(item.root) : "")
    setError("")
  }
  const create = async () => {
    if (pending() || !selected() || !directory()) return
    setPending(true)
    setError("")
    try {
      const session = await oc.createSession(directory())
      sessionStorage.setItem("es-app-focus-session", session.id)
      setOpen(false)
      navigate(sessionHref(session.id, directory()))
    } catch (cause) {
      setError(cause instanceof SessionCreateError ? cause.message : "The server response was lost. A session may have been created; check the session list before trying again.")
    } finally {
      setPending(false)
    }
  }
  return <div class="new-session" classList={{ "new-session-compact": props.compact }}>
    <button ref={button} class={props.compact ? "mini-item new-session-button" : "new-session-button"}
      title="New session" aria-label="New session" aria-haspopup="dialog" aria-expanded={open()}
      onClick={() => open() ? close(false) : show()}>
      <span aria-hidden="true">＋</span><Show when={!props.compact}><span>New session</span></Show>
    </button>
    <Show when={open()}>
      <form ref={form} class="new-session-form" role="dialog" aria-label="New session"
        style={{ top: `${anchor().top}px`, "inset-inline-start": `${anchor().start}px` }}
        onSubmit={(event) => { event.preventDefault(); void create() }}>
        <label class="new-session-field">
          <span>Project</span>
          <select aria-label="New session project" value={project()} onChange={(event) => chooseProject(event.currentTarget.value)} disabled={pending()}>
            <option value="" disabled>Choose…</option>
            <For each={projects()}>{(item) => <option value={item.name}>{item.name}</option>}</For>
          </select>
        </label>
        <Show when={selected()}>
          <label class="new-session-field">
            <span>Workspace</span>
            <select aria-label="New session workspace" value={directory()} onChange={(event) => setDirectory(event.currentTarget.value)}
              disabled={pending() || directories().length < 2}>
              <For each={directories()}>{(value, index) => <option value={value}>{index() === 0 ? "project root" : workspaceLabel(value)}</option>}</For>
            </select>
          </label>
          <div class="new-session-directory"><bdi dir="ltr">{directory()}</bdi></div>
          <div class="new-session-actions">
            <button type="submit" class="new-session-create" aria-label={pending() ? "Creating…" : "Create session"} disabled={pending() || !directory()}>
              {pending() ? "Creating…" : "Create"}
            </button>
            <span class="dim">esc closes</span>
          </div>
        </Show>
        <Show when={error()}><div class="err" role="alert">{error()}</div></Show>
      </form>
    </Show>
  </div>
}
