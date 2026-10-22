/* The front desk's two durable seams, both ordinary Core sessions:
 * - the desk conversation (one pointer, verified against Core on load);
 * - evidence briefs as child sessions whose metadata binds them to a source revision.
 * State is always re-read from Core. Nothing is resent or rerun automatically. */
import { createEffect, createSignal, on, onCleanup, onMount } from "solid-js"
import type { Session } from "@opencode-ai/sdk/v2"
import { descending } from "@opencode-ai/schema/identifier"
import { oc, SessionCreateError, type ContextPart, type MessageWithParts } from "./api"
import { assistantOps, handled, emptyMemory, eraseMemory, nextMemory, type MemoryDocument, type MemoryOp } from "./desk-memory"
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

/** Local read-only retrieval inside the anchor's project root. Every other tool, reads outside the
 * root and environment files are denied, so a brief never prompts for permission, runs commands,
 * reaches the network or writes anything. */
/* Public shape other clients (native, phone) can read without es-app code:
 * - anchor: Core session ses_fdbrief_<sha256(editspace root)[:20 hex]> in that root (archived);
 * - job: its child session ses_fdjob_<sha256(JSON [anchor, source, revision, attempt])[:24 hex]>,
 *   metadata.frontDesk = BriefMeta {kind:"brief", requestID, source: "attention:<editspace>:<record id>", revision, title, refs};
 * - result: the job's last completed assistant text is one JSON object matching BRIEF_SCHEMA (desk.ts),
 *   valid only while the ledger record still has that revision. */
export const briefID = async (parent: string, source: string, revision: string, attempt: number) => {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify([parent, source, revision, attempt]))))
  return `ses_fdjob_${[...digest].map(byte => byte.toString(16).padStart(2, "0")).join("").slice(0, 24)}`
}

export const BRIEF_PERMISSION = [
  { permission: "*", pattern: "*", action: "deny" as const },
  ...["read", "grep", "glob", "list"].map(permission => ({ permission, pattern: "*", action: "allow" as const })),
  ...["*.env", "*.env.*", "**/.env", "**/.env.*"].map(pattern => ({ permission: "read", pattern, action: "deny" as const })),
  { permission: "external_directory", pattern: "*", action: "deny" as const },
]

