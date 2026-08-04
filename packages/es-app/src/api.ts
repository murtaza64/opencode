/* Thin fetch layer. The daemon (:4096) is reached via the /oc proxy, the es
 * dashboard server (:7777) via /es — both same-origin through vite. */
import type { Message, Part, Session } from "@opencode-ai/sdk/v2"

export type MessageWithParts = { info: Message; parts: Part[] }

const q = (directory: string) => `directory=${encodeURIComponent(directory)}`

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(`${res.url}: HTTP ${res.status} ${await res.text()}`)
  return res.json()
}

export const oc = {
  sessions: (directory: string): Promise<Session[]> =>
    fetch(`/oc/session?${q(directory)}`).then(json<Session[]>),

  umbrellaSessions: (directory: string): Promise<Session[]> =>
    fetch(`/oc/umbrella/session?${q(directory)}`).then(json<Session[]>),

  session: (id: string, directory: string): Promise<Session> =>
    fetch(`/oc/session/${id}?${q(directory)}`).then(json<Session>),

  messages: (id: string, directory: string): Promise<MessageWithParts[]> =>
    fetch(`/oc/session/${id}/message?${q(directory)}`).then(json<MessageWithParts[]>),

  status: (directory: string): Promise<Record<string, { type: string }>> =>
    fetch(`/oc/session/status?${q(directory)}`).then(json<Record<string, { type: string }>>),

  permissions: (directory: string): Promise<any[]> =>
    fetch(`/oc/permission?${q(directory)}`).then(json<any[]>),

  questions: (directory: string): Promise<any[]> =>
    fetch(`/oc/question?${q(directory)}`).then(json<any[]>),

  providers: (directory: string): Promise<{ providers: any[]; default: Record<string, string> }> =>
    fetch(`/oc/config/providers?${q(directory)}`).then(json<{ providers: any[]; default: Record<string, string> }>),

  prompt: async (
    session: Session,
    directory: string,
    text: string,
    opts: {
      model?: { providerID: string; modelID: string }
      images?: { mime: string; url: string; filename: string }[]
    } = {},
  ) => {
    const parts: Record<string, unknown>[] = []
    if (text) parts.push({ type: "text", text })
    for (const img of opts.images ?? []) {
      parts.push({ type: "file", mime: img.mime, url: img.url, filename: img.filename })
    }
    // reuse the session's own agent; model defaults to the previous turn's
    const body: Record<string, unknown> = { parts, agent: session.agent }
    const model =
      opts.model ??
      (session.model ? { providerID: session.model.providerID, modelID: session.model.id } : undefined)
    if (model) body.model = model
    const res = await fetch(`/oc/session/${session.id}/prompt_async?${q(directory)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
    if (!res.ok) throw new Error(`prompt failed: HTTP ${res.status} ${await res.text()}`)
  },

  // fire-and-forget: the status SSE flips busy->idle on its own
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

const esQ = (es?: string) => (es ? `es=${encodeURIComponent(es)}` : "")

export const es = {
  editspaces: (): Promise<{ editspaces: { name: string; root: string }[]; default: string | null }> =>
    fetch("/es/api/editspaces").then(json<{ editspaces: { name: string; root: string }[]; default: string | null }>),
  state: (esName?: string): Promise<any> => fetch(`/es/api/state?${esQ(esName)}`).then(json),
  refresh: (esName?: string): Promise<any> =>
    fetch(`/es/api/refresh?${esQ(esName)}`, { method: "POST" }).then(json),
  digest: (sessionID: string, esName?: string): Promise<any> =>
    fetch(`/es/api/digest/${sessionID}?force=true&${esQ(esName)}`, { method: "POST" }).then(json),
}
