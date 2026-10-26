import { batch } from "solid-js"
import { ascending } from "@opencode-ai/schema/identifier"
import { createStore, reconcile } from "solid-js/store"
import type {
  ExperimentalCapabilities,
  Session,
  SessionV1InputPayload,
  SessionV1InputReceipt,
  SessionV1InputUpdatePayload,
} from "@opencode-ai/sdk/v2"
import { oc, inputImages, type InputImage } from "./api"
import { HttpError, httpError, supersededError } from "./api-error"
import { composerStorage } from "./composer-storage"
import type { ContextPart } from "./api"
import { defaultImageCapability } from "./image-fit"
import { createImageStore, type ImageStore } from "./image-store"

export type ComposerMode = "send" | "aside" | "queue" | "steer"
export type ComposerAction = Exclude<ComposerMode, "send">
export type ComposerBuffer = "task" | "aside"
export type ComposerModel = { providerID: string; modelID: string }
export type ComposerImage = { id: string; mime: string; url: string; filename: string; normalized?: boolean }
export type ComposerDraft = {
  text: string
  images: ComposerImage[]
  model: ComposerModel | null
  selection: [number, number]
  revision: number
}
export type ComposerCapabilities = {
  sessionAside?: { version: number; cancel: boolean; images?: ImageCapability }
  sessionInput?: { version: number; delivery: string[]; list: boolean; cancel: boolean; update?: boolean; images?: ImageCapability }
}
export type ImageCapability = NonNullable<ExperimentalCapabilities["sessionInput"]["images"]> & {
  compressedMetadata: false
}
export type InputPayload = {
  readonly [Key in keyof SessionV1InputPayload]: Readonly<SessionV1InputPayload[Key]>
}
export type InputReceipt = SessionV1InputReceipt
export type AsideSnapshot = {
  capturedAt: number
  throughMessageID?: string
  excludedMessageCount: number
  activity: { status: "idle" | "busy" | "retry"; tools: { name: string; status: "running" | "pending" }[] }
}
export type AsideRequest = {
  requestID: string
  question: string
  images?: readonly InputImage[]
  status: "running" | "done" | "error" | "cancelled" | "unknown"
  text?: string
  snapshot?: AsideSnapshot
  error?: string
}
export type ComposerAdmission = {
  payload: InputPayload
  agent?: string
  draft?: ComposerDraft
  fence?: { successor: string; state: "pending" | "committed" }
  revision: number
  status: "sending" | "unknown"
  error?: string
  buffer?: ComposerBuffer
  targetRevision?: number
}
export type ComposerRecovery = {
  admission: ComposerAdmission
  model: ComposerModel | null
  agent: string | null
  missingImages?: boolean
  reconciled?: boolean
}
export type ComposerInputEdit = {
  text: string
  delivery: "queue" | "steer"
  expectedRevision: number
  command?: SessionV1InputUpdatePayload
  status: "editing" | "saving" | "unknown" | "conflict"
  open: boolean
  error: string
}
export type ComposerSuperseded = {
  successor: string
  state: "pending" | "committed"
  draft: ComposerDraft
  buffer: ComposerBuffer
  mode: ComposerMode
  complete?: boolean
}
export type ComposerState = {
  visibleBuffer: ComposerBuffer
  keyboardTarget: ComposerAction
  targetRevision: number
  mode: ComposerMode
  busy: boolean
  normalExplicit: boolean
  normalSubmission: {
    text: string
    images: number
    // Exact submitted images for the pending echo. Kept in memory only: the
    // draft and image store own durable copies, so a reload falls back to the count.
    previews?: readonly ComposerImage[]
    // The submitted draft, held in memory once the editor is cleared. While its buffer is
    // empty, saved snapshots write it there, so a reload still restores it (images included).
    draft?: ComposerDraft
    // Why the outcome is unknown; shown on the outgoing message rather than as a composer error.
    error?: string
    status: "sending" | "accepted" | "unknown"
    after?: string
    action?: ComposerAction
    /** Client-chosen user message ID; the only way to find an unconfirmed send again. */
    messageID?: string
    /** Draft revision the send was made from, so a confirmation clears only that draft. */
    revision?: number
    buffer?: ComposerBuffer
    /** Core is reachable and has no message with this ID: "Send again" is offered. */
    absent?: boolean
    checking?: boolean
  } | null
  task: ComposerDraft
  aside: ComposerDraft
  asideSeeded: boolean
  sending: boolean
  asideRequest: AsideRequest | null
  admission: ComposerAdmission | null
  recoveries: ComposerRecovery[]
  recoveryBusy: string | null
  recoveryError: string
  inputEdits: Record<string, ComposerInputEdit>
  superseded: ComposerSuperseded | null
  receipts: InputReceipt[]
  capabilities: ComposerCapabilities | null
  capabilityError: string
  modelSelection: { model: ComposerModel; status: "pending" | "unknown" } | null
  sessionModel: ComposerModel | null
  error: string
  storageError: string
  inputLoading: boolean
  hydrating: boolean
}
export type ComposerDependencies = {
  fetch?: (url: string, init?: RequestInit) => Promise<Response>
  prompt?: typeof oc.prompt
  /** Test seam for SEND_DEADLINE_MS. */
  sendDeadlineMs?: number
  storage?: Pick<Storage, "getItem" | "setItem"> | null
  images?: ImageStore
  requestID?: () => string
}
export type Composer = ReturnType<typeof createComposer>

const controllers = new Map<string, Composer>()
const storageKey = (sessionID: string, directory: string) =>
  `es-app:composer:1:${JSON.stringify([sessionID, directory])}`

export const getComposer = (sessionID: string, directory: string): Composer => {
  const key = storageKey(sessionID, directory)
  const cached = controllers.get(key)
  if (cached) return cached
  const composer = createComposer(sessionID, directory)
  controllers.set(key, composer)
  return composer
}

/**
 * First message of a session created by the draft New session page. The text is put in
 * the session's own composer draft and submitted there, so it is persisted with the draft
 * and the submission record before any request, and the composer's pending echo and
 * unknown-outcome handling apply. Returns false, sending nothing, if the draft cannot be
 * read back from storage.
 */
export const sendFirstMessage = async (
  session: Session,
  text: string,
  storage: () => Pick<Storage, "getItem"> | null = () =>
    typeof window === "undefined" ? null : composerStorage(navigator.userAgent, window.sessionStorage, () => window.localStorage),
) => {
  const composer = getComposer(session.id, session.directory)
  if (composer.state.normalSubmission) return true
  if (composer.state.task.text !== text) composer.setText(text)
  try {
    if (JSON.parse(storage()?.getItem(storageKey(session.id, session.directory)) ?? "null")?.task?.text !== text) return false
  } catch {
    return false
  }
  void composer.submitVisible("steer", session)
  return true
}

/**
 * Why a failed-turn Retry must wait: a human send whose admission is unresolved could
 * still land, and retrying first would reorder or obscure it. Reads saved state for
 * sessions whose composer is not open; unreadable saved state blocks like an unknown send.
 */
export const unresolvedSend = (
  sessionID: string,
  directory: string,
  storage: () => Pick<Storage, "getItem"> | null = () =>
    typeof window === "undefined" ? null : composerStorage(navigator.userAgent, window.sessionStorage, () => window.localStorage),
) => {
  const live = controllers.get(storageKey(sessionID, directory))
  if (live?.restoreError()) return "Saved composer state could not be restored. Check the conversation first."
  const saved = live ? undefined : readSubmission(storage, storageKey(sessionID, directory))
  if (saved === "unreadable") return "Saved composer state is unreadable. Open the session and check the conversation first."
  const submission = live ? live.state.normalSubmission : saved?.normalSubmission
  if (live?.state.sending || submission?.status === "sending") return "A message is still being sent."
  if (submission?.status === "unknown") return "A previous Send outcome is unknown. Check the conversation first."
  if (live ? live.state.admission : saved?.admission) return "An input admission is unresolved. Reconcile it first."
  return ""
}

// undefined = nothing saved for this session; "unreadable" = saved state exists or may exist but cannot be read.
const readSubmission = (storage: () => Pick<Storage, "getItem"> | null, key: string) => {
  try {
    const raw = storage()?.getItem(key)
    if (raw == null) return undefined
    const value: unknown = JSON.parse(raw)
    if (!value || typeof value !== "object") return "unreadable" as const
    return value as Partial<Pick<ComposerState, "normalSubmission" | "admission">>
  } catch {
    return "unreadable" as const
  }
}

/** A send with no answer by then is shown as not confirmed and stops blocking the composer. */
export const SEND_DEADLINE_MS = 25_000

