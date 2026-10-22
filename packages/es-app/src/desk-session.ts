/* The front desk's two durable seams, both ordinary Core sessions:
 * - the desk conversation (one pointer, verified against Core on load);
 * - evidence briefs as child sessions whose metadata binds them to a source revision.
 * State is always re-read from Core. Nothing is resent or rerun automatically. */
import { createSignal, onCleanup, onMount } from "solid-js"
import type { Session } from "@opencode-ai/sdk/v2"
import { descending } from "@opencode-ai/schema/identifier"
import { oc, SessionCreateError, type ContextPart } from "./api"
import { BRIEF_SCHEMA, BRIEF_SYSTEM, briefPacket, briefState, deskContext, type BriefMeta, type BriefState, type DeskItem } from "./desk"

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

type CreateBody = Parameters<typeof oc.createSession>[1] & { id: string }
/** `create` is kept until Core confirms the session, so a lost response is retried with the same identity. */
export type DeskPointer = { session: string; directory: string; create?: CreateBody }

export const createDeskSession = () => {
  const [pointer, setPointer] = createSignal(readJSON<DeskPointer>(POINTER, value => typeof value?.session === "string" && typeof value?.directory === "string"))
  const [session, setSession] = createSignal<Session>()
  const [status, setStatus] = createSignal<"none" | "checking" | "ready" | "missing" | "unavailable" | "creating" | "unconfirmed">(pointer() ? "checking" : "none")
  const [error, setError] = createSignal("")
  const save = (value?: DeskPointer) => {
    if (value) localStorage.setItem(POINTER, JSON.stringify(value))
    else localStorage.removeItem(POINTER)
    setPointer(value)
  }
  const confirmed = (created: Session) => {
    try { save({ session: created.id, directory: created.directory }) } catch {
      // The saved create body still names this session; the next check reconciles it.
      setPointer({ session: created.id, directory: created.directory })
    }
    setSession(created)
    setStatus("ready")
  }
  const verify = async () => {
    const current = pointer()
    if (!current) return setStatus("none")
    setStatus("checking")
    try {
      confirmed(await oc.session(current.session, current.directory))
    } catch (cause) {
      const missing = String(cause).includes("HTTP 404")
      // An unconfirmed create may never have reached Core; only the identical request may follow.
      if (missing && current.create) return setStatus("unconfirmed")
      // Only a definite 404 means the pointer is gone; anything else keeps it for a later check.
      setStatus(missing ? "missing" : "unavailable")
    }
  }
  onMount(() => void verify())
  const admit = async (value: DeskPointer & { create: CreateBody }) => {
    setStatus("creating")
    setError("")
    try {
      const created = await oc.createSession(value.directory, value.create)
      if (created.id !== value.session) throw new SessionCreateError("Core confirmed a different session than requested.", true)
      confirmed(created)
    } catch (cause) {
      setError(cause instanceof SessionCreateError ? cause.message : String(cause))
      if (cause instanceof SessionCreateError && !cause.uncertain) {
        try { save(undefined) } catch { setPointer(undefined) }
        return setStatus("none")
      }
      setStatus("unconfirmed")
    }
  }
  const start = async (directory: string) => {
    if (status() !== "none") return
    setStatus("creating")
    const agents = await oc.agents(directory).catch(() => [])
    const id = `ses_${descending()}`
    const value = {
      session: id, directory,
      create: {
        id,
        title: "Front desk",
        ...(agents.some(agent => agent.name === AGENT) ? { agent: AGENT } : {}),
        // The desk answers and routes; it never edits files, whichever agent serves it.
        permission: [{ permission: "edit", pattern: "*", action: "deny" as const }],
      },
    }
    // Saved before the request: without a durable identity a lost response could orphan a conversation.
    try { save(value) } catch {
      setError("Could not save the front desk identity locally, so no conversation was created. Free browser storage and try again.")
      return setStatus("none")
    }
    await admit(value)
  }
  /** Human-confirmed retry of an unconfirmed create: the identical request, never a new conversation. */
  const confirm = async () => {
    const current = pointer()
    if (current?.create && status() === "unconfirmed") await admit({ ...current, create: current.create })
  }
  const forget = () => {
    try { localStorage.removeItem(POINTER) } catch { /* cleared for this view regardless */ }
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
  return { pointer, session, status, error, setError, verify, start, confirm, forget, context, sent }
}

export type BriefJob = { id: string; directory: string; meta: BriefMeta; created: number; state: BriefState | { state: "starting" } | { state: "unconfirmed" } }
type PendingCreate = { id: string; directory: string; body: Parameters<typeof oc.createSession>[1] & { id: string }; packet: string; created: number }

const metaOf = (session: Session): BriefMeta | undefined => {
  const value = (session.metadata as Record<string, unknown> | undefined)?.frontDesk as BriefMeta | undefined
  return value?.kind === "brief" && typeof value.requestID === "string" && typeof value.source === "string" && typeof value.revision === "string" && Array.isArray(value.refs) ? value : undefined
}

export const createBriefs = (desk: () => DeskPointer | undefined, current: (key: string) => DeskItem | undefined) => {
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
  const [preparing, setPreparing] = createSignal(false)
  const pendingJob = (value: PendingCreate): BriefJob => ({ id: value.id, directory: value.directory, meta: value.body.metadata!.frontDesk as BriefMeta, created: value.created, state: { state: inflight() === value.id ? "starting" : "unconfirmed" } })
  let generation = 0
  // Settled briefs never change on their own, so their transcripts are read once per explicit
  // refresh, not on every tick: N finished briefs must not mean N reads per poll.
  const settled = new Map<string, BriefJob>()
  const isSettled = (job: BriefJob) => ["ready", "failed", "unknown"].includes(job.state.state)
  const refresh = async (explicit = false) => {
    const target = desk()
    const local = () => pending() ? [pendingJob(pending()!)] : []
    if (!target) return setJobs(local())
    const current = ++generation
    try {
      const [children, status] = await Promise.all([oc.children(target.session, target.directory), oc.status(target.directory)])
      const briefs = children.flatMap(child => { const meta = metaOf(child); return meta ? [{ child, meta }] : [] })
      const live = (id: string) => ["busy", "retry"].includes(status[id]?.type ?? "")
      const stale = briefs.filter(({ child }) => explicit || !settled.has(child.id) || live(child.id) || child.id === inflight())
      const read = await limited(stale, 4, ({ child, meta }) => oc.messagesTail(child.id, child.directory, 4).then((messages): BriefJob => ({
        id: child.id, directory: child.directory, meta, created: child.time.created,
        state: briefState(meta, messages, status[child.id]?.type),
      })))
      if (current !== generation) return
      for (const job of read) {
        if (isSettled(job) && job.id !== inflight()) settled.set(job.id, job)
        else settled.delete(job.id)
      }
      const known = new Set(briefs.map(({ child }) => child.id))
      for (const id of settled.keys()) if (!known.has(id)) settled.delete(id)
      const found = briefs.map(({ child }) => read.find(job => job.id === child.id) ?? settled.get(child.id)!)
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
  const admit = async (value: PendingCreate, claimed = false) => {
    if ((inflight() || preparing()) && !claimed) return
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
    settled.delete(child.id)
    await refresh()
  }
  const reusable = (item: DeskItem) => jobs().find(job => job.meta.source === item.key && job.meta.revision === item.revision && job.state.state !== "failed" && job.state.state !== "unknown")
  /** One read-only pass per exact source revision. An existing check for it is reused, not rerun. */
  const start = async (item: DeskItem) => {
    const target = desk()
    if (!target || pending() || preparing() || inflight()) return
    const existing = reusable(item)
    if (existing) return existing
    // Claimed synchronously, before the first await, so near-simultaneous clicks start one check.
    setPreparing(true)
    try {
      const tail = await oc.messagesTail(item.source.session, item.source.directory, 10).catch(() => [])
      // Re-read the canonical item: the source may have moved on while its thread was read.
      const latest = current(item.key)
      if (!latest || latest.revision !== item.revision) {
        setError("The source changed while the brief was being prepared. Nothing was started.")
        return
      }
      if (desk()?.session !== target.session || pending() || inflight() || reusable(latest)) return
      const packet = briefPacket(latest, tail)
      const meta: BriefMeta = { kind: "brief", requestID: crypto.randomUUID(), source: latest.key, revision: latest.revision, title: latest.title, refs: packet.refs }
      const id = `ses_${descending()}`
      const value: PendingCreate = {
        id, directory: target.directory, packet: packet.text, created: Date.now(),
        body: {
          id,
          parentID: target.session,
          title: `Brief: ${latest.title.slice(0, 60)}`,
          metadata: { frontDesk: meta },
          // No tools at all: the pass reads only the packet and replies with JSON text.
          permission: [{ permission: "*", pattern: "*", action: "deny" }],
        },
      }
      // Saved before the request so a lost response survives reload with the same identity.
      try { savePending(value) } catch {
        setError("Could not save the brief identity locally, so it was not started. Free browser storage and try again.")
        return
      }
      setError("")
      await admit(value, true)
    } finally {
      setPreparing(false)
    }
  }
  /** Human-confirmed retry of an unconfirmed create: the identical request, never a new session. */
  const confirm = async () => {
    const value = pending()
    if (value) await admit(value)
  }
  return { jobs, error, pending, preparing, refresh, start, confirm }
}

/** Map with at most `limit` requests in flight, preserving input order. */
const limited = async <T, R>(items: T[], limit: number, map: (item: T) => Promise<R>) => {
  const results: R[] = new Array(items.length)
  let next = 0
  const worker = async () => {
    for (let index = next++; index < items.length; index = next++) results[index] = await map(items[index]!)
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}
