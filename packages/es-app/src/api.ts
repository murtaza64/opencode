/* Thin fetch layer. The daemon (:4096) is reached via the /oc proxy, the es
 * dashboard server (:7777) via /es — both same-origin through vite. */
import type { Agent, GlobalSession, Message, Part, PermissionRequest, QuestionRequest, Session, SessionFailure, SessionRetryResult, SessionV1InputImage, Todo } from "@opencode-ai/sdk/v2"
import { httpError } from "./api-error"
import type { PendingHandoff } from "./handoffs"
import type { SquadronMeta } from "./mail-origin"

export type MessageWithParts = { info: Message; parts: Part[] }
/** Generated text attached to a human's own message; marked synthetic and with its producer. */
export type ContextPart = { type: "text"; text: string; synthetic: true; metadata: { source: string; key: string } }
export type InputImage = Readonly<SessionV1InputImage>
export const inputImages = <Mime extends string>(
  images: readonly { mime: Mime; url: string; filename?: string }[],
) =>
  Object.freeze(
    images.map((image) =>
      Object.freeze({
        type: "file" as const,
        mime: image.mime,
        url: image.url,
        ...(image.filename !== undefined ? { filename: image.filename } : {}),
      }),
    ),
  )
export type AttentionNotification = {
  id: string
  kind: "permission" | "question" | "idle"
  session: string
  title: string
  directory: string
  editspace: string
  updated: number
}

export type SessionCreateBody = {
  id?: string
  parentID?: string
  title?: string
  agent?: string
  model?: { providerID: string; id: string }
  metadata?: Record<string, unknown>
  permission?: { permission: string; pattern: string; action: "allow" | "deny" | "ask" }[]
}

export class SessionCreateError extends Error {
  constructor(message: string, readonly uncertain: boolean) {
    super(message)
  }
}

let sessionWindow = 200
const q = (directory: string) => `directory=${encodeURIComponent(directory)}`

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(`${res.url}: HTTP ${res.status} ${await res.text()}`)
  return res.json()
}

type Page = { items: MessageWithParts[]; cursor?: string }
const RECENT_PAGE_MS = 2000
type Shared = { limit: number; value: Promise<Page>; consumers: number; waiting: number; abort: AbortController; done?: boolean }
const pages = new Map<string, Shared>()
const readPage = async (id: string, directory: string, limit: number, before: string | undefined, signal: AbortSignal): Promise<Page> => {
  const res = await fetch(
    `/oc/session/${id}/message?${q(directory)}&summaryPatches=false&limit=${limit}${before ? `&before=${encodeURIComponent(before)}` : ""}`,
    { signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]) },
  )
  const items = await json<MessageWithParts[]>(res)
  return { items, cursor: res.headers.get("X-Next-Cursor") ?? undefined }
}
// `exact`: the caller pages with the cursor, so only a read of the same size can serve it.
// The shared request is cancelled only when every caller waiting on it has cancelled.
const sharedPage = async (id: string, directory: string, limit: number, before: string | undefined, signal: AbortSignal | undefined, exact = false): Promise<Page> => {
  signal?.throwIfAborted()
  const key = `${id}\u0000${directory}\u0000${before ?? ""}`
  let entry = pages.get(key)
  // Snapshots and paging (exact) never take a completed result: they must see current history.
  if (!entry || (exact ? entry.limit !== limit || entry.done : entry.limit < limit)) {
    const abort = new AbortController()
    const created: Shared = { limit, value: readPage(id, directory, limit, before, abort.signal), consumers: 0, waiting: 0, abort }
    entry = created
    pages.set(key, created)
    // A completed read keeps serving smaller tails briefly: the desk asks for its last 20 messages
    // right after its view loaded 80, which was a second full read for the same data.
    void created.value.then(
      () => (created.done = true, setTimeout(() => { if (pages.get(key) === created) pages.delete(key) }, RECENT_PAGE_MS)),
      () => { if (pages.get(key) === created) pages.delete(key) },
    )
  }
  const shared = entry
  const first = shared.consumers++ === 0
  shared.waiting++
  const leave = () => {
    if (--shared.waiting > 0) return
    if (pages.get(key) === shared) pages.delete(key)
    shared.abort.abort(signal?.reason)
  }
  try {
    const result = await (signal ? Promise.race([shared.value, new Promise<never>((_, reject) => {
      signal.addEventListener("abort", () => { leave(); reject(signal.reason) }, { once: true })
    })]) : shared.value)
    shared.waiting--
    const items = result.items.length > limit ? result.items.slice(-limit) : result.items
    const cursor = shared.limit === limit ? result.cursor : items[0]?.info.id
    return { items: first ? [...items] : structuredClone(items), cursor }
  } catch (error) {
    if (!signal?.aborted) shared.waiting--
    throw error
  }
}

