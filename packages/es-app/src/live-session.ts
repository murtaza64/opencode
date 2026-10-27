/* Live session store: initial fetch + SSE event reducer, shaped exactly like
 * session-ui's DataProvider Data store. Trimmed port of packages/app's
 * global-sync/event-reducer.ts (message.updated / part.updated / part.delta /
 * session.status), without the Binary/reconcile machinery. */
import { createStore, produce, reconcile } from "solid-js/store"
import { batch, createSignal, onCleanup } from "solid-js"
import type { Message, Part, Session, SessionStatus, Todo } from "@opencode-ai/sdk/v2"
import { oc } from "./api"
import { createServerEvents, type ServerEvents } from "./event-source"
import { anchorValid } from "./message-anchor"
import { perfSpan, perfTimed } from "./perf-telemetry"

export const TAIL = 80
export const SNAPSHOT_TIMEOUT_MS = 30_000
const SKIP_PARTS = new Set(["patch", "step-start", "step-finish"])
// Keep diff statistics without retaining patch bodies unused by this transcript.
const visibleMessage = (info: Message): Message => {
  if (info.role !== "user" || !info.summary || !info.summary.diffs.some((diff) => diff.patch !== undefined)) return info
  return {
    ...info,
    summary: {
      ...info.summary,
      diffs: info.summary.diffs.map((diff) => {
        const metadata = { ...diff }
        delete metadata.patch
        return metadata
      }),
    },
  }
}
type LiveEvent = { type: string; properties?: any }

const isTerminal = (event: LiveEvent) =>
  event.type === "session.idle" ||
  event.type === "session.error" ||
  (event.type === "session.status" && event.properties?.status?.type === "idle") ||
  (event.type === "message.updated" &&
    event.properties?.info?.role === "assistant" &&
    !!(event.properties.info.error || event.properties.info.time?.completed))

export const errorText = (error: unknown): string => {
  if (typeof error === "string" && error) return error
  if (error && typeof error === "object") {
    if ("data" in error && error.data && typeof error.data === "object" && "message" in error.data)
      return errorText(error.data.message)
    if ("message" in error && typeof error.message === "string" && error.message) return error.message
    if ("name" in error && typeof error.name === "string" && error.name) return error.name
  }
  return "Session failed"
}

export type LiveData = {
  session: Session[]
  session_status: Record<string, any>
  session_diff: Record<string, any[]>
  message: Record<string, Message[]>
  part: Record<string, Part[]>
  part_text_accum_delta: Record<string, string>
  todo: Todo[]
}

// message/part ids are time-prefixed and sort lexicographically
function insertSorted<T>(list: T[], item: T, id: (x: T) => string): void {
  const key = id(item)
  const i = list.findIndex((x) => id(x) >= key)
  if (i === -1) list.push(item)
  else if (id(list[i]!) === key) list[i] = item
  else list.splice(i, 0, item)
}

