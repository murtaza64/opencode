/* The front desk's two durable seams, both ordinary Core sessions:
 * - the desk conversation (one pointer, verified against Core on load);
 * - evidence briefs as child sessions whose metadata binds them to a source revision.
 * State is always re-read from Core. Nothing is resent or rerun automatically. */
import { createEffect, createSignal, on, onCleanup, onMount } from "solid-js"
import type { Session } from "@opencode-ai/sdk/v2"
import { descending } from "@opencode-ai/schema/identifier"
import { oc, ocAt, SessionCreateError, type ContextPart, type MessageWithParts } from "./api"
import { readHost, workFeedHosts } from "./host"
import { earlierDesks, placement, resolveHome, sharedNotice, writePointer, type DeskHome, type Placement, type PointerView } from "./desk-pointer"
import { unresolvedSend } from "./composer"
import type { SessionHost } from "./session-host"
import { clearBackend, describeFailure, isTransient, reportBackend } from "./backend-status"
import { assistantOps, handled, emptyMemory, eraseMemory, nextMemory, type MemoryDocument, type MemoryOp } from "./desk-memory"
import type { AttentionRecord } from "./attention"
import { BRIEF_CONTRACT, BRIEF_SCHEMA, BRIEF_SYSTEM, type ConversationDocument, type ConversationThread, briefComplete, briefPacket, briefState, contextNote, deskContext, nextNoteSeq, recordNote, type BriefMeta, type NoteState, type BriefState, type DeskItem, SOURCE_TAIL } from "./desk"
import { DESK } from "./desk-identity"

const POINTER = "es-app:front-desk:1"
// This device's desks that a shared desk replaced, kept so they stay one tap away, and the shared desk last announced.
const EARLIER = "es-app:front-desk:earlier:1"
const SHARED_SEEN = "es-app:front-desk:shared-seen:1"
// The remote home's desk last read, so an input to it is still reconciled while the home cannot be read.
const HOME_DESK = "es-app:front-desk:home-desk:1"
// How often a device whose desk lives on another host re-reads the home, to fall back or fail back.
const HOME_POLL = 15_000
// Longest the desk chat waits for the host and home reads before it loads this device's own desk.
const HOME_READ_LIMIT = 5_000
// Per desk session: what its context notes have told it so far (NoteState).
const NOTE = "es-app:front-desk:context:2"
const PENDING = "es-app:front-desk:brief-create:1"
const AGENT = "front-desk"
/** The model the Front Desk chat and its brief jobs run on is the host's own: the `front-desk` agent's model
 * as the host's Core resolves its config, reported by the host's dashboard (GET /api/frontdesk/model, shared
 * with its server-side preparation). Nothing here names a provider; an unusable model is reported, never replaced. */
export type DeskModel = { providerID: string; modelID: string }
export type HostModel = { model: DeskModel | null; available: boolean; reason: string }
const [hostModel, setHostModel] = createSignal<HostModel>()
let hostModelRead: Promise<HostModel> | undefined
export const readHostModel = (force = false) => {
  if (!hostModelRead || force) hostModelRead = fetch("/es/api/frontdesk/model", { credentials: "include" })
    .then(async response => response.ok ? await response.json() as HostModel : { model: null, available: false, reason: `the dashboard did not report it (HTTP ${response.status})` })
    .catch(() => ({ model: null, available: false, reason: "the dashboard is unreachable" }))
    .then(value => { setHostModel(value); return value })
  return hostModelRead
}
/** This host's desk model when it can run here; undefined while unknown or unusable. */
export const deskModel = () => { const value = hostModel(); return value?.available ? value.model ?? undefined : undefined }
export { hostModel }
const CONTEXT_SOURCE = "es-app/front-desk"

const readJSON = <T,>(key: string, valid: (value: any) => boolean): T | undefined => {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? "null")
    return valid(value) ? value : undefined
  } catch { return undefined }
}

type CreateBody = Parameters<typeof oc.createSession>[1] & { id: string }
/** `create` is kept until Core confirms the session, so a lost response is retried with the same identity. `host` is
 * set when the profile's desk lives on another Work host (its home); this device's own pointer is then kept, unused. */
export type DeskPointer = { session: string; directory: string; create?: CreateBody; host?: SessionHost & { id: string; label: string } }

