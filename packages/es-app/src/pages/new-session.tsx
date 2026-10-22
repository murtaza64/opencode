/* Draft-first New session (dotfiles#240): the page opens ready to type with
 * remembered defaults, and nothing exists on the server until the first Send.
 * Send creates the session with the chosen agent and model, then hands the
 * text to that session's own composer, which owns sending, the pending echo
 * and unknown-outcome reconciliation. Only a confirmed create navigates. */
import { createEffect, createMemo, createResource, createSignal, For, Show } from "solid-js"
import { useNavigate } from "@solidjs/router"
import { oc, SessionCreateError } from "../api"
import { sessionHref, useDashboard } from "../state"
import { AppHeader } from "../components/native-header"
import { firstSendKey } from "../first-send"
import "./new-session.css"

const DRAFT = "es-app:new-session:draft:1"
const LAST = "es-app:new-session:last:1"
type Draft = { project: string; directory: string; agent: string; model: string; text: string }

const projectDirectory = (root: string) => root.replace(/\/+$/, "").replace(/\/\.editspace$/, "")
// "lanes/<lane>/repos/<owner>/<repo>" reads as "<lane> · <repo>"; anything else by its basename
const workspaceLabel = (directory: string) => {
  const lane = /\/lanes\/([^/]+)(?:\/(.*))?$/.exec(directory)
  if (!lane) return directory.split("/").filter(Boolean).at(-1) ?? directory
  const tail = lane[2]?.split("/").filter(Boolean).at(-1)
  return tail && tail !== lane[1] ? `${lane[1]} · ${tail}` : lane[1]
}
const read = <T,>(storage: Storage, key: string): Partial<T> => {
  try { return JSON.parse(storage.getItem(key) ?? "{}") ?? {} } catch { return {} }
}

