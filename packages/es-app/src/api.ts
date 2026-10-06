/* Thin fetch layer. The daemon (:4096) is reached via the /oc proxy, the es
 * dashboard server (:7777) via /es — both same-origin through vite. */
import type { Agent, GlobalSession, Message, Part, PermissionRequest, QuestionRequest, Session, SessionV1InputImage } from "@opencode-ai/sdk/v2"

export type MessageWithParts = { info: Message; parts: Part[] }
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

export class SessionCreateError extends Error {
  constructor(message: string, readonly uncertain: boolean) {
    super(message)
  }
}

const q = (directory: string) => `directory=${encodeURIComponent(directory)}`

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(`${res.url}: HTTP ${res.status} ${await res.text()}`)
  return res.json()
}

export const oc = {
  createSession: async (directory: string): Promise<Session> => {
    let res: Response
    try {
      res = await fetch(`/oc/session?${q(directory)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
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
    if (!value || typeof value.id !== "string" || !/^ses_[\w-]+$/.test(value.id) || value.directory !== directory || value.parentID)
      throw new SessionCreateError("The server returned an invalid confirmation. A session may have been created; check the session list before trying again.", true)
    return value as Session
  },

  allSessions: async (roots = true): Promise<GlobalSession[]> => {
    // Timestamp-only cursors can skip sessions tied at a page boundary.
    // Grow the window until it contains every row instead.
    for (let limit = 200; ; limit *= 2) {
      const res = await fetch(`/oc/experimental/session?roots=${roots}&archived=true&limit=${limit}`)
      const sessions = await json<GlobalSession[]>(res)
      if (!res.headers.get("x-next-cursor")) return roots ? sessions.filter((s) => !s.parentID) : sessions
    }
  },

  sessions: (directory: string): Promise<Session[]> =>
    fetch(`/oc/session?${q(directory)}`).then(json<Session[]>),

  umbrellaSessions: (directory: string): Promise<Session[]> =>
    fetch(`/oc/umbrella/session?${q(directory)}`).then(json<Session[]>),

  session: (id: string, directory: string, signal?: AbortSignal): Promise<Session> =>
    fetch(`/oc/session/${id}?${q(directory)}`, { signal }).then(json<Session>),

  messages: (id: string, directory: string, signal?: AbortSignal): Promise<MessageWithParts[]> =>
    fetch(`/oc/session/${id}/message?${q(directory)}&summaryPatches=false`, { signal }).then(json<MessageWithParts[]>),

  // bounded tail: the newest `limit` messages only (hover insights fallback)
  messagesTail: (id: string, directory: string, limit: number, signal?: AbortSignal): Promise<MessageWithParts[]> =>
    fetch(`/oc/session/${id}/message?${q(directory)}&summaryPatches=false&limit=${limit}`, { signal }).then(json<MessageWithParts[]>),

  status: (directory: string, signal?: AbortSignal): Promise<Record<string, { type: string }>> =>
    fetch(`/oc/session/status?${q(directory)}`, { signal }).then(json<Record<string, { type: string }>>),

  permissions: (directory: string): Promise<PermissionRequest[]> =>
    fetch(`/oc/permission?${q(directory)}`).then(json<PermissionRequest[]>),

  questions: (directory: string): Promise<QuestionRequest[]> =>
    fetch(`/oc/question?${q(directory)}`).then(json<QuestionRequest[]>),

  providers: (directory: string): Promise<{ providers: any[]; default: Record<string, string> }> =>
    fetch(`/oc/config/providers?${q(directory)}`).then(json<{ providers: any[]; default: Record<string, string> }>),

  agents: (directory: string): Promise<Agent[]> => fetch(`/oc/agent?${q(directory)}`).then(json<Agent[]>),

  prompt: async (
    session: Session,
    directory: string,
    text: string,
    opts: {
      model?: { providerID: string; modelID: string }
      images?: readonly { mime: string; url: string; filename?: string }[]
    } = {},
  ) => {
    const parts: Record<string, unknown>[] = []
    if (text) parts.push({ type: "text", text })
    parts.push(...inputImages(opts.images ?? []))
    // A selected preference is resolved server-side, including its variant.
    const body: Record<string, unknown> = { parts, agent: session.agent }
    const model =
      opts.model ??
      (session.preferredModel ? undefined : session.model ? { providerID: session.model.providerID, modelID: session.model.id } : undefined)
    if (model) body.model = model
    const res = await fetch(`/oc/session/${session.id}/prompt_async?${q(directory)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
    if (!res.ok) throw new Error(`prompt failed: HTTP ${res.status} ${await res.text()}`)
  },

  // The response waits for runner interruption and cleanup.
  abort: async (id: string, directory: string) => {
    const res = await fetch(`/oc/session/${id}/abort?${q(directory)}`, { method: "POST" })
    if (!res.ok) throw new Error(`abort failed: HTTP ${res.status} ${await res.text()}`)
  },

  // messageID = fork point: the new session copies history strictly before it;
  // omitted = fork at tip (full history)
  fork: (id: string, directory: string, messageID?: string): Promise<Session> =>
    fetch(`/oc/session/${id}/fork?${q(directory)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(messageID ? { messageID } : {}),
    }).then(json<Session>),

  archive: (id: string, directory: string): Promise<Session> =>
    fetch(`/oc/session/${id}?${q(directory)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ time: { archived: Date.now() } }),
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
    if (!res.ok) throw new Error(`permission reply failed: HTTP ${res.status}`)
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
  sessionInsights: (sessionID: string, directory: string, signal?: AbortSignal): Promise<SessionInsights> =>
    fetch(`/es/api/session-insights?session_id=${encodeURIComponent(sessionID)}&${q(directory)}`, { signal })
      .then(statusJson<SessionInsights>),
  prDetail: (url: string, signal?: AbortSignal): Promise<any> =>
    fetch(`/es/api/pr-detail?url=${encodeURIComponent(url)}`, { signal }).then(statusJson),
  editspaces: (): Promise<{ editspaces: { name: string; root: string }[]; default: string | null }> =>
    fetch("/es/api/editspaces").then(json<{ editspaces: { name: string; root: string }[]; default: string | null }>),
  state: (esName?: string): Promise<any> => fetch(`/es/api/state?${esQ(esName)}`).then(json),
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
