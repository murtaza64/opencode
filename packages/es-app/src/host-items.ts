/* The in-Work detail and actions of another Work host's entry (work-queue.ts `remote`). Everything goes through the
 * Local listener's /hosts/<id>/ routes, so a read, an answer, a reply or a frame address is that host's own, with that
 * host's operator session, and the window never switches to that host's tab. To answer another host's decision, use
 * `createAttention(project, { prefix: hostPrefix(host) })`; to reply to its permission or question, `hostCore(host)`. */
import { ocAt } from "./api"
import { attentionPath, type AttentionRecord } from "./attention"
import type { HomeRequestRow } from "./home-requests"

const ID = /^[a-z][a-z0-9-]{0,31}$/

/** The Local listener prefix of a Work host's routes. */
export const hostPrefix = (host: string) => {
  if (!ID.test(host) || host === "local") throw new Error(`Invalid Work host ${JSON.stringify(host)}`)
  return `/hosts/${host}`
}

/** That host's Core client: its permission/question lists and replies (`permissionReply`, `questionReply`, `questionReject`). */
export const hostCore = (host: string) => ocAt(`${hostPrefix(host)}/oc`)

/** That host's current record of one decision; undefined when it no longer has it. */
export const readHostDecision = async (host: string, record: Pick<AttentionRecord, "editspace" | "id">) => {
  const response = await fetch(attentionPath(`/${encodeURIComponent(record.id)}`, record.editspace, hostPrefix(host)), { credentials: "include", cache: "no-store" })
  if (response.status === 404) return undefined
  if (!response.ok) throw new Error(`${host}: decision unavailable (HTTP ${response.status})`)
  return (await response.json()) as AttentionRecord
}

/** One pending permission or question, validated against that host's Core: undefined when it is no longer pending
 * there (its outcome is unknown, never assumed granted or answered). */
export const readHostRequest = async (host: string, request: Pick<HomeRequestRow, "kind" | "id" | "session" | "directory">) => {
  const core = hostCore(host)
  const list = await (request.kind === "permission" ? core.permissions(request.directory) : core.questions(request.directory))
  return list.find((item) => item.id === request.id && item.sessionID === request.session)
}

/** A frame address for one of that host's file Surfaces, minted through the Local listener and served from that host.
 * A URL Surface cannot be framed from another computer yet: its frame answers 502 "served only on its own host". */
export const hostSurfaceAddress = async (host: string, surface: string) => {
  const response = await fetch(`${hostPrefix(host)}/__es/surface/${encodeURIComponent(surface)}`, { cache: "no-store" })
  if (!response.ok || !response.headers.get("content-type")?.includes("application/json")) throw new Error(`${host}: this listener does not frame that host's surfaces`)
  const body = (await response.json()) as { src: string; expires_at?: number }
  return { src: body.src, expiresAt: body.expires_at }
}
