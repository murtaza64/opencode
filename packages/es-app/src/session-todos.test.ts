import { afterEach, expect, spyOn, test } from "bun:test"
import { createEffect, createRoot, onCleanup } from "solid-js"
import { createSessionTodos, currentTodo, todoProvenance, type TodoEntry } from "./session-todos"

const todo = (content: string, status: string) => ({ content, status, priority: "medium" })
const entry = (todos: TodoEntry["todos"], state: TodoEntry["state"] = "known"): TodoEntry => ({ directory: "/repo", state, todos })
let fetchSpy: ReturnType<typeof spyOn> | undefined
afterEach(() => fetchSpy?.mockRestore())

test("shows the first in-progress todo with progress counts", () => {
  expect(currentTodo(entry([todo("Read design", "completed"), todo("Wire Home", "in_progress"), todo("Test RTL", "in_progress"), todo("Park", "pending")])))
    .toEqual({ kind: "active", text: "Wire Home", done: 1, total: 4, more: 1, at: undefined })
})

test("does not present a pending todo as in progress", () => {
  expect(currentTodo(entry([todo("Read design", "completed"), todo("Park", "pending")]))).toEqual({ kind: "next", text: "Park", done: 1, total: 2, at: undefined })
})

test("reports completed, absent, loading and unavailable lists honestly", () => {
  expect(currentTodo(entry([todo("Read design", "completed"), todo("Dropped", "cancelled")]))).toEqual({ kind: "complete", done: 1, total: 2, at: undefined })
  expect(currentTodo(entry([]))).toEqual({ kind: "none" })
  expect(currentTodo(undefined)).toEqual({ kind: "loading" })
  expect(currentTodo(entry([], "loading"))).toEqual({ kind: "loading" })
  expect(currentTodo(entry([], "error"))).toEqual({ kind: "unavailable" })
})

const start = (responses: ((path: string) => Promise<Response>)) => {
  const paths: string[] = []
  fetchSpy = spyOn(globalThis, "fetch").mockImplementation(((input: RequestInfo | URL) => {
    const url = new URL(String(input), "http://localhost")
    paths.push(`${url.pathname}?${url.searchParams.get("directory")}`)
    return responses(url.pathname)
  }) as typeof fetch)
  return { todos: createRoot(() => createSessionTodos(0)), paths }
}

test("reads a watched session once and follows its todo.updated events", async () => {
  const { todos, paths } = start(async () => Response.json([todo("Initial", "in_progress")]))
  todos.watch("ses_a", "/repo")
  todos.watch("ses_a", "/repo")
  await Bun.sleep(0)
  expect(paths).toEqual(["/oc/session/ses_a/todo?/repo"])
  expect(currentTodo(todos.get("ses_a"))).toMatchObject({ kind: "active", text: "Initial" })
  todos.apply("/repo", { type: "todo.updated", properties: { sessionID: "ses_a", todos: [todo("Initial", "completed"), todo("Next", "in_progress")] } })
  expect(currentTodo(todos.get("ses_a"))).toMatchObject({ kind: "active", text: "Next", done: 1, total: 2 })
  expect(todos.get("ses_a")?.at).toBeNumber()
})

test("ignores events for unwatched sessions and other directories", async () => {
  const { todos } = start(async () => Response.json([]))
  todos.watch("ses_a", "/repo")
  await Bun.sleep(0)
  todos.apply("/repo", { type: "todo.updated", properties: { sessionID: "ses_b", todos: [todo("Other", "in_progress")] } })
  todos.apply("/elsewhere", { type: "todo.updated", properties: { sessionID: "ses_a", todos: [todo("Wrong directory", "in_progress")] } })
  expect(todos.get("ses_b")).toBeUndefined()
  expect(currentTodo(todos.get("ses_a"))).toEqual({ kind: "none" })
})

test("an event observed during the snapshot read wins over its older response", async () => {
  let release!: (response: Response) => void
  const { todos } = start(() => new Promise((resolve) => { release = resolve }))
  todos.watch("ses_a", "/repo")
  todos.apply("/repo", { type: "todo.updated", properties: { sessionID: "ses_a", todos: [todo("Newer", "in_progress")] } })
  release(Response.json([todo("Older", "in_progress")]))
  await Bun.sleep(0)
  expect(currentTodo(todos.get("ses_a"))).toMatchObject({ kind: "active", text: "Newer" })
})

test("a failed read keeps the last-known list marked as an error", async () => {
  let fail = false
  const { todos } = start(async () => fail ? new Response("down", { status: 503 }) : Response.json([todo("Known", "in_progress")]))
  todos.watch("ses_a", "/repo")
  await Bun.sleep(0)
  fail = true
  todos.reload()
  await Bun.sleep(0)
  expect(todos.get("ses_a")?.state).toBe("error")
  expect(currentTodo(todos.get("ses_a"))).toMatchObject({ kind: "active", text: "Known" })
})

