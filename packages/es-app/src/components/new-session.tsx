import { createMemo, createSignal, For, Show } from "solid-js"
import { useNavigate } from "@solidjs/router"
import { oc, SessionCreateError } from "../api"
import { sessionHref, useDashboard } from "../state"

const projectDirectory = (root: string) => root.replace(/\/+$/, "").replace(/\/\.editspace$/, "")

export const NewSession = (props: { compact?: boolean }) => {
  const dashboard = useDashboard()
  const navigate = useNavigate()
  const [open, setOpen] = createSignal(false)
  const [project, setProject] = createSignal("")
  const [directory, setDirectory] = createSignal("")
  const [pending, setPending] = createSignal(false)
  const [error, setError] = createSignal("")
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
  const show = () => {
    const initial = dashboard.allProjects() ? "" : current()
    const item = projects().find((entry) => entry.name === initial)
    setProject(initial)
    setDirectory(item ? projectDirectory(item.root) : "")
    setError("")
    setOpen(true)
  }
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
  return <div class="new-session">
    <button class={props.compact ? "mini-item new-session-button" : "nav-item new-session-button"}
      title="New session" aria-label="New session" aria-expanded={open()} onClick={() => open() ? setOpen(false) : show()}>
      <span aria-hidden="true">＋</span><Show when={!props.compact}> <span>New session</span></Show>
    </button>
    <Show when={open()}>
      <form class="new-session-form" onSubmit={(event) => { event.preventDefault(); void create() }}>
        <label>Project
          <select aria-label="New session project" value={project()} onChange={(event) => chooseProject(event.currentTarget.value)} disabled={pending()}>
            <option value="" disabled>Select a project</option>
            <For each={projects()}>{(item) => <option value={item.name}>{item.name}</option>}</For>
          </select>
        </label>
        <Show when={selected()}>
          <label>Workspace
            <select aria-label="New session workspace" value={directory()} onChange={(event) => setDirectory(event.currentTarget.value)} disabled={pending()}>
              <For each={directories()}>{(value, index) => <option value={value}>{index() === 0 ? "Project" : value.split("/").filter(Boolean).at(-1)}</option>}</For>
            </select>
          </label>
          <div class="new-session-directory"><span>Directory</span><bdi dir="ltr">{directory()}</bdi></div>
          <button type="submit" disabled={pending() || !directory()}>{pending() ? "Creating…" : "Create session"}</button>
        </Show>
        <Show when={error()}><div class="err" role="alert">{error()}</div></Show>
      </form>
    </Show>
  </div>
}