/** The saved Front Desk chat session id, read from local storage only (no request). */
export const deskSessionID = () => readJSON<DeskPointer>(POINTER, value => typeof value?.session === "string")?.session

export const createDeskSession = () => {
  const [devicePointer, setPointer] = createSignal(readJSON<DeskPointer>(POINTER, value => typeof value?.session === "string" && typeof value?.directory === "string"))
  // The profile's home (desk-pointer-contract-v1). A remote home's desk replaces this device's pointer for the view.
  const [home, setHome] = createSignal<DeskHome>({ kind: "off" })
  const [remote, setRemote] = createSignal<DeskPointer>()
  const pointer = () => remote() ?? devicePointer()
  const client = () => ocAt(pointer()?.host?.base ?? "/oc")
  const [session, setSession] = createSignal<Session>()
  const [status, setStatus] = createSignal<"none" | "checking" | "ready" | "missing" | "unavailable" | "creating" | "unconfirmed" | "remote-none" | "home-offline" | "home-claim">("checking")
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
    void preferDeskModel(created)
  }
  // A conversation that inherited another model (e.g. from its agent's default) switches to the desk
  // model through the session's own preference, which applies from its next turn: a running turn and
  // the transcript are untouched. A preference someone chose explicitly is left alone.
  const preferDeskModel = async (current: Session) => {
    const host = await readHostModel()
    const model = host.available ? host.model : undefined
    if (!model || current.preferredModel || (current.model?.providerID === model.providerID && current.model.id === model.modelID)) return
    if (pointer()?.host) return
    await oc.preferModel(current.id, current.directory, model).then(setSession, () => undefined)
  }
  const verifyDevice = async () => {
    const current = devicePointer()
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
  /** Adopt the home's pointer on this host: it becomes this device's pointer too. */
  const [replaced, setReplaced] = createSignal(readJSON<{ session: string; directory: string }[]>(EARLIER, value => Array.isArray(value)) ?? [])
  const [seen, setSeen] = createSignal(readJSON<string>(SHARED_SEEN, value => typeof value === "string"))
  // This device's own earlier desk becomes a read-only Earlier link, never deleted.
  const retire = (current?: string) => {
    const old = devicePointer()
    if (!old || old.create || old.session === current || replaced().some(entry => entry.session === old.session)) return
    const next = [{ session: old.session, directory: old.directory }, ...replaced()].slice(0, 10)
    setReplaced(next)
    try { localStorage.setItem(EARLIER, JSON.stringify(next)) } catch { /* remembered for this page */ }
  }
  const adopt = (view: PointerView) => {
    if (!view.session || !view.directory) return
    retire(view.session)
    if (devicePointer()?.session !== view.session) try { save({ session: view.session, directory: view.directory }) } catch { setPointer({ session: view.session, directory: view.directory }) }
  }
  // Placement (desk-pointer `placement`): with a remote home, input goes to the home's desk while it answers; when it
  // stays unreachable, to this device's own existing desk on this host ("fallback"). Each switch waits until no input
  // on the desk being left is in flight or of unknown outcome (the composer's own receipts for that exact session).
  const [placed, setPlaced] = createSignal<"home" | "fallback">("home")
  const [decision, setDecision] = createSignal<Placement>()
  let homeSeen: { up: boolean; since: number } | undefined
  let settled = ""
  const homeDesk = () => remote() ?? readJSON<DeskPointer>(HOME_DESK, value => typeof value?.session === "string" && typeof value?.directory === "string" && typeof value?.host?.id === "string")
  const place = (resolved: DeskHome) => {
    if (resolved.kind !== "remote" && resolved.kind !== "unreachable") return
    const up = resolved.kind === "remote"
    const now = Date.now()
    if (homeSeen?.up !== up) homeSeen = { up, since: now }
    const own = devicePointer()
    const local = own && !own.create ? own : undefined
    const left = placed() === "home" ? homeDesk() : local
    const unsettled = left && unresolvedSend(left.session, left.directory, undefined, placed() === "home" ? left.host : undefined) ? 1 : 0
    const next = placement({ homeUp: up, since: homeSeen.since, now, current: placed(), local, unsettled })
    setDecision(next)
    // Never a new conversation: without this device's own desk there is nothing to fall back to.
    return next === "fallback" && local ? "fallback" as const : "home" as const
  }
  /** `quiet`: a background re-read; it changes nothing on screen unless the home or the placement changed. */
  const verify = async (quiet = false) => {
    if (!quiet) setStatus("checking")
    // The chat waits on this, so a host read that hangs or fails must not leave it on "Loading chat…": after the
    // bound it continues as if no home were configured (this device's own desk), and a later check catches up.
    const resolved = await Promise.race([
      readHost().then(info => resolveHome(workFeedHosts(info))),
      new Promise<DeskHome>(resolve => setTimeout(() => resolve({ kind: "off" }), HOME_READ_LIMIT)),
    ]).catch((): DeskHome => ({ kind: "off" }))
    const where = place(resolved)
    const key = JSON.stringify([resolved.kind, where, resolved.kind === "remote" ? resolved.view.session ?? null : null])
    setHome(resolved)
    if (quiet && key === settled) return
    settled = key
    setPlaced(where ?? "home")
    if (where === "fallback") {
      setRemote(undefined)
      return verifyDevice()
    }
    if (resolved.kind === "unreachable") return setStatus("home-offline")
    if (resolved.kind === "remote") {
      setRemote(undefined)
      if (!resolved.view.session || !resolved.view.directory) return setStatus("remote-none")
      const value = { session: resolved.view.session, directory: resolved.view.directory, host: resolved.host }
      setRemote(value)
      try { localStorage.setItem(HOME_DESK, JSON.stringify(value)) } catch { /* reconciled this page only */ }
      try {
        setSession(await ocAt(resolved.host.base).session(value.session, value.directory))
        return setStatus("ready")
      } catch { return setStatus("unavailable") }
    }
    // A home with no desk yet starts a new conversation on first use (admit writes `create`); this device's earlier
    // desk is never imported, since the human chose a fresh Work desk on the home (front-desk:work-home:v1). Earlier
    // desks stay readable from their own hosts.
    if (resolved.kind === "local" && resolved.view.session) adopt(resolved.view)
    // This host's own conversation is offered, never claimed silently: the human either makes it the Work desk or
    // starts a new one (it stays readable under Earlier desks).
    if (resolved.kind === "local" && !resolved.view.session && devicePointer() && !devicePointer()!.create) {
      await verifyDevice()
      if (status() === "ready") return setStatus("home-claim")
      retire()
      try { save(undefined) } catch { setPointer(undefined) }
      return setStatus("none")
    }
    await verifyDevice()
  }
  /** Re-read the home now: it may have been turned on or off since this page loaded. */
  const freshHome = async () => {
    const resolved = await Promise.race([
      readHost().then(info => resolveHome(workFeedHosts(info))),
      new Promise<DeskHome>(resolve => setTimeout(() => resolve(home()), HOME_READ_LIMIT)),
    ]).catch(() => home())
    setHome(resolved)
    return resolved
  }
  /** On the home host with no Work desk yet: make this host's own conversation the Work desk (same session). */
  const claim = async () => {
    const own = devicePointer()
    const current = await freshHome()
    if (status() !== "home-claim" || !own || own.create || current.kind !== "local") return verify()
    const result = await writePointer({ expected_revision: current.view.revision, session: own.session, directory: own.directory, reason: "create" })
    if (!result.ok && !result.view) setError(`Could not make this ${DESK.name}: ${result.error}`)
    await verify()
  }
  /** On the home host with no Work desk yet: keep this host's conversation as an earlier desk and start a new one. */
  const startNew = (directory: string) => {
    if (status() !== "home-claim") return
    retire()
    try { save(undefined) } catch { setPointer(undefined) }
    setSession(undefined)
    setStatus("none")
    return start(directory)
  }
  onMount(() => void verify())
  const poll = setInterval(() => {
    const kind = home().kind
    if (kind === "remote" || kind === "unreachable" || placed() === "fallback") void verify(true)
  }, HOME_POLL)
  onCleanup(() => clearInterval(poll))
  const admit = async (value: DeskPointer & { create: CreateBody }) => {
    setStatus("creating")
    setError("")
    try {
      const created = await oc.createSession(value.directory, value.create)
      if (created.id !== value.session) throw new SessionCreateError("Core confirmed a different session than requested.", true)
      confirmed(created)
      // The home is read again: this page may have loaded before its host became the home.
      const current = await freshHome()
      // On the home host the new desk claims the profile's pointer; if another device won, its desk is adopted and
      // this one stays an ordinary session (nothing deleted).
      if (current.kind === "local") {
        const result = await writePointer({ expected_revision: current.view.revision, session: created.id, directory: created.directory, reason: "create" })
        if (!result.ok && result.view?.session && result.view.session !== created.id) { adopt(result.view); await verifyDevice() }
      }
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
    // A home elsewhere that appeared after this page loaded owns the desk: nothing is created here.
    const where = await freshHome()
    if (where.kind === "remote" || where.kind === "unreachable") return verify()
    const [agents, host] = await Promise.all([oc.agents(directory).catch(() => []), readHostModel()])
    const id = `ses_${descending()}`
    const value = {
      session: id, directory,
      create: {
        id,
        title: DESK.name,
        ...(agents.some(agent => agent.name === AGENT) ? { agent: AGENT } : {}),
        // Without a usable host model the agent's own resolution applies, and Core reports any failure.
        ...(host.available && host.model ? { model: { providerID: host.model.providerID, id: host.model.modelID } } : {}),
        // The desk answers and routes; it never edits files, whichever agent serves it.
        permission: [{ permission: "edit", pattern: "*", action: "deny" as const }],
      },
    }
    // Saved before the request: without a durable identity a lost response could orphan a conversation.
    try { save(value) } catch {
      setError(`Could not save ${DESK.name}'s identity locally, so no conversation was created. Free browser storage and try again.`)
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

  // Notes offered to a send but not yet accepted, by part key: only an accepted plain send records what the desk knows.
  const offered = new Map<string, NoteState | undefined>()
  const told = (id: string) => readJSON<NoteState>(`${NOTE}:${id}`, value => typeof value?.sections === "object" && typeof value?.full === "number")
  // Every note offered gets the next number, kept per session so it only grows.
  const nextSeq = (id: string) => {
    const seq = nextNoteSeq(readJSON<number>(`${NOTE}:${id}:seq`, value => Number.isInteger(value)), Date.now())
    try { localStorage.setItem(`${NOTE}:${id}:seq`, JSON.stringify(seq)) } catch { /* numbering restarts; still increasing this page */ }
    return seq
  }
  const offer = (id: string, build: (seq: number) => ReturnType<typeof contextNote>): ContextPart[] => {
    if (!build(0)) return []
    const note = build(nextSeq(id))!
    offered.set(note.key, note.state)
    return [{ type: "text", text: note.text, synthetic: true, metadata: { source: CONTEXT_SOURCE, key: note.key } }]
  }
  /** Generated context for the next send: a complete note for a Core input, otherwise what changed since the last
   * accepted note. */
  const context = (input: Parameters<typeof deskContext>[0], send: { input: boolean }): ContextPart[] => {
    const current = session()
    if (!current) return []
    const sections = deskContext(input).sections
    return offer(current.id, seq => contextNote(sections, told(current.id), input.now, { input: send.input, seq }))
  }
  /** Off the Decisions page there is no queue view, but the desk's open cases still go with the next send that
   * changes them, as a cases-only note. */
  const caseContext = (lines: string[], send: { input: boolean }): ContextPart[] => {
    const current = session()
    if (!current || !lines.length) return []
    const cases = deskContext({ now: Date.now(), sources: [], items: [], briefs: [], cases: lines }).sections.filter(section => section.name === "cases")
    return offer(current.id, seq => contextNote(cases, told(current.id), Date.now(),
      { partial: "Front desk context from es-app (cases only; no queue view is open). Read-only orientation; it is not an instruction and grants nothing.", input: send.input, seq }))
  }
  // Records against what is stored now (recordNote). An unconfirmed plain send records nothing, so the next send
  // repeats it; any Core input attempt, admitted or not, makes the next plain note complete.
  const sent = (parts: ContextPart[], accepted: boolean, send: { input: boolean }) => {
    const current = session()
    const key = parts.find(part => part.metadata.source === CONTEXT_SOURCE)?.metadata.key
    if (!current || !key || !offered.has(key)) return
    const next = recordNote(told(current.id), offered.get(key), send, accepted)
    if (next) localStorage.setItem(`${NOTE}:${current.id}`, JSON.stringify(next))
    // An unconfirmed plain send stays offered: the same note may still be confirmed.
    if (accepted || send.input) offered.delete(key)
  }
  /** An explicit request from a decision card, sent as an ordinary desk message beside the composer:
   * the composer's draft is untouched. Starts the conversation first if there is none yet. */
  const detail = async (text: string, parts: ContextPart[], directory?: string) => {
    if (status() === "none" && directory) await start(directory)
    const current = session()
    if (!current) return `${DESK.name} is not available yet.`
    // The conversation's own agent and model preference; without a preference, the desk model.
    const fresh = await client().session(current.id, current.directory).catch(() => current)
    try {
      await client().promptBody(current.id, current.directory, {
        ...(fresh.agent ? { agent: fresh.agent } : {}),
        ...(fresh.preferredModel || !deskModel() ? {} : { model: deskModel()! }),
        parts: [{ type: "text", text }, ...parts],
      })
    } catch (cause) {
      return `Not sent: ${cause instanceof Error ? cause.message : String(cause)}`
    }
  }
  // A remote home leaves this device's own pointer in place; it counts as an earlier desk until adopted elsewhere.
  const earlier = () => earlierDesks(home(), pointer()?.session,
    [...replaced(), ...(remote() && devicePointer() && !devicePointer()!.create ? [{ session: devicePointer()!.session, directory: devicePointer()!.directory }] : [])])
  const notice = () => status() === "ready" && sharedNotice(home(), pointer()?.session, earlier(), seen())
  const dismissNotice = () => {
    const current = pointer()?.session
    if (!current) return
    setSeen(current)
    try { localStorage.setItem(SHARED_SEEN, JSON.stringify(current)) } catch { /* shown again next page */ }
  }
  /** Is this the profile's Front Desk conversation: the current desk on its host, or this device's own desk (its
   * fallback when the home is unreachable). Identity comes from the pointers, never the title. */
  const isDesk = (sessionID: string, hostID?: string) =>
    (pointer()?.session === sessionID && pointer()?.host?.id === hostID)
    || (!hostID && devicePointer()?.session === sessionID && !devicePointer()?.create)
  return { pointer, home, placed, decision, isDesk, session, status, error, setError, verify, start, claim, startNew, confirm, forget, context, caseContext, sent, detail, earlier, notice, dismissNotice }
}

export type BriefJob = { id: string; directory: string; meta: BriefMeta; created: number; state: BriefState | { state: "starting" } | { state: "unconfirmed" } }
/** `model`: the host's desk model when the job was claimed; the prompt runs on it, never on a later host's. */
type PendingCreate = { id: string; directory: string; body: Parameters<typeof oc.createSession>[1] & { id: string }; packet: string; created: number; model?: DeskModel }

/** A brief made under the current contract for exactly this item revision: the newest attempt, except that
 * a ready one stays shown while a newer (regenerated) attempt is still being prepared. */
export const currentJob = (jobs: BriefJob[], item: DeskItem, pinned?: string) => {
  if (pinned) return jobs.find(job => job.id === pinned && job.meta.source === item.key)
  const attempts = jobs.filter(job => job.meta.source === item.key && job.meta.revision === item.revision && (job.meta.contract ?? 1) === BRIEF_CONTRACT)
    .toSorted((a, b) => b.created - a.created)
  const newest = attempts[0]
  if (!newest || newest.state.state === "ready" || newest.state.state === "failed") return newest
  return attempts.find(job => job.state.state === "ready") ?? newest
}
/** Only a ready brief that covers the canonical request may replace its text. */
export const completeBriefJob = (jobs: BriefJob[], item: DeskItem, pinned?: string) => {
  const job = currentJob(jobs, item, pinned)
  return job?.state.state === "ready" && briefComplete(job.state.result, item) ? job : undefined
}
/** A newer attempt than the brief shown is still being prepared (after Regenerate). */
export const regeneratingJob = (jobs: BriefJob[], item: DeskItem) => {
  const shown = currentJob(jobs, item)
  return jobs.some(job => job !== shown && job.meta.source === item.key && job.meta.revision === item.revision && (job.meta.contract ?? 1) === BRIEF_CONTRACT
    && shown && job.created > shown.created && (job.state.state === "running" || job.state.state === "starting"))
}

/** The brief the human saw when answering: the job recorded on the answer, else (older answers) the
 * newest ready brief made for the content they answered (`item.revision`). Never a brief for later content. */
export const answeredJob = (jobs: BriefJob[], item: DeskItem, answer?: { revision?: number; brief?: { job: string } | null } | null) => {
  if (answer?.brief?.job) return jobs.find(job => job.id === answer.brief!.job && job.meta.source === item.key)
  if (!answer) return
  return jobs.filter(job => job.meta.source === item.key && job.meta.revision === item.revision && job.state.state === "ready")
    .sort((a, b) => b.created - a.created)[0]
}

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
 *   attempt = how many jobs already exist for that source and revision (any contract),
 *   metadata.frontDesk = BriefMeta {kind:"brief", requestID, source: "attention:<editspace>:<record id>", revision, title, refs, contract};
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

/** `others`: the brief anchors of the host's other projects. A client prepares under the anchor of the project
 * in view, so a record's brief may sit under any of them; jobs are matched by their source, wherever they are. */
export const createBriefs = (desk: () => DeskPointer | undefined, current: (key: string) => DeskItem | undefined, ensure?: () => Promise<unknown>,
  others: () => DeskPointer[] = () => [], options: { client?: Pick<typeof oc, "children" | "status" | "messagesTail">; readOnly?: boolean; prefix?: string } = {}) => {
  const client = options.client ?? oc
  const [jobs, setJobs] = createSignal<BriefJob[]>([])
  const [error, setError] = createSignal("")
  // The underlying cause of a non-actionable read error: kept for diagnostics, not shown as a banner.
  const [detail, setDetail] = createSignal("")
  // A create whose response was lost. It keeps its client-chosen session ID, so confirming it
  // re-sends the identical request and Core returns the same session instead of a second one.
  const [pending, setPending] = createSignal(options.readOnly ? undefined : readJSON<PendingCreate>(PENDING, value => typeof value?.id === "string" && typeof value?.body?.id === "string"))
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
  // "unknown" is not settled: a job read between its prompt's admission and Core reporting it busy looks stopped,
  // and caching that would show "Brief stopped before finishing" beside a brief that finished moments later.
  const isSettled = (job: BriefJob) => ["ready", "failed"].includes(job.state.state)
  const absent = new Map<string, number>()
  const refresh = async (explicit = false) => {
    const target = desk()
    const local = () => pending() ? [pendingJob(pending()!)] : []
    // Other anchors are read only. One that does not exist (never used) is not asked again for a few minutes, so
    // N unused projects are not N reads per poll. Without this project's own anchor, those briefs still show.
    const elsewhere = others().filter(other => other.session !== target?.session && (absent.get(other.session) ?? 0) < Date.now())
    if (!target && !elsewhere.length) return setJobs(local())
    const current = ++generation
    try {
      const [children, status, ...extra] = await Promise.all([target ? client.children(target.session, target.directory) : [], target ? client.status(target.directory) : ({} as Awaited<ReturnType<typeof oc.status>>),
        ...elsewhere.map(other => Promise.all([client.children(other.session, other.directory), client.status(other.directory)])
          .catch(cause => { if (String(cause).includes("404")) absent.set(other.session, Date.now() + 300_000); return undefined }))])
      const statuses = Object.assign({}, ...extra.flatMap(value => value ? [value[1]] : []), status) as typeof status
      const seen = new Set<string>()
      const briefs = [...children, ...extra.flatMap(value => value?.[0] ?? [])].filter(child => !seen.has(child.id) && seen.add(child.id))
        .flatMap(child => { const meta = metaOf(child); return meta ? [{ child, meta }] : [] })
      const live = (id: string) => ["busy", "retry"].includes(statuses[id]?.type ?? "")
      const stale = briefs.filter(({ child }) => explicit || !settled.has(child.id) || live(child.id) || child.id === inflight())
      const read = await limited(stale, 4, ({ child, meta }) => client.messagesTail(child.id, child.directory, 4).then((messages): BriefJob => ({
        id: child.id, directory: child.directory, meta, created: child.time.created,
        state: briefState(meta, messages, statuses[child.id]?.type),
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
      if (target) setSynced(target.session)
      setError("")
      if (!options.readOnly) clearBackend("Brief checks")
    } catch (cause) {
      // Last-known brief states stay; a persisting failure also reaches the shared status.
      if (current === generation) { setError("Briefs could not be refreshed; showing the last known."); setDetail(String(cause)); if (!options.readOnly) reportBackend("Brief checks", cause) }
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
        if (cause.message.includes("HTTP 409")) { /* adopted above */ }
        else if (isTransient(cause)) reportBackend("Brief start", cause)
        else setError(`Brief not started (${describeFailure(cause)}).`)
      }
      setInflight(undefined)
      return refresh()
    }
    savePending(undefined)
    await oc.promptBody(child.id, child.directory, {
      // Older saved creates carry no model: the session keeps the one it was created with.
      ...(value.model ? { model: value.model } : {}),
      // Plain-text JSON: Core's message listing cannot yet encode stored json_schema formats.
      system: `${BRIEF_SYSTEM}\n${JSON.stringify(BRIEF_SCHEMA)}`,
      parts: [{ type: "text", text: value.packet }],
    }).catch(() => undefined) // The durable session shows whether the prompt was admitted.
    setInflight(undefined)
    settled.delete(child.id)
    await refresh()
  }
  // A job under an older brief contract is not reused: the next start makes a current one (a new attempt).
  const reusable = (item: DeskItem) => jobs().find(job => job.meta.source === item.key && job.meta.revision === item.revision && (job.meta.contract ?? 1) === BRIEF_CONTRACT && job.state.state !== "failed" && job.state.state !== "unknown")
  /** One read-only pass per exact source revision. An existing check for it is reused, not rerun. */
  const start = async (item: DeskItem) => {
    if (options.readOnly) return
    // A series question gets no brief of its own: one model call per question would fan out (attention S7).
    if (item.series || item.record?.series) return
    // A review item's artifact is its own explanation: no model call (attention ATTN-15).
    if (item.kind === "review") return
    if (pending() || preparing() || inflight()) return
    const existing = reusable(item)
    if (existing) return existing
    // Claimed synchronously, before the first await, so near-simultaneous starts make one check.
    setPreparing(true)
    try {
      if (!desk() && ensure) await ensure()
      const target = desk()
      if (!target) return
      const host = await readHostModel()
      if (!host.available || !host.model) {
        setError(`Briefs are unavailable on this host: ${host.reason}.`)
        return
      }
      const [tail, conversation] = await Promise.all([oc.messagesTail(item.source.session, item.source.directory, SOURCE_TAIL).catch(() => []), item.record ? readConversation(item.record) : undefined])
      // Re-read the canonical item: the source may have moved on while its thread was read.
      const latest = current(item.key)
      if (!latest || latest.revision !== item.revision) {
        setError("The source changed while the brief was being prepared. Nothing was started.")
        return
      }
      if (desk()?.session !== target.session || pending() || inflight() || reusable(latest)) return
      const packet = briefPacket(latest, tail, conversation?.threads ?? [], conversation?.documents ?? [])
      const meta: BriefMeta = { kind: "brief", requestID: crypto.randomUUID(), source: latest.key, revision: latest.revision, title: latest.title, refs: packet.refs, contract: BRIEF_CONTRACT, model: `${host.model.providerID}/${host.model.modelID}` }
      // Deterministic per (parent, source, revision, attempt): every client computes the same ID, so
      // Core's create reconciliation makes the first creator win and the rest adopt its job.
      const attempt = jobs().filter(job => job.meta.source === latest.key && job.meta.revision === latest.revision).length
      const id = await briefID(target.session, latest.key, latest.revision, attempt)
      const value: PendingCreate = {
        id, directory: target.directory, packet: packet.text, created: Date.now(), model: host.model,
        body: {
          id,
          parentID: target.session,
          title: `Brief: ${latest.title.slice(0, 60)}`,
          model: { providerID: host.model.providerID, id: host.model.modelID },
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
    if (options.readOnly) return
    const value = pending()
    if (value) await admit(value)
  }
  /** A fresh brief for an attention request's current content, made by the host that owns it (the same route
   * the phone uses). The previous brief stays shown until the new one is ready. */
  const [regenerating, setRegenerating] = createSignal(false)
  // `prefix`: another host's dashboard. A read-only reader may still ask that host to make a brief there.
  const regenerate = async (item: DeskItem) => {
    if (options.readOnly && options.prefix === undefined) return
    if (!item.record || item.kind === "review" || regenerating()) return
    setRegenerating(true)
    try {
      const response = await fetch(`${options.prefix ?? ""}/es/api/frontdesk/briefs/${encodeURIComponent(item.record.id)}/regenerate?es=${encodeURIComponent(item.record.editspace)}`, {
        method: "POST", credentials: "include", headers: { "content-type": "application/json", "X-Attention-CSRF": "1" }, body: "{}",
      })
      const body = await response.json().catch(() => ({})) as { error?: string }
      setError(response.ok ? "" : `Brief not regenerated: ${body.error ?? `HTTP ${response.status}`}.`)
    } catch {
      setError("Brief not regenerated: the dashboard is unreachable.")
    } finally {
      setRegenerating(false)
    }
    await refresh()
  }
  return { jobs, error, detail, pending, preparing, synced, refresh, start, confirm, regenerate, regenerating }
}

/** The original human conversation behind a record, read-only via the dashboard. Shared per record
 * revision so the card and its brief read it once; failure is a quiet empty result. */
type Conversation = { threads: ConversationThread[]; documents: ConversationDocument[]; error?: string }
const conversations = new Map<string, Promise<Conversation>>()
export const readConversation = (record: AttentionRecord) => {
  const key = `${record.editspace}\u0000${record.id}\u0000${record.revision}`
  const known = conversations.get(key)
  if (known) return known
  const read = fetch(`/es/api/frontdesk/conversation?es=${encodeURIComponent(record.editspace)}&record=${encodeURIComponent(record.id)}`, { credentials: "include" })
    .then(response => response.ok ? response.json() : { error: "Conversation unavailable." })
    .then((value): Conversation => ({ threads: Array.isArray(value?.threads) ? value.threads as ConversationThread[] : [],
      documents: Array.isArray(value?.documents) ? value.documents as ConversationDocument[] : [], ...(value?.error ? { error: String(value.error) } : {}) }))
    .catch((): Conversation => ({ threads: [], documents: [], error: "Conversation unavailable." }))
    // A failed read may be retried after a minute; a found conversation is kept for the revision.
    .then(value => { if (value.error) setTimeout(() => conversations.delete(key), 60_000); return value })
  conversations.set(key, read)
  return read
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
const MEMORY_RETRY_MS = 15_000
const absent = (cause: unknown) => /the dashboard has no memory endpoint|HTTP 501/.test(String(cause instanceof Error ? cause.message : cause))

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
      clearBackend("Front desk memory")
    } catch (cause) {
      setStatus("unavailable")
      setNotice(`Memory could not be read (${describeFailure(cause)}). Last-known notes are shown; nothing was changed.`)
      // A dashboard without memory is a fact shown in the panel; load trouble is shared status and retries.
      if (absent(cause)) return
      reportBackend("Front desk memory", cause)
      clearTimeout(retry)
      retry = setTimeout(() => void load(), MEMORY_RETRY_MS)
    }
  }
  let retry: ReturnType<typeof setTimeout> | undefined
  onCleanup(() => clearTimeout(retry))
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
  const [detail, setDetail] = createSignal("")
  const [target, setTarget] = createSignal<DeskPointer>()
  // True once the lookup settled: the parent exists (pointer set) or definitely does not yet.
  const [checked, setChecked] = createSignal(false)
  createEffect(() => {
    const root = directory()
    if (!root || target()?.directory === root) return
    void briefAnchorID(root).then(id => {
      setTarget({ session: id, directory: root })
      return oc.session(id, root).then(existing => { setPointer({ session: id, directory: existing.directory }); setChecked(true) },
        cause => { if (String(cause).includes("HTTP 404")) setChecked(true); else { setError("Briefs unavailable."); setDetail(String(cause)); reportBackend("Briefs", cause) } })
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
      setError("Briefs unavailable.")
      setDetail(cause instanceof Error ? cause.message : String(cause))
    }
  }
  return { pointer, error, detail, checked, ready: () => !!target(), ensure }
}