export type UsageTokens = { input: number; output: number; reasoning: number; cache: { read: number; write: number } }
export type UsageLimit = { limit?: number; remaining?: number; reset?: string }
/** GET /experimental/usage/daily: estimated spend per local day on this host (not provider billing). */
export type UsageDaily = {
  estimate: true
  basis: string
  host: string
  observedAt: string
  offsetMinutes: number
  coverage: { scope: string; liveSince?: string; backfilled: boolean }
  /** Newer Cores: `cost` is null when nothing on the day is priced; `coverage` and `complete` say why. */
  days: {
    day: string
    cost: number | null
    complete?: boolean
    unpricedModels?: number
    models: { provider: string; model: string; cost: number | null; coverage?: "priced" | "missing-rate" | "no-usage"; tokens: UsageTokens }[]
  }[]
  rateLimits: {
    source: string
    providers: { provider: string; observedAt: string; requests?: UsageLimit; tokens?: UsageLimit; inputTokens?: UsageLimit; outputTokens?: UsageLimit }[]
  }
}

export const oc = {
  // The body is Core's create body. A client-chosen id makes a lost response reconcilable.
  createSession: async (directory: string, body: SessionCreateBody = {}): Promise<Session> => {
    let res: Response
    try {
      res = await fetch(`/oc/session?${q(directory)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      })
    } catch {
      throw new SessionCreateError("The server response was lost. A session may have been created; check the session list before trying again.", true)
    }
    if (!res.ok) {
      const detail = await res.text()
      if ((res.status >= 500 && !detail.trim()) || [502, 504].includes(res.status))
        throw new SessionCreateError("The server response was lost. A session may have been created; check the session list before trying again.", true)
      throw new SessionCreateError(`Session creation failed: HTTP ${res.status} ${detail}`, false)
    }
    const value = await res.json()
    if (!value || typeof value.id !== "string" || !/^ses_[\w-]+$/.test(value.id) || value.directory !== directory || (value.parentID ?? undefined) !== body.parentID || (body.id && value.id !== body.id))
      throw new SessionCreateError("The server returned an invalid confirmation. A session may have been created; check the session list before trying again.", true)
    return value as Session
  },

  allSessions: async (roots = true): Promise<GlobalSession[]> => {
    // Timestamp-only cursors can skip sessions tied at a page boundary.
    // Grow the window until it contains every row instead, starting from the
    // last window that sufficed (re-growing from 200 cost 4 serial reads).
    for (let limit = sessionWindow; ; limit *= 2) {
      const res = await fetch(`/oc/experimental/session?roots=${roots}&archived=true&limit=${limit}`)
      const sessions = await json<GlobalSession[]>(res)
      if (res.headers.get("x-next-cursor")) continue
      sessionWindow = limit
      return roots ? sessions.filter((s) => !s.parentID) : sessions
    }
  },

  umbrellaSessions: (directory: string): Promise<Session[]> =>
    fetch(`/oc/umbrella/session?${q(directory)}`).then(json<Session[]>),

  session: (id: string, directory: string, signal?: AbortSignal): Promise<Session> =>
    fetch(`/oc/session/${id}?${q(directory)}`, { signal }).then(json<Session>),

  messages: (id: string, directory: string, signal?: AbortSignal): Promise<MessageWithParts[]> =>
    fetch(`/oc/session/${id}/message?${q(directory)}&summaryPatches=false`, { signal }).then(json<MessageWithParts[]>),

  // bounded tail: the newest `limit` messages only (hover insights fallback)
  // Message page reads are single-flight per (session, directory, cursor): opening the Front Desk
  // asked for the same tail 4-6 times at once (live view, memory, briefs), which queued behind
  // the browser's six-connection pool for 150-420 ms each. A tail is served from an in-flight
  // page of at least that size; every caller gets its own copy (stores mutate what they hold).
  messagesTail: async (id: string, directory: string, limit: number, signal?: AbortSignal): Promise<MessageWithParts[]> =>
    (await sharedPage(id, directory, limit, undefined, signal)).items,

  messagesPage: (id: string, directory: string, limit: number, before?: string, signal?: AbortSignal) =>
    sharedPage(id, directory, limit, before, signal, true),

  /** Undefined when the session has no such message (404, or 400 for a malformed ID). */
  message: async (id: string, directory: string, messageID: string, signal?: AbortSignal) => {
    const res = await fetch(`/oc/session/${id}/message/${encodeURIComponent(messageID)}?${q(directory)}`, { signal })
    if (res.status === 404 || res.status === 400) return undefined
    return json<MessageWithParts>(res)
  },

  children: (id: string, directory: string, signal?: AbortSignal): Promise<Session[]> =>
    fetch(`/oc/session/${id}/children?${q(directory)}`, { signal }).then(json<Session[]>),

  // Raw prompt admission for callers that own their parts (generated context, structured briefs).
  promptBody: async (id: string, directory: string, body: Record<string, unknown>) => {
    const res = await fetch(`/oc/session/${id}/prompt_async?${q(directory)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
    if (!res.ok) throw await httpError(res)
  },

  todos: (id: string, directory: string, signal?: AbortSignal): Promise<Todo[]> =>
    fetch(`/oc/session/${id}/todo?${q(directory)}`, { signal }).then(json<Todo[]>),

  status: (directory: string, signal?: AbortSignal): Promise<Record<string, { type: string }>> =>
    fetch(`/oc/session/status?${q(directory)}`, { signal }).then(json<Record<string, { type: string }>>),

  permissions: (directory: string): Promise<PermissionRequest[]> =>
    fetch(`/oc/permission?${q(directory)}`).then(json<PermissionRequest[]>),

  questions: (directory: string): Promise<QuestionRequest[]> =>
    fetch(`/oc/question?${q(directory)}`).then(json<QuestionRequest[]>),

  providers: (directory: string): Promise<{ providers: any[]; default: Record<string, string> }> =>
    fetch(`/oc/config/providers?${q(directory)}`).then(json<{ providers: any[]; default: Record<string, string> }>),

  agents: (directory: string): Promise<Agent[]> => fetch(`/oc/agent?${q(directory)}`).then(json<Agent[]>),

  /** Reviewed recovery of an interrupted step (Core `POST /session/:id/recover`); typed system provenance, no fake user turn. */
  recover: async (id: string, directory: string, body: { recoveryID: string; anchorMessageID: string; text: string; reason: string; sender: string }) => {
    const res = await fetch(`/oc/session/${id}/recover?${q(directory)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
    if (!res.ok) throw await httpError(res)
    return (await res.json()) as { outcome: string }
  },

  /** Durable sourced input (Core `POST /session/:id/input`): labelled by kind, never shown as the human typing. */
  sourcedInput: async (id: string, directory: string, input: { requestID: string; text: string; kind: string; sender: string }) => {
    const res = await fetch(`/oc/session/${id}/input?${q(directory)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ requestID: input.requestID, delivery: "queue", text: input.text,
        source: { type: "editspace-mail", id: input.requestID, sender: input.sender, recipient: id, kind: input.kind } }),
    })
    if (!res.ok) throw await httpError(res)
  },

  prompt: async (
    session: Session,
    directory: string,
    text: string,
    opts: {
      model?: { providerID: string; modelID: string }
      images?: readonly { mime: string; url: string; filename?: string }[]
      context?: readonly ContextPart[]
      /** Client-chosen user message ID, so an unconfirmed send can be found later by GET /message/:id. */
      messageID?: string
      signal?: AbortSignal
    } = {},
  ) => {
    const parts: Record<string, unknown>[] = []
    if (text) parts.push({ type: "text", text })
    parts.push(...inputImages(opts.images ?? []))
    parts.push(...(opts.context ?? []))
    // A selected preference is resolved server-side, including its variant.
    const body: Record<string, unknown> = { parts, agent: session.agent, ...(opts.messageID ? { messageID: opts.messageID } : {}) }
    const model =
      opts.model ??
      (session.preferredModel ? undefined : session.model ? { providerID: session.model.providerID, modelID: session.model.id } : undefined)
    if (model) body.model = model
    const res = await fetch(`/oc/session/${session.id}/prompt_async?${q(directory)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: opts.signal,
    })
    if (!res.ok) throw await httpError(res)
  },

  // The response waits for runner interruption and cleanup.
  abort: async (id: string, directory: string) => {
    const res = await fetch(`/oc/session/${id}/abort?${q(directory)}`, { method: "POST" })
    if (!res.ok) throw new Error(`abort failed: HTTP ${res.status} ${await res.text()}`)
  },

  // undefined = this Core predates the usage route (404 or the HTML app page); the page says so.
  usageDaily: async (days: number, signal?: AbortSignal): Promise<UsageDaily | undefined> => {
    // Days are local: the offset is east-positive minutes, the inverse of getTimezoneOffset().
    const res = await fetch(`/oc/experimental/usage/daily?days=${days}&offsetMinutes=${-new Date().getTimezoneOffset()}`, { signal })
    if (res.status === 404 || !res.headers.get("content-type")?.includes("application/json")) return undefined
    return json<UsageDaily>(res)
  },

  // undefined = this Core predates failure tracking; the feature stays hidden.
  failedSessions: async (): Promise<SessionFailure[] | undefined> => {
    const res = await fetch("/oc/experimental/session/failed")
    if (res.status === 404) return undefined
    return json<SessionFailure[]>(res)
  },

  // "unknown": the request may have reached Core, so the outcome must be re-read, never re-assumed.
  retrySession: async (failure: Pick<SessionFailure, "sessionID" | "directory" | "messageID">):
    Promise<SessionRetryResult | { outcome: "unknown" | "unavailable" | "rejected"; detail: string }> => {
    let res: Response
    try {
      res = await fetch(`/oc/session/${failure.sessionID}/retry?${q(failure.directory)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messageID: failure.messageID }),
      })
    } catch {
      return { outcome: "unknown", detail: "The response was lost" }
    }
    if (res.ok) {
      const value = await res.json().catch(() => undefined)
      return value && typeof value.outcome === "string" ? value as SessionRetryResult
        : { outcome: "unknown", detail: "Unreadable response" }
    }
    if (res.status === 404) return { outcome: "unavailable", detail: "Session or retry support not found" }
    if (res.status >= 500 || res.status === 408) return { outcome: "unknown", detail: `HTTP ${res.status}` }
    return { outcome: "rejected", detail: `HTTP ${res.status}` }
  },

  // messageID = fork point: the new session copies history strictly before it;
  // omitted = fork at tip (full history)
  fork: (id: string, directory: string, messageID?: string): Promise<Session> =>
    fetch(`/oc/session/${id}/fork?${q(directory)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(messageID ? { messageID } : {}),
    }).then(json<Session>),

  rename: (id: string, directory: string, title: string): Promise<Session> =>
    fetch(`/oc/session/${id}?${q(directory)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title }),
    }).then(json<Session>),

  // Sets the session's model preference, used from its next turn; the running turn and history are unchanged.
  preferModel: (id: string, directory: string, model: { providerID: string; modelID: string }): Promise<Session> =>
    fetch(`/oc/session/${id}?${q(directory)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model }),
    }).then(json<Session>),

  archive: (id: string, directory: string): Promise<Session> =>
    fetch(`/oc/session/${id}?${q(directory)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ time: { archived: Date.now() } }),
    }).then(json<Session>),

  unarchive: (id: string, directory: string): Promise<Session> =>
    fetch(`/oc/session/${id}?${q(directory)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ time: { archived: null } }),
    }).then(json<Session>),

  remove: async (id: string, directory: string) => {
    const res = await fetch(`/oc/session/${id}?${q(directory)}`, { method: "DELETE" })
    if (!res.ok) throw new Error(`delete failed: HTTP ${res.status} ${await res.text()}`)
  },

  permissionReply: async (requestID: string, directory: string, reply: "once" | "always" | "reject") => {
    const res = await fetch(`/oc/permission/${requestID}/reply?${q(directory)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reply }),
    })
    // HttpError keeps the status: 404 means the request was no longer pending.
    if (!res.ok) throw await httpError(res)
  },

  questionReply: async (requestID: string, directory: string, answers: string[][]) => {
    const res = await fetch(`/oc/question/${requestID}/reply?${q(directory)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ answers }),
    })
    if (!res.ok) throw new Error(`question reply failed: HTTP ${res.status}`)
  },

  questionReject: async (requestID: string, directory: string) => {
    const res = await fetch(`/oc/question/${requestID}/reject?${q(directory)}`, { method: "POST" })
    if (!res.ok) throw new Error(`question reject failed: HTTP ${res.status}`)
  },
}

export type IssueRow = {
  ref: string
  number: number | null
  title: string
  state: "open" | "closed"
  status?: string
  feature?: string
  markers: string[]
  claims: string[]
  labels: string[]
  assignees: string[]
  updated_at: string
  url: string
}
export type IssueList = { backend: string; repo?: string; issues: IssueRow[]; error?: string }
export type IssueDetail = IssueRow & {
  backend: string
  body: string
  comments: { author: string; created_at: string; body: string }[]
  blockers?: string[]
  reviewers?: string[]
  state_reason?: string
  created_at?: string
}
export type DocMeta = { path: string; name: string; title: string; status: string }
export type DocList = {
  sources: { key: string; kind: string; groups: Record<string, DocMeta[]> }[]
  roots: { source: string; root: string; lane: string }[]
  error?: string
}
export type DocContent = {
  source: string
  path: string
  variant: string
  variant_label: string
  exists: boolean
  content: string
  variants: { name: string; label: string }[]
  title?: string
  error?: string
}

export type MailMessage = {
  /** Present on mail the Squadron bridge wrote (`from: integration:squadron`). */
  squadron?: SquadronMeta
  id: string
  ts: string | number
  created_ms?: number
  from: string
  sender_session?: string
  origin_run?: string
  origin_tool_call?: string
  relationship?: string
  to: string
  direction: "sent" | "received"
  deliveries: MailDelivery[]
  kind?: string
  in_reply_to?: string | null
  supersedes?: string | null
  text: string
  via?: string
  /** A cross-editspace projection: the canonical record lives in another editspace. */
  canonical?: { editspace: string; id: string; kind?: string; in_reply_to?: string }
  /** Set by canonicalMail: this editspace's id of the projection. */
  projection?: string
}
export type MailDelivery = {
  message_id: string
  recipient: string
  session: string | null
  mode: string | null
  state: string
  request_id: string | null
  error: string | null
  presented_at: string | number | null
  handled_at: string | number | null
  wake_observations?: readonly { outcome: "scheduled" | "coalesced"; observedAt: number }[]
}
export type MailTimeline = { editspace: string; lane: string; messages: MailMessage[] }
export type Handoff = { lane: string; predecessor: string; successor: string; reason?: string; kickoff?: "skipped"; context?: string }
export type LaneProvenance = {
  delegations: { lane: string; parent: string; session: string | null; status: string }[]
  spawned: { lane: string; by: string }[]
}
export type MailSubscription = { selector: string; sender: string; kind: string; mode: "actionable" | "passive" | "mute" }
// One Wingman (cloud) lane as es-dashboard reports it: the lane record's
// fields, all optional strings. See dotfiles docs/editspace-lanes.md.
export type WingmanLane = {
  lane?: string
  owner?: string
  issue?: string
  status?: string
  activity?: string
  model?: string
  runtime?: string
  "wingman-status"?: string
  "wingman-turns"?: string
  "wingman-cost"?: string
  "wingman-kind"?: string
  "wingman-repos"?: string
  "wingman-branch"?: string
  "wingman-prs"?: string
  "wingman-ci"?: string
  "wingman-url"?: string
  "wingman-synced"?: string
  "wingman-error"?: string
}
export type WingmanTurn = {
  turn?: number
  prompt?: string
  reply?: string
  status?: string
  cost_usd?: number | null
  started_at?: string
  completed_at?: string
  error?: unknown
  events?: { kind?: string; text?: string; tool_name?: string | null; timestamp?: string }[]
}
export type WingmanTranscript = { owner?: string; status?: string; turns?: WingmanTurn[]; turns_dropped?: number }

const esQ = (es?: string) => (es ? `es=${encodeURIComponent(es)}` : "")

export interface SessionSearchResult {
  id: string
  title: string
  directory: string
  parent_id: string | null
  updated: number | null
  snippet: string
  matches: number
}

// dotfiles#139 read-only insight endpoints; `status` lets callers tell "not
// deployed" (404/501) apart from a failed lookup
export class ApiStatusError extends Error {
  constructor(readonly status: number, url: string, readonly body: unknown) {
    super(`${url}: HTTP ${status}`)
  }
  /** the route itself is absent (FastAPI's unregistered-route 404 / 501), as opposed to a lookup failure */
  get routeMissing() {
    return this.status === 501 || (this.status === 404 && typeof this.body === "object" && this.body !== null && (this.body as any).detail === "Not Found")
  }
}
const statusJson = async <T,>(res: Response): Promise<T> => {
  if (!res.ok) throw new ApiStatusError(res.status, res.url, await res.json().catch(() => undefined))
  return res.json()
}

// shape served by es-dashboard (dotfiles#139 `session_insights`); sizes are
// visible character counts, never text
export type SessionInsights = {
  session_id: string
  directory: string
  cost: number | null
  completed_turns: number
  session_model: { providerID: string; modelID: string } | null
  latest: {
    model: { providerID: string; modelID: string } | null
    cost: number
    tokens: { input: number; output: number; reasoning: number; cache: { read: number; write: number } }
  } | null
  composition: {
    unit: "characters"
    scope: "since_last_compaction" | "full_visible_history"
    user_text: number
    assistant_text: number
    tool_call_metadata: number
    tool_output: number
    other_unattributed: number
  } | null
  error?: string
}

export type CurrentWork = {
  turn: {
    started_at: number | null
    elapsed_seconds: number | null
    status: "busy" | "idle" | "unknown"
    user_messages: number | null
    assistant_messages: number | null
    tool_calls: number | null
    active_tools: { name: string; status: string }[]
    watermark: string | null
  }
  summary: {
    status: "ready" | "stale" | "error" | "unavailable"
    text: string | null
    generated_at: number | null // Unix seconds, unlike turn.started_at (milliseconds)
    watermark: string | null
  }
}

export const es = {
  currentWork: (sessionID: string, directory: string, generate = false, signal?: AbortSignal): Promise<CurrentWork> =>
    fetch(`/es/api/current-work?session_id=${encodeURIComponent(sessionID)}&${q(directory)}${generate ? "&generate=true" : ""}`, { signal })
      .then(statusJson<CurrentWork>),
  subscriptions: (name: string, recipient: string): Promise<{ recipient: string; subscriptions: MailSubscription[] }> =>
    fetch(`/es/api/subscriptions?es=${encodeURIComponent(name)}&recipient=${encodeURIComponent(recipient)}`)
      .then(statusJson<{ recipient: string; subscriptions: MailSubscription[] }>),
  setSubscription: (name: string, recipient: string, subscription: MailSubscription) =>
    fetch(`/es/api/subscriptions?es=${encodeURIComponent(name)}`, {
      method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify({ recipient, ...subscription }),
    }).then(statusJson<unknown>),
  removeSubscription: (name: string, recipient: string, subscription: MailSubscription) =>
    fetch(`/es/api/subscriptions?es=${encodeURIComponent(name)}`, {
      method: "DELETE", headers: { "content-type": "application/json" },
      body: JSON.stringify({ recipient, selector: subscription.selector, sender: subscription.sender, kind: subscription.kind }),
    }).then(statusJson<unknown>),
  // Explicit lane provenance: delegation parents and first spawners (see es-dashboard).
  laneProvenance: (name: string): Promise<LaneProvenance> =>
    fetch(`/es/api/lane-provenance?es=${encodeURIComponent(name)}`).then(statusJson<LaneProvenance>),
  // The dashboard must create the handoff document, spawn the successor, and
  // transfer the lane owner as one server-side operation before returning.
  handoffs: (name: string): Promise<{ handoffs: Handoff[]; pending?: PendingHandoff[] }> =>
    fetch(`/es/api/handoffs?es=${encodeURIComponent(name)}`).then(statusJson<{ handoffs: Handoff[]; pending?: PendingHandoff[] }>),
  handoff: (name: string, lane: string, predecessor: string, task: string, handoff: string): Promise<Handoff | { lane: string; predecessor: string; status: "pending" }> =>
    fetch(`/es/api/handoffs?es=${encodeURIComponent(name)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ lane, predecessor, task, handoff }),
    }).then(statusJson<Handoff | { lane: string; predecessor: string; status: "pending" }>),
  mail: (name: string, recipient: { lane: string } | { session: string }, signal?: AbortSignal): Promise<MailTimeline> =>
    fetch(`/es/api/mail?es=${encodeURIComponent(name)}&${"lane" in recipient
      ? `lane=${encodeURIComponent(recipient.lane)}` : `session=${encodeURIComponent(recipient.session)}`}`, { signal }).then(statusJson<MailTimeline>),
  sessionInsights: (sessionID: string, directory: string, signal?: AbortSignal): Promise<SessionInsights> =>
    fetch(`/es/api/session-insights?session_id=${encodeURIComponent(sessionID)}&${q(directory)}`, { signal })
      .then(statusJson<SessionInsights>),
  prDetail: (url: string, signal?: AbortSignal): Promise<any> =>
    fetch(`/es/api/pr-detail?url=${encodeURIComponent(url)}`, { signal }).then(statusJson),
  editspaces: (): Promise<{ editspaces: { name: string; root: string }[]; default: string | null }> =>
    fetch("/es/api/editspaces").then(json<{ editspaces: { name: string; root: string }[]; default: string | null }>),
  state: (esName?: string): Promise<any> => fetch(`/es/api/state?${esQ(esName)}`).then(json),
  wingman: (esName?: string): Promise<{ lanes: WingmanLane[]; error: string }> =>
    fetch(`/es/api/wingman?${esQ(esName)}`).then(statusJson<{ lanes: WingmanLane[]; error: string }>),
  // Live fetch through the Wingman gateway; slow (seconds) and fails off VPN.
  wingmanTranscript: (lane: string, esName?: string, signal?: AbortSignal, expectedOwner?: string): Promise<WingmanTranscript> =>
    fetch(`/es/api/wingman/transcript?lane=${encodeURIComponent(lane)}&${esQ(esName)}${expectedOwner ? `&expected_owner=${encodeURIComponent(expectedOwner)}` : ""}`, { signal })
      .then(statusJson<WingmanTranscript>),
  notifications: (): Promise<{ notifications: AttentionNotification[] }> =>
    fetch("/es/api/notifications").then(json<{ notifications: AttentionNotification[] }>),
  refresh: (esName?: string): Promise<any> =>
    fetch(`/es/api/refresh?${esQ(esName)}`, { method: "POST" }).then(json),
  digest: (sessionID: string, esName?: string): Promise<any> =>
    fetch(`/es/api/digest/${sessionID}?force=true&${esQ(esName)}`, { method: "POST" }).then(json),
  brief: (ticket: string, esName?: string): Promise<any> =>
    fetch(`/es/api/brief/${ticket}?force=true&${esQ(esName)}`, { method: "POST" }).then(json),
  // tickets + docs browser (read-only)
  issues: (esName?: string): Promise<IssueList> => fetch(`/es/api/issues?${esQ(esName)}`).then(json<IssueList>),
  issue: async (ref: string, esName?: string): Promise<IssueDetail> => {
    const { classifyRef, ticketLookupRef } = await import("./ticket-url")
    const ticket = classifyRef(ref)
    const tracker = ticket.repo ? await es.issues(esName) : undefined
    if (tracker?.error) throw new Error(tracker.error)
    const lookup = ticketLookupRef(ticket, tracker?.backend === "gh" ? tracker.repo : undefined)
    if (lookup === undefined) {
      throw new Error(`Ticket ${ref} does not match the selected GitHub tracker (${tracker?.repo ?? tracker?.backend ?? "unknown"}).`)
    }
    return fetch(`/es/api/issue?ref=${encodeURIComponent(lookup)}&${esQ(esName)}`).then(json<IssueDetail>)
  },
  docs: (esName?: string): Promise<DocList> => fetch(`/es/api/docs?${esQ(esName)}`).then(json<DocList>),
  doc: (source: string, path: string, variant?: string, esName?: string): Promise<DocContent> =>
    fetch(
      `/es/api/doc?source=${encodeURIComponent(source)}&path=${encodeURIComponent(path)}` +
        `${variant ? `&variant=${encodeURIComponent(variant)}` : ""}&${esQ(esName)}`,
    ).then(json<DocContent>),
  // front desk (dotfiles prds/front-desk.md): returns {session, directory,
  // existing} — existing=true means a busy front desk absorbed the ask
  frontdesk: (question: string, esName?: string): Promise<any> =>
    fetch(`/es/api/frontdesk?${esQ(esName)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ question }),
    }).then(json),
  curate: (esName?: string): Promise<any> =>
    fetch(`/es/api/curate?force=true&${esQ(esName)}`, { method: "POST" }).then(json),
  // substring search over session titles + transcripts (opencode sqlite);
  // days=0 = all time (slow: full part-table scan)
  search: (q: string, days = 30): Promise<{ query: string; results: SessionSearchResult[] }> =>
    fetch(`/es/api/search?q=${encodeURIComponent(q)}&days=${days}`).then(
      json<{ query: string; results: SessionSearchResult[] }>,
    ),
}
