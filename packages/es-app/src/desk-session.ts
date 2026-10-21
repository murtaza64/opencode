/* The front desk's two durable seams, both ordinary Core sessions:
 * - the desk conversation (one pointer, verified against Core on load);
 * - evidence briefs as child sessions whose metadata binds them to a source revision.
 * State is always re-read from Core. Nothing is resent or rerun automatically. */
import { createSignal, onCleanup, onMount } from "solid-js"
import type { Session } from "@opencode-ai/sdk/v2"
import { descending } from "@opencode-ai/schema/identifier"
import { oc, SessionCreateError, type ContextPart } from "./api"
import { BRIEF_SCHEMA, BRIEF_SYSTEM, briefPacket, briefState, deskContext, type BriefMeta, type BriefState, type DeskItem } from "./desk"

export type DeskPointer = { session: string; directory: string }
const POINTER = "es-app:front-desk:1"
const NOTE = "es-app:front-desk:context:1"
const PENDING = "es-app:front-desk:brief-create:1"
const AGENT = "front-desk"
const CONTEXT_SOURCE = "es-app/front-desk"

const readJSON = <T,>(key: string, valid: (value: any) => boolean): T | undefined => {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? "null")
    return valid(value) ? value : undefined
  } catch { return undefined }
}

export const createDeskSession = () => {
  const [pointer, setPointer] = createSignal(readJSON<DeskPointer>(POINTER, value => typeof value?.session === "string" && typeof value?.directory === "string"))
  const [session, setSession] = createSignal<Session>()
  const [status, setStatus] = createSignal<"none" | "checking" | "ready" | "missing" | "unavailable" | "creating">(pointer() ? "checking" : "none")
  const [error, setError] = createSignal("")
  const verify = async () => {
    const current = pointer()
    if (!current) return setStatus("none")
    setStatus("checking")
    try {
      setSession(await oc.session(current.session, current.directory))
      setStatus("ready")
    } catch (cause) {
      // Only a definite 404 means the pointer is gone; anything else keeps it for a later check.
      setStatus(String(cause).includes("HTTP 404") ? "missing" : "unavailable")
    }
  }
  onMount(() => void verify())
  const start = async (directory: string) => {
    if (status() === "creating") return
    setStatus("creating")
    setError("")
    try {
      const agents = await oc.agents(directory).catch(() => [])
      const created = await oc.createSession(directory, {
        title: "Front desk",
        ...(agents.some(agent => agent.name === AGENT) ? { agent: AGENT } : {}),
        // The desk answers and routes; it never edits files, whichever agent serves it.
        permission: [{ permission: "edit", pattern: "*", action: "deny" }],
      })
      localStorage.setItem(POINTER, JSON.stringify({ session: created.id, directory: created.directory }))
      setPointer({ session: created.id, directory: created.directory })
      setSession(created)
      setStatus("ready")
    } catch (cause) {
      setError(cause instanceof SessionCreateError ? cause.message : String(cause))
      setStatus(pointer() ? "unavailable" : "none")
    }
  }
  const forget = () => {
    localStorage.removeItem(POINTER)
    setPointer(undefined)
    setSession(undefined)
    setStatus("none")
  }

  /** Generated context for the next idle send, only when the desk's view changed since the last accepted one. */
  const context = (input: Parameters<typeof deskContext>[0]): ContextPart[] => {
    const current = session()
    if (!current) return []
    const note = deskContext(input)
    if (localStorage.getItem(`${NOTE}:${current.id}`) === note.key) return []
    return [{ type: "text", text: note.text, synthetic: true, metadata: { source: CONTEXT_SOURCE, key: note.key } }]
  }
  // An unconfirmed send leaves the key unrecorded, so the next send carries the context again.
  const sent = (parts: ContextPart[], accepted: boolean) => {
    const current = session()
    const key = parts.find(part => part.metadata.source === CONTEXT_SOURCE)?.metadata.key
    if (current && key && accepted) localStorage.setItem(`${NOTE}:${current.id}`, key)
  }
  return { pointer, session, status, error, setError, verify, start, forget, context, sent }
}

export type BriefJob = { id: string; directory: string; meta: BriefMeta; created: number; state: BriefState | { state: "starting" } | { state: "unconfirmed" } }
type PendingCreate = { id: string; directory: string; body: Parameters<typeof oc.createSession>[1] & { id: string }; packet: string; created: number }

const metaOf = (session: Session): BriefMeta | undefined => {
  const value = (session.metadata as Record<string, unknown> | undefined)?.frontDesk as BriefMeta | undefined
  return value?.kind === "brief" && typeof value.requestID === "string" && typeof value.source === "string" && typeof value.revision === "string" && Array.isArray(value.refs) ? value : undefined
}

