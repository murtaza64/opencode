import { createSignal, onCleanup } from "solid-js"

// Operator-requested self-handoff (CHAT-13) against this host's dashboard: POST /api/handoffs/self queues one
// durable input asking the lane owner to write a handoff and spawn its successor; GET reports what actually
// happened; DELETE withdraws it while the input is still pending. Every state shown comes from a server reply:
// nothing is assumed done. One request ID per session is kept across reloads, so a retry or a second click
// re-sends the same request instead of starting another.

export const SELF_HANDOFF_VERSION = 1
const POLL_MS = 3000

export type SelfHandoffProgress = "requested" | "presented" | "doc-written" | "spawning"
export type SelfHandoffState =
  | { state: "idle" }
  | { state: "sending" }
  | { state: "confirm"; model: string }
  | { state: SelfHandoffProgress }
  | { state: "verified"; successor: string; doc: string; title: string; agent: string; model: string; notCarried: string[] }
  | { state: "failed"; reason: string }
  | { state: "error"; message: string }

type Saved = { requestID: string; frontier: boolean }
type Input = {
  editspace: () => string | undefined
  lane: () => string | undefined
  session: string
  storage?: Pick<Storage, "getItem" | "setItem" | "removeItem">
  fetch?: typeof fetch
  mint?: () => string
  poll?: number
}

const PROGRESS = new Set(["requested", "presented", "doc-written", "spawning"])

export const createSelfHandoff = (input: Input) => {
  const request = input.fetch ?? fetch
  const storage = input.storage ?? localStorage
  const mint = input.mint ?? (() => `sh_${crypto.randomUUID().replace(/-/g, "")}`)
  const [state, setState] = createSignal<SelfHandoffState>({ state: "idle" })
  const key = () => `es-app:self-handoff:${input.editspace()}:${input.session}`
  const saved = (): Saved | undefined => {
    const value = (() => { try { return JSON.parse(storage.getItem(key()) ?? "null") } catch { return null } })()
    return value && typeof value.requestID === "string" ? { requestID: value.requestID, frontier: value.frontier === true } : undefined
  }
  const save = (value: Saved) => storage.setItem(key(), JSON.stringify(value))
  const url = (path: string, extra = "") => `/es/api/handoffs/self${path}?es=${encodeURIComponent(input.editspace() ?? "")}${extra}`
  const write = { "content-type": "application/json", "X-Attention-CSRF": "1" }
  let timer: ReturnType<typeof setTimeout> | undefined
  let disposed = false
  onCleanup(() => { disposed = true; clearTimeout(timer) })

  const schedule = () => {
    clearTimeout(timer)
    if (!disposed && PROGRESS.has(state().state)) timer = setTimeout(() => void refresh(), input.poll ?? POLL_MS)
  }

  /** Reads the saved request's state from the server; with nothing saved, the button is idle. */
  const refresh = async () => {
    const current = saved()
    const lane = input.lane()
    if (!current || !lane || !input.editspace()) return setState({ state: "idle" })
    const response = await request(url(`/${encodeURIComponent(current.requestID)}`, `&lane=${encodeURIComponent(lane)}`), { credentials: "include" }).catch(() => undefined)
    if (disposed) return
    // A request this host no longer knows (another editspace's store, a wiped database) is not shown as live.
    if (response?.status === 404) { storage.removeItem(key()); return setState({ state: "idle" }) }
    const body = await response?.json().catch(() => undefined)
    setState(response?.ok ? parse(body) : { state: "error", message: errorText(response?.status, body) })
    schedule()
  }

  /** Sends (or re-sends) this session's request. `frontier` is the operator's confirmation for a frontier model. */
  const start = async (frontier = false) => {
    const lane = input.lane()
    if (!lane || !input.editspace() || state().state === "sending") return
    const current = saved()
    // The server binds a request ID to its frontier flag: a retry re-sends both unchanged.
    const requestID = current?.requestID ?? mint()
    frontier = frontier || !!current?.frontier
    save({ requestID, frontier })
    setState({ state: "sending" })
    const response = await request(url(""), { method: "POST", credentials: "include", headers: write,
      body: JSON.stringify({ lane, session: input.session, requestID, ...(frontier ? { frontier: true } : {}) }) }).catch(() => undefined)
    if (disposed) return
    const body: Record<string, unknown> | undefined = await response?.json().catch(() => undefined)
    if (response?.status === 409 && body?.error === "frontier-confirm")
      return setState({ state: "confirm", model: typeof body.model === "string" ? body.model : "a frontier model" })
    // Another open request for this session (another window, a lost reply): follow that one instead.
    if (response?.status === 409 && typeof body?.existing === "string") {
      save({ requestID: body.existing, frontier: false })
      return refresh()
    }
    if (!response?.ok) return setState({ state: "error", message: errorText(response?.status, body) })
    setState(parse(body))
    schedule()
  }

  /** Withdraws the request; the server allows it only while the input is still pending. */
  const cancel = async () => {
    const current = saved()
    const lane = input.lane()
    if (!current || !lane) return
    const response = await request(url(`/${encodeURIComponent(current.requestID)}`, `&lane=${encodeURIComponent(lane)}`),
      { method: "DELETE", credentials: "include", headers: write }).catch(() => undefined)
    if (disposed) return
    const body = await response?.json().catch(() => undefined)
    if (!response?.ok) return setState({ state: "error", message: response?.status === 409 ? "Too late to cancel: the agent already has the request." : errorText(response?.status, body) })
    setState(parse(body))
    schedule()
  }

  /** After a failure (or a cancel), the next request gets a new ID. */
  const reset = () => { storage.removeItem(key()); clearTimeout(timer); setState({ state: "idle" }) }
  const decline = () => { const current = saved(); if (current) save({ ...current, frontier: false }); setState({ state: "idle" }) }

  return { state, refresh, start, cancel, reset, decline }
}