export const createComposer = (sessionID: string, directory: string, dependencies: ComposerDependencies = {}) => {
  const request = dependencies.fetch ?? ((url, init) => fetch(url, init))
  const prompt = dependencies.prompt ?? oc.prompt
  const requestID = dependencies.requestID ?? (() => crypto.randomUUID())
  const imageStore = dependencies.images ?? createImageStore()
  const key = storageKey(sessionID, directory)
  const url = (path: string, query = "") =>
    `/oc/session/${encodeURIComponent(sessionID)}${path}?directory=${encodeURIComponent(directory)}${query}`
  const [state, setState] = createStore<ComposerState>({
    visibleBuffer: "task",
    keyboardTarget: "steer",
    targetRevision: 0,
    mode: "send",
    busy: false,
    normalExplicit: false,
    normalSubmission: null,
    task: emptyDraft(),
    aside: emptyDraft(),
    asideSeeded: false,
    sending: false,
    asideRequest: null,
    admission: null,
    recoveries: [],
    recoveryBusy: null,
    recoveryError: "",
    inputEdits: {},
    superseded: null,
    receipts: [],
    capabilities: null,
    capabilityError: "",
    modelSelection: null,
    sessionModel: null,
    error: "",
    storageError: "",
    inputLoading: false,
    hydrating: false,
  })
  const blank = (draft: ComposerDraft) => !draft.text && !draft.images.length
  const heldDraft = (buffer: ComposerBuffer) => {
    const held = state.normalSubmission
    return held?.draft && held.buffer === buffer && blank(state[buffer]) ? held.draft : state[buffer]
  }
  // Puts an in-flight message's draft back in an editor the user has not typed into since.
  const restoreSubmitted = (buffer: ComposerBuffer, draft: ComposerDraft) => {
    if (!blank(state[buffer])) return false
    // Setting the textarea value puts the caret at the end, so the saved selection does too.
    setState(buffer, { ...copyDraft(draft), selection: [draft.text.length, draft.text.length], revision: state[buffer].revision + 1 })
    return true
  }

  const tracked = new Set<string>()
  const cancelling = new Set<string>()
  const [missingImages, setMissingImages] = createStore({ task: false, aside: false, superseded: false })
  const imageWarning = () =>
    missingImages.task || missingImages.aside || missingImages.superseded
      ? "Some saved images could not be restored. Reattach or explicitly clear images in the affected draft before sending."
      : ""
  let asideAbort: AbortController | undefined
  let activeInput: string | undefined
  let capabilityVersion = 0
  let storage: ComposerDependencies["storage"]
  let restored = false
  let restoreError = ""
  let restoredRecord: Record<string, unknown> | undefined
  let missingAdmission = false
  try {
    storage =
      dependencies.storage === undefined
        ? typeof window === "undefined"
          ? null
          : composerStorage(navigator.userAgent, window.sessionStorage, () => window.localStorage)
        : dependencies.storage
    const raw = storage?.getItem(key)
    if (raw) {
      const saved: unknown = JSON.parse(raw)
      if (
        !record(saved) ||
        saved.version !== 1 ||
        !isDraft(saved.task) ||
        !isDraft(saved.aside) ||
        !isMode(saved.mode)
      ) {
        throw new Error("Invalid saved composer draft")
      }
      restoredRecord = saved
      if (saved.recoveries !== undefined) {
        if (!Array.isArray(saved.recoveries) || !saved.recoveries.every(isRecovery))
          throw new Error("Invalid saved input recovery journal")
        setState("recoveries", saved.recoveries.map((entry) => ({ ...entry,
          admission: { ...entry.admission, payload: { ...entry.admission.payload, images: [] },
            draft: entry.admission.draft ? { ...entry.admission.draft, images: [] } : undefined },
        })))
      }
      if (record(saved.inputEdits)) {
        Object.entries(saved.inputEdits).forEach(([id, edit]) => {
          if (isInputEdit(edit)) setState("inputEdits", id, { ...edit, status: edit.status === "saving" ? "unknown" : edit.status })
        })
      }
      setState({ task: { ...saved.task, images: [] }, aside: { ...saved.aside, images: [] }, mode: saved.mode, asideSeeded: saved.asideSeeded === true })
      setState({
        visibleBuffer:
          saved.directView === 1 && (saved.visibleBuffer === "task" || saved.visibleBuffer === "aside")
            ? saved.visibleBuffer
            : saved.mode === "aside"
              ? "aside"
              : "task",
        keyboardTarget: saved.directView === 1 && isAction(saved.keyboardTarget) ? saved.keyboardTarget : "steer",
        targetRevision:
          typeof saved.targetRevision === "number" && Number.isSafeInteger(saved.targetRevision)
            ? saved.targetRevision
            : 0,
      })
      setState(
        "normalExplicit",
        saved.normalExplicit === true ||
          (saved.normalExplicit === undefined &&
            saved.mode === "send" &&
            (!!saved.task.text || !!saved.task.images.length)),
      )
      if (
        record(saved.normalSubmission) &&
        typeof saved.normalSubmission.text === "string" &&
        typeof saved.normalSubmission.images === "number"
      ) {
        setState("normalSubmission", {
          text: saved.normalSubmission.text,
          images: saved.normalSubmission.images,
          status: saved.normalSubmission.status === "accepted" ? "accepted" : "unknown",
          ...(typeof saved.normalSubmission.after === "string" ? { after: saved.normalSubmission.after } : {}),
          ...(isAction(saved.normalSubmission.action) ? { action: saved.normalSubmission.action } : {}),
          ...(typeof saved.normalSubmission.messageID === "string" ? { messageID: saved.normalSubmission.messageID } : {}),
          ...(typeof saved.normalSubmission.revision === "number" ? { revision: saved.normalSubmission.revision } : {}),
          ...(saved.normalSubmission.buffer === "task" || saved.normalSubmission.buffer === "aside" ? { buffer: saved.normalSubmission.buffer } : {}),
        })
      }
      if (record(saved.modelSelection) && isModel(saved.modelSelection.model))
        setState("modelSelection", { model: saved.modelSelection.model, status: "unknown" })
      if (isModel(saved.sessionModel)) setState("sessionModel", saved.sessionModel)
      if (record(saved.missingImages)) {
        setMissingImages({ task: saved.missingImages.task === true, aside: saved.missingImages.aside === true,
          superseded: saved.missingImages.superseded === true })
        setState("storageError", imageWarning())
      }
      if (Array.isArray(saved.tracked))
        saved.tracked.filter((id): id is string => typeof id === "string").forEach((id) => tracked.add(id))
      if (saved.admission != null) {
        if (!isAdmission(saved.admission))
          throw new Error("Invalid saved input identity; do not resubmit without checking inputs")
        setState("admission", {
          ...saved.admission,
          payload: copyPayload({ ...saved.admission.payload, ...(saved.admission.payload.images ? { images: [] } : {}) } as unknown as InputPayload),
          draft: saved.admission.draft ? { ...saved.admission.draft, images: [] } : undefined,
          status: "unknown",
          error: "Admission needs reconciliation after reload.",
        })
        tracked.add(saved.admission.payload.requestID)
      }
      if (record(saved.superseded) && /^ses_[\w-]+$/.test(String(saved.superseded.successor)) &&
        saved.superseded.successor !== sessionID && (saved.superseded.state === "pending" || saved.superseded.state === "committed") &&
        isDraft(saved.superseded.draft) && (saved.superseded.buffer === "task" || saved.superseded.buffer === "aside") && isMode(saved.superseded.mode)) {
        setState("superseded", {
          successor: saved.superseded.successor as string,
          state: saved.superseded.state as "pending" | "committed",
          buffer: saved.superseded.buffer,
          mode: saved.superseded.mode,
          ...(saved.superseded.complete === false ? { complete: false } : {}),
          draft: { ...saved.superseded.draft, images: [] },
        })
      }
      if (
        record(saved.asideRequest) &&
        typeof saved.asideRequest.requestID === "string" &&
        typeof saved.asideRequest.question === "string"
      ) {
        setState("asideRequest", {
          requestID: saved.asideRequest.requestID,
          question: saved.asideRequest.question,
          ...(isSavedImages(saved.asideRequest.images) ? { images: [] } : {}),
          status: "unknown",
          error: "Aside completion is unknown after reload. Cancel this request before asking another.",
        })
      }
      restored = true
    }
  } catch (error) {
    restoreError = `Cannot restore saved drafts: ${message(error)}. Keep this tab open; saved request identity must be recovered before sending.`
    setState("storageError", restoreError)
    storage = null
  }

  let revision = 0
  let scheduled = false
  let savedRefs = recordRefs(restoredRecord)
  const pendingPuts = new Set<Promise<string>>()
  let hydration = Promise.resolve()
  let settingAside = false
  const missingRecoveries = new Set<string>()
  const unresolvedRecoveries = new Map<string, SavedRecovery>()
  const imageEdits = { task: 0, aside: 0 }
  const snapshot = () => ({
    version: 1,
    directView: 1,
    visibleBuffer: state.visibleBuffer,
    keyboardTarget: state.keyboardTarget,
    targetRevision: state.targetRevision,
    mode: state.mode,
    normalExplicit: state.normalExplicit,
    normalSubmission: state.normalSubmission ? { ...state.normalSubmission, previews: undefined, draft: undefined, checking: undefined } : null,
    modelSelection: state.modelSelection,
    sessionModel: state.sessionModel,
    task: copyDraft(heldDraft("task")),
    aside: copyDraft(heldDraft("aside")),
    asideSeeded: state.asideSeeded,
    admission: state.admission
      ? { ...state.admission, payload: copyPayload(state.admission.payload),
        ...(state.admission.draft ? { draft: copyDraft(state.admission.draft) } : {}), status: "unknown" }
      : null,
    recoveries: state.recoveries,
    inputEdits: state.inputEdits,
    superseded: state.superseded ? { ...state.superseded, draft: copyDraft(state.superseded.draft) } : null,
    asideRequest:
      state.asideRequest?.status === "running" || state.asideRequest?.status === "unknown"
        ? {
            requestID: state.asideRequest.requestID,
            question: state.asideRequest.question,
            images: state.asideRequest.images,
          }
        : null,
    missingImages: { ...missingImages },
    tracked: [...tracked],
  })
  const write = (saved: ReturnType<typeof snapshot>, strict = false) => {
    if (!storage) return false
    try {
      const content = JSON.stringify(saved)
      storage.setItem(key, content)
      if (strict && storage.getItem(key) !== content) throw new Error("Saved source drafts could not be verified")
      const refs = recordRefs(saved)
      const removed = [...savedRefs].filter((ref) => !refs.has(ref))
      savedRefs = refs
      if (removed.length) void Promise.allSettled([...pendingPuts]).then(() =>
        imageStore.remove(removed.filter((ref) => !savedRefs.has(ref)), key),
      ).catch((error) => setState("storageError", `Cannot remove saved images: ${message(error)}`))
      setState("storageError", imageWarning() || (imageStore.volatile && refs.size ? "Images remain in this tab only. Keep this tab open." : ""))
      return true
    } catch (error) {
      if (strict) {
        setState("storageError", `Cannot confirm saved source drafts: ${message(error)}. Keep this tab open.`)
        return false
      }
      // Drop draft copies only; uncertain requests must keep their exact submitted images.
      try {
        storage.setItem(
          key,
          JSON.stringify({
            ...saved,
            task: { ...saved.task, images: [] },
            aside: { ...saved.aside, images: [] },
            missingImages: {
              task: missingImages.task || !!state.task.images.length,
              aside: missingImages.aside || !!state.aside.images.length,
              superseded: missingImages.superseded,
            },
          }),
        )
        setState(
          "storageError",
          imageWarning() || "Images could not be saved and remain in this tab only. Keep this tab open.",
        )
        return true
      } catch {
        setState("storageError", `Drafts and request IDs could not be saved: ${message(error)}. Keep this tab open.`)
        return false
      }
    }
  }
  const persistAsync = async (strict = false, recovery?: ComposerRecovery): Promise<boolean> => {
    if (!storage) return false
    await hydration
    while (true) {
      const current = revision
      const saved = { ...snapshot(), ...(recovery ? { admission: null,
        recoveries: [...state.recoveries, recovery] } : {}) }
      const entries = [...saved.task.images, ...saved.aside.images, ...(saved.superseded?.draft.images ?? []), ...(saved.admission?.payload.images ?? []), ...(saved.admission?.draft?.images ?? []), ...(saved.asideRequest?.images ?? []), ...saved.recoveries.flatMap((entry) => [...(entry.admission.payload.images ?? []), ...(entry.admission.draft?.images ?? [])])]
      if (strict && entries.length && imageStore.volatile) {
        setState("storageError", "Cannot confirm saved source images: image storage is tab-only. Keep this tab open.")
        return false
      }
      const refs = new Map<string, Promise<string>>()
      try {
        await Promise.all(entries.map(async (image) => {
          if (!refs.has(image.url)) {
            const put = imageStore.put(image, key)
            pendingPuts.add(put)
            void put.then(() => pendingPuts.delete(put), () => pendingPuts.delete(put))
            refs.set(image.url, put)
          }
          await refs.get(image.url)
        }))
      } catch (error) {
        setState("storageError", `Images could not be saved and remain in this tab only: ${message(error)}`)
        return false
      }
      if (strict && entries.length && imageStore.volatile) {
        setState("storageError", "Cannot confirm saved source images: image storage is tab-only. Keep this tab open.")
        return false
      }
      if (current !== revision) continue
      const keys = new Map(await Promise.all([...refs].map(async ([url, promise]) => [url, await promise] as const)))
      const reference = (image: { url: string; mime: string; filename?: string; id?: string; normalized?: boolean }) => ({
        ref: keys.get(image.url)!, mime: image.mime, filename: image.filename,
        ...(image.id === undefined ? {} : { id: image.id }),
        ...(image.normalized === undefined ? {} : { normalized: image.normalized }),
      })
      if (strict && entries.length && imageStore.volatile) {
        setState("storageError", "Cannot confirm saved source images: image storage is tab-only. Keep this tab open.")
        return false
      }
      const result = write({
        ...saved,
        task: { ...saved.task, images: saved.task.images.map(reference) },
        aside: { ...saved.aside, images: saved.aside.images.map(reference) },
        superseded: saved.superseded ? { ...saved.superseded, draft: { ...saved.superseded.draft, images: saved.superseded.draft.images.map(reference) } } : null,
        admission: saved.admission ? { ...saved.admission,
          payload: { ...saved.admission.payload, images: saved.admission.payload.images?.map(reference) },
          ...(saved.admission.draft ? { draft: { ...saved.admission.draft, images: saved.admission.draft.images.map(reference) } } : {}),
        } : null,
        recoveries: saved.recoveries.map((entry) => unresolvedRecoveries.get(entry.admission.payload.requestID) ?? ({ ...entry, admission: { ...entry.admission,
          payload: { ...entry.admission.payload, images: entry.admission.payload.images?.map(reference) },
          ...(entry.admission.draft ? { draft: { ...entry.admission.draft, images: entry.admission.draft.images.map(reference) } } : {}),
        } })),
        asideRequest: saved.asideRequest ? { ...saved.asideRequest, images: saved.asideRequest.images?.map(reference) } : null,
      } as unknown as ReturnType<typeof snapshot>, strict)
      if (current === revision) return result
    }
  }
  const persist = () => {
    ++revision
    if (state.hydrating || heldDraft("task").images.length || heldDraft("aside").images.length || state.superseded?.draft.images.length || state.admission?.payload.images?.length || state.admission?.draft?.images.length || state.asideRequest?.images?.length || state.recoveries.some((entry) => entry.admission.payload.images?.length || entry.admission.draft?.images.length)) {
      if (!scheduled) {
        scheduled = true
        queueMicrotask(() => {
          scheduled = false
          void persistAsync()
        })
      }
      return !!storage
    }
    return write(snapshot())
  }
  if (restoredRecord) {
    const saved = restoredRecord
    const recoveries = Array.isArray(saved.recoveries) ? saved.recoveries.filter(isRecovery) : []
    const task = saved.task as SavedDraft
    const aside = saved.aside as SavedDraft
    const admission = isAdmission(saved.admission) ? saved.admission : undefined
    const submittedImages = admission?.draft?.images ?? []
    const requestImages = record(saved.asideRequest) && isSavedImages(saved.asideRequest.images) ? saved.asideRequest.images : []
    const supersededImages = record(saved.superseded) && isDraft(saved.superseded.draft) ? saved.superseded.draft.images : []
    const needsHydration = [...task.images, ...aside.images, ...supersededImages, ...(admission?.payload.images ?? []), ...submittedImages, ...requestImages, ...recoveries.flatMap((entry) => [...(entry.admission.payload.images ?? []), ...(entry.admission.draft?.images ?? [])])].some((image) => "ref" in image)
    if (needsHydration) setState("hydrating", true)
    if (!needsHydration) {
      setState("task", "images", task.images as ComposerImage[])
      setState("aside", "images", aside.images as ComposerImage[])
      if (state.superseded) setState("superseded", "draft", "images", supersededImages as ComposerImage[])
      if (admission && state.admission) setState("admission", "payload", copyPayload(admission.payload as unknown as InputPayload))
      if (admission?.draft && state.admission) setState("admission", "draft", copyDraft(admission.draft as ComposerDraft))
      setState("recoveries", recoveries as ComposerRecovery[])
      if (state.asideRequest && requestImages.length) setState("asideRequest", "images", inputImages(requestImages as unknown as InputImage[]))
      persist()
    } else hydration = (async () => {
      const resolveImages = async (images: readonly SavedImage[]) => {
        const result = await Promise.all(images.map(async (image) => {
          if ("url" in image) return image
          const blob = await imageStore.get(image.ref).catch(() => undefined)
          if (!blob || blob.mime !== image.mime) return undefined
          const { ref, ...metadata } = image
          return { ...metadata, url: blob.url }
        }))
        return { images: result.filter((image): image is NonNullable<typeof image> => !!image), missing: result.length !== result.filter(Boolean).length }
      }
      const [taskImages, asideImages, failedImages, admittedImages, draftImages, asideImagesRequest] = await Promise.all([
        resolveImages(task.images), resolveImages(aside.images), resolveImages(supersededImages), resolveImages(admission?.payload.images ?? []), resolveImages(submittedImages), resolveImages(requestImages),
      ])
      const resolvedRecoveries = await Promise.all(recoveries.map(async (entry) => {
        const payload = await resolveImages(entry.admission.payload.images ?? [])
        const draft = await resolveImages(entry.admission.draft?.images ?? [])
        if (payload.missing || draft.missing) {
          missingRecoveries.add(entry.admission.payload.requestID)
          unresolvedRecoveries.set(entry.admission.payload.requestID, { ...entry, missingImages: true })
        }
        return { ...entry, missingImages: payload.missing || draft.missing, admission: { ...entry.admission,
          payload: copyPayload({ ...entry.admission.payload, images: payload.images.map((image) => ({ ...image, type: "file" as const })) } as InputPayload),
          draft: entry.admission.draft ? { ...entry.admission.draft, images: draft.images as ComposerImage[] } : undefined,
        } }
      }))
      setState("recoveries", resolvedRecoveries)
      if (!imageEdits.task) setState("task", "images", taskImages.images.map((image) => ({ ...image, id: image.id ?? crypto.randomUUID() })) as ComposerImage[])
      if (!imageEdits.aside) setState("aside", "images", asideImages.images.map((image) => ({ ...image, id: image.id ?? crypto.randomUUID() })) as ComposerImage[])
      if (state.superseded) setState("superseded", "draft", "images", failedImages.images.map((image) => ({ ...image, id: image.id ?? crypto.randomUUID() })) as ComposerImage[])
      if (failedImages.missing) setMissingImages("superseded", true)
      if (!imageEdits.task && taskImages.missing) setMissingImages("task", true)
      if (!imageEdits.aside && asideImages.missing) setMissingImages("aside", true)
      if (admission && state.admission?.payload.requestID === admission.payload.requestID) {
        setState("admission", "payload", copyPayload({ ...admission.payload, ...(admission.payload.images ? { images: admittedImages.images.map((image) => ({ ...image, type: "file" as const })) as InputImage[] } : {}) } as InputPayload))
        if (admission.draft) setState("admission", "draft", { ...admission.draft, images: draftImages.images as ComposerImage[] })
        if (admittedImages.missing || draftImages.missing) {
          missingAdmission = true
          setState("admission", "error", "Saved images are missing. Reconcile or cancel this input; do not retry.")
        }
      }
      if (state.asideRequest && asideImagesRequest.images.length) setState("asideRequest", "images", inputImages(asideImagesRequest.images.map((image) => ({ ...image, type: "file" as const })) as InputImage[]))
      if (asideImagesRequest.missing) setState("asideRequest", "error", "Saved images are missing. Cancel this Aside; do not resubmit.")
      setState("hydrating", false)
      if (restored) persist()
    })()
  }
  const draftKey = () => (state.mode === "aside" ? "aside" : "task")
  let selectionChain = Promise.resolve()
  let sessionModelTime = 0
  let selectionVersion = 0
  let selectionBlocked = false
  const matchesModel = (session: Session, model: ComposerModel) =>
    session.preferredModel?.providerID === model.providerID && session.preferredModel.id === model.modelID
  const reconcileModel = async () => {
    const selection = state.modelSelection
    if (!selection) return true
    const version = selectionVersion
    try {
      const actual = await json<Session>(await request(url("")))
      if (version !== selectionVersion) return false
      if (!matchesModel(actual, selection.model)) throw new Error("Server model does not match this selection")
      sessionModelTime = actual.time.updated
      selectionBlocked = false
      setState({ modelSelection: null, sessionModel: { ...selection.model }, error: "" })
      if (state.task.model?.providerID === selection.model.providerID && state.task.model.modelID === selection.model.modelID)
        updateDraft({ model: null }, false, "task")
      persist()
      return true
    } catch (error) {
      if (version !== selectionVersion) return false
      setState("modelSelection", "status", "unknown")
      setState("error", `Model selection is unconfirmed: ${message(error)}. No task input was sent.`)
      persist()
      return false
    }
  }
  const chooseSessionModel = (model: ComposerModel) => {
    if (state.recoveryBusy) {
      setState("error", "Input recovery is in progress. Model selection was not changed; try again after recovery.")
      return Promise.resolve()
    }
    const target = { ...model }
    const version = ++selectionVersion
    setState({ modelSelection: { model: target, status: "pending" }, error: "" })
    persist()
    // Serialize PATCHes: a slow earlier response cannot overwrite a newer selection.
    const apply = async () => {
      if (selectionBlocked) return
      try {
        const actual = await json<Session>(await request(url(""), {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: target }),
        }))
        if (!matchesModel(actual, target)) throw new Error("Server returned a different model")
        sessionModelTime = actual.time.updated
        if (version !== selectionVersion) return
        setState({ modelSelection: null, sessionModel: target })
        if (state.task.model?.providerID === target.providerID && state.task.model.modelID === target.modelID)
          updateDraft({ model: null }, false, "task")
      } catch (error) {
        if (error instanceof HttpError && error.status < 500) {
          if (version !== selectionVersion) return
          setState("modelSelection", null)
          setState("error", `Model not selected: ${message(error)}. Draft kept.`)
          persist()
          return
        }
        const actual = await json<Session>(await request(url(""))).catch(() => null)
        if (actual && matchesModel(actual, target)) {
          sessionModelTime = actual.time.updated
          if (version === selectionVersion) {
            setState({ modelSelection: null, sessionModel: target, error: "" })
            if (state.task.model?.providerID === target.providerID && state.task.model.modelID === target.modelID)
              updateDraft({ model: null }, false, "task")
          }
          persist()
          return
        }
        selectionBlocked = true
        setState("modelSelection", "status", "unknown")
        setState("error", "Model selection is unconfirmed. No task input was sent; refresh before selecting again.")
        persist()
      }
    }
    selectionChain = selectionChain.then(apply, apply)
    return selectionChain
  }
  const updateDraft = (value: Partial<ComposerDraft>, revise = true, key: ComposerBuffer = draftKey()) => {
    const hadContent = !!state[key].text || !!state[key].images.length
    setState(key, { ...value, revision: state[key].revision + (revise ? 1 : 0) })
    if (key === state.visibleBuffer && hadContent && !state[key].text && !state[key].images.length) {
      setState({ keyboardTarget: "steer", targetRevision: state.targetRevision + 1 })
    }
    persist()
  }
  const clearTask = (revision: number, buffer: ComposerBuffer = "task", targetRevision?: number) => {
    if (state[buffer].revision !== revision) return
    setMissingImages(buffer, false)
    setState(buffer, { text: "", images: [], selection: [0, 0], revision: revision + 1 })
    if (buffer === state.visibleBuffer && targetRevision !== undefined && state.targetRevision === targetRevision) {
      setState({ keyboardTarget: "steer", targetRevision: state.targetRevision + 1 })
    }
  }
  const capabilityReason = (mode: ComposerMode) => {
    if (mode === "send") return ""
    if (!state.capabilities) return state.capabilityError || "Server capabilities have not loaded."
    if (mode === "aside") {
      const aside = state.capabilities.sessionAside
      return aside?.version === 1 && aside.cancel === true
        ? ""
        : "This server does not support cancellable Aside requests."
    }
    const input = state.capabilities.sessionInput
    return input?.version === 1 && input.list === true && input.cancel === true && input.delivery.includes(mode)
      ? ""
      : `This server does not support ${mode} inputs with listing and cancellation.`
  }
  const imageCapabilityReason = (mode: ComposerMode, images: readonly { mime: string; url: string }[]) => {
    if (!images.length || mode === "send") return ""
    const capability =
      mode === "aside" ? state.capabilities?.sessionAside?.images : state.capabilities?.sessionInput?.images
    if (!capability) return `This server does not support images for ${mode}. The draft is kept.`
    return imageReason(images, capability)
  }
  const blockedReason = (mode: ComposerMode = state.mode, buffer: ComposerBuffer = draftKey()) => {
    if (restoreError) return restoreError
    if (state.hydrating) return "Saved images are still loading. Wait before sending."
    if (state.superseded && mode !== "aside") return `Session superseded by ${state.superseded.successor}. Recover the draft in the successor explicitly.`
    const draft = state[buffer]
    if (missingImages[buffer])
      return "Images are missing from this restored draft. Reattach or explicitly clear images before sending."
    const unavailable = capabilityReason(mode)
    if (unavailable) return unavailable
    const media = imageCapabilityReason(mode, draft.images)
    if (media) return media
    if (mode === "aside") {
      if (state.asideRequest?.status === "running" || state.asideRequest?.status === "unknown")
        return "Cancel or resolve the current Aside before asking another."
      if (draft.text.length > 32_000) return "Aside questions are limited to 32,000 characters."
      return ""
    }
    const outgoing = outgoingReason(mode)
    if (outgoing) return outgoing
    if (state.recoveryBusy) return "Input recovery is in progress. Wait before sending another task message."
    if (state.modelSelection) return "Model selection is pending. Task messages wait for confirmation."
    if (mode === "send") return state.busy ? "Task busy. Normal Send is unavailable; choose Aside, Queue or Steer." : ""
    return ""
  }
  // A block caused by an input the transcript already shows as an outgoing bubble with its own cue.
  const outgoingReason = (mode: ComposerMode) => {
    if (mode === "aside") return ""
    if (state.sending) return "A task message is being sent."
    // An unconfirmed input is set aside (kept, same request ID) when the next message is sent,
    // and an unconfirmed Send never blocks the next one.
    if (state.admission && (state.admission.status !== "unknown" || state.admission.fence))
      return "Reconcile or retry the existing input before sending another task message."
    return ""
  }
  const accept = (receipt: InputReceipt, expectedID = receipt.requestID) => {
    if (receipt.sessionID !== sessionID || receipt.requestID !== expectedID)
      throw new Error("Input receipt identity did not match this request.")
    const recovery = state.recoveries.find((entry) => entry.admission.payload.requestID === receipt.requestID)
    if (recovery && (recovery.missingImages || !matchesRecovery(receipt, recovery)))
      throw new Error("Receipt does not match the saved exact input; admission remains unknown")
    if (recovery && !recovery.reconciled)
      setState("recoveries", (entry) => entry.admission.payload.requestID === receipt.requestID, "reconciled", true)
    const admission = state.admission
    if (
      admission?.payload.requestID === receipt.requestID &&
      (receipt.delivery !== admission.payload.delivery ||
        receipt.text !== admission.payload.text ||
         (!missingAdmission && !sameImages(receipt.images, admission.payload.images)) ||
        (admission.payload.agent !== undefined && receipt.agent !== admission.payload.agent))
    )
      throw new Error("Input ID belongs to a different payload. The draft was not cleared.")
    batch(() => {
      const previous = state.receipts.find((item) => item.requestID === receipt.requestID)
      if (!previous || (previous.state === "pending" && (receipt.revision ?? 0) >= (previous.revision ?? 0))) {
        const receipts = [...state.receipts.filter((item) => item.requestID !== receipt.requestID), receipt].sort(
          (a, b) => a.admittedSeq - b.admittedSeq,
        )
        const terminal = receipts.filter((item) => item.state !== "pending").slice(-50)
        setState(
          "receipts",
          reconcile(
            receipts.filter((item) => item.state === "pending" || terminal.includes(item)),
            { key: "requestID" },
          ),
        )
      }
      if ((previous?.state ?? receipt.state) === "pending" && receipt.state === "pending")
        tracked.add(receipt.requestID)
      else tracked.delete(receipt.requestID)
      if (admission?.payload.requestID === receipt.requestID) {
        clearTask(admission.revision, admission.buffer ?? "task", admission.targetRevision)
        setState("admission", null)
        missingAdmission = false
        activeInput = undefined
        setState("sending", false)
      }
    })
    if (!state.inputLoading) persist()
  }
  const readInput = async (id: string) => {
    if (state.hydrating) await hydration
    const response = await request(url(`/input/${encodeURIComponent(id)}`))
    if (response.status === 404) return null
    const receipt = await json<InputReceipt>(response)
    accept(receipt, id)
    return receipt
  }
  const loadCapabilities = async () => {
    const version = ++capabilityVersion
    // A refresh keeps known capabilities, so reopening a session does not disable and re-enable
    // its controls; only a failed read clears them.
    setState({ capabilityError: "" })
    try {
      const value = await json<unknown>(
        await request(`/oc/experimental/capabilities?directory=${encodeURIComponent(directory)}`),
      )
      if (!record(value)) throw new Error("Invalid server capabilities")
      const aside = value.sessionAside
      const input = value.sessionInput
      const capabilities: ComposerCapabilities = {}
      if (record(aside) && typeof aside.version === "number" && typeof aside.cancel === "boolean") {
        capabilities.sessionAside = {
          version: aside.version,
          cancel: aside.cancel,
          images: imageCapability(aside.images),
        }
      }
      if (
        record(input) &&
        typeof input.version === "number" &&
        typeof input.list === "boolean" &&
        typeof input.cancel === "boolean" &&
        Array.isArray(input.delivery) &&
        input.delivery.every((item) => typeof item === "string")
      ) {
        capabilities.sessionInput = {
          version: input.version,
          delivery: input.delivery,
          list: input.list,
          cancel: input.cancel,
          update: input.update === true,
          images: imageCapability(input.images),
        }
      }
      if (version === capabilityVersion) setState("capabilities", capabilities)
    } catch (error) {
      if (version === capabilityVersion)
        setState({ capabilities: null, capabilityError: `Cannot load server capabilities: ${message(error)}` })
    }
  }
  /** Look up an unconfirmed Send by its own message ID. Found: it was sent. 404 from a
   * reachable session: it never landed, and only then is "Send again" offered. */
  const checkSubmission = async () => {
    const submission = state.normalSubmission
    if (submission?.status !== "unknown" || !submission.messageID || submission.checking) return
    const id = submission.messageID
    setState("normalSubmission", "checking", true)
    try {
      const response = await request(url(`/message/${encodeURIComponent(id)}`))
      if (state.normalSubmission?.messageID !== id) return
      if (response.ok) {
        if (submission.revision !== undefined) clearTask(submission.revision, submission.buffer ?? "task")
        setState("normalSubmission", { status: "accepted", absent: false })
        return
      }
      if (response.status === 404 && (await request(url(""))).ok) setState("normalSubmission", "absent", true)
    } catch {
      // Still unreachable: stays unconfirmed and is checked again on the next refresh.
    } finally {
      if (state.normalSubmission?.messageID === id) setState("normalSubmission", "checking", false)
      persist()
    }
  }
  /** Explicit only: resend the same text under the same message ID after a fresh "not found". */
  const sendAgain = async (session: Session) => {
    const submission = state.normalSubmission
    if (submission?.status !== "unknown" || !submission.absent || !submission.messageID || state.sending) return
    const buffer = submission.buffer ?? "task"
    const draft = state[buffer]
    if (submission.images && (submission.revision !== draft.revision || draft.images.length !== submission.images)) {
      setState("error", "The draft changed since this message, so its images cannot be matched. Send the draft as a new message instead.")
      return
    }
    setState("normalSubmission", "absent", false)
    await checkSubmission()
    if (!state.normalSubmission?.absent || state.normalSubmission.messageID !== submission.messageID) return
    setState("sending", true)
    setState("normalSubmission", { status: "sending", absent: false })
    persist()
    try {
      await prompt(session, directory, submission.text, {
        images: submission.images ? draft.images : [], messageID: submission.messageID, signal: AbortSignal.timeout(dependencies.sendDeadlineMs ?? SEND_DEADLINE_MS),
      })
      if (submission.revision !== undefined) clearTask(submission.revision, buffer)
      setState("normalSubmission", "status", "accepted")
    } catch {
      setState("normalSubmission", "status", "unknown")
    } finally {
      setState("sending", false)
      persist()
    }
  }
  const refreshInputs = async () => {
    if (state.hydrating) await hydration
    void checkSubmission()
    if (state.inputLoading) return
    const input = state.capabilities?.sessionInput
    if (input?.version !== 1 || !input.list) return
    setState("inputLoading", true)
    try {
      let after: number | null = null
      const cursors = new Set<number>()
      do {
        const page: { items: InputReceipt[]; next: number | null } = await json(
          await request(url("/input", `&state=pending&limit=100${after === null ? "" : `&after=${after}`}`)),
        )
        page.items.forEach((receipt) => accept(receipt))
        after = page.next
        if (after !== null && (!Number.isSafeInteger(after) || cursors.has(after)))
          throw new Error("Invalid input pagination cursor")
        if (after !== null) cursors.add(after)
      } while (after !== null)
      // A pending-only list cannot tell us whether a previously seen input was promoted or cancelled.
      const ids = [...tracked]
      for (let index = 0; index < ids.length; index += 8) {
        const results = await Promise.allSettled(ids.slice(index, index + 8).map(readInput))
        const failed = results.find((result) => result.status === "rejected")
        if (failed?.status === "rejected") throw failed.reason
      }
      if (state.admission?.status === "unknown" && !missingAdmission)
        setState("admission", "error", "Input not found. Retry explicitly with the same request ID.")
      if (state.error.startsWith("Cannot refresh inputs:")) setState("error", "")
    } catch (error) {
      setState("error", `Cannot refresh inputs: ${message(error)}`)
    } finally {
      setState("inputLoading", false)
      persist()
    }
  }
  // Inputs whose POST got no answer before the deadline (a stalled server, not a refusal).
  const timedOut = new Set<string>()
  const admit = async (admission: ComposerAdmission) => {
    activeInput = admission.payload.requestID
    try {
      const receipt = await json<InputReceipt>(
        await request(url("/input"), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(admission.payload),
          signal: AbortSignal.timeout(dependencies.sendDeadlineMs ?? SEND_DEADLINE_MS),
        }),
      )
      accept(receipt, admission.payload.requestID)
    } catch (error) {
      if (state.admission?.payload.requestID !== admission.payload.requestID) return
      const superseded = supersededError(error, sessionID)
      if (superseded) {
        // /input writes its durable row before waking the runner. The wake may hit
        // the fence after admission, so the 409 alone cannot prove rejection.
        const receipt = await readInput(admission.payload.requestID).catch(() => null)
        if (receipt || state.admission?.payload.requestID !== admission.payload.requestID) return
        // Successor recovery moves the visible draft, so put the fenced input's draft back there.
        if (admission.draft) restoreSubmitted(admission.buffer ?? "task", admission.draft)
        setState("admission", {
          status: "unknown",
          fence: superseded,
          error: `Session fenced toward ${superseded.successor}. Admission is unconfirmed; reconcile this request ID before recovering the draft in another session.`,
        })
        return
      }
      if (error instanceof HttpError && [400, 401, 403, 404, 413, 415, 422].includes(error.status)) {
        tracked.delete(admission.payload.requestID)
        if (admission.draft) restoreSubmitted(admission.buffer ?? "task", admission.draft)
        setState({
          admission: null,
          error: `Input rejected: ${message(error)}. Draft kept; correct it before sending again.`,
        })
        return
      }
      if (error instanceof DOMException && error.name === "TimeoutError") timedOut.add(admission.payload.requestID)
      setState("admission", {
        status: "unknown",
        error: `Admission not confirmed: ${message(error)}. Reconcile before retrying.`,
      })
    } finally {
      if (activeInput === admission.payload.requestID) {
        activeInput = undefined
        setState("sending", false)
      }
      persist()
    }
  }
  const submit = async (
    session: Session,
    nextModel?: ComposerModel | null,
    direct?: { mode: ComposerMode; buffer: ComposerBuffer; targetRevision: number; action: ComposerAction },
    latestMessageID?: string,
    context?: readonly ContextPart[],
  ) => {
    if (state.hydrating) await hydration
    const mode = direct?.mode ?? state.mode
    const buffer = direct?.buffer ?? draftKey()
    // An earlier input whose outcome is unknown (including one restored after reload) never
    // blocks a new message: it moves to the set-aside list with its request ID, retry explicit only.
    if (mode !== "aside" && state.admission?.status === "unknown" && !state.admission.fence && !state.sending) await setAsideAdmission()
    if (mode !== "aside" && (state.sending || state.recoveryBusy || state.admission || state.superseded || restoreError || missingImages[buffer])) {
      if (!direct) setState("error", blockedReason(mode, buffer))
      return
    }
    const media = imageCapabilityReason(mode, state[buffer].images)
    if (media) {
      if (!direct) setState("error", media)
      return
    }
    if (mode !== "aside" && (state.modelSelection || state[buffer].model)) {
      if (state.modelSelection) await selectionChain
      if (state.modelSelection && !(await reconcileModel())) return
      if (state[buffer].model && (state.sessionModel?.providerID !== state[buffer].model?.providerID || state.sessionModel?.modelID !== state[buffer].model?.modelID))
        await chooseSessionModel(state[buffer].model!)
      if (state.modelSelection) return
      if (state.error.startsWith("Model not selected:")) return
    }
    const reason = blockedReason(mode, buffer)
    if (reason) {
      if (!direct) setState("error", reason)
      return
    }
    if (session.id !== sessionID) {
      setState("error", "Session does not match this composer.")
      return
    }
    const draft = copyDraft(state[buffer])
    const text = draft.text.trim()
    if (!text && !draft.images.length) return
    const images =
      mode !== "send" && draft.images.length
        ? inputImages(draft.images.map((image) => ({ ...image, mime: requireImageMime(image.mime) })))
        : undefined
    setState("error", "")
    // A new message replaces an earlier submission's row: an unconfirmed one stays findable
    // in the conversation by its ID, and is never resent implicitly.
    if (state.normalSubmission?.status === "accepted" || (mode === "send" && state.normalSubmission?.status === "unknown"))
      setState("normalSubmission", null)
    if (mode === "aside") {
      const id = requestID()
      const abort = new AbortController()
      asideAbort = abort
      setState("asideRequest", null)
      setState("asideRequest", { requestID: id, question: text, ...(images ? { images } : {}), status: "running" })
      if (!(images ? await persistAsync() : persist()) && images) {
        setState({
          asideRequest: null,
          error:
            "Cannot save the image Aside for recovery. No Aside was sent; draft kept. Free browser storage and try again.",
        })
        return
      }
      try {
        const result = await json<{ requestID: string; text: string; snapshot: AsideSnapshot }>(
          await request(url("/aside"), {
            method: "POST",
            headers: { "content-type": "application/json" },
            signal: abort.signal,
            body: JSON.stringify({
              requestID: id,
              question: text,
              ...(images ? { images } : {}),
              ...(draft.model ? { model: draft.model } : {}),
            }),
          }),
        )
        if (result.requestID !== id) throw new Error("Aside response identity did not match this request")
        if (state.asideRequest?.requestID !== id || abort.signal.aborted) return
        setState("asideRequest", { status: "done", text: result.text, snapshot: result.snapshot, error: undefined })
        if (direct) clearTask(draft.revision, buffer, direct.targetRevision)
      } catch (error) {
        if (state.asideRequest?.requestID !== id || abort.signal.aborted) return
        setState("asideRequest", {
          status: error instanceof HttpError && error.status < 500 ? "error" : "unknown",
          error: `${message(error)}${error instanceof HttpError && error.status < 500 ? "" : ". Aside completion is unknown; no retry was sent."}`,
        })
      } finally {
        persist()
      }
      return
    }
    setState("sending", true)
    if (mode === "send") {
      const submittedModel = draft.model ?? state.sessionModel ?? nextModel ?? null
      const messageID = `msg_${ascending()}`
      setState({
        normalExplicit: true,
        normalSubmission: {
          text,
          images: draft.images.length,
          ...(draft.images.length ? { previews: draft.images } : {}),
          draft: { ...draft, model: submittedModel },
          buffer,
          status: "sending",
          after: latestMessageID,
          ...(direct ? { action: direct.action } : {}),
          messageID,
          revision: draft.revision,
        },
      })
      // The outgoing bubble now shows the message, so the editor is cleared rather than showing it twice.
      if (draft.images.length) await persistAsync()
      else persist()
      clearTask(draft.revision, buffer, direct?.targetRevision)
      try {
        await prompt(state.sessionModel ? { ...session, preferredModel: { id: state.sessionModel.modelID, providerID: state.sessionModel.providerID } } : session, directory, text, {
          images: draft.images, model: state.sessionModel ? undefined : draft.model ?? nextModel ?? undefined, ...(context?.length ? { context } : {}),
          messageID, signal: AbortSignal.timeout(dependencies.sendDeadlineMs ?? SEND_DEADLINE_MS),
        })
        setState("normalSubmission", { status: "accepted", draft: undefined })
      } catch (error) {
        const superseded = supersededError(error, sessionID)
        if (superseded) restoreSubmitted(buffer, { ...draft, model: submittedModel })
        if (superseded) setState({
          normalSubmission: null,
          superseded: { ...superseded, draft: { ...draft, model: submittedModel }, buffer, mode },
          error: `Session superseded by ${superseded.successor}. Draft kept; recover explicitly in the successor.`,
        })
        else {
          // Not failed: it may still land. The draft goes back in the editor, the composer
          // unlocks, and the send is looked up by its ID whenever the session is reachable.
          // A confirmation clears the editor only if it still holds that restored draft.
          const restored = restoreSubmitted(buffer, { ...draft, model: submittedModel })
          setState("normalSubmission", {
            status: "unknown", error: message(error),
            ...(restored ? { draft: undefined, revision: state[buffer].revision } : {}),
          })
        }
      } finally {
        setState("sending", false)
        persist()
      }
      return
    }
    const admission: ComposerAdmission = {
      payload: Object.freeze({
        requestID: requestID(),
        delivery: mode,
        text,
        ...(images ? { images } : {}),
      }),
      revision: draft.revision,
      agent: session.agent,
      draft: { ...draft, model: draft.model ?? state.sessionModel ?? nextModel ?? null },
      status: "sending",
      ...(direct ? { buffer, targetRevision: direct.targetRevision } : {}),
    }
    tracked.add(admission.payload.requestID)
    setState("admission", admission)
    if (!(images ? await persistAsync() : persist()) && images) {
      tracked.delete(admission.payload.requestID)
      setState({
        admission: null,
        sending: false,
        error:
          "Cannot save the exact image input for retry. No input was sent; draft kept. Free browser storage and try again.",
      })
      return
    }
    clearTask(admission.revision, buffer, direct?.targetRevision)
    await admit(admission)
    // An unanswered input moves to the set-aside list (same request ID, checked on every refresh),
    // so it never blocks the next message.
    if (timedOut.has(admission.payload.requestID) && state.admission?.payload.requestID === admission.payload.requestID &&
      state.admission.status === "unknown" && !state.admission.fence)
      await setAsideAdmission()
  }
  const retryAdmission = async () => {
    if (state.hydrating) await hydration
    if (!state.admission || state.sending) return
    if (missingAdmission) {
      setState("error", "Saved images are missing. Reconcile or cancel this input; do not retry.")
      return
    }
    const admission = { ...state.admission, payload: copyPayload(state.admission.payload),
      ...(state.admission.draft ? { draft: copyDraft(state.admission.draft) } : {}) }
    const reason = capabilityReason(admission.payload.delivery)
    if (reason) {
      setState("error", reason)
      return
    }
    setState({ sending: true, error: "" })
    activeInput = admission.payload.requestID
    try {
      if (await readInput(admission.payload.requestID)) return
      if (state.admission?.payload.requestID !== admission.payload.requestID) return
      const media = imageCapabilityReason(admission.payload.delivery, admission.payload.images ?? [])
      if (media) {
        setState("error", media)
        return
      }
      if (admission.payload.images?.length && !(await persistAsync())) {
        setState("error", "Cannot save the exact image input for retry. No retry was sent; keep this tab open.")
        return
      }
      setState("admission", { status: "sending", error: undefined })
      await admit(admission)
    } catch (error) {
      if (state.admission?.payload.requestID === admission.payload.requestID) {
        setState("admission", {
          status: "unknown",
          error: `Reconciliation failed; no retry was sent: ${message(error)}`,
        })
      }
    } finally {
      if (activeInput === admission.payload.requestID) {
        activeInput = undefined
        setState("sending", false)
      }
      persist()
    }
  }
  const setAsideAdmission = async () => {
    if (state.hydrating) await hydration
    const admission = state.admission
    if (!admission || admission.status !== "unknown" || state.sending || missingAdmission || settingAside) return
    settingAside = true
    // One verified snapshot commits both the current unsent editor and recovery
    // identity. Images use the same owned blob references as other saved drafts.
    try {
      if (!storage) throw new Error("Durable local storage is unavailable")
      const entry: ComposerRecovery = {
        admission: { ...admission, payload: copyPayload(admission.payload),
          ...(admission.draft ? { draft: copyDraft(admission.draft) } : {}), status: "unknown" },
        model: admission.draft?.model ? { ...admission.draft.model } : null,
        agent: admission.agent ?? admission.payload.agent ?? null,
      }
      if (!(await persistAsync(true, entry))) throw new Error("Current draft and recovery could not be durably saved")
      if (state.admission?.payload.requestID !== admission.payload.requestID) return
      setState("recoveries", [...state.recoveries, entry])
      // Do not clear or restore the editor: it may contain a newer unsent draft.
      setState({ admission: null, recoveryError: "", error: "" })
      missingAdmission = false
      persist()
    } catch (error) {
      setState("recoveryError", `Cannot save this unknown input for recovery: ${message(error)}. Keep this tab open; input was not dismissed.`)
    } finally {
      settingAside = false
    }
  }
  const recoverAdmission = async (id: string, retry = false) => {
    if (state.hydrating) await hydration
    if (state.recoveryBusy) return
    const entry = state.recoveries.find((item) => item.admission.payload.requestID === id)
    if (!entry) return
    if (retry && (state.modelSelection || state.sending)) {
      setState("recoveryError", "Model selection or task submission is in progress or unconfirmed. No recovery retry sent; wait and check again.")
      return
    }
    setState({ recoveryBusy: id, recoveryError: "" })
    try {
      if (entry.missingImages || missingRecoveries.has(id)) throw new Error("Saved recovery images are missing. No retry was sent; retain the original request ID.")
      const response = await request(url(`/input/${encodeURIComponent(id)}`))
      if (response.status !== 404) {
        accept(await json<InputReceipt>(response), id)
        return
      }
      if (!retry) {
        setState("recoveryError", "Input not found. Its admission is still unknown; no retry was sent.")
        return
      }
      if (entry.admission.fence) throw new Error("Session was superseded; retry is unavailable")
      const reason = capabilityReason(entry.admission.payload.delivery) || imageCapabilityReason(entry.admission.payload.delivery, entry.admission.payload.images ?? [])
      if (reason) throw new Error(reason)
      if (!entry.model) throw new Error("Original model is unknown. No retry sent; check the original input instead.")
      const session = await json<Session>(await request(url("")))
      const selected = session.preferredModel ?? session.model
      if (session.id !== sessionID || selected?.providerID !== entry.model.providerID || selected.id !== entry.model.modelID)
        throw new Error("Original model no longer matches the session model. No retry sent; model selection and current draft were not changed.")
      if (!entry.admission.payload.agent && (!entry.agent || session.agent !== entry.agent))
        throw new Error("Original agent no longer matches the session agent. No retry sent; current draft was not changed.")
      // Only an explicit retry after a successful not-found check may POST.
      accept(await json<InputReceipt>(await request(url("/input"), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(entry.admission.payload),
      })), id)
    } catch (error) {
      setState("recoveryError", `Recovery outcome unknown: ${message(error)}. Exact request kept; no automatic retry.`)
    } finally {
      setState("recoveryBusy", null)
    }
  }
  const editInput = (id: string) => {
    const receipt = state.receipts.find((item) => item.requestID === id)
    if (!state.capabilities?.sessionInput?.update || receipt?.state !== "pending" || receipt.source) return
    // The main composer edits one pending input at a time; other edits keep their text, closed.
    // An update in flight or with an unknown outcome stays on screen until resolved.
    const others = Object.keys(state.inputEdits).filter((other) => other !== id && state.inputEdits[other]!.open)
    if (others.some((other) => ["saving", "unknown"].includes(state.inputEdits[other]!.status))) return
    others.forEach((other) => setState("inputEdits", other, "open", false))
    const previous = state.inputEdits[id]
    setState("inputEdits", id, previous ? { ...previous, open: true } : {
      text: receipt.text, delivery: receipt.delivery, expectedRevision: receipt.revision ?? 0,
      status: "editing", open: true, error: "",
    })
    persist()
  }
  const saveInput = async (id: string) => {
    const edit = state.inputEdits[id]
    if (!edit || edit.status === "saving" || edit.status === "conflict" || !state.capabilities?.sessionInput?.update) return
    const receipt = state.receipts.find((item) => item.requestID === id)
    if ((!edit.command && receipt?.state !== "pending") || receipt?.source) {
      setState("inputEdits", id, { status: "conflict", error: `Input is ${receipt?.state ?? "unavailable"}; your edit is kept.` })
      return
    }
    // Retrying an uncertain update must reuse its exact command, never re-admit.
    const previous = edit.command
    const command = previous ?? {
      commandID: requestID(), expectedRevision: edit.expectedRevision, text: edit.text, delivery: edit.delivery,
    }
    setState("inputEdits", id, { command, status: "saving", error: "" })
    if (!(await persistAsync(true))) {
      setState("inputEdits", id, { status: previous ? "unknown" : "editing", command: previous, error: "Cannot save the update identity locally. No update sent; edit kept." })
      return
    }
    try {
      const response = await request(url(`/input/${encodeURIComponent(id)}`), {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(command),
      })
      if (response.status === 409) {
        // Read authoritative state, including servers which omit the conflict body.
        await readInput(id)
        setState("inputEdits", id, { status: "conflict", error: "Input was picked up or changed elsewhere. Your edit is kept; nothing was resent." })
        return
      }
      if ([400, 422].includes(response.status) || (!previous && [401, 403, 404, 413, 415].includes(response.status))) {
        setState("inputEdits", id, { status: "editing", command: undefined,
          error: `Update rejected: ${message(await httpError(response))}. Edit kept.` })
        return
      }
      const result = await json<InputReceipt>(response)
      accept(result, id)
      setState("inputEdits", id, { status: "editing", open: false, command: undefined,
        expectedRevision: result.revision ?? command.expectedRevision + 1 })
    } catch (error) {
      setState("inputEdits", id, { status: "unknown", error: `Update not confirmed (${message(error)}). Retry sends the same update.` })
    } finally {
      persist()
    }
  }
  const cancelInput = async (id: string) => {
    if (state.hydrating) await hydration
    if (cancelling.has(id)) return
    const input = state.capabilities?.sessionInput
    if (input?.version !== 1 || !input.cancel || !input.list) {
      setState("error", "Input cancellation is unavailable.")
      return
    }
    cancelling.add(id)
    setState("error", "")
    try {
      const response = await request(url(`/input/${encodeURIComponent(id)}`), { method: "DELETE" })
      if (response.status === 409) {
        const receipt = await readInput(id)
        setState(
          "error",
          receipt
            ? `Input is ${receipt.state}; cancellation was not applied.`
            : "Input no longer found; cancellation was not confirmed.",
        )
        return
      }
      accept(await json<InputReceipt>(response), id)
    } catch (error) {
      setState("error", `Input cancellation not confirmed: ${message(error)}. Refresh inputs to reconcile.`)
    } finally {
      cancelling.delete(id)
    }
  }
  const cancelAside = async () => {
    const current = state.asideRequest
    if (
      !current ||
      (current.status !== "running" && current.status !== "unknown") ||
      cancelling.has(`aside:${current.requestID}`)
    )
      return
    const id = current.requestID
    const abort = asideAbort
    cancelling.add(`aside:${id}`)
    try {
      const cancelled = await json<boolean>(
        await request(url(`/aside/${encodeURIComponent(id)}`), {
          method: "DELETE",
          signal: new AbortController().signal,
        }),
      )
      if (state.asideRequest?.requestID !== id || state.asideRequest.status === "done") return
      if (typeof cancelled !== "boolean") throw new Error("The server did not confirm cancellation")
      setState(
        "asideRequest",
        cancelled
          ? { status: "cancelled", error: undefined }
          : {
              status: "error",
              error: "No active Aside remains. Its answer is unavailable; cancellation did not stop an active request.",
            },
      )
      abort?.abort()
    } catch (error) {
      if (state.asideRequest?.requestID !== id || state.asideRequest.status === "done") return
      setState("asideRequest", {
        status: "unknown",
        error: `Aside cancellation not confirmed: ${message(error)}. The parent task was not stopped.`,
      })
    } finally {
      cancelling.delete(`aside:${id}`)
      persist()
    }
  }
  const closeAside = async () => {
    const id = state.asideRequest?.requestID
    if (state.asideRequest?.status === "running" || state.asideRequest?.status === "unknown") await cancelAside()
    if (
      state.asideRequest?.requestID !== id ||
      state.asideRequest?.status === "running" ||
      state.asideRequest?.status === "unknown"
    )
      return
    setState("asideRequest", null)
    persist()
  }
  const selectMode = (mode: ComposerMode) => {
    batch(() => {
      if (mode === "aside" && !state.asideSeeded) {
        setState("aside", copyDraft(state.task))
        setMissingImages("aside", missingImages.task)
        setState("asideSeeded", true)
      }
      setState({ mode, normalExplicit: mode === "send", error: "" })
    })
    persist()
  }
  let recovering = false
  // The caller owns the confirmation UI. Its callback receives the proposed drafts
  // (including the rejected snapshot) before any destination draft is changed.
  const recoverHandoffDrafts = async (
    predecessor: { state: ComposerState; hydrated: Promise<void>; persistForRecovery: () => Promise<boolean> },
    confirm: (drafts: { task: ComposerDraft; aside: ComposerDraft }) => boolean | Promise<boolean>,
  ): Promise<boolean> => {
    if (recovering) return false
    recovering = true
    try {
      await Promise.all([hydration, predecessor.hydrated])
      const source = predecessor.state
      const safe = () => !state.hydrating && !source.hydrating && !restoreError && !!storage && !state.superseded &&
        source.superseded?.complete !== false &&
        !state.sending && !state.admission && !state.modelSelection && state.normalSubmission?.status !== "unknown" &&
        state.normalSubmission?.status !== "sending" && !state.asideRequest?.status?.match(/^(running|unknown)$/) &&
        !source.sending && !source.admission && !source.modelSelection && source.normalSubmission?.status !== "unknown" &&
        source.normalSubmission?.status !== "sending" && !source.asideRequest?.status?.match(/^(running|unknown)$/) &&
        !missingImages.task && !missingImages.aside && !source.storageError.includes("could not be restored")
      if (!safe() || source === state) return false
      const current = JSON.stringify([snapshot(), state.sessionModel, state.sending, state.busy, missingImages])
      const sourceVersion = () => JSON.stringify([source.task, source.aside, source.mode, source.visibleBuffer,
        source.keyboardTarget, source.asideSeeded, source.normalExplicit, source.sessionModel,
        source.sending, source.admission, source.normalSubmission, source.modelSelection, source.asideRequest,
        source.superseded])
      const original = sourceVersion()
      const drafts = {
        task: { ...copyDraft(source.task), model: source.task.model ? { ...source.task.model } : source.sessionModel ? { ...source.sessionModel } : null },
        aside: copyDraft(source.aside),
      }
      if (source.superseded) {
        drafts[source.superseded.buffer] = copyDraft(source.superseded.draft)
      }
      if (!(await confirm({ task: copyDraft(drafts.task), aside: copyDraft(drafts.aside) }))) return false
      if (!safe() || current !== JSON.stringify([snapshot(), state.sessionModel, state.sending, state.busy, missingImages]) || original !== sourceVersion()) return false
      if (!(await predecessor.persistForRecovery())) return false
      if (!safe() || current !== JSON.stringify([snapshot(), state.sessionModel, state.sending, state.busy, missingImages]) || original !== sourceVersion()) return false
      if (drafts.task.images.length || drafts.aside.images.length) {
        if (imageStore.volatile) {
          setState("storageError", "Cannot recover images: destination image storage is tab-only. Existing drafts kept.")
          return false
        }
      }
      const saved = {
        ...snapshot(),
        task: drafts.task,
        aside: drafts.aside,
        mode: source.superseded?.mode ?? source.mode,
        visibleBuffer: source.superseded?.buffer ?? source.visibleBuffer,
        keyboardTarget: source.superseded
          ? source.superseded.mode === "aside" ? "aside" : source.superseded.mode === "queue" ? "queue" : "steer"
          : source.keyboardTarget,
        targetRevision: state.targetRevision + 1,
        asideSeeded: source.asideSeeded,
        normalExplicit: source.superseded ? source.superseded.mode === "send" : source.normalExplicit,
      }
      const refs: string[] = []
      try {
        const reference = async (image: ComposerImage) => {
          const ref = await imageStore.put(image, key)
          refs.push(ref)
          return { ref, id: image.id, mime: image.mime, filename: image.filename, ...(image.normalized === undefined ? {} : { normalized: image.normalized }) }
        }
        const [taskImages, asideImages] = await Promise.all([
          Promise.all(drafts.task.images.map(reference)), Promise.all(drafts.aside.images.map(reference)),
        ])
        if ((taskImages.length || asideImages.length) && imageStore.volatile) {
          setState("storageError", "Cannot recover images: destination image storage is tab-only. Existing drafts kept.")
          return false
        }
        if (!safe() || current !== JSON.stringify([snapshot(), state.sessionModel, state.sending, state.busy, missingImages]) || original !== sourceVersion()) return false
        // Commit references before touching in-memory state. This path must not use write's image-dropping quota fallback.
        const persisted = { ...saved, task: { ...saved.task, images: taskImages }, aside: { ...saved.aside, images: asideImages } }
        const content = JSON.stringify(persisted)
        storage!.setItem(key, content)
        if (storage!.getItem(key) !== content) throw new Error("Recovered drafts could not be verified")
        const previousRefs = savedRefs
        savedRefs = recordRefs(persisted)
        const removed = [...previousRefs].filter((ref) => !savedRefs.has(ref))
        if (removed.length) void imageStore.remove(removed, key).catch((error) => setState("storageError", `Cannot remove saved images: ${message(error)}`))
        ++revision
        batch(() => {
          setState("task", drafts.task)
          setState("aside", drafts.aside)
          setState({ mode: saved.mode, visibleBuffer: saved.visibleBuffer, keyboardTarget: saved.keyboardTarget,
            targetRevision: saved.targetRevision, asideSeeded: saved.asideSeeded,
            normalExplicit: saved.normalExplicit, storageError: "" })
        })
        return true
      } finally {
        const unused = refs.filter((ref) => !savedRefs.has(ref))
        if (unused.length) await imageStore.remove(unused, key).catch(() => {})
      }
    } catch (error) {
      setState("storageError", `Cannot recover handoff drafts: ${message(error)}. Existing drafts kept.`)
      return false
    } finally {
      recovering = false
    }
  }
  return {
    state,
    restoreError: () => restoreError,
    persistAsync,
    persistForRecovery: () => persistAsync(true),
    // Resolves once saved image refs are restored into the in-memory drafts.
    get hydrated() { return hydration },
    importHandoffDrafts: async (predecessor: { state: ComposerState; hydrated: Promise<void> }) => {
      // A handoff never moves an in-flight admission or sends a prompt. Existing
      // successor edits take precedence over the predecessor's saved draft.
      // Image-only drafts are empty until hydration, so decide only afterwards.
      await Promise.all([hydration, predecessor.hydrated])
      const source = predecessor.state
      const hasSuccessorDraft = !!state.task.text || !!state.task.images.length || !!state.aside.text || !!state.aside.images.length
      batch(() => {
        for (const buffer of ["task", "aside"] as const) {
          if (state[buffer].text || state[buffer].images.length) continue
          setState(buffer, copyDraft(source[buffer]))
        }
        if (!state.asideSeeded && source.asideSeeded) setState("asideSeeded", true)
        if (!hasSuccessorDraft) setState({ visibleBuffer: source.visibleBuffer, keyboardTarget: source.keyboardTarget })
      })
      return persistAsync()
    },
    recoverHandoffDrafts,
    visibleDraft: () => state[state.visibleBuffer],
    selectTarget: (keyboardTarget: ComposerAction) => {
      setState({ keyboardTarget, targetRevision: state.targetRevision + 1 })
      persist()
    },
    restoreDraft: (visibleBuffer: ComposerBuffer) => {
      setState({ visibleBuffer, keyboardTarget: "steer", targetRevision: state.targetRevision + 1 })
      persist()
    },
    setVisibleText: (text: string) => updateDraft({ text }, true, state.visibleBuffer),
    setVisibleModel: (model: ComposerModel | null) =>
      updateDraft({ model: model ? { ...model } : null }, true, state.visibleBuffer),
    chooseSessionModel,
    reconcileSessionModel: reconcileModel,
    observeSessionModel: (session: Session) => {
      if (state.modelSelection || session.time.updated < sessionModelTime) return
      sessionModelTime = session.time.updated
      const next = session.preferredModel ? { providerID: session.preferredModel.providerID, modelID: session.preferredModel.id } : null
      if (next?.providerID === state.sessionModel?.providerID && next?.modelID === state.sessionModel?.modelID) return
      setState("sessionModel", next)
      persist()
    },
    setVisibleSelection: (start: number, end: number) =>
      updateDraft({ selection: [start, end] }, false, state.visibleBuffer),
    reasonForAction: (action: ComposerAction) =>
      blockedReason(action === "steer" && !state.busy ? "send" : action, state.visibleBuffer),
    outgoingReason: (action: ComposerAction) => outgoingReason(action === "steer" && !state.busy ? "send" : action),
    // `context` rides only on a plain send, inside the same message as the human's text.
    submitVisible: (action: ComposerAction, session: Session, nextModel?: ComposerModel | null, latestMessageID?: string, context?: readonly ContextPart[]) =>
      submit(session, nextModel, {
        action,
        mode: action === "steer" && !state.busy ? "send" : action,
        buffer: state.visibleBuffer,
        targetRevision: state.targetRevision,
      }, latestMessageID, context),
    setText: (text: string) => updateDraft({ text }),
    /**
     * Inserts dictated text into the draft that was visible when dictation started, without
     * touching images or model. Returns the caret after the insertion.
     */
    insertDictation: (buffer: ComposerBuffer, captured: Pick<ComposerDraft, "revision" | "selection">, text: string) => {
      const next = dictationInsert(state[buffer], captured, text)
      updateDraft({ text: next.text, selection: [next.caret, next.caret] }, true, buffer)
      return next.caret
    },
    setImages: (images: ComposerImage[], buffer: ComposerBuffer = draftKey()) => {
      imageEdits[buffer]++
      setMissingImages(buffer, false)
      updateDraft({ images: images.map((image) => ({ ...image })) }, true, buffer)
    },
    setError: (error: string) => setState("error", error),
    setModel: (model: ComposerModel | null) => updateDraft({ model: model ? { ...model } : null }),
    setSelection: (start: number, end: number) => updateDraft({ selection: [start, end] }, false),
    selectMode,
    // Puts a not-confirmed Send back in the editor to edit or resend; refuses to overwrite newer typing.
    editNormalSubmission: () => {
      const held = state.normalSubmission
      if (held?.status !== "unknown" || !held.draft || !restoreSubmitted(held.buffer ?? "task", held.draft)) return false
      setState("normalSubmission", null)
      persist()
      return true
    },
    dismissNormalSubmission: () => {
      if (state.normalSubmission?.status === "sending") return
      setState("normalSubmission", null)
      persist()
    },
    observeBusy: (busy: boolean) => {
      setState("busy", busy)
      if (state.hydrating) return
      if (busy && state.mode === "send" && !state.normalExplicit && !state.task.text && !state.task.images.length)
        selectMode("queue")
      if (
        !busy &&
        (state.mode === "queue" || state.mode === "steer") &&
        !state.task.text &&
        !state.task.images.length &&
        !state.admission &&
        !state.sending
      ) {
        setState({ mode: "send", normalExplicit: false, error: "" })
        persist()
      }
    },
    loadCapabilities,
    refreshInputs,
    checkSubmission,
    sendAgain,
    submit,
    retryAdmission,
    setAsideAdmission,
    recoverAdmission,
    cancelInput,
    editInput,
    saveInput,
    /** The pending input open in the main composer, if any. */
    editingInput: () => Object.keys(state.inputEdits).find((id) => state.inputEdits[id]!.open),
    changeInputEdit: (id: string, value: Partial<Pick<ComposerInputEdit, "text" | "delivery">>) => {
      const edit = state.inputEdits[id]
      if (!edit || edit.status === "saving" || edit.status === "unknown") return
      setState("inputEdits", id, { ...value, ...(edit.status === "conflict" ? { command: undefined } : {}) })
      persist()
    },
    closeInputEdit: (id: string) => {
      setState("inputEdits", id, "open", false)
      persist()
    },
    rebaseInputEdit: (id: string) => {
      const receipt = state.receipts.find((item) => item.requestID === id)
      if (!state.inputEdits[id] || receipt?.state !== "pending" || receipt.source) return
      setState("inputEdits", id, { expectedRevision: receipt.revision ?? 0, command: undefined, status: "editing", error: "" })
      persist()
    },
    cancelAside,
    closeAside,
    blockedReason,
    capabilityReason: () => capabilityReason(state.mode) || imageCapabilityReason(state.mode, state[draftKey()].images),
    actionLabel: () => ({ send: "Send", aside: "Ask aside", queue: "Queue message", steer: "Steer task" })[state.mode],
  }
}