export const createBriefs = (desk: () => DeskPointer | undefined, current: (key: string) => DeskItem | undefined, ensure?: () => Promise<unknown>) => {
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
  // The parent whose children were last read successfully; automatic starts wait for it.
  const [synced, setSynced] = createSignal<string>()
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
      setSynced(target.session)
      setError("")
    } catch (cause) {
      if (current === generation) setError(`Background checks could not be read (${String(cause)}). Last-known states are shown.`)
    }
  }
  // Read as soon as the parent is known, not at the next poll.
  createEffect(on(() => desk()?.session, (session, previous) => { if (session && session !== previous) void refresh() }, { defer: true }))
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
        // 409: another client (tab, native app) already created this job; adopt it, never prompt it again.
        if (!cause.message.includes("HTTP 409")) setError(`Brief not started: ${cause.message}`)
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
    if (pending() || preparing() || inflight()) return
    const existing = reusable(item)
    if (existing) return existing
    // Claimed synchronously, before the first await, so near-simultaneous starts make one check.
    setPreparing(true)
    try {
      if (!desk() && ensure) await ensure()
      const target = desk()
      if (!target) return
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
      // Deterministic per (parent, source, revision, attempt): every client computes the same ID, so
      // Core's create reconciliation makes the first creator win and the rest adopt its job.
      const attempt = jobs().filter(job => job.meta.source === latest.key && job.meta.revision === latest.revision).length
      const id = await briefID(target.session, latest.key, latest.revision, attempt)
      const value: PendingCreate = {
        id, directory: target.directory, packet: packet.text, created: Date.now(),
        body: {
          id,
          parentID: target.session,
          title: `Brief: ${latest.title.slice(0, 60)}`,
          metadata: { frontDesk: meta },
          permission: BRIEF_PERMISSION,
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
  return { jobs, error, pending, preparing, synced, refresh, start, confirm }
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

const MEMORY_REFUSED = "es-app:front-desk:memory-refused:1"
type Stored = { hash: string; document: MemoryDocument }
const MEMORY_URL = "/es/api/frontdesk/memory"
const MEMORY_UNCERTAIN = "es-app:front-desk:memory-uncertain:1"
type PutBody = { expected_hash: string; document: MemoryDocument }
// A change is identified by its revision and newest history item; the file holding both means it committed.
const committed = (file: MemoryDocument, body: PutBody) =>
  file.revision === body.document.revision && JSON.stringify(file.history.at(-1)) === JSON.stringify(body.document.history.at(-1))

/** Personal memory in one file, replaced only by compare-and-set on its content hash. */
export const createMemory = () => {
  const [stored, setStored] = createSignal<Stored>()
  const [status, setStatus] = createSignal<"idle" | "loading" | "writing" | "unavailable">("idle")
  const [notice, setNotice] = createSignal("")
  const document = () => stored()?.document ?? emptyMemory()
  // A save whose outcome is unknown. Its original request may still commit, so it is kept until the
  // file shows it committed or can no longer commit, and only the identical request is resent.
  const [uncertain, setUncertain] = createSignal(readJSON<PutBody>(MEMORY_UNCERTAIN, value => typeof value?.expected_hash === "string" && !!value?.document))
  const keepUncertain = (body?: PutBody) => {
    try {
      if (body) localStorage.setItem(MEMORY_UNCERTAIN, JSON.stringify(body))
      else localStorage.removeItem(MEMORY_UNCERTAIN)
    } catch { /* kept in memory for this page */ }
    setUncertain(body)
  }
  const reconcile = () => {
    const body = uncertain()
    const file = stored()
    if (!body || !file) return
    if (committed(file.document, body)) {
      keepUncertain(undefined)
      setNotice("The earlier memory change was confirmed in the file.")
      return
    }
    // The file moved on without it: compare-and-set guarantees the original can no longer commit.
    if (file.hash !== body.expected_hash) {
      keepUncertain(undefined)
      setNotice("The earlier memory change was not saved: memory changed before it could commit.")
    }
  }
  const load = async () => {
    setStatus(previous => previous === "writing" ? previous : "loading")
    try {
      const response = await fetch(MEMORY_URL, { credentials: "include" })
      if (!response.ok) throw new Error(response.status === 404 ? "the dashboard has no memory endpoint" : `HTTP ${response.status}`)
      setStored(await response.json())
      reconcile()
      setStatus(previous => previous === "writing" ? previous : "idle")
    } catch (cause) {
      setStatus("unavailable")
      setNotice(`Memory could not be read (${cause instanceof Error ? cause.message : String(cause)}). Last-known notes are shown; nothing was changed.`)
    }
  }
  type Outcome = "written" | "refused" | "conflict" | "unconfirmed" | "busy" | "forbidden"
  const send = async (body: PutBody): Promise<Outcome> => {
    setStatus("writing")
    try {
      const response = await fetch(MEMORY_URL, {
        method: "PUT", credentials: "include",
        headers: { "content-type": "application/json", "X-Attention-CSRF": "1" },
        body: JSON.stringify(body),
      }).catch(() => undefined)
      if (response?.ok) {
        setStored(await response.json())
        if (uncertain() && JSON.stringify(uncertain()) === JSON.stringify(body)) keepUncertain(undefined)
        return "written"
      }
      // No response, or a server error that may have followed the commit: read the file before deciding.
      if (!response || response.status >= 500) {
        keepUncertain(body)
        await load()
        return uncertain() ? "unconfirmed" : committed(document(), body) ? "written" : "conflict"
      }
      await load()
      if (response.status === 409) return uncertain() ? "unconfirmed" : "conflict"
      if (response.status === 401 || response.status === 403) return "forbidden"
      setNotice(`Memory change refused: ${(await response.json().catch(() => undefined))?.error ?? `HTTP ${response.status}`}`)
      return "refused"
    } finally {
      setStatus(previous => previous === "writing" ? "idle" : previous)
    }
  }
  const messages: Record<Exclude<Outcome, "written" | "refused">, string> = {
    conflict: "Memory changed elsewhere first. Your change was not saved; review the newest notes and try again.",
    unconfirmed: "The memory change is not confirmed. It may still be saved; reload to check, or resend the identical change.",
    busy: "Another memory change is in progress or unconfirmed.",
    forbidden: "Memory is read-only here: the operator connection is unavailable.",
  }
  const commit = async (next: MemoryDocument | { refused: string }, base: Stored | undefined, label: string): Promise<Outcome> => {
    if (!base || status() === "writing" || uncertain()) return "busy"
    if ("refused" in next) {
      setNotice(`${label} not saved: ${next.refused}`)
      return "refused"
    }
    const outcome = await send({ expected_hash: base.hash, document: next })
    if (outcome !== "written" && outcome !== "refused") setNotice(messages[outcome])
    if (outcome === "written") setNotice("")
    return outcome
  }
  /** Resend exactly the unconfirmed request; compare-and-set keeps it from applying twice. */
  const resend = async () => {
    const body = uncertain()
    if (!body || status() === "writing") return
    const outcome = await send(body)
    if (outcome === "conflict") reconcile()
    else setNotice(outcome === "written" ? "Memory change saved." : messages[outcome as keyof typeof messages] ?? "")
  }
  /** One change on top of the file as last read. Desk changes carry their opKey and apply once. */
  const write = async (op: MemoryOp, actor: "human" | "assistant", source?: { messageID: string; opKey: string }) => {
    const base = stored()
    if (base && source && handled(base.document, source.opKey)) return "written" as const
    return commit(base ? nextMemory(base.document, op, actor, Date.now(), source) : { refused: "Memory has not been read yet." }, base,
      actor === "assistant" ? "The desk's memory change" : "Change")
  }
  const erase = async (entryID: string) => {
    const base = stored()
    if (await commit(base ? eraseMemory(base.document, entryID, Date.now()) : { refused: "Memory has not been read yet." }, base, "Erase") === "written")
      setNotice(`Erased "${entryID}" from history.`)
  }
  // Refused desk changes are reported once, not on every later scan of the same reply.
  const refused = new Set(readJSON<string[]>(MEMORY_REFUSED, Array.isArray) ?? [])
  /** Apply memory changes the desk wrote in its own completed replies, oldest first, once each. */
  const absorb = async (messages: MessageWithParts[]) => {
    for (const item of assistantOps(messages)) {
      if (handled(document(), item.opKey) || refused.has(item.opKey)) continue
      const outcome = await write(item.op, "assistant", item)
      if (outcome === "written") continue
      // Conflicts and unconfirmed writes retry on a later scan; only a refused change is final.
      if (outcome !== "refused") return
      refused.add(item.opKey)
      try { localStorage.setItem(MEMORY_REFUSED, JSON.stringify([...refused].slice(-200))) } catch { /* reported again after reload at worst */ }
    }
  }
  return { document, status, notice, uncertain, load, write, erase, absorb, resend }
}

/** Parent for evidence briefs, shared by Home and the desk so one source revision has one check.
 * Deterministic per project root, so concurrent first use reconciles to the same session. Viewing
 * only reads; the parent is created when a brief is first requested. */
export const briefAnchorID = async (root: string) => {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(root)))
  return `ses_fdbrief_${[...digest].map(byte => byte.toString(16).padStart(2, "0")).join("").slice(0, 20)}`
}

export const createBriefAnchor = (directory: () => string | undefined) => {
  const [pointer, setPointer] = createSignal<DeskPointer>()
  const [error, setError] = createSignal("")
  const [target, setTarget] = createSignal<DeskPointer>()
  // True once the lookup settled: the parent exists (pointer set) or definitely does not yet.
  const [checked, setChecked] = createSignal(false)
  createEffect(() => {
    const root = directory()
    if (!root || target()?.directory === root) return
    void briefAnchorID(root).then(id => {
      setTarget({ session: id, directory: root })
      return oc.session(id, root).then(existing => { setPointer({ session: id, directory: existing.directory }); setChecked(true) },
        cause => { if (String(cause).includes("HTTP 404")) setChecked(true); else setError(`Briefs are unavailable (${String(cause)}).`) })
    })
  })
  const ensure = async () => {
    const current = target()
    if (!current) return
    if (pointer()?.session === current.session) return pointer()
    try {
      const created = await oc.createSession(current.directory, { id: current.session, title: "Front desk briefs", permission: [{ permission: "*", pattern: "*", action: "deny" }] })
      // Hidden from session lists; archived sessions and their children stay readable.
      await oc.archive(created.id, current.directory).catch(() => undefined)
      setPointer({ session: created.id, directory: created.directory })
      setError("")
      return pointer()
    } catch (cause) {
      setError(`Briefs are unavailable (${cause instanceof Error ? cause.message : String(cause)}).`)
    }
  }
  return { pointer, error, checked, ready: () => !!target(), ensure }
}
