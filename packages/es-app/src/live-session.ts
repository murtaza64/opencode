/* Live session store: initial fetch + SSE event reducer, shaped exactly like
 * session-ui's DataProvider Data store. Trimmed port of packages/app's
 * global-sync/event-reducer.ts (message.updated / part.updated / part.delta /
 * session.status), without the Binary/reconcile machinery. */
import { createStore, produce, reconcile } from "solid-js/store"
import { batch, createSignal, onCleanup } from "solid-js"
import type { Message, Part, Session, SessionStatus } from "@opencode-ai/sdk/v2"
import { oc } from "./api"

const SKIP_PARTS = new Set(["patch", "step-start", "step-finish"])
type LiveEvent = { type: string; properties?: any }

const isTerminal = (event: LiveEvent) =>
  event.type === "session.idle" ||
  event.type === "session.error" ||
  (event.type === "session.status" && event.properties?.status?.type === "idle") ||
  (event.type === "message.updated" &&
    event.properties?.info?.role === "assistant" &&
    !!(event.properties.info.error || event.properties.info.time?.completed))

const errorText = (error: unknown): string => {
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
  })

  const [transientError, setTransientError] = createSignal("")
  const [clearedThrough, setClearedThrough] = createSignal("")
  const [connection, setConnection] = createStore({ stream: "", snapshot: "", event: "" })
  const [loading, setLoading] = createSignal(false)
  const latest = () => data.message[sessionID]?.at(-1)
  const error = () => {
    const message = latest()
    return (
      transientError() ||
      (message?.role === "assistant" && message.id > clearedThrough() && message.error ? errorText(message.error) : "")
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
    if (error() || connectionError()) setData("session_status", sessionID, reconcile({ type: "idle" }))
  }
  let disposed = false
  let activeLoad: Promise<void> | undefined
  let duringLoad: LiveEvent[] | undefined
  let refreshAfterLoad = false
  const uncertainParts = new Set<string>()

  const load = (): Promise<void> => {
    if (disposed) return Promise.resolve()
    if (activeLoad) return activeLoad
    setLoading(true)
    duringLoad = []
    activeLoad = (async () => {
      const [session, messages, status] = await Promise.all([
        oc.session(sessionID, directory),
        oc.messages(sessionID, directory),
        oc.status(directory),
      ])
      if (disposed) return
      const events = duringLoad!
      duringLoad = undefined
      messages.sort((a, b) => a.info.id.localeCompare(b.info.id))
      batch(() => {
        const previous = latest()
        if (previous && (messages.findLast((m) => m.info.role === "user")?.info.id ?? "") > previous.id) clearFailure()
        setData(
          produce((draft) => {
            draft.session = [session]
            draft.session_status = { ...status, [sessionID]: status[sessionID] ?? { type: "idle" } }
            draft.message[sessionID] = messages.map((m) => m.info)
            draft.part = {}
            draft.part_text_accum_delta = {}
            for (const m of messages) draft.part[m.info.id] = m.parts.filter((p) => !SKIP_PARTS.has(p.type))
          }),
        )
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
        stopOnFailure()
      })
    })().finally(() => {
      activeLoad = undefined
      duringLoad = undefined
      if (disposed) return
      setLoading(false)
      if (refreshAfterLoad) {
        refreshAfterLoad = false
        queueMicrotask(() => void load())
      }
    })
    // Explicit callers still receive a rejection; automatic reconnect loads
    // also report it even when nobody awaits them.
    void activeLoad.catch((failure) => {
      if (disposed) return
      batch(() => {
        setConnection("snapshot", `Unable to load session: ${errorText(failure)}`)
        stopOnFailure()
      })
    })
    return activeLoad
  }

  const refresh = () => {
    if (activeLoad || duringLoad) {
      refreshAfterLoad = true
      return
    }
    void load()
  }

  const reduce = (event: LiveEvent) => {
    const props = event.properties ?? {}
    switch (event.type) {
      case "session.status": {
        setData("session_status", props.sessionID, reconcile(props.status))
        break
      }
      case "session.idle": {
        setData("session_status", props.sessionID, reconcile({ type: "idle" }))
        break
      }
      case "message.updated": {
        const info: Message = props.info
        if (info.sessionID !== sessionID) break
        setData(
          produce((draft) => {
            draft.message[sessionID] ??= []
            insertSorted(draft.message[sessionID]!, info, (m) => m.id)
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
        if (part.sessionID !== sessionID || SKIP_PARTS.has(part.type)) break
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
  let source: EventSource | undefined
  try {
    source = new EventSource(`/oc/event?directory=${encodeURIComponent(directory)}`)
    source.onopen = () => {
      if (disposed) return
      setConnection("stream", "")
      refresh()
    }
    source.onerror = () => {
      if (disposed) return
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
    source?.close()
  })

  return { data, load, apply, error, connectionError, loading, retry }
}