/**
 * Untouched since capture: dictation replaces the selection it started with, like typing would.
 * Edited meanwhile: it goes in at the current caret and never replaces the newer text.
 * Selections are caret ranges; callers collapse a Vim normal-mode block to its start.
 */
export const dictationInsert = (
  draft: Pick<ComposerDraft, "text" | "revision" | "selection">,
  captured: Pick<ComposerDraft, "revision" | "selection">,
  dictated: string,
) => {
  const clamp = (value: number) => Math.max(0, Math.min(draft.text.length, value))
  const [start, end] =
    draft.revision === captured.revision
      ? [clamp(Math.min(...captured.selection)), clamp(Math.max(...captured.selection))]
      : [clamp(Math.min(...draft.selection)), clamp(Math.min(...draft.selection))]
  const before = draft.text.slice(0, start)
  const after = draft.text.slice(end)
  const body = dictated.trim()
  const lead = before && !/\s$/.test(before) ? " " : ""
  const trail = after && !/^[\s.,;:!?)\]}]/.test(after) ? " " : ""
  const inserted = `${lead}${body}${trail}`
  return { start, end, inserted, text: before + inserted + after, caret: start + lead.length + body.length }
}

const emptyDraft = (): ComposerDraft => ({ text: "", images: [], model: null, selection: [0, 0], revision: 0 })
const isInputEdit = (value: unknown): value is ComposerInputEdit =>
  record(value) && typeof value.text === "string" && (value.delivery === "queue" || value.delivery === "steer") &&
  typeof value.expectedRevision === "number" && Number.isSafeInteger(value.expectedRevision) && value.expectedRevision >= 0 &&
  typeof value.open === "boolean" && typeof value.error === "string" &&
  ["editing", "saving", "unknown", "conflict"].includes(String(value.status)) &&
  (value.command === undefined || (record(value.command) && typeof value.command.commandID === "string" &&
    value.command.expectedRevision === value.expectedRevision && value.command.text === value.text && value.command.delivery === value.delivery))