const parse = (body: unknown): SelfHandoffState => {
  const value = body && typeof body === "object" ? body as Record<string, unknown> : {}
  const text = (field: string) => typeof value[field] === "string" ? value[field] as string : ""
  if (PROGRESS.has(text("state"))) return { state: text("state") as SelfHandoffProgress }
  if (value.state === "verified" && text("successor"))
    return { state: "verified", successor: text("successor"), doc: text("doc"), title: text("title"), agent: text("agent"), model: text("model"),
      notCarried: Array.isArray(value.notCarried) ? value.notCarried.filter((item): item is string => typeof item === "string") : [] }
  if (value.state === "failed") return { state: "failed", reason: text("reason") || "unknown reason" }
  return { state: "error", message: "The dashboard sent an unreadable reply." }
}

const errorText = (status: number | undefined, body: unknown) => {
  if (status === undefined) return "Could not reach this host's dashboard."
  if (status === 403) return "Answers are off: reconnect as operator in Decisions & inbox, then retry."
  if (status === 409) return "The dashboard refused: this session is no longer the lane owner, or the request conflicts with another."
  if (status === 503) return "Self-handoff is unavailable on this host right now."
  const error = body && typeof body === "object" && "error" in body && typeof body.error === "string" ? body.error : ""
  return `Self-handoff failed (${status}${error ? `: ${error}` : ""}).`
}

/** The visible line for each state, in words. */
export const selfHandoffText = (value: SelfHandoffState) => {
  switch (value.state) {
    case "idle": return ""
    case "sending": return "Requesting handoff…"
    case "confirm": return `This session runs ${value.model}. The successor will use the same frontier model.`
    case "requested": return "Handoff requested: queued for the agent after its current work."
    case "presented": return "The agent has the request and is writing the handoff."
    case "doc-written": return "Handoff document written; waiting for the successor to start."
    case "spawning": return "Starting the successor…"
    case "verified": return "Handed off: the successor now owns the lane."
    case "failed": return `Handoff did not happen: ${value.reason}.`
    case "error": return value.message
  }
}