export default function NewSessionPage() {
  const dashboard = useDashboard()
  const navigate = useNavigate()
  const saved = read<Draft>(sessionStorage, DRAFT)
  const last = read<{ project: string; model: string; agent: string }>(localStorage, LAST)
  const projects = () => dashboard.editspaces()?.editspaces ?? []
  const current = () => dashboard.allProjects() ? last.project : dashboard.editspace() ?? dashboard.editspaces()?.default ?? undefined
  const [project, setProject] = createSignal(saved.project ?? "")
  const [directory, setDirectory] = createSignal(saved.directory ?? "")
  const [agent, setAgent] = createSignal(saved.agent ?? last.agent ?? "")
  const [model, setModel] = createSignal(saved.model ?? last.model ?? "")
  const [text, setText] = createSignal(saved.text ?? "")
  const [pending, setPending] = createSignal(false)
  const [error, setError] = createSignal("")
  // A lost create response may have made a session; another Send waits for an explicit recheck.
  const [uncertain, setUncertain] = createSignal(false)
  let editor: HTMLTextAreaElement | undefined

  const selected = createMemo(() => projects().find((item) => item.name === project()))
  // Project defaults once the project list loads: the current project, else the last one used here.
  createEffect(() => {
    if (project() || !projects().length) return
    const initial = projects().find((item) => item.name === current()) ?? projects().find((item) => item.name === dashboard.editspaces()?.default) ?? projects()[0]
    if (initial) chooseProject(initial.name)
  })
  const directories = createMemo(() => {
    const item = selected()
    if (!item) return []
    const root = projectDirectory(item.root)
    return [root, ...dashboard.sessionRows()
      .filter((session) => session.directory.startsWith(`${item.root.replace(/\/+$/, "")}/lanes/`))
      .map((session) => session.directory)]
      .filter((value, index, values) => !!value && values.indexOf(value) === index)
  })
  const [agents] = createResource(directory, (dir) => oc.agents(dir).catch(() => []))
  const [providers] = createResource(directory, (dir) => oc.providers(dir).catch(() => ({ providers: [], default: {} })))
  const primaryAgents = () => (agents() ?? []).filter((item) => item.mode !== "subagent" && !item.hidden)
  // A remembered model that this directory does not offer falls back to the server default.
  const modelValue = () => {
    const value = model()
    const [providerID, modelID] = value.split("\u0000")
    return providers()?.providers.some((item) => item.id === providerID && item.models?.[modelID!]) ? value : ""
  }

  const chooseProject = (name: string) => {
    setProject(name)
    const item = projects().find((entry) => entry.name === name)
    setDirectory(item ? projectDirectory(item.root) : "")
    setUncertain(false)
    setError("")
  }
  createEffect(() => sessionStorage.setItem(DRAFT, JSON.stringify({ project: project(), directory: directory(), agent: agent(), model: model(), text: text() })))
  queueMicrotask(() => editor?.focus())

  const send = async () => {
    const body = text()
    if (pending() || uncertain() || !directory() || !body.trim()) return
    setPending(true)
    setError("")
    const [providerID, modelID] = modelValue().split("\u0000")
    try {
      const session = await oc.createSession(directory(), { agent: agent() || undefined, model: providerID && modelID ? { providerID, modelID } : undefined })
      localStorage.setItem(LAST, JSON.stringify({ project: project(), model: model(), agent: agent() }))
      // The session page sends this once, through its own composer.
      sessionStorage.setItem(firstSendKey, JSON.stringify({ sessionID: session.id, text: body }))
      sessionStorage.setItem("es-app-focus-session", session.id)
      sessionStorage.removeItem(DRAFT)
      navigate(sessionHref(session.id, directory()), { replace: true })
    } catch (cause) {
      const lost = !(cause instanceof SessionCreateError) || cause.uncertain
      setUncertain(lost)
      setError(cause instanceof SessionCreateError ? cause.message : "The server response was lost. A session may have been created; check the session list before trying again.")
    } finally {
      setPending(false)
    }
  }

  return <main class="session-page new-session-page">
    <div class="session-main">
      <AppHeader><h1>New session</h1></AppHeader>
      <div class="new-session-space" />
      <form class="prompt-box new-session-draft" onSubmit={(event) => { event.preventDefault(); void send() }}>
        <div class="new-session-settings" role="group" aria-label="New session settings">
          <select aria-label="Project" value={project()} disabled={pending()} onChange={(event) => chooseProject(event.currentTarget.value)}>
            <Show when={!project()}><option value="" disabled>Project…</option></Show>
            <For each={projects()}>{(item) => <option value={item.name} selected={item.name === project()}>{item.name}</option>}</For>
          </select>
          <select aria-label="Workspace" value={directory()} disabled={pending() || directories().length < 2} title={directory()}
            onChange={(event) => { setDirectory(event.currentTarget.value); setUncertain(false) }}>
            <For each={directories()}>{(value, index) => <option value={value} selected={value === directory()}>{index() === 0 ? "project root" : workspaceLabel(value)}</option>}</For>
          </select>
          <select aria-label="Agent" value={agent()} disabled={pending()} onChange={(event) => setAgent(event.currentTarget.value)}>
            <option value="" selected={!agent()}>default agent</option>
            <For each={primaryAgents()}>{(item) => <option value={item.name} selected={item.name === agent()}>{item.name}</option>}</For>
          </select>
          <select aria-label="Model" value={modelValue()} disabled={pending()} onChange={(event) => setModel(event.currentTarget.value)}>
            <option value="" selected={!modelValue()}>default model</option>
            <For each={providers()?.providers ?? []}>{(provider) => <optgroup label={provider.id}>
              <For each={Object.keys(provider.models ?? {})}>{(id) => <option value={`${provider.id}\u0000${id}`} selected={modelValue() === `${provider.id}\u0000${id}`}>{id}</option>}</For>
            </optgroup>}</For>
          </select>
        </div>
        <textarea ref={editor} aria-label="Message" dir="auto" placeholder="What should this session do?" value={text()} disabled={pending()}
          onInput={(event) => setText(event.currentTarget.value)}
          onKeyDown={(event) => { if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !event.isComposing) { event.preventDefault(); void send() } }} />
        <div class="new-session-submit">
          <Show when={error()}><span class="err" role="alert">{error()}</span></Show>
          <Show when={uncertain()}><button type="button" onClick={() => { setUncertain(false); setError("") }}>I checked the session list</button></Show>
          <button type="submit" class="primary" disabled={pending() || uncertain() || !directory() || !text().trim()}>
            {pending() ? "Creating…" : "Send"} <kbd aria-hidden="true">⌘/Ctrl↵</kbd>
          </button>
        </div>
      </form>
    </div>
  </main>
}
