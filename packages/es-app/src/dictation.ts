import { createStore, produce } from "solid-js/store"
import { getComposer, type ComposerBuffer, type ComposerDraft } from "./composer"
import type { SessionHost } from "./session-host"

/**
 * Operator dictation into a composer draft. The native shell owns capture and local
 * transcription behind `/__es/voice`; this owns the target and draft insertion only, so the
 * speech backend can change without touching composers. Text is never sent.
 *
 * A dictation is bound to its origin when recording starts: window origin (profile), host, session, directory,
 * draft buffer and caret. Its transcript lands only in that draft. If the person has moved to another draft by then
 * (another session, host or profile), it is held as a pending dictation on the original draft, to insert or discard
 * there; never inserted into whatever is open now.
 */
export type DictationTarget = {
  sessionID: string
  directory: string
  host?: SessionHost
  buffer: ComposerBuffer
  // Draft state when dictation started: where the text goes if the draft is untouched.
  revision: number
  selection: [number, number]
  /** Window origin (profile) when recording started. */
  origin?: string
  /** A non-composer field (a decision card's note), keyed like `decision-note:<editspace>:<id>`. */
  field?: string
}
/** A transcript held for its original draft because the person had moved elsewhere when it arrived. */
export type PendingDictation = { id: string; text: string; at: number }
export type DictationState = {
  // unsupported: no native bridge (web or paired clients); setup: bridge present, pipeline missing.
  availability: "unknown" | "unsupported" | "setup" | "ready"
  setup: string
  phase: "idle" | "starting" | "recording" | "transcribing"
  target: DictationTarget | null
  startedAt: number
  error: DictationError | null
  /** A short-lived outcome to show on the origin draft (cancelled, clip limit reached). */
  notice: { target: DictationTarget; text: string } | null
  /** Pending transcripts by draft key. */
  pending: Record<string, PendingDictation[]>
}
export type DictationError = {
  target: DictationTarget
  message: string
  detail?: string
  // The one recovery the error offers.
  action: "retry" | "settings" | null
}
// Inserts into a mounted, focused editor (one undoable edit); false falls back to the saved draft.
export type DictationEditor = (target: DictationTarget, text: string) => boolean
export type DictationDependencies = {
  fetch?: (url: string, init?: RequestInit) => Promise<Response>
  id?: () => string
  now?: () => number
  insert?: (target: DictationTarget, text: string) => number
  /** Window origin now (profile); defaults to location.origin. */
  origin?: () => string
  /** Longest clip; recording stops itself here. */
  maxClipMs?: number
  storage?: Pick<Storage, "getItem" | "setItem">
}

const PENDING_KEY = "es-app:dictation-pending:1"
const MAX_CLIP_MS = 5 * 60_000
export type Dictation = ReturnType<typeof createDictation>