const copyDraft = (draft: ComposerDraft): ComposerDraft => ({
  ...draft,
  images: draft.images.map((image) => ({ ...image })),
  model: draft.model ? { ...draft.model } : null,
  selection: [draft.selection[0], draft.selection[1]],
})
const copyPayload = (payload: InputPayload): InputPayload =>
  Object.freeze({
    ...payload,
    ...(payload.images ? { images: inputImages(payload.images) } : {}),
  })
const imageMimeTypes = defaultImageCapability.mimeTypes
const requireImageMime = (mime: string) => {
  const supported = imageMimeTypes.find((value) => value === mime)
  if (!supported) throw new Error("Unsupported image MIME type")
  return supported
}
const imageCapability = (value: unknown): ImageCapability | undefined => {
  if (
    !record(value) ||
    value.version !== 1 ||
    value.encoding !== "data-url" ||
    !Array.isArray(value.mimeTypes) ||
    !value.mimeTypes.length ||
    !value.mimeTypes.every((mime) => imageMimeTypes.some((supported) => supported === mime)) ||
    value.animated !== false ||
    value.compressedMetadata !== false ||
    ![value.maxCount, value.maxBytes, value.maxTotalBytes, value.maxWidth, value.maxHeight, value.maxPixels].every(
      (limit) => typeof limit === "number" && Number.isSafeInteger(limit) && limit > 0,
    )
  )
    return
  return {
    version: 1,
    encoding: "data-url",
    mimeTypes: value.mimeTypes,
    maxCount: Math.min(value.maxCount as number, 8),
    maxBytes: Math.min(value.maxBytes as number, defaultImageCapability.maxBytes),
    maxTotalBytes: Math.min(value.maxTotalBytes as number, defaultImageCapability.maxTotalBytes),
    maxWidth: Math.min(value.maxWidth as number, defaultImageCapability.maxWidth),
    maxHeight: Math.min(value.maxHeight as number, defaultImageCapability.maxHeight),
    maxPixels: Math.min(value.maxPixels as number, defaultImageCapability.maxPixels),
    animated: false,
    compressedMetadata: false,
  }
}
const imageReason = (images: readonly { mime: string; url: string }[], capability: ImageCapability) => {
  if (images.length > capability.maxCount) return `At most ${capability.maxCount} images are allowed. Draft kept.`
  let total = 0
  for (const image of images) {
    if (!capability.mimeTypes.includes(image.mime))
      return "Unsupported image format. Use PNG, JPEG, WebP or GIF. Draft kept."
    const prefix = `data:${image.mime};base64,`
    if (!image.url.startsWith(prefix)) return "Images must be base64 data URLs matching their MIME type. Draft kept."
    const encoded = image.url.slice(prefix.length)
    const bytes = (encoded.length / 4) * 3 - (encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0)
    if (bytes > capability.maxBytes) return `Each image is limited to ${capability.maxBytes} bytes. Draft kept.`
    if (!encoded.length || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded))
      return "Invalid base64 image data. Draft kept."
    total += bytes
    if (total > capability.maxTotalBytes)
      return `Images are limited to ${capability.maxTotalBytes} total bytes. Draft kept.`
  }
  return ""
}
const isImages = (value: unknown): value is InputImage[] =>
  Array.isArray(value) &&
  value.every(
    (image) =>
      record(image) &&
      image.type === "file" &&
      typeof image.mime === "string" &&
      imageMimeTypes.some((mime) => mime === image.mime) &&
      typeof image.url === "string" &&
      (image.filename === undefined || typeof image.filename === "string"),
   )