test("an in-progress todo counts as observed this turn only after an update received during the busy turn", () => {
  const read = currentTodo(entry([todo("Old work", "in_progress")]))
  expect(todoProvenance(read, { status: "busy", startedAt: 1_000 })).toBe("unobserved")
  const updated = currentTodo({ ...entry([todo("New work", "in_progress")]), at: 2_000 })
  expect(todoProvenance(updated, { status: "busy", startedAt: 1_000 })).toBe("observed")
  // A new busy turn that has not rewritten its list keeps the old item persisted.
  expect(todoProvenance(updated, { status: "busy", startedAt: 3_000 })).toBe("unobserved")
  expect(todoProvenance(updated, { status: "idle", startedAt: 1_000 })).toBe("unobserved")
  expect(todoProvenance(updated, { status: "unknown" })).toBe("unobserved")
})

test("released watches are dropped and reconnect rereads only live watches", async () => {
  const { todos, paths } = start(async () => Response.json([todo("Work", "in_progress")]))
  const releasePinned = todos.watch("ses_pinned", "/repo")
  const releaseSelected = todos.watch("ses_selected", "/repo")
  const releaseAgain = todos.watch("ses_pinned", "/repo")
  await Bun.sleep(0)
  expect(paths.sort()).toEqual(["/oc/session/ses_pinned/todo?/repo", "/oc/session/ses_selected/todo?/repo"])
  releaseSelected()
  releasePinned()
  await Bun.sleep(1)
  // A second watcher of the same session keeps it alive.
  expect(todos.get("ses_pinned")).toBeDefined()
  expect(todos.get("ses_selected")).toBeUndefined()
  todos.apply("/repo", { type: "todo.updated", properties: { sessionID: "ses_selected", todos: [todo("Late", "in_progress")] } })
  expect(todos.get("ses_selected")).toBeUndefined()
  paths.length = 0
  todos.reload()
  await Bun.sleep(0)
  expect(paths).toEqual(["/oc/session/ses_pinned/todo?/repo"])
  releaseAgain()
  releaseAgain()
  await Bun.sleep(1)
  expect(todos.watched()).toEqual([])
  paths.length = 0
  todos.reload()
  await Bun.sleep(0)
  expect(paths).toEqual([])
})

test("a read that completes after release does not resurrect the session", async () => {
  let release!: (response: Response) => void
  const { todos } = start(() => new Promise((resolve) => { release = resolve }))
  const unwatch = todos.watch("ses_a", "/repo")
  unwatch()
  await Bun.sleep(1)
  release(Response.json([todo("Late", "in_progress")]))
  await Bun.sleep(0)
  expect(todos.get("ses_a")).toBeUndefined()
})

test("watching inside an effect reads once and keeps the list after it loads", async () => {
  const { todos, paths } = start(async () => Response.json([todo("Work", "in_progress")]))
  const dispose = createRoot((cleanup) => {
    createEffect(() => onCleanup(todos.watch("ses_a", "/repo")))
    return cleanup
  })
  await Bun.sleep(10)
  expect(paths).toEqual(["/oc/session/ses_a/todo?/repo"])
  expect(currentTodo(todos.get("ses_a"))).toMatchObject({ kind: "active", text: "Work" })
  dispose()
  await Bun.sleep(1)
  expect(todos.get("ses_a")).toBeUndefined()
})

test("a row that remounts within the grace keeps its observed update without rereading", async () => {
  const paths: string[] = []
  fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL) => {
    paths.push(new URL(String(input), "http://localhost").pathname)
    return Response.json([todo("Snapshot", "in_progress")])
  }) as typeof fetch)
  const todos = createRoot(() => createSessionTodos(50))
  const release = todos.watch("ses_a", "/repo")
  await Bun.sleep(0)
  todos.apply("/repo", { type: "todo.updated", properties: { sessionID: "ses_a", todos: [todo("Observed", "in_progress")] } })
  const at = todos.get("ses_a")?.at
  release()
  const again = todos.watch("ses_a", "/repo")
  await Bun.sleep(80)
  expect(paths).toEqual(["/oc/session/ses_a/todo"])
  expect(todos.get("ses_a")).toMatchObject({ at, todos: [{ content: "Observed" }] })
  again()
  await Bun.sleep(80)
  expect(todos.get("ses_a")).toBeUndefined()
})

test("an explicit reload recovers a transient read failure", async () => {
  let fail = true
  const { todos } = start(async () => fail ? new Response("down", { status: 503 }) : Response.json([todo("Recovered", "in_progress")]))
  todos.watch("ses_a", "/repo")
  await Bun.sleep(0)
  expect(currentTodo(todos.get("ses_a"))).toEqual({ kind: "unavailable" })
  fail = false
  todos.reload()
  await Bun.sleep(0)
  expect(currentTodo(todos.get("ses_a"))).toMatchObject({ kind: "active", text: "Recovered" })
})

test("rewatching within the release grace retries a failed read", async () => {
  let fail = true
  const paths: string[] = []
  fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL) => {
    paths.push(new URL(String(input), "http://localhost").pathname)
    return fail ? new Response("down", { status: 503 }) : Response.json([todo("Second read", "in_progress")])
  }) as typeof fetch)
  const todos = createRoot(() => createSessionTodos(1_000))
  todos.watch("ses_a", "/repo")()
  await Bun.sleep(0)
  fail = false
  todos.watch("ses_a", "/repo")
  await Bun.sleep(0)
  expect(paths).toHaveLength(2)
  expect(currentTodo(todos.get("ses_a"))).toMatchObject({ kind: "active", text: "Second read" })
})