export const createDictation = (dependencies: DictationDependencies = {}) => {
  const request = dependencies.fetch ?? ((url, init) => fetch(url, init))
  const id = dependencies.id ?? (() => crypto.randomUUID())
  const now = dependencies.now ?? (() => Date.now())
  const origin = dependencies.origin ?? (() => typeof location === "undefined" ? "" : location.origin)
  const storage = dependencies.storage ?? (typeof localStorage === "undefined" ? undefined : localStorage)
  const saved = (() => { try { return JSON.parse(storage?.getItem(PENDING_KEY) ?? "{}") as Record<string, PendingDictation[]> } catch { return {} } })()
  const fields = new Map<string, (text: string) => void>()
  const composerInsert =
    dependencies.insert ??
    ((target: DictationTarget, text: string) =>
      getComposer(target.sessionID, target.directory, target.host).insertDictation(target.buffer, target, text))
  const [state, setState] = createStore<DictationState>({
    availability: "unknown",
    setup: "",
    phase: "idle",
    target: null,
    startedAt: 0,
    error: null,
    notice: null,
    pending: saved && typeof saved === "object" ? saved : {},
  })
  const persistPending = () => { try { storage?.setItem(PENDING_KEY, JSON.stringify(state.pending)) } catch { /* kept for this page */ } }
  // The draft the person is in now (set by the mounted dictation control); undefined outside a UI.
  let view: string | undefined
  const insert = (target: DictationTarget, text: string) => {
    if (target.field) {
      const write = fields.get(target.field)
      if (write) { write(text); return 0 }
      hold(target, text)
      return 0
    }
    return composerInsert(target, text)
  }
  const hold = (target: DictationTarget, text: string) => {
    setState("pending", produce((pending) => { (pending[key(target)] ??= []).push({ id: id(), text, at: now() }) }))
    persistPending()
  }
  let clipTimer: ReturnType<typeof setTimeout> | undefined
  const editors = new Map<string, DictationEditor>()
  // The run whose result may still land; cancel clears it so a late transcript is dropped.
  const run: { id?: string } = {}
  const post = (action: "start" | "stop" | "cancel" | "settings", body: { id?: string } = {}) =>
    request(`/__es/voice/${action}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
  const result = async (response: Response) => {
    const body: unknown = await response.json().catch(() => undefined)
    return body && typeof body === "object"
      ? (body as { ok?: boolean; code?: string; message?: string; detail?: string; text?: string })
      : {}
  }
  const settle = (error?: DictationState["error"]) => {
    clearTimeout(clipTimer)
    setState({ phase: "idle", target: null, startedAt: 0, error: error ?? null })
  }

  const refresh = async () => {
    const response = await request("/__es/voice").catch(() => undefined)
    if (!response?.ok || !response.headers.get("content-type")?.includes("application/json")) {
      setState({ availability: "unsupported", setup: "" })
      return
    }
    const status = await result(response) as { available?: boolean; message?: string; state?: string; id?: string }
    setState({ availability: status.available ? "ready" : "setup", setup: status.available ? "" : status.message ?? "" })
    // A capture this renderer no longer tracks (reload) cannot deliver anywhere: stop it.
    if (status.id && status.state !== "idle" && status.id !== run.id) await post("cancel", { id: status.id }).catch(() => undefined)
  }

  const start = async (target: DictationTarget) => {
    if (state.phase !== "idle" || state.availability !== "ready") return
    const current = id()
    run.id = current
    setState({ phase: "starting", target: { ...target, origin: target.origin ?? origin(), host: target.host ? { ...target.host } : undefined, selection: [...target.selection] },
      startedAt: now(), error: null, notice: null })
    const response = await post("start", { id: current }).catch(() => undefined)
    // Cancelled while starting: the cancel may have reached the shell first, so repeat it.
    if (run.id !== current) {
      if (response?.ok) await post("cancel", { id: current }).catch(() => undefined)
      return
    }
    if (!response?.ok) {
      run.id = undefined
      const body = response ? await result(response) : {}
      if (body.code === "unavailable") setState({ availability: "setup", setup: body.detail ?? "" })
      return settle({
        target,
        message: body.message ?? "Couldn't record: Editspace didn't respond",
        detail: body.detail,
        action: body.code === "permission" ? "settings" : body.code === "busy" || body.code === "unavailable" ? null : "retry",
      })
    }
    setState({ phase: "recording", startedAt: now() })
    // A clip has a length bound: recording stops itself and transcribes what it has.
    clipTimer = setTimeout(() => {
      if (run.id !== current || state.phase !== "recording") return
      const bound = state.target
      void stop().then(() => { if (bound) setState("notice", { target: bound, text: "Stopped at the clip limit" }) })
    }, dependencies.maxClipMs ?? MAX_CLIP_MS)
  }

  const stop = async () => {
    const current = run.id
    const target = state.target
    if (!current || !target || state.phase !== "recording") return
    setState("phase", "transcribing")
    const response = await post("stop", { id: current }).catch(() => undefined)
    if (run.id !== current) return
    run.id = undefined
    const body = response ? await result(response) : {}
    if (!response?.ok || typeof body.text !== "string")
      return settle({
        target,
        message: body.message ?? "Couldn't transcribe: Editspace didn't respond",
        detail: body.detail,
        action: body.code === "empty" ? null : "retry",
      })
    settle()
    // Moved elsewhere (another draft, host or profile) since recording started: hold it on the origin draft.
    if ((target.origin ?? origin()) !== origin() || (view !== undefined && view !== key(target) && !target.field)) return hold(target, body.text)
    if (!editors.get(key(target))?.(target, body.text)) insert(target, body.text)
  }

  const cancel = async () => {
    const current = run.id
    if (!current) return
    run.id = undefined
    const target = state.target
    settle()
    if (target) setState("notice", { target, text: "Dictation cancelled" })
    await post("cancel", { id: current }).catch(() => undefined)
  }

  return {
    state,
    refresh,
    start,
    stop,
    cancel,
    toggle: (target: DictationTarget) => (state.phase === "idle" ? start(target) : owns(state.target, target) ? stop() : undefined),
    dismiss: () => setState({ error: null, notice: null }),
    /** The draft (or field) the person is in now; a transcript for another one is held as pending. */
    setView: (draft: Pick<DictationTarget, "sessionID" | "directory" | "host"> | undefined) => { view = draft ? key(draft) : undefined },
    pending: (draft: Pick<DictationTarget, "sessionID" | "directory" | "host">) => state.pending[key(draft)] ?? [],
    /** Inserts a held transcript into its draft at the draft's current caret, then forgets it. */
    acceptPending: (target: DictationTarget, pendingID: string) => {
      const item = (state.pending[key(target)] ?? []).find((entry) => entry.id === pendingID)
      if (!item) return
      setState("pending", produce((pending) => { pending[key(target)] = (pending[key(target)] ?? []).filter((entry) => entry.id !== pendingID) }))
      persistPending()
      if (!editors.get(key(target))?.(target, item.text)) insert(target, item.text)
    },
    discardPending: (draft: Pick<DictationTarget, "sessionID" | "directory" | "host">, pendingID: string) => {
      setState("pending", produce((pending) => { pending[key(draft)] = (pending[key(draft)] ?? []).filter((entry) => entry.id !== pendingID) }))
      persistPending()
    },
    /** A non-composer field (decision note) that takes transcripts while mounted. */
    attachField: (field: string, write: (text: string) => void) => {
      fields.set(field, write)
      return () => { if (fields.get(field) === write) fields.delete(field) }
    },
    owns,
    settings: () => post("settings").catch(() => undefined),
    /** A mounted composer editor that can take the text as one undoable edit. */
    attach: (draft: Pick<DictationTarget, "sessionID" | "directory" | "host">, editor: DictationEditor) => {
      editors.set(key(draft), editor)
      return () => {
        if (editors.get(key(draft)) === editor) editors.delete(key(draft))
      }
    },
  }
}

const key = (draft: Pick<DictationTarget, "sessionID" | "directory" | "host">) =>
  JSON.stringify([draft.sessionID, draft.directory, draft.host?.id ?? null])

const owns = (target: DictationTarget | null | undefined, draft: Pick<DictationTarget, "sessionID" | "directory" | "host">) =>
  !!target && key(target) === key(draft)

export const dictationTarget = (
  sessionID: string,
  directory: string,
  buffer: ComposerBuffer,
  draft: Pick<ComposerDraft, "revision" | "selection">,
  host?: SessionHost,
): DictationTarget => ({ sessionID, directory, host: host ? { ...host } : undefined, buffer, revision: draft.revision, selection: [...draft.selection] })

export const dictation = createDictation()

/** A decision card's note (or another field) as a dictation target. */
export const fieldTarget = (field: string): DictationTarget => ({ sessionID: `field:${field}`, directory: "", buffer: "task", revision: 0, selection: [0, 0], field })