type SavedImage = { ref: string; mime: string; filename?: string; id?: string; normalized?: boolean; type?: "file" } | ComposerImage
type SavedDraft = Omit<ComposerDraft, "images"> & { images: SavedImage[] }
type SavedRecovery = Omit<ComposerRecovery, "admission"> & {
  admission: Omit<ComposerAdmission, "payload" | "draft"> & {
    payload: Omit<InputPayload, "images"> & { images?: SavedImage[] }
    draft?: SavedDraft
  }
}
const isRecovery = (value: unknown): value is SavedRecovery =>
  record(value) && isAdmission(value.admission) && (value.model === null || isModel(value.model)) &&
  (value.reconciled === undefined || typeof value.reconciled === "boolean") &&
  (value.agent === null || typeof value.agent === "string")
const isSavedImages = (value: unknown): value is SavedImage[] =>
  Array.isArray(value) && value.every((image) =>
    record(image) &&
    typeof image.mime === "string" &&
    (typeof image.ref === "string" || typeof image.url === "string") &&
    (image.filename === undefined || typeof image.filename === "string") &&
    (image.id === undefined || typeof image.id === "string") &&
    (image.normalized === undefined || typeof image.normalized === "boolean") &&
    (image.type === undefined || image.type === "file"),
  )
const recordRefs = (value: unknown): Set<string> => {
  if (!record(value)) return new Set()
  const images = [
    ...(record(value.task) && isSavedImages(value.task.images) ? value.task.images : []),
    ...(record(value.aside) && isSavedImages(value.aside.images) ? value.aside.images : []),
    ...(record(value.superseded) && record(value.superseded.draft) && isSavedImages(value.superseded.draft.images) ? value.superseded.draft.images : []),
    ...(record(value.admission) && record(value.admission.payload) && isSavedImages(value.admission.payload.images) ? value.admission.payload.images : []),
    ...(record(value.admission) && record(value.admission.draft) && isSavedImages(value.admission.draft.images) ? value.admission.draft.images : []),
    ...(record(value.asideRequest) && isSavedImages(value.asideRequest.images) ? value.asideRequest.images : []),
    ...(Array.isArray(value.recoveries) ? value.recoveries.filter(isRecovery).flatMap((entry) =>
      [...(entry.admission.payload.images ?? []), ...(entry.admission.draft?.images ?? [])]) : []),
  ]
  return new Set(images.flatMap((image) => "ref" in image ? [image.ref] : []))
}
const sameImages = (left: readonly InputImage[] | undefined, right: readonly InputImage[] | undefined) =>
  (left?.length ?? 0) === (right?.length ?? 0) &&
  (left ?? []).every(
    (image, index) =>
      image.type === right?.[index]?.type &&
      image.mime === right[index].mime &&
      image.url === right[index].url &&
      image.filename === right[index].filename,
  )
