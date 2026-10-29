/* Status and open requests for one session on another Work host, the subset of session-activity a
 * session view reads. This page's activity index covers only its own host, so a view of another
 * host's session reads that host's status, permissions, questions and subagents itself (through
 * the Local listener's /hosts/<id>/oc routes) and follows the view's own event stream. */
import { batch, createSignal, onCleanup } from "solid-js"
import type { PermissionRequest, QuestionRequest, Session } from "@opencode-ai/sdk/v2"
import { ocAt } from "./api"
import { coalesced } from "./coalesced"
import type { SessionHost } from "./session-host"

type Request = { directory: string } & (
  | { kind: "permission"; request: PermissionRequest }
  | { kind: "question"; request: QuestionRequest }
)

/** Why that host's reads fail: "auth" (sign-in needed) or "unreachable". */
export type HostReach = "auth" | "unreachable"

export const REFRESH_MS = 30_000

export const createHostActivity = (host: SessionHost, sessionID: string, directory: string) => {
  const oc = ocAt(host.base)
  const [requests, setRequests] = createSignal<Request[]>([])
  const [statuses, setStatuses] = createSignal<Record<string, { type: string }>>({})
  const [children, setChildren] = createSignal<Session[]>([])
  const [reach, setReach] = createSignal<HostReach>()
  const [known, setKnown] = createSignal(false)
  let disposed = false
  let inflight: Promise<void> | undefined
  // A reply settles its request at once; a snapshot read before the reply landed must not bring it back.
  const settled = new Set<string>()

  const family = () => new Set([sessionID, ...children().map((child) => child.id)])
  const refreshDirectory = (_directory = directory, afterReply = false): Promise<void> => {
    if (disposed) return Promise.resolve()
    if (inflight) return afterReply ? inflight.then(() => refreshDirectory(directory)) : inflight
    inflight = (async () => {
      const [status, permissions, questions, subagents] = await Promise.allSettled([
        oc.status(directory),
        oc.permissions(directory),
        oc.questions(directory),
        oc.children(sessionID, directory),
      ])
      if (disposed) return
      batch(() => {
        if (status.status === "fulfilled") setStatuses(status.value)
        if (subagents.status === "fulfilled") setChildren(subagents.value)
        setRequests((previous) => [
          ...(permissions.status === "fulfilled"
            ? permissions.value.map((request) => ({ kind: "permission" as const, request, directory }))
            : previous.filter((item) => item.kind === "permission")),
          ...(questions.status === "fulfilled"
            ? questions.value.map((request) => ({ kind: "question" as const, request, directory }))
            : previous.filter((item) => item.kind === "question")),
        ].filter((item) => !settled.has(`${item.kind}:${item.request.id}`))
          // Keep the objects already shown, so open cards do not remount on each read.
          .map((item) => previous.find((old) => old.kind === item.kind && old.request.id === item.request.id) ?? item))
        const failures = [status, permissions, questions].flatMap((result) => result.status === "rejected" ? [result.reason] : [])
        setReach(failures.length ? (failures.some((reason) => /HTTP (401|403)\b/.test(String(reason))) ? "auth" : "unreachable") : undefined)
        if (!failures.length) setKnown(true)
      })
    })().finally(() => { inflight = undefined })
    return inflight
  }
  const later = coalesced(() => void refreshDirectory(), 500)

  /** Events of this directory from the view's own stream (already filtered to that host and directory). */
  const apply = (event: { type: string; properties?: any }) => {
    const props = event.properties ?? {}
    if (event.type === "session.status" && typeof props.sessionID === "string")
      setStatuses((previous) => ({ ...previous, [props.sessionID]: props.status }))
    if ((event.type === "session.idle" || event.type === "session.error") && typeof props.sessionID === "string")
      setStatuses((previous) => ({ ...previous, [props.sessionID]: { type: "idle" } }))
    if (event.type === "permission.replied") settled.add(`permission:${props.requestID}`)
    if (event.type === "question.replied" || event.type === "question.rejected") settled.add(`question:${props.requestID}`)
    if (settled.size) setRequests((previous) => previous.filter((item) => !settled.has(`${item.kind}:${item.request.id}`)))
    if (event.type.startsWith("permission.") || event.type.startsWith("question.") ||
      (event.type === "session.created" && props.info?.parentID === sessionID)) later()
  }

  void refreshDirectory()
  const timer = setInterval(() => void refreshDirectory(), REFRESH_MS)
  onCleanup(() => {
    disposed = true
    clearInterval(timer)
    later.cancel()
  })

  const label = () => host.label ?? host.id ?? "That host"
  return {
    pending: (_id: string) => requests().filter((item) => family().has(item.request.sessionID)),
    running: (_id: string) => [...family()].filter((owner) => ["busy", "retry"].includes(statuses()[owner]?.type ?? "")),
    status: (id: string) => statuses()[id]?.type ?? (known() ? "idle" : undefined),
    error: (_id: string, _directory?: string) =>
      reach() === "auth" ? `${label()}: sign-in needed. Showing what was last loaded.`
        : reach() ? `${label()} is unreachable. Showing what was last loaded.` : "",
    reach,
    session: (id: string) => children().find((child) => child.id === id),
    refreshDirectory,
    apply,
  }
}

export type HostActivity = ReturnType<typeof createHostActivity>
