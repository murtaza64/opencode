import { batch, createEffect, createMemo, createSignal, onCleanup, untrack } from "solid-js"
import type { Event, GlobalSession, PermissionRequest, QuestionRequest } from "@opencode-ai/sdk/v2"
import { oc } from "./api"

type Snapshot = {
  status: Record<string, { type: string }>
  permissions: PermissionRequest[]
  questions: QuestionRequest[]
  statusKnown?: boolean
  permissionsKnown?: boolean
  questionsKnown?: boolean
  error: string
}

type Request = { directory: string } & (
  | { kind: "permission"; request: PermissionRequest }
  | { kind: "question"; request: QuestionRequest }
)

export const createSessionActivity = (sessions: () => GlobalSession[], refreshSessions: () => void) => {
  const [snapshots, setSnapshots] = createSignal<Record<string, Snapshot>>({})
  const [connectionError, setConnectionError] = createSignal("")
  const index = createMemo(() => new Map(sessions().map((s) => [s.id, s])))
  const children = createMemo(() => {
    const result = new Map<string, string[]>()
    for (const s of sessions()) {
      if (!s.parentID) continue
      const ids = result.get(s.parentID) ?? []
      ids.push(s.id)
      result.set(s.parentID, ids)
    }
    return result
  })
  const family = (id: string) => {
    const ids = new Set<string>()
    const queue = [id]
    for (const next of queue) {
      if (ids.has(next)) continue
      ids.add(next)
      queue.push(...(children().get(next) ?? []))
    }
    return ids
  }
  const root = (id: string) => {
    const visited = new Set<string>()
    let session = index().get(id)
    while (session?.parentID && !visited.has(session.id)) {
      visited.add(session.id)
      const parent = index().get(session.parentID)
      if (!parent) break
      session = parent
    }
    return session
  }
  const requests = createMemo<Request[]>((previous = []) =>
    Object.entries(snapshots())
      .flatMap(([directory, snapshot]) => [
        ...snapshot.permissions.map((request) => ({ kind: "permission" as const, request, directory })),
        ...snapshot.questions.map((request) => ({ kind: "question" as const, request, directory })),
      ])
      .map(
        (item) =>
          previous.find(
            (old) => old.kind === item.kind && old.request.id === item.request.id && old.directory === item.directory,
          ) ?? item,
      ),
  )
  const pending = (id: string) => {
    const ids = family(id)
    return requests().filter((item) => ids.has(item.request.sessionID))
  }
  const running = (id: string) => {
    const ids = family(id)
    return Object.values(snapshots()).flatMap((snapshot) =>
      Object.entries(snapshot.status)
        .filter(([owner, status]) => ids.has(owner) && (status.type === "busy" || status.type === "retry"))
        .map(([owner]) => owner),
    )
  }
  const error = (id: string, directory?: string) => {
    const dirs = new Set([...family(id)].map((owner) => index().get(owner)?.directory))
    if (directory) dirs.add(directory)
    return [
      connectionError(),
      ...Object.entries(snapshots())
        .filter(([directory]) => dirs.has(directory))
        .map(([, snapshot]) => snapshot.error),
    ]
      .filter(Boolean)
      .join("\n")
  }

  let disposed = false
  const settled = new Set<string>()
  const requestKey = (directory: string, kind: string, id: string) => `${directory}\u0000${kind}\u0000${id}`
  const inflight = new Map<string, { events: Event[]; promise: Promise<void> }>()
  const apply = (directory: string, event: Event) => {
    if (event.type === "permission.replied") settled.add(requestKey(directory, "permission", event.properties.requestID))
    if (event.type === "question.replied" || event.type === "question.rejected") settled.add(requestKey(directory, "question", event.properties.requestID))
    setSnapshots((previous) => {
      const snapshot: Snapshot = previous[directory] ?? { status: {}, permissions: [], questions: [], error: "" }
      switch (event.type) {
        case "session.status":
          return {
            ...previous,
            [directory]: {
              ...snapshot,
              status: { ...snapshot.status, [event.properties.sessionID]: event.properties.status },
            },
          }
        case "session.idle":
        case "session.error": {
          const id = event.properties.sessionID
          if (!id) return previous
          return { ...previous, [directory]: { ...snapshot, status: { ...snapshot.status, [id]: { type: "idle" } } } }
        }
        case "permission.asked":
          if (settled.has(requestKey(directory, "permission", event.properties.id))) return previous
          return {
            ...previous,
            [directory]: {
              ...snapshot,
              permissions: [...snapshot.permissions.filter((p) => p.id !== event.properties.id), event.properties],
            },
          }
        case "permission.replied":
          return {
            ...previous,
            [directory]: {
              ...snapshot,
              permissions: snapshot.permissions.filter((p) => p.id !== event.properties.requestID),
            },
          }
        case "question.asked":
          if (settled.has(requestKey(directory, "question", event.properties.id))) return previous
          return {
            ...previous,
            [directory]: {
              ...snapshot,
              questions: [...snapshot.questions.filter((q) => q.id !== event.properties.id), event.properties],
            },
          }
        case "question.replied":
        case "question.rejected":
          return {
            ...previous,
            [directory]: {
              ...snapshot,
              questions: snapshot.questions.filter((q) => q.id !== event.properties.requestID),
            },
          }
        case "session.deleted": {
          const id = event.properties.info.id
          return { ...previous, [directory]: { ...snapshot,
            status: { ...snapshot.status, [id]: { type: "idle" } },
            permissions: snapshot.permissions.filter((p) => p.sessionID !== id),
            questions: snapshot.questions.filter((q) => q.sessionID !== id),
          } }
        }
        default:
          return previous
      }
    })
  }
  const refreshDirectory = (directory: string, afterReply = false): Promise<void> => {
    if (disposed) return Promise.resolve()
    const active = inflight.get(directory)
    if (active) return afterReply ? active.promise.then(() => refreshDirectory(directory)) : active.promise
    const events: Event[] = []
    const promise = (async () => {
      const [status, permissions, questions] = await Promise.allSettled([
        oc.status(directory),
        oc.permissions(directory),
        oc.questions(directory),
      ])
      if (disposed) return
      batch(() => {
        setSnapshots((previous) => ({
          ...previous,
          [directory]: {
            status: status.status === "fulfilled" ? status.value : (previous[directory]?.status ?? {}),
            statusKnown: status.status === "fulfilled",
            permissionsKnown: permissions.status === "fulfilled",
            questionsKnown: questions.status === "fulfilled",
            permissions:
              (permissions.status === "fulfilled" ? permissions.value : (previous[directory]?.permissions ?? []))
                .filter((p) => !settled.has(requestKey(directory, "permission", p.id))),
            questions: (questions.status === "fulfilled" ? questions.value : (previous[directory]?.questions ?? []))
              .filter((q) => !settled.has(requestKey(directory, "question", q.id))),
            error: [status, permissions, questions].some((result) => result.status === "rejected")
              ? `Unable to refresh activity or requests for ${directory}. Retrying automatically.`
              : "",
          },
        }))
        // Asked/replied events are idempotent; replay them over raced snapshots.
        for (const event of events) apply(directory, event)
      })
    })().finally(() => inflight.delete(directory))
    inflight.set(directory, { events, promise })
    return promise
  }
  const refresh = async (dirs = [...new Set([...sessions().map((s) => s.directory), ...Object.keys(snapshots())])]) => {
    // Avoid initializing every historical directory concurrently.
    for (let offset = 0; offset < dirs.length && !disposed; offset += 8) {
      await Promise.all(dirs.slice(offset, offset + 8).map((directory) => refreshDirectory(directory)))
    }
  }
  createEffect(() => {
    const dirs = [...new Set(sessions().map((s) => s.directory))]
    untrack(() => {
      void refresh(dirs.filter((directory) => !snapshots()[directory]))
    })
  })
  const source = new EventSource("/oc/global/event")
  let timer: ReturnType<typeof setTimeout> | undefined
  const scheduleSessions = () => {
    if (timer) return
    timer = setTimeout(() => {
      timer = undefined
      refreshSessions()
    }, 500)
  }
  source.onopen = () => {
    if (disposed) return
    setConnectionError("")
    refreshSessions()
    void refresh()
  }
  source.onerror = () => {
    if (disposed) return
    setConnectionError("Activity connection lost. Reconnecting; requests and status may be outdated.")
    setSnapshots((current) => Object.fromEntries(Object.entries(current).map(([directory, snapshot]) =>
      [directory, { ...snapshot, statusKnown: false, permissionsKnown: false, questionsKnown: false }])))
  }
  source.onmessage = (message) => {
    if (disposed) return
    try {
      const { directory, payload: event } = JSON.parse(message.data) as { directory: string; payload: Event }
      if (!event?.type || !directory) return
      if (
        event.type.startsWith("session.") ||
        event.type.startsWith("permission.") ||
        event.type.startsWith("question.")
      ) {
        inflight.get(directory)?.events.push(event)
        apply(directory, event)
      }
      if (
        ["session.created", "session.updated", "session.deleted", "permission.asked", "question.asked"].includes(
          event.type,
        )
      )
        scheduleSessions()
      if (event.type.startsWith("permission.v2.") || event.type.startsWith("question.v2."))
        void refreshDirectory(directory)
    } catch {
      setConnectionError("Unable to read activity events. Refreshing requests and status.")
      void refresh()
    }
  }
  const interval = setInterval(() => {
    refreshSessions()
    void refresh()
  }, 30_000)
  onCleanup(() => {
    disposed = true
    source.close()
    clearTimeout(timer)
    clearInterval(interval)
  })
  const status = (id: string) => {
    const snapshot = snapshots()[index().get(id)?.directory ?? ""]
    return snapshot?.status[id]?.type ?? (snapshot && !snapshot.error ? "idle" : undefined)
  }
  const idle = (id: string) => !connectionError() && [...family(id)].every((owner) => {
    const snapshot = snapshots()[index().get(owner)?.directory ?? ""]
    return snapshot?.statusKnown && (snapshot.status[owner]?.type ?? "idle") === "idle"
  })
  const requestState = (kind: "permission" | "question", id: string, directory: string, requestID?: string) => {
    const snapshot = snapshots()[directory]
    if (requestID && settled.has(requestKey(directory, kind, requestID))) return "cleared"
    const items = kind === "permission" ? snapshot?.permissions : snapshot?.questions
    if (items?.some((item) => item.sessionID === id && (!requestID || item.id === requestID))) return "pending"
    return !connectionError() && (kind === "permission" ? snapshot?.permissionsKnown : snapshot?.questionsKnown) ? "cleared" : "unknown"
  }
  return {
    pending,
    running,
    status,
    idle,
    requestState,
    root,
    requests,
    error,
    refresh,
    refreshDirectory,
    session: (id: string) => index().get(id),
  }
}
