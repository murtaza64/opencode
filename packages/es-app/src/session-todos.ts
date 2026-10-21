import { createSignal, untrack } from "solid-js"
import type { Todo } from "@opencode-ai/sdk/v2"
import { oc } from "./api"

export type TodoEntry = {
  directory: string
  state: "loading" | "known" | "error"
  todos: readonly Todo[]
  // When this client received a todo.updated event. It is not the write time;
  // a snapshot read has no update time at all.
  at?: number
}

export type CurrentTodo =
  | { kind: "loading" | "unavailable" | "none" }
  | { kind: "active"; text: string; done: number; total: number; more: number; at?: number }
  | { kind: "next"; text: string; done: number; total: number; at?: number }
  | { kind: "complete"; done: number; total: number; at?: number }

// Projection of the agent's own todo list for currently watched sessions only:
// one snapshot read per watch, then todo.updated events from the shared stream.
// Released sessions are dropped after a short grace, so a remounting row keeps
// its observed update while reconnect rereads only live watches.
export const createSessionTodos = (grace = 2_000) => {
  const [entries, setEntries] = createSignal<Record<string, TodoEntry>>({})
  const versions = new Map<string, number>()
  const watchers = new Map<string, number>()
  const removals = new Map<string, ReturnType<typeof setTimeout>>()
  const load = (id: string, directory: string) => {
    const version = (versions.get(id) ?? 0) + 1
    versions.set(id, version)
    setEntries((previous) => ({ ...previous, [id]: { ...previous[id], directory, state: previous[id]?.state === "known" ? "known" : "loading", todos: previous[id]?.todos ?? [] } }))
    return oc.todos(id, directory).then(
      (todos) => {
        // An event observed after this read began is newer than its response.
        if (versions.get(id) !== version) return
        setEntries((previous) => ({ ...previous, [id]: { directory, state: "known", todos, at: undefined } }))
      },
      () => {
        if (versions.get(id) !== version) return
        setEntries((previous) => ({ ...previous, [id]: { ...previous[id]!, state: "error" } }))
      },
    )
  }
  return {
    get: (id: string) => entries()[id],
    // Returns the release for this watch; callers tie it to their lifecycle.
    watch: (id: string, directory: string) => {
      const key = JSON.stringify([directory, id])
      watchers.set(key, (watchers.get(key) ?? 0) + 1)
      clearTimeout(removals.get(key))
      removals.delete(key)
      // Untracked: a watch inside an effect must not resubscribe to every list update.
      const entry = untrack(entries)[id]
      // A failed read is retried by a new watch rather than reused from the release grace.
      if (!entry || entry.directory !== directory || entry.state === "error") void load(id, directory)
      let released = false
      return () => {
        if (released) return
        released = true
        const count = (watchers.get(key) ?? 1) - 1
        if (count > 0) return void watchers.set(key, count)
        watchers.delete(key)
        removals.set(key, setTimeout(() => {
          removals.delete(key)
          if (watchers.has(key) || untrack(entries)[id]?.directory !== directory) return
          versions.set(id, (versions.get(id) ?? 0) + 1)
          setEntries((previous) => Object.fromEntries(Object.entries(previous).filter(([other]) => other !== id)))
        }, grace))
      }
    },
    watched: () => [...watchers.keys()].map((key) => JSON.parse(key) as [string, string]),
    apply: (directory: string, event: { type: string; properties?: unknown }) => {
      if (event.type !== "todo.updated") return
      const properties = event.properties as { sessionID?: unknown; todos?: unknown } | undefined
      const id = typeof properties?.sessionID === "string" ? properties.sessionID : undefined
      if (!id || !Array.isArray(properties?.todos)) return
      const entry = entries()[id]
      if (!entry || entry.directory !== directory) return
      versions.set(id, (versions.get(id) ?? 0) + 1)
      setEntries((previous) => ({ ...previous, [id]: { directory, state: "known", todos: properties.todos as Todo[], at: Date.now() } }))
    },
    // Events may have been missed while disconnected; reread every watched list.
    reload: () => [...watchers.keys()].forEach((key) => {
      const [directory, id] = JSON.parse(key) as [string, string]
      void load(id, directory)
    }),
  }
}

export const currentTodo = (entry: TodoEntry | undefined): CurrentTodo => {
  if (!entry || (entry.state === "loading" && !entry.todos.length)) return { kind: "loading" }
  if (entry.state === "error" && !entry.todos.length) return { kind: "unavailable" }
  const todos = entry.todos.filter((todo) => todo.content.trim())
  if (!todos.length) return { kind: "none" }
  const done = todos.filter((todo) => todo.status === "completed").length
  const active = todos.filter((todo) => todo.status === "in_progress")
  if (active.length) return { kind: "active", text: active[0]!.content.trim(), done, total: todos.length, more: active.length - 1, at: entry.at }
  const next = todos.find((todo) => todo.status === "pending")
  if (next) return { kind: "next", text: next.content.trim(), done, total: todos.length, at: entry.at }
  return { kind: "complete", done, total: todos.length, at: entry.at }
}

export type TodoTurn = { status: "busy" | "idle" | "unknown"; startedAt?: number | null }

// A persisted list can carry an in_progress item from an earlier turn. Receiving
// an update after the busy turn started is an observation, not the list's write
// identity, so callers label it as observed rather than as current execution.
export const todoProvenance = (todo: CurrentTodo, turn: TodoTurn) => {
  if (!("at" in todo) || turn.status !== "busy" || !todo.at || !turn.startedAt) return "unobserved" as const
  return todo.at >= turn.startedAt ? "observed" as const : "unobserved" as const
}