const matchesRecovery = (receipt: InputReceipt, entry: ComposerRecovery) =>
  ((entry.reconciled && (receipt.revision ?? 0) > 0) ||
    (receipt.text === entry.admission.payload.text && receipt.delivery === entry.admission.payload.delivery)) &&
  (!(entry.agent ?? entry.admission.payload.agent) || receipt.agent === (entry.agent ?? entry.admission.payload.agent)) &&
  JSON.stringify(receipt.source) === JSON.stringify(entry.admission.payload.source) &&
  sameImages(receipt.images, entry.admission.payload.images)
const message = (error: unknown) => (error instanceof Error ? error.message : String(error))
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null
const isMode = (value: unknown): value is ComposerMode =>
  value === "send" || value === "aside" || value === "queue" || value === "steer"
const isAction = (value: unknown): value is ComposerAction =>
  value === "aside" || value === "queue" || value === "steer"
const isModel = (value: unknown): value is ComposerModel =>
  record(value) && typeof value.providerID === "string" && typeof value.modelID === "string"
const isDraft = (value: unknown): value is SavedDraft =>
  record(value) &&
  typeof value.text === "string" &&
  Array.isArray(value.images) &&
  isSavedImages(value.images) &&
  value.images.every((image) => typeof image.filename === "string" && ("ref" in image || typeof image.id === "string")) &&
  (value.model === null ||
    (record(value.model) && typeof value.model.providerID === "string" && typeof value.model.modelID === "string")) &&
  Array.isArray(value.selection) &&
  value.selection.length === 2 &&
  value.selection.every((item) => Number.isSafeInteger(item) && item >= 0) &&
  typeof value.revision === "number" &&
  Number.isSafeInteger(value.revision) &&
  value.revision >= 0
