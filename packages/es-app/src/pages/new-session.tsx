/* Draft-first New session (dotfiles#240): the page opens ready to type with
 * remembered defaults, and nothing exists on the server until the first Send.
 * Send saves the exact create request (with a client-chosen session id) before
 * posting it, so a lost response survives reload and is reconciled by reading
 * that id, never by creating another session. A confirmed session gets the
 * text in its own durable composer draft, which submits it (recording the
 * submission before the request) before this page lets go of it; the composer
 * then owns the pending echo and unknown-outcome recovery. */
import { createEffect, createMemo, createResource, createSignal, For, Show } from "solid-js"
import { useLocation, useNavigate } from "@solidjs/router"
import { host, readHost } from "../host"
import { descending } from "@opencode-ai/schema/identifier"
import { oc, SessionCreateError, type SessionCreateBody } from "../api"
import { sendFirstMessage } from "../composer"
import { sessionHref, useDashboard } from "../state"
import { AppHeader } from "../components/native-header"
import type { Session } from "@opencode-ai/sdk/v2"
import { shortcutLabel } from "../shortcuts"
import "./new-session.css"

const DRAFT = "es-app:new-session:draft:1"
const LAST = "es-app:new-session:last:1"
// The exact request sent; identity and settings stay bound to it until it is confirmed.
// lost: a response was lost, so a request with this id may still land at any time.
// absent: the last read of the id found nothing yet (a late request can still create it).
type Attempt = { directory: string; body: SessionCreateBody & { id: string }; text: string; lost?: boolean; absent?: boolean }
type Draft = { project: string; directory: string; agent: string; model: string; text: string; attempt?: Attempt }

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
  // An unconfirmed create: saved before posting, cleared only by reading its exact id.
  const [attempt, setAttempt] = createSignal<Attempt | undefined>(saved.attempt)
  const locked = () => pending() || !!attempt()
  // A reserved attempt can only be sent again as the identical request, once its id is known absent.
  const retryable = () => !pending() && !!attempt()?.absent
  let editor: HTMLTextAreaElement | undefined

  // Where the session runs, visible before Send. New work defaults to the registry's default host
  // (the Mini); this host is an explicit choice (?host=). Another host's session is created on that
  // host's own page, so its draft, request and receipt stay there; an unavailable host is never
  // replaced by another.
  const route = useLocation()
  void readHost()
  const workHosts = () => host()?.work ?? []
  const destination = createMemo(() => {
    const hosts = workHosts()
    const asked = new URLSearchParams(route.search).get("host")
    if (attempt()) return host()?.id
    return hosts.find((item) => item.id === asked)?.id ?? hosts.find((item) => item.default)?.id ?? host()?.id
  })
  const here = () => workHosts().length < 2 || destination() === host()?.id
  const target = () => workHosts().find((item) => item.id === destination())
  const targetFeed = () => dashboard.work.feeds().find((feed) => feed.host.id === destination())
  const hostDown = (id?: string) => dashboard.work.feeds().find((feed) => feed.host.id === id)?.state().status === "unavailable"
  const targetDown = () => hostDown(destination())
  // The draft text goes with the hand-off (URL fragment: never sent to a server) and is cleared here,
  // so one prompt cannot be started on two hosts. That host's page creates the session itself.
  const handOff = () => {
    const item = target()
    if (!item || targetDown()) return
    const draft = text().trim() ? `#draft=${encodeURIComponent(text())}` : ""
    setText("")
    window.location.assign(`${item.origin}/new?host=${encodeURIComponent(item.id)}${draft}`)
  }
  // Receiving a hand-off: the text joins this host's draft, never replacing text already here.
  const incoming = new URLSearchParams(route.hash.replace(/^#/, "")).get("draft")
  if (incoming !== null && !attempt()) {
    setText((current) => current.trim() ? `${current}\n\n${incoming}` : incoming)
    navigate(`${route.pathname}${route.search}`, { replace: true })
  }

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
    setError("")
  }
  // Once handed to a session the draft belongs to it; nothing here may write it back.
  let handed = false
  const save = () => handed || sessionStorage.setItem(DRAFT, JSON.stringify({ project: project(), directory: directory(), agent: agent(), model: model(), text: text(), attempt: attempt() }))
  createEffect(save)
  queueMicrotask(() => editor?.focus())

  // Hands a confirmed session its first message, then lets go of the draft.
  const open = async (session: Session, value: Attempt) => {
    if (!(await sendFirstMessage(session, value.text))) {
      // The attempt stays, so Send stays locked and "Check again" retries this hand-off.
      setError("The session was created, but its draft could not be saved. Your text is kept; Check again to retry.")
      return
    }
    setAttempt(undefined)
    handed = true
    localStorage.setItem(LAST, JSON.stringify({ project: project(), model: model(), agent: agent() }))
    sessionStorage.setItem("es-app-focus-session", session.id)
    sessionStorage.removeItem(DRAFT)
    navigate(sessionHref(session.id, value.directory), { replace: true })
  }
  const post = async (value: Attempt) => {
    setPending(true)
    setError("")
    try {
      const session = await oc.createSession(value.directory, value.body)
      await open(session, value)
    } catch (cause) {
      const known = cause instanceof SessionCreateError && !cause.uncertain
      // A definite rejection frees the draft only if no earlier request with this id was lost;
      // otherwise the rejection may mean that request landed, so the id is read again.
      if (known && !value.lost) setAttempt(undefined)
      else if (known) queueMicrotask(() => void reconcile())
      else setAttempt({ ...value, lost: true, absent: false })
      setError(cause instanceof SessionCreateError ? cause.message : "The server response was lost. A session may have been created; check again before sending.")
    } finally {
      setPending(false)
      save()
    }
  }
  const send = async () => {
    const reserved = attempt()
    // Sending again after a lost response repeats the exact request, same id and settings.
    if (reserved) return retryable() ? post({ ...reserved, absent: false }) : undefined
    const body = text()
    if (locked() || !directory() || !body.trim()) return
    const [providerID, modelID] = modelValue().split("\u0000")
    const value: Attempt = {
      directory: directory(),
      text: body,
      body: { id: `ses_${descending()}`, ...(agent() ? { agent: agent() } : {}), ...(providerID && modelID ? { model: { providerID, id: modelID } } : {}) },
    }
    // Saved before the request, so a lost response keeps the same identity across reload.
    setAttempt(value)
    save()
    await post(value)
  }
  // Reads the exact attempted id. Found: opened. Not found: still reserved, because the lost
  // request can land later; only the identical request may be sent again.
  const reconcile = async () => {
    const value = attempt()
    if (!value || pending()) return
    setPending(true)
    try {
      const session = await oc.session(value.body.id, value.directory)
      if (session.directory !== value.directory) throw Error("directory mismatch")
      await open(session, value)
    } catch (cause) {
      if (String(cause).includes("HTTP 404")) {
        setAttempt({ ...value, absent: true })
        setError("Not created yet. Send repeats the same request, so at most one session is created.")
      } else setError("Still unknown whether the session was created. Check again shortly.")
    } finally {
      setPending(false)
      save()
    }
  }
  // An unconfirmed attempt from before a reload is checked once on open.
  if (attempt()) queueMicrotask(() => void reconcile())

  return <main class="session-page new-session-page">
    <div class="session-main">
      <AppHeader><h1>New session</h1></AppHeader>
      <div class="new-session-space" />
      <form class="prompt-box new-session-draft" onSubmit={(event) => { event.preventDefault(); if (here()) void send() }}>
        <Show when={workHosts().length > 1}>
          <label class="new-session-host">Run on
            <select aria-label="Run on" value={destination()} disabled={locked()} onChange={(event) => navigate(`/new?host=${encodeURIComponent(event.currentTarget.value)}`, { replace: true })}>
              <For each={workHosts()}>{(item) => <option value={item.id} selected={item.id === destination()}>{item.label}{item.default ? " · default" : ""}{hostDown(item.id) ? " · unreachable" : ""}</option>}</For>
            </select>
          </label>
        </Show>
        <Show when={here()}>
        <div class="new-session-settings" role="group" aria-label="New session settings">
          <select aria-label="Project" value={project()} disabled={locked()} onChange={(event) => chooseProject(event.currentTarget.value)}>
            <Show when={!project()}><option value="" disabled>Project…</option></Show>
            <For each={projects()}>{(item) => <option value={item.name} selected={item.name === project()}>{item.name}</option>}</For>
          </select>
          <select aria-label="Workspace" value={directory()} disabled={locked() || directories().length < 2} title={directory()}
            onChange={(event) => setDirectory(event.currentTarget.value)}>
            <For each={directories()}>{(value, index) => <option value={value} selected={value === directory()}>{index() === 0 ? "project root" : workspaceLabel(value)}</option>}</For>
          </select>
          <select aria-label="Agent" value={agent()} disabled={locked()} onChange={(event) => setAgent(event.currentTarget.value)}>
            <option value="" selected={!agent()}>default agent</option>
            <For each={primaryAgents()}>{(item) => <option value={item.name} selected={item.name === agent()}>{item.name}</option>}</For>
          </select>
          <select aria-label="Model" value={modelValue()} disabled={locked()} onChange={(event) => setModel(event.currentTarget.value)}>
            <option value="" selected={!modelValue()}>default model</option>
            <For each={providers()?.providers ?? []}>{(provider) => <optgroup label={provider.id}>
              <For each={Object.keys(provider.models ?? {})}>{(id) => <option value={`${provider.id}\u0000${id}`} selected={modelValue() === `${provider.id}\u0000${id}`}>{id}</option>}</For>
            </optgroup>}</For>
          </select>
        </div>
        </Show>
        <textarea ref={editor} aria-label="Message" dir="auto" value={text()} readOnly={locked()}
          onInput={(event) => setText(event.currentTarget.value)}
          onKeyDown={(event) => { if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !event.isComposing) { event.preventDefault(); if (here()) void send(); else handOff() } }} />
        <Show when={here()} fallback={
          <div class="new-session-submit new-session-elsewhere">
            <Show when={targetDown()} fallback={<span class="dim">Project, agent and model are chosen on {target()?.label}.</span>}>
              <span class="err" role="alert">{target()?.label} is unreachable. Choose {host()?.label} or try again.</span>
              <button type="button" onClick={() => void targetFeed()?.load()}>Try again</button>
            </Show>
            <button type="button" class="primary" disabled={targetDown()} onClick={handOff}>Start on {target()?.label} <kbd aria-hidden="true">{shortcutLabel("submit")}</kbd></button>
          </div>
        }>
        <div class="new-session-submit">
          <Show when={error()}><span class="err" role="alert">{error()}</span></Show>
          <Show when={attempt() && !pending()}><button type="button" onClick={() => void reconcile()}>Check again</button></Show>
          <button type="submit" class="primary" disabled={attempt() ? !retryable() : locked() || !directory() || !text().trim()}>
            {pending() ? "Creating…" : workHosts().length > 1 ? `Start on ${host()?.label}` : "Send"} <kbd aria-hidden="true">{shortcutLabel("submit")}</kbd>
          </button>
        </div>
        </Show>
      </form>
    </div>
  </main>
}