export const createBriefs = (desk: () => DeskPointer | undefined) => {
  const [jobs, setJobs] = createSignal<BriefJob[]>([])
  const [error, setError] = createSignal("")
  // A create whose response was lost. It keeps its client-chosen session ID, so confirming it
  // re-sends the identical request and Core returns the same session instead of a second one.
  const [pending, setPending] = createSignal(readJSON<PendingCreate>(PENDING, value => typeof value?.id === "string" && typeof value?.body?.id === "string"))
  const savePending = (value?: PendingCreate) => {
    if (value) localStorage.setItem(PENDING, JSON.stringify(value))
    else localStorage.removeItem(PENDING)
    setPending(value)
  }
  const [inflight, setInflight] = createSignal<string>()
  const pendingJob = (value: PendingCreate): BriefJob => ({ id: value.id, directory: value.directory, meta: value.body.metadata!.frontDesk as BriefMeta, created: value.created, state: { state: inflight() === value.id ? "starting" : "unconfirmed" } })
  let generation = 0
  const refresh = async () => {
    const target = desk()
    const local = () => pending() ? [pendingJob(pending()!)] : []
    if (!target) return setJobs(local())
    const current = ++generation
    try {
      const [children, status] = await Promise.all([oc.children(target.session, target.directory), oc.status(target.directory)])
      const found = await Promise.all(children.flatMap(child => {
        const meta = metaOf(child)
        if (!meta) return []
        return [oc.messagesTail(child.id, child.directory, 4).then(messages => ({
          id: child.id, directory: child.directory, meta, created: child.time.created,
          state: briefState(meta, messages, status[child.id]?.type),
        }))]
      }))
      if (current !== generation) return
      if (pending() && found.some(job => job.id === pending()!.id)) savePending(undefined)
      setJobs([...found, ...local()].sort((a, b) => b.created - a.created))
      setError("")
    } catch (cause) {
      if (current === generation) setError(`Background checks could not be read (${String(cause)}). Last-known states are shown.`)
    }
  }
  onMount(() => {
    void refresh()
    let timer: ReturnType<typeof setTimeout>
    const tick = () => {
      const active = jobs().some(job => job.state.state === "running" || job.state.state === "starting")
      timer = setTimeout(() => void refresh().finally(tick), active ? 1500 : 15_000)
    }
    tick()
    onCleanup(() => { clearTimeout(timer); generation++ })
  })
  const admit = async (value: PendingCreate) => {
    if (inflight()) return
    setInflight(value.id)
    setJobs(previous => [pendingJob(value), ...previous.filter(job => job.id !== value.id)])
    let child: Session
    try {
      child = await oc.createSession(value.directory, value.body)
      if (child.id !== value.id) throw new SessionCreateError("Core confirmed a different session than requested.", true)
    } catch (cause) {
      if (cause instanceof SessionCreateError && !cause.uncertain) {
        savePending(undefined)
        setError(`Brief not started: ${cause.message}`)
      }
      setInflight(undefined)
      return refresh()
    }
    savePending(undefined)
    await oc.promptBody(child.id, child.directory, {
      // Plain-text JSON: Core's message listing cannot yet encode stored json_schema formats.
      system: `${BRIEF_SYSTEM}\n${JSON.stringify(BRIEF_SCHEMA)}`,
      parts: [{ type: "text", text: value.packet }],
    }).catch(() => undefined) // The durable session shows whether the prompt was admitted.
    setInflight(undefined)
    await refresh()
  }
  /** One read-only pass per exact source revision. An existing check for it is reused, not rerun. */
  const start = async (item: DeskItem) => {
    const target = desk()
    if (!target || pending()) return
    const existing = jobs().find(job => job.meta.source === item.key && job.meta.revision === item.revision && job.state.state !== "failed" && job.state.state !== "unknown")
    if (existing) return existing
    const requestID = crypto.randomUUID()
    const tail = await oc.messagesTail(item.source.session, item.source.directory, 10).catch(() => [])
    const packet = briefPacket(item, tail)
    const meta: BriefMeta = { kind: "brief", requestID, source: item.key, revision: item.revision, title: item.title, refs: packet.refs }
    const id = `ses_${descending()}`
    const value: PendingCreate = {
      id, directory: target.directory, packet: packet.text, created: Date.now(),
      body: {
        id,
        parentID: target.session,
        title: `Brief: ${item.title.slice(0, 60)}`,
        metadata: { frontDesk: meta },
        // No tools at all: the pass reads only the packet and replies with JSON text.
        permission: [{ permission: "*", pattern: "*", action: "deny" }],
      },
    }
    // Saved before the request so a lost response survives reload with the same identity.
    savePending(value)
    await admit(value)
  }
  /** Human-confirmed retry of an unconfirmed create: the identical request, never a new session. */
  const confirm = async () => {
    const value = pending()
    if (value) await admit(value)
  }
  return { jobs, error, pending, refresh, start, confirm }
}