const isAdmission = (value: unknown): value is Omit<ComposerAdmission, "payload" | "draft"> & { payload: Omit<InputPayload, "images"> & { images?: SavedImage[] }; draft?: SavedDraft } =>
  record(value) &&
  record(value.payload) &&
  typeof value.payload.requestID === "string" &&
  value.payload.requestID.length > 0 &&
  value.payload.requestID.length <= 200 &&
  (value.payload.delivery === "queue" || value.payload.delivery === "steer") &&
  typeof value.payload.text === "string" &&
  (value.payload.images === undefined || isSavedImages(value.payload.images)) &&
  (value.draft === undefined || isDraft(value.draft)) &&
  (/\S/.test(value.payload.text) || (isSavedImages(value.payload.images) && value.payload.images.length > 0)) &&
  (value.payload.agent === undefined || typeof value.payload.agent === "string") &&
  (value.buffer === undefined || value.buffer === "task" || value.buffer === "aside") &&
  (value.targetRevision === undefined ||
    (typeof value.targetRevision === "number" && Number.isSafeInteger(value.targetRevision))) &&
  typeof value.revision === "number" &&
  Number.isSafeInteger(value.revision)
const json = async <T>(response: Response): Promise<T> => {
  if (!response.ok) throw await httpError(response)
  return response.json()
}
