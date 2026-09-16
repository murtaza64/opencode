import { batch } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import type {
  ExperimentalCapabilities,
  Session,
  SessionV1InputPayload,
  SessionV1InputReceipt,
} from "@opencode-ai/sdk/v2"
import { oc, inputImages, type InputImage } from "./api"
import { composerStorage } from "./composer-storage"

export type ComposerMode = "send" | "aside" | "queue" | "steer"
export type ComposerAction = Exclude<ComposerMode, "send">
export type ComposerBuffer = "task" | "aside"
export type ComposerModel = { providerID: string; modelID: string }
export type ComposerImage = { id: string; mime: string; url: string; filename: string }
export type ComposerDraft = {
  text: string
  images: ComposerImage[]
  model: ComposerModel | null
  selection: [number, number]
  revision: number
}
export type ComposerCapabilities = {
  sessionAside?: { version: number; cancel: boolean; images?: ImageCapability }
  sessionInput?: { version: number; delivery: string[]; list: boolean; cancel: boolean; images?: ImageCapability }
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
  revision: number
  status: "sending" | "unknown"
  error?: string
  buffer?: ComposerBuffer
  targetRevision?: number
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
    status: "sending" | "accepted" | "unknown"
    action?: ComposerAction
  } | null
  queueAgent: string | null
  task: ComposerDraft
  aside: ComposerDraft
  asideSeeded: boolean
  sending: boolean
  asideRequest: AsideRequest | null
  admission: ComposerAdmission | null
  receipts: InputReceipt[]
  capabilities: ComposerCapabilities | null
  capabilityError: string
  error: string
  storageError: string
  inputLoading: boolean
}
export type ComposerDependencies = {
  fetch?: (url: string, init?: RequestInit) => Promise<Response>
  prompt?: typeof oc.prompt
  storage?: Pick<Storage, "getItem" | "setItem"> | null
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

export const createComposer = (sessionID: string, directory: string, dependencies: ComposerDependencies = {}) => {
  const request = dependencies.fetch ?? ((url, init) => fetch(url, init))
  const prompt = dependencies.prompt ?? oc.prompt
  const requestID = dependencies.requestID ?? (() => crypto.randomUUID())
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
    queueAgent: null,
    task: emptyDraft(),
    aside: emptyDraft(),
    asideSeeded: false,
    sending: false,
    asideRequest: null,
    admission: null,
    receipts: [],
    capabilities: null,
    capabilityError: "",
    error: "",
    storageError: "",
    inputLoading: false,
  })
  const tracked = new Set<string>()
  const cancelling = new Set<string>()
  const [missingImages, setMissingImages] = createStore({ task: false, aside: false })
  const imageWarning = () =>
    missingImages.task || missingImages.aside
      ? "Some saved images could not be restored. Reattach or explicitly clear images in the affected draft before sending."
      : ""
  let asideAbort: AbortController | undefined
  let activeInput: string | undefined
  let capabilityVersion = 0
  let storage: ComposerDependencies["storage"]
  let restored = false
  let restoreError = ""
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
      setState({ task: saved.task, aside: saved.aside, mode: saved.mode, asideSeeded: saved.asideSeeded === true })
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
          status: "unknown",
          ...(isAction(saved.normalSubmission.action) ? { action: saved.normalSubmission.action } : {}),
        })
      }
      if (typeof saved.queueAgent === "string") setState("queueAgent", saved.queueAgent)
      if (record(saved.missingImages)) {
        setMissingImages({ task: saved.missingImages.task === true, aside: saved.missingImages.aside === true })
        setState("storageError", imageWarning())
      }
      if (Array.isArray(saved.tracked))
        saved.tracked.filter((id): id is string => typeof id === "string").forEach((id) => tracked.add(id))
      if (saved.admission != null) {
        if (!isAdmission(saved.admission))
          throw new Error("Invalid saved input identity; do not resubmit without checking inputs")
        setState("admission", {
          ...saved.admission,
          payload: copyPayload(saved.admission.payload),
          status: "unknown",
          error: "Admission needs reconciliation after reload.",
        })
        tracked.add(saved.admission.payload.requestID)
      }
      if (
        record(saved.asideRequest) &&
        typeof saved.asideRequest.requestID === "string" &&
        typeof saved.asideRequest.question === "string"
      ) {
        setState("asideRequest", {
          requestID: saved.asideRequest.requestID,
          question: saved.asideRequest.question,
          ...(isImages(saved.asideRequest.images) ? { images: inputImages(saved.asideRequest.images) } : {}),
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

  const persist = () => {
    if (!storage) return false
    const saved = {
      version: 1,
      directView: 1,
      visibleBuffer: state.visibleBuffer,
      keyboardTarget: state.keyboardTarget,
      targetRevision: state.targetRevision,
      mode: state.mode,
      normalExplicit: state.normalExplicit,
      normalSubmission:
        state.normalSubmission?.status === "sending" || state.normalSubmission?.status === "unknown"
          ? { ...state.normalSubmission }
          : null,
      queueAgent: state.queueAgent,
      task: copyDraft(state.task),
      aside: copyDraft(state.aside),
      asideSeeded: state.asideSeeded,
      admission: state.admission
        ? { ...state.admission, payload: copyPayload(state.admission.payload), status: "unknown" }
        : null,
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
    }
    try {
      storage.setItem(key, JSON.stringify(saved))
      setState("storageError", imageWarning())
      return true
    } catch (error) {
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
  // Restore/migrate before exposing the controller; no late async load can replace newer typing.
  if (restored) persist()
  const draftKey = () => (state.mode === "aside" ? "aside" : "task")
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
    if (state.sending) return "A task message is being sent."
    if (state.admission) return "Reconcile or retry the existing input before sending another task message."
    if (mode === "send") {
      if (state.normalSubmission?.status === "unknown")
        return "Previous normal Send outcome is unknown. Check the conversation, then dismiss its status before sending again."
      return state.busy ? "Task busy. Normal Send is unavailable; choose Aside, Queue or Steer." : ""
    }
    if (draft.model) return "Task delivery uses the session model. Clear the override or use Aside."
    return ""
  }
  const accept = (receipt: InputReceipt, expectedID = receipt.requestID) => {
    if (receipt.sessionID !== sessionID || receipt.requestID !== expectedID)
      throw new Error("Input receipt identity did not match this request.")
    const admission = state.admission
    if (
      admission?.payload.requestID === receipt.requestID &&
      (receipt.delivery !== admission.payload.delivery ||
        receipt.text !== admission.payload.text ||
        !sameImages(receipt.images, admission.payload.images) ||
        (admission.payload.agent !== undefined && receipt.agent !== admission.payload.agent))
    )
      throw new Error("Input ID belongs to a different payload. The draft was not cleared.")
    batch(() => {
      const previous = state.receipts.find((item) => item.requestID === receipt.requestID)
      if (!previous || previous.state === "pending") {
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
        activeInput = undefined
        setState("sending", false)
      }
    })
    if (!state.inputLoading) persist()
  }
  const readInput = async (id: string) => {
    const response = await request(url(`/input/${encodeURIComponent(id)}`))
    if (response.status === 404) return null
    const receipt = await json<InputReceipt>(response)
    accept(receipt, id)
    return receipt
  }
  const loadCapabilities = async () => {
    const version = ++capabilityVersion
    setState({ capabilities: null, capabilityError: "" })
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
          images: imageCapability(input.images),
        }
      }
      if (version === capabilityVersion) setState("capabilities", capabilities)
    } catch (error) {
      if (version === capabilityVersion)
        setState("capabilityError", `Cannot load server capabilities: ${message(error)}`)
    }
  }
  const refreshInputs = async () => {
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
      if (state.admission?.status === "unknown")
        setState("admission", "error", "Input not found. Retry explicitly with the same request ID.")
      if (state.error.startsWith("Cannot refresh inputs:")) setState("error", "")
    } catch (error) {
      setState("error", `Cannot refresh inputs: ${message(error)}`)
    } finally {
      setState("inputLoading", false)
      persist()
    }
  }
  const admit = async (admission: ComposerAdmission) => {
    activeInput = admission.payload.requestID
    try {
      const receipt = await json<InputReceipt>(
        await request(url("/input"), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(admission.payload),
        }),
      )
      accept(receipt, admission.payload.requestID)
    } catch (error) {
      if (state.admission?.payload.requestID !== admission.payload.requestID) return
      if (error instanceof HttpError && [400, 401, 403, 404, 413, 415, 422].includes(error.status)) {
        tracked.delete(admission.payload.requestID)
        setState({
          admission: null,
          error: `Input rejected: ${message(error)}. Draft kept; correct it before sending again.`,
        })
        return
      }
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
  ) => {
    const mode = direct?.mode ?? state.mode
    const buffer = direct?.buffer ?? draftKey()
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
    if (state.normalSubmission?.status === "accepted") setState("normalSubmission", null)
    if (mode === "aside") {
      const id = requestID()
      const abort = new AbortController()
      asideAbort = abort
      setState("asideRequest", null)
      setState("asideRequest", { requestID: id, question: text, ...(images ? { images } : {}), status: "running" })
      if (!persist() && images) {
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
      setState({
        normalExplicit: true,
        normalSubmission: {
          text,
          images: draft.images.length,
          status: "sending",
          ...(direct ? { action: direct.action } : {}),
        },
      })
      persist()
      try {
        await prompt(session, directory, text, { images: draft.images, model: draft.model ?? nextModel ?? undefined })
        clearTask(draft.revision, buffer, direct?.targetRevision)
        setState("normalSubmission", "status", "accepted")
      } catch (error) {
        setState("normalSubmission", "status", "unknown")
        setState("error", `Send not confirmed: ${message(error)}. Check the conversation before sending again.`)
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
        ...(mode === "queue" && state.queueAgent ? { agent: state.queueAgent } : {}),
      }),
      revision: draft.revision,
      status: "sending",
      ...(direct ? { buffer, targetRevision: direct.targetRevision } : {}),
    }
    tracked.add(admission.payload.requestID)
    setState("admission", admission)
    if (!persist() && images) {
      tracked.delete(admission.payload.requestID)
      setState({
        admission: null,
        sending: false,
        error:
          "Cannot save the exact image input for retry. No input was sent; draft kept. Free browser storage and try again.",
      })
      return
    }
    await admit(admission)
  }
  const retryAdmission = async () => {
    if (!state.admission || state.sending) return
    const admission = { ...state.admission, payload: copyPayload(state.admission.payload) }
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
      if (admission.payload.images?.length && !persist()) {
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
  const cancelInput = async (id: string) => {
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
  return {
    state,
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
    setVisibleSelection: (start: number, end: number) =>
      updateDraft({ selection: [start, end] }, false, state.visibleBuffer),
    reasonForAction: (action: ComposerAction) =>
      blockedReason(action === "steer" && !state.busy ? "send" : action, state.visibleBuffer),
    submitVisible: (action: ComposerAction, session: Session, nextModel?: ComposerModel | null) =>
      submit(session, nextModel, {
        action,
        mode: action === "steer" && !state.busy ? "send" : action,
        buffer: state.visibleBuffer,
        targetRevision: state.targetRevision,
      }),
    setText: (text: string) => updateDraft({ text }),
    setQueueAgent: (agent: string | null) => {
      if (state.queueAgent === agent) return
      setState("queueAgent", agent)
      updateDraft({}, true, state.visibleBuffer)
    },
    setImages: (images: ComposerImage[], buffer: ComposerBuffer = draftKey()) => {
      setMissingImages(buffer, false)
      updateDraft({ images: images.map((image) => ({ ...image })) }, true, buffer)
    },
    setModel: (model: ComposerModel | null) => updateDraft({ model: model ? { ...model } : null }),
    setSelection: (start: number, end: number) => updateDraft({ selection: [start, end] }, false),
    selectMode,
    dismissNormalSubmission: () => {
      if (state.normalSubmission?.status === "sending") return
      setState("normalSubmission", null)
      persist()
    },
    observeBusy: (busy: boolean) => {
      setState("busy", busy)
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
    submit,
    retryAdmission,
    cancelInput,
    cancelAside,
    closeAside,
    blockedReason,
    capabilityReason: () => capabilityReason(state.mode) || imageCapabilityReason(state.mode, state[draftKey()].images),
    actionLabel: () => ({ send: "Send", aside: "Ask aside", queue: "Queue message", steer: "Steer task" })[state.mode],
  }
}

const emptyDraft = (): ComposerDraft => ({ text: "", images: [], model: null, selection: [0, 0], revision: 0 })
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
const imageMimeTypes = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const
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
    maxBytes: Math.min(value.maxBytes as number, 5_242_880),
    maxTotalBytes: Math.min(value.maxTotalBytes as number, 10_485_760),
    maxWidth: Math.min(value.maxWidth as number, 8192),
    maxHeight: Math.min(value.maxHeight as number, 8192),
    maxPixels: Math.min(value.maxPixels as number, 16_777_216),
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
const sameImages = (left: readonly InputImage[] | undefined, right: readonly InputImage[] | undefined) =>
  (left?.length ?? 0) === (right?.length ?? 0) &&
  (left ?? []).every(
    (image, index) =>
      image.type === right?.[index]?.type &&
      image.mime === right[index].mime &&
      image.url === right[index].url &&
      image.filename === right[index].filename,
  )
const message = (error: unknown) => (error instanceof Error ? error.message : String(error))
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null
const isMode = (value: unknown): value is ComposerMode =>
  value === "send" || value === "aside" || value === "queue" || value === "steer"
const isAction = (value: unknown): value is ComposerAction =>
  value === "aside" || value === "queue" || value === "steer"
const isDraft = (value: unknown): value is ComposerDraft =>
  record(value) &&
  typeof value.text === "string" &&
  Array.isArray(value.images) &&
  value.images.every(
    (image) =>
      record(image) && [image.id, image.mime, image.url, image.filename].every((item) => typeof item === "string"),
  ) &&
  (value.model === null ||
    (record(value.model) && typeof value.model.providerID === "string" && typeof value.model.modelID === "string")) &&
  Array.isArray(value.selection) &&
  value.selection.length === 2 &&
  value.selection.every((item) => Number.isSafeInteger(item) && item >= 0) &&
  typeof value.revision === "number" &&
  Number.isSafeInteger(value.revision) &&
  value.revision >= 0
const isAdmission = (value: unknown): value is ComposerAdmission =>
  record(value) &&
  record(value.payload) &&
  typeof value.payload.requestID === "string" &&
  value.payload.requestID.length > 0 &&
  value.payload.requestID.length <= 200 &&
  (value.payload.delivery === "queue" || value.payload.delivery === "steer") &&
  typeof value.payload.text === "string" &&
  (value.payload.images === undefined || isImages(value.payload.images)) &&
  (/\S/.test(value.payload.text) || (isImages(value.payload.images) && value.payload.images.length > 0)) &&
  (value.payload.agent === undefined || typeof value.payload.agent === "string") &&
  (value.buffer === undefined || value.buffer === "task" || value.buffer === "aside") &&
  (value.targetRevision === undefined ||
    (typeof value.targetRevision === "number" && Number.isSafeInteger(value.targetRevision))) &&
  typeof value.revision === "number" &&
  Number.isSafeInteger(value.revision)
class HttpError extends Error {
  constructor(
    readonly status: number,
    detail: string,
  ) {
    super(`HTTP ${status} ${detail}`)
  }
}
const json = async <T>(response: Response): Promise<T> => {
  if (!response.ok) throw new HttpError(response.status, await response.text())
  return response.json()
}
