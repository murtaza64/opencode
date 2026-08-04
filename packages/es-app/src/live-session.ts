/* Live session store: initial fetch + SSE event reducer, shaped exactly like
 * session-ui's DataProvider Data store. Trimmed port of packages/app's
 * global-sync/event-reducer.ts (message.updated / part.updated / part.delta /
 * session.status), without the Binary/reconcile machinery. */
import { createStore, produce, reconcile, type SetStoreFunction } from "solid-js/store"
import { onCleanup } from "solid-js"
import type { Message, Part, Session } from "@opencode-ai/sdk/v2"
import { oc } from "./api"

const SKIP_PARTS = new Set(["patch", "step-start", "step-finish"])

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

  const load = async () => {
    const [session, messages, status] = await Promise.all([
      oc.session(sessionID, directory),
      oc.messages(sessionID, directory),
      oc.status(directory),
    ])
    setData(
      produce((draft) => {
        draft.session = [session]
        draft.session_status = status
        draft.message[sessionID] = messages.map((m) => m.info)
        for (const m of messages) draft.part[m.info.id] = m.parts.filter((p) => !SKIP_PARTS.has(p.type))
      }),
    )
  }

  const apply = (event: { type: string; properties?: any }) => {
    const props = event.properties ?? {}
    switch (event.type) {
      case "session.status": {
        setData("session_status", props.sessionID, props.status)
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

  const source = new EventSource(`/oc/event?directory=${encodeURIComponent(directory)}`)
  source.onmessage = (e) => {
    try {
      const event = JSON.parse(e.data)
      apply(event)
      onEvent?.(event)
    } catch {
      /* ignore malformed frames */
    }
  }
  onCleanup(() => source.close())

  return { data, load, apply }
}