export function createLiveSession(
  sessionID: string,
  directory: string,
  onEvent?: (event: { type: string; properties?: any }) => void,
) {
  const [data, setData] = createStore<LiveData>({
    session: [],
    session_status: {},
    session_diff: {},
    message: {},
    part: {},
    part_text_accum_delta: {},
    todo: [],
  })

  const [transientError, setTransientError] = createSignal("")
  const [clearedThrough, setClearedThrough] = createSignal("")
  const [connection, setConnection] = createStore({ stream: "", snapshot: "", event: "" })
  const [loading, setLoading] = createSignal(false)
  // True once any snapshot has landed; cached stores keep showing it while later loads run.
  const [loaded, setLoaded] = createSignal(false)
  const [loadingOlder, setLoadingOlder] = createSignal(false)
  const [olderCursor, setOlderCursor] = createSignal<string | undefined>()
  const hasOlder = () => olderCursor() !== undefined
  const latest = () => data.message[sessionID]?.at(-1)
  const error = () => {
    const message = latest()
    return (
      transientError() ||
      (message?.role === "assistant" && message.id > clearedThrough() && message.error?.name !== "MessageAbortedError" && message.error
        ? errorText(message.error) : "")
    )
  }
  const connectionError = () => [connection.stream, connection.snapshot, connection.event].filter(Boolean).join("\n")
  const retry = (): Extract<SessionStatus, { type: "retry" }> | undefined => {
    const status = data.session_status[sessionID]
    return status?.type === "retry" ? status : undefined
  }
  const clearFailure = () => {
    setTransientError("")
    const message = latest()
    const id = message?.role === "assistant" && message.error ? message.id : ""
    setClearedThrough((previous) => (id > previous ? id : previous))
  }
  const stopOnFailure = () => {
    // A failed turn ends work. A dropped stream does not: the session's last known status stays,
    // so a busy session never looks idle (and never routes a new message as a plain Send).
    if (error()) setData("session_status", sessionID, reconcile({ type: "idle" }))
  }
  let disposed = false
  const controller = new AbortController()
  let activeLoad: Promise<void> | undefined
  let duringLoad: LiveEvent[] | undefined
  let refreshAfterLoad = false
  let snapshotStarted = false
  let streamOpened = false
  let releaseInitial: (() => void) | undefined
  let retryTimer: ReturnType<typeof setTimeout> | undefined
  let retryDelay = 1000
  const uncertainParts = new Set<string>()

  // A hidden cached store stops snapshot work: its in-flight read is aborted
  // quietly and reconnects/retries wait until a view loads it again.
  let suspended = false
  let loadAbort: AbortController | undefined
  const load = (): Promise<void> => {
    if (disposed) return Promise.resolve()
    suspended = false
    if (activeLoad) return activeLoad
    setLoading(true)
    const abort = new AbortController()
    loadAbort = abort
    // A snapshot read that never answers fails after SNAPSHOT_TIMEOUT_MS and is retried with
    // backoff, instead of leaving the view loading forever.
    const signal = AbortSignal.any([controller.signal, abort.signal, AbortSignal.timeout(SNAPSHOT_TIMEOUT_MS)])
    duringLoad = []
    activeLoad = (async () => {
      if (!snapshotStarted && !streamOpened && source) {
        // Subscribe before the first snapshot so its one GET cannot miss events
        // between server capture and stream admission. Do not block offline loads.
        await new Promise<void>((resolve) => {
          const timeout = setTimeout(resolve, 200)
          releaseInitial = () => {
            clearTimeout(timeout)
            resolve()
          }
        })
        releaseInitial = undefined
      }
      if (disposed) return
      snapshotStarted = true
      // Journal which of the snapshot reads holds the transcript back.
      const timings: Record<string, number> = {}
      const timed = <T>(name: string, read: Promise<T>) => perfTimed(read, (ms) => { timings[name] = ms })
      const snapshot = perfSpan("session.snapshot", { sessionID, warm: loaded() })
      const [session, page, status, todos] = await Promise.all([
        timed("session", oc.session(sessionID, directory, signal)),
        timed("messages", oc.messagesPage(sessionID, directory, TAIL, undefined, signal)),
        timed("status", oc.status(directory, signal)),
        // Todos are auxiliary: a failed read keeps the last list, never the transcript.
        timed("todos", oc.todos(sessionID, directory, signal)).catch(() => undefined),
      ]).catch((failure: unknown) => {
        snapshot.end(signal.aborted ? "aborted" : "failed", { ...timings, error: errorText(failure).slice(0, 160) })
        throw failure
      })
      snapshot.end("ok", { ...timings, messages: page.items.length })
      if (disposed) return
      const events = duringLoad!
      duringLoad = undefined
      const messages = page.items.sort((a, b) => a.info.id.localeCompare(b.info.id))
      batch(() => {
        const previous = latest()
        if (previous && (messages.findLast((m) => m.info.role === "user")?.info.id ?? "") > previous.id) clearFailure()
        const existing = data.message[sessionID] ?? []
        const first = messages[0]?.info.id
        // A fresh tail supersedes its overlapping window; already-loaded older
        // messages remain available across reconnects and explicit refreshes.
        const retained = olderCursor() || page.cursor
          ? existing.filter((message) => !first || message.id < first)
          : []
        const merged = [...retained, ...messages.map((message) => visibleMessage(message.info))]
        const cursor = !page.cursor && first && (!existing.length || first <= existing[0]!.id)
          ? undefined
          : olderCursor() ?? (existing.length ? undefined : page.cursor)
        // Reconnect snapshots must not remount the unchanged transcript.
        setData("session", reconcile([session]))
        setData("session_status", reconcile({ ...status, [sessionID]: status[sessionID] ?? { type: "idle" } }))
        setData("message", sessionID, reconcile(merged))
        setData(
          "part",
          reconcile(
            Object.fromEntries([
              ...retained.map((message) => [message.id, data.part[message.id] ?? []] as const),
              ...messages.map((message) => [message.info.id, message.parts.filter((part) => !SKIP_PARTS.has(part.type))] as const),
            ]),
          ),
        )
        setOlderCursor(cursor)
        if (todos) setData("todo", reconcile(todos))
        setData("part_text_accum_delta", reconcile({}))
        const bases = new Set<string>()
        uncertainParts.clear()
        // Without a snapshot cursor, only a full SSE part gives concurrent
        // deltas an unambiguous base. Repair other overlaps on completion.
        for (const event of events) {
          const props = event.properties ?? {}
          if (event.type === "message.part.updated") {
            bases.add(props.part.id)
            uncertainParts.delete(props.part.id)
          }
          if (event.type === "message.part.removed") {
            bases.delete(props.partID)
            uncertainParts.delete(props.partID)
          }
          if (event.type === "message.part.delta" && !bases.has(props.partID)) {
            uncertainParts.add(props.partID)
            continue
          }
          reduce(event)
        }
        if (uncertainParts.size && events.some(isTerminal)) refreshAfterLoad = true
        setConnection("snapshot", "")
        setLoaded(true)
        stopOnFailure()
      })
      clearTimeout(retryTimer)
      retryTimer = undefined
      retryDelay = 1000
    })().finally(() => {
      activeLoad = undefined
      duringLoad = undefined
      if (disposed) return
      setLoading(false)
      if (refreshAfterLoad && !suspended) {
        refreshAfterLoad = false
        queueMicrotask(() => void load())
      }
    })
    // Explicit callers still receive a rejection; automatic reconnect loads
    // also report it even when nobody awaits them.
    void activeLoad.catch((failure) => {
      if (disposed || abort.signal.aborted) return
      batch(() => {
        setConnection("snapshot", `Unable to load session: ${errorText(failure)}`)
        stopOnFailure()
      })
      if (retryTimer || suspended) return
      retryTimer = setTimeout(() => {
        retryTimer = undefined
        if (!disposed) void load()
      }, retryDelay)
      retryDelay = Math.min(retryDelay * 2, 30_000)
    })
    return activeLoad
  }

  let olderLoad: Promise<void> | undefined
  // Concurrent callers share the page in flight, so a waiter observes its result.
  const older = (): Promise<void> => {
    if (olderLoad) return olderLoad
    if (disposed || !hasOlder()) return Promise.resolve()
    olderLoad = loadOlder()
    return olderLoad
  }
  const loadOlder = async (): Promise<void> => {
    setLoadingOlder(true)
    try {
      // Always yield first: `older` must record this load before its cleanup runs.
      await activeLoad
      const before = olderCursor()
      if (disposed || !before) return
      const page = await oc.messagesPage(sessionID, directory, TAIL, before, controller.signal)
      if (disposed) return
      batch(() => {
        const existing = data.message[sessionID] ?? []
        const byID = new Map(existing.map((message) => [message.id, message]))
        page.items.forEach((message) => byID.set(message.info.id, visibleMessage(message.info)))
        setData("message", sessionID, reconcile([...byID.values()].sort((a, b) => a.id.localeCompare(b.id))))
        page.items.forEach((message) =>
          setData("part", message.info.id, reconcile(message.parts.filter((part) => !SKIP_PARTS.has(part.type)))),
        )
        setOlderCursor(page.cursor)
      })
    } finally {
      // Cleared with the cursor update, so no caller sees a new cursor and a finished load in flight.
      olderLoad = undefined
      setLoadingOlder(false)
    }
  }

  /** Loads the older pages that contain `ids`, and no further. Returns the IDs this session does not have. */
  const reveal = async (ids: readonly string[]): Promise<string[]> => {
    if (activeLoad) await activeLoad
    const loaded = (id: string) => !!data.message[sessionID]?.some((message) => message.id === id)
    const unknown = new Set<string>()
    // Confirm each unloaded ID first, so an unknown one never pages the whole transcript.
    for (const id of ids) {
      if (loaded(id)) continue
      const found = anchorValid(id) ? await oc.message(sessionID, directory, id, controller.signal) : undefined
      if (!found || found.info.sessionID !== sessionID) unknown.add(id)
    }
    while (!disposed && hasOlder() && ids.some((id) => !unknown.has(id) && !loaded(id))) {
      const cursor = olderCursor()
      await older()
      if (olderCursor() === cursor) break
    }
    return ids.filter((id) => unknown.has(id) || !loaded(id))
  }

  const suspend = () => {
    suspended = true
    loadAbort?.abort()
    clearTimeout(retryTimer)
    retryTimer = undefined
  }

  const refresh = () => {
    if (suspended) return
    if (activeLoad || duringLoad) {
      refreshAfterLoad = true
      return
    }
    void load()
  }

  const reduce = (event: LiveEvent) => {
    const props = event.properties ?? {}
    switch (event.type) {
      case "session.updated": {
        if (props.sessionID !== sessionID || !props.info) break
        setData("session", reconcile([props.info]))
        break
      }
      case "session.status": {
        setData("session_status", props.sessionID, reconcile(props.status))
        break
      }
      case "session.idle": {
        setData("session_status", props.sessionID, reconcile({ type: "idle" }))
        break
      }
      case "todo.updated": {
        if (props.sessionID !== sessionID || !Array.isArray(props.todos)) break
        setData("todo", reconcile(props.todos))
        break
      }
      case "message.updated": {
        const info: Message = props.info
        if (info.sessionID !== sessionID) break
        if (hasOlder() && data.message[sessionID]?.[0] && info.id < data.message[sessionID]![0]!.id) break
        setData(
          produce((draft) => {
            draft.message[sessionID] ??= []
            insertSorted(draft.message[sessionID]!, visibleMessage(info), (m) => m.id)
          }),
        )
        break
      }
      case "message.removed": {
        if (props.sessionID !== sessionID) break
        setData(
          produce((draft) => {
            const messages = draft.message[sessionID]
            if (messages) {
              const i = messages.findIndex((m) => m.id === props.messageID)
              if (i !== -1) messages.splice(i, 1)
            }
            delete draft.part[props.messageID]
          }),
        )
        break
      }
      case "message.part.updated": {
        const part: Part = props.part
        if (part.sessionID !== sessionID || SKIP_PARTS.has(part.type) || !data.message[sessionID]?.some((message) => message.id === part.messageID)) break
        setData(
          produce((draft) => {
            delete draft.part_text_accum_delta[part.id]
            draft.part[part.messageID] ??= []
            insertSorted(draft.part[part.messageID]!, part, (p) => p.id)
          }),
        )
        break
      }
      case "message.part.removed": {
        if (props.sessionID !== sessionID) break
        setData(
          produce((draft) => {
            delete draft.part_text_accum_delta[props.partID]
            const parts = draft.part[props.messageID]
            if (!parts) return
            const i = parts.findIndex((p) => p.id === props.partID)
            if (i !== -1) parts.splice(i, 1)
          }),
        )
        break
      }
      case "message.part.delta": {
        if (props.sessionID !== sessionID) break
        const parts = data.part[props.messageID]
        if (!parts) break
        const i = parts.findIndex((p) => p.id === props.partID)
        if (i === -1) break
        const current = (parts[i] as any)[props.field]
        setData(
          "part_text_accum_delta",
          props.partID,
          (existing) => (existing ?? (typeof current === "string" ? current : "")) + props.delta,
        )
        setData(
          "part",
          props.messageID,
          produce((draft) => {
            const part = draft[i] as any
            part[props.field] = (part[props.field] ?? "") + props.delta
          }),
        )
        break
      }
    }
  }

  const apply = (event: LiveEvent) => {
    if (disposed) return
    const props = event.properties ?? {}
    const owner = props.sessionID ?? props.info?.sessionID ?? props.part?.sessionID
    batch(() => {
      if (owner === sessionID) {
        // The store mutates inserted parts as deltas arrive; retain wire values.
        duringLoad?.push(structuredClone(event))
        if (event.type === "session.error") setTransientError(errorText(props.error))
        if (event.type === "session.status" && (props.status.type === "busy" || props.status.type === "retry"))
          clearFailure()
        if (event.type === "message.updated" && props.info.role === "user" && props.info.id > (latest()?.id ?? ""))
          clearFailure()
        if (event.type === "message.part.updated") uncertainParts.delete(props.part.id)
        if (event.type === "message.part.removed") uncertainParts.delete(props.partID)
      }
      reduce(event)
      stopOnFailure()
    })
    if (owner === sessionID && uncertainParts.size && isTerminal(event)) refresh()
  }

  const eventFailure = (failure: unknown) => {
    if (disposed) return
    batch(() => {
      setConnection("event", `Unable to process session event: ${errorText(failure)}`)
      stopOnFailure()
    })
  }
  let source: ServerEvents | undefined
  try {
    source = createServerEvents(`/oc/event?directory=${encodeURIComponent(directory)}`, {
      types: ["session.", "message.", "todo.", "permission.", "question."],
    })
    source.onopen = () => {
      if (disposed) return
      setConnection("stream", "")
      streamOpened = true
      releaseInitial?.()
      if (!activeLoad || snapshotStarted) refresh()
    }
    source.onerror = () => {
      if (disposed) return
      releaseInitial?.()
      batch(() => {
        setConnection("stream", "Session connection lost. Reconnecting...")
        stopOnFailure()
      })
    }
    source.onmessage = (e) => {
      if (disposed) return
      try {
        const event = JSON.parse(e.data)
        if (!event || typeof event.type !== "string") throw new Error("Invalid session event")
        setConnection("event", "")
        apply(event)
        void Promise.resolve(onEvent?.(event)).catch(eventFailure)
      } catch (failure) {
        eventFailure(failure)
      }
    }
  } catch (failure) {
    setConnection("stream", `Unable to connect to session: ${errorText(failure)}`)
    stopOnFailure()
  }
  onCleanup(() => {
    disposed = true
    controller.abort()
    clearTimeout(retryTimer)
    source?.close()
  })

  return { data, load, suspend, older, reveal, hasOlder, loadingOlder, apply, error, connectionError, loading, loaded, retry }
}
