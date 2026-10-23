import { createStore } from "solid-js/store"
import { getComposer, type ComposerBuffer, type ComposerDraft } from "./composer"

/**
 * Operator dictation into a composer draft. The native shell owns capture and local
 * transcription behind `/__es/voice`; this owns the target and draft insertion only, so the
 * speech backend can change without touching composers. Text is never sent.
 */
export type DictationTarget = {
  sessionID: string
  directory: string
  buffer: ComposerBuffer
  // Draft state when dictation started: where the text goes if the draft is untouched.
  revision: number
  selection: [number, number]
}
export type DictationState = {
  // unsupported: no native bridge (web or paired clients); setup: bridge present, pipeline missing.
  availability: "unknown" | "unsupported" | "setup" | "ready"
  setup: string
  phase: "idle" | "starting" | "recording" | "transcribing"
  target: DictationTarget | null
  startedAt: number
  error: DictationError | null
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
}
export type Dictation = ReturnType<typeof createDictation>

export const createDictation = (dependencies: DictationDependencies = {}) => {
  const request = dependencies.fetch ?? ((url, init) => fetch(url, init))
  const id = dependencies.id ?? (() => crypto.randomUUID())
  const now = dependencies.now ?? (() => Date.now())
  const insert =
    dependencies.insert ??
    ((target: DictationTarget, text: string) =>
      getComposer(target.sessionID, target.directory).insertDictation(target.buffer, target, text))
  const [state, setState] = createStore<DictationState>({
    availability: "unknown",
    setup: "",
    phase: "idle",
    target: null,
    startedAt: 0,
    error: null,
  })
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
  const settle = (error?: DictationState["error"]) =>
    setState({ phase: "idle", target: null, startedAt: 0, error: error ?? null })

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
    setState({ phase: "starting", target: { ...target, selection: [...target.selection] }, startedAt: now(), error: null })
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
    if (!editors.get(key(target))?.(target, body.text)) insert(target, body.text)
  }

  const cancel = async () => {
    const current = run.id
    if (!current) return
    run.id = undefined
    settle()
    await post("cancel", { id: current }).catch(() => undefined)
  }

  return {
    state,
    refresh,
    start,
    stop,
    cancel,
    toggle: (target: DictationTarget) => (state.phase === "idle" ? start(target) : owns(state.target, target) ? stop() : undefined),
    dismiss: () => setState("error", null),
    owns,
    settings: () => post("settings").catch(() => undefined),
    /** A mounted composer editor that can take the text as one undoable edit. */
    attach: (draft: Pick<DictationTarget, "sessionID" | "directory">, editor: DictationEditor) => {
      editors.set(key(draft), editor)
      return () => {
        if (editors.get(key(draft)) === editor) editors.delete(key(draft))
      }
    },
  }
}

const key = (draft: Pick<DictationTarget, "sessionID" | "directory">) => JSON.stringify([draft.sessionID, draft.directory])

const owns = (target: DictationTarget | null | undefined, draft: Pick<DictationTarget, "sessionID" | "directory">) =>
  !!target && target.sessionID === draft.sessionID && target.directory === draft.directory

export const dictationTarget = (
  sessionID: string,
  directory: string,
  buffer: ComposerBuffer,
  draft: Pick<ComposerDraft, "revision" | "selection">,
): DictationTarget => ({ sessionID, directory, buffer, revision: draft.revision, selection: [...draft.selection] })

export const dictation = createDictation()
