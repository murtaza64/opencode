import { afterEach, beforeEach, expect, spyOn, test, type Mock } from "bun:test"
import type { GlobalSession, PermissionRequest, QuestionRequest } from "@opencode-ai/sdk/v2"
import { createRoot, createSignal } from "solid-js"
import { createSessionActivity } from "./session-activity"

const rootDirectory = "/repo"
const childDirectory = "/repo/child & tools"
const grandchildDirectory = "/repo/grandchild"
const unrelatedDirectory = "/other"
const directories = [rootDirectory, childDirectory, grandchildDirectory, unrelatedDirectory]
const session = (id: string, directory = rootDirectory, parentID?: string) =>
  ({ id, directory, parentID, title: id, time: { created: 1, updated: 1 } }) as GlobalSession
const permission = (id: string, sessionID = "ses_child"): PermissionRequest => ({
  id,
  sessionID,
  permission: "bash",
  patterns: ["bun test"],
  always: [],
  metadata: {},
})
const question = (id: string, sessionID = "ses_grandchild"): QuestionRequest => ({
  id,
  sessionID,
  questions: [{ header: "Tests", question: "Run tests?", options: [{ label: "Yes", description: "Run tests" }] }],
})

class ActivityEvents {
  static current: ActivityEvents
  onmessage?: (event: { data: string }) => void
  onopen?: () => void
  onerror?: () => void
  closed = false
  constructor(readonly url: string) {
    ActivityEvents.current = this
  }
  close() {
    this.closed = true
  }
  send(directory: string, type: string, properties: unknown) {
    this.onmessage?.({ data: JSON.stringify({ directory, payload: { type, properties } }) })
  }
}

type Snapshot = {
  status: Record<string, { type: string }>
  permissions: PermissionRequest[]
  questions: QuestionRequest[]
}
let snapshots: Record<string, Snapshot>
let failures: Set<string>
let dispose: () => void
let fetchSpy: Mock<(input: RequestInfo | URL) => Promise<Response>>
let originalSource: PropertyDescriptor | undefined
let releases: (() => void)[]
let outstanding: Promise<void>[]

const response = (input: RequestInfo | URL) => {
  const url = new URL(input instanceof Request ? input.url : String(input), "http://localhost")
  const directory = url.searchParams.get("directory") ?? ""
  const snapshot = snapshots[directory]
  if (!snapshot) throw new Error(`Unexpected directory: ${directory}`)
  if (failures.has(`${directory}:${url.pathname}`)) return new Response("Unavailable", { status: 503 })
  if (url.pathname === "/oc/session/status") return Response.json(snapshot.status)
  if (url.pathname === "/oc/permission") return Response.json(snapshot.permissions)
  if (url.pathname === "/oc/question") return Response.json(snapshot.questions)
  throw new Error(`Unexpected fetch: ${url.pathname}`)
}
const start = (
  initial = [
    session("ses_parent"),
    session("ses_child", childDirectory, "ses_parent"),
    session("ses_grandchild", grandchildDirectory, "ses_child"),
    session("ses_unrelated", unrelatedDirectory),
  ],
) =>
  createRoot((cleanup) => {
    dispose = cleanup
    const [sessions, setSessions] = createSignal(initial)
    const refreshes: number[] = []
    const activity = createSessionActivity(sessions, () => refreshes.push(1))
    return { activity, setSessions, refreshes }
  })
const load = (activity: ReturnType<typeof createSessionActivity>) =>
  Promise.all(directories.map((directory) => activity.refreshDirectory(directory)))

test("reply refresh cannot reuse a snapshot started before the reply", async () => {
  const { activity } = start()
  await load(activity)
  snapshots[childDirectory]!.permissions = [permission("perm_reply")]
  const held = holdSnapshot(activity, childDirectory)
  snapshots[childDirectory]!.permissions = []
  const refreshed = activity.refreshDirectory(childDirectory, true)
  held.release()
  await refreshed
  expect(activity.pending("ses_parent")).toEqual([])
})

// Capture the HTTP body before releasing it, independently of subsequent SSE events.
const holdSnapshot = (activity: ReturnType<typeof createSessionActivity>, directory: string) => {
  const gate = Promise.withResolvers<void>()
  releases.push(() => gate.resolve())
  fetchSpy.mockImplementation(async (input) => {
    const stale = response(input)
    await gate.promise
    return stale
  })
  const loading = activity.refreshDirectory(directory)
  outstanding.push(loading)
  return { loading, release: () => gate.resolve() }
}

beforeEach(() => {
  snapshots = Object.fromEntries(
    directories.map((directory) => [directory, { status: {}, permissions: [], questions: [] }]),
  )
  failures = new Set()
  releases = []
  outstanding = []
  originalSource = Object.getOwnPropertyDescriptor(globalThis, "EventSource")
  Object.defineProperty(globalThis, "EventSource", { configurable: true, value: ActivityEvents })
  fetchSpy = spyOn(globalThis, "fetch")
  fetchSpy.mockImplementation(async (input) => response(input))
})

afterEach(async () => {
  dispose?.()
  releases.forEach((release) => release())
  await Promise.allSettled(outstanding)
  fetchSpy.mockRestore()
  if (originalSource) Object.defineProperty(globalThis, "EventSource", originalSource)
  else Reflect.deleteProperty(globalThis, "EventSource")
})

test("an idle parent reports busy and retry descendants but excludes unrelated sessions", async () => {
  snapshots[rootDirectory].status = { ses_parent: { type: "idle" } }
  snapshots[childDirectory].status = { ses_child: { type: "busy" } }
  snapshots[grandchildDirectory].status = { ses_grandchild: { type: "retry" } }
  snapshots[unrelatedDirectory].status = { ses_unrelated: { type: "busy" } }
  const { activity } = start()
  await load(activity)
  expect(activity.running("ses_parent").sort()).toEqual(["ses_child", "ses_grandchild"])
  expect(activity.running("ses_child").sort()).toEqual(["ses_child", "ses_grandchild"])
  ActivityEvents.current.send(childDirectory, "session.idle", { sessionID: "ses_child" })
  expect(activity.running("ses_parent")).toEqual(["ses_grandchild"])
  ActivityEvents.current.send(grandchildDirectory, "session.error", { sessionID: "ses_grandchild" })
  expect(activity.running("ses_parent")).toEqual([])
})

test("pending parent, child, and grandchild requests remain visible while descendants run with each owner directory", async () => {
  const parent = question("que_parent", "ses_parent")
  const child = permission("per_child")
  const grandchild = question("que_grandchild")
  snapshots[rootDirectory].questions = [parent]
  snapshots[childDirectory].permissions = [child]
  snapshots[childDirectory].status = { ses_child: { type: "busy" } }
  snapshots[grandchildDirectory].questions = [grandchild]
  snapshots[unrelatedDirectory].permissions = [permission("per_unrelated", "ses_unrelated")]
  snapshots[unrelatedDirectory].questions = [question("que_unrelated", "ses_unrelated")]
  const { activity } = start()
  await load(activity)
  expect(activity.pending("ses_parent")).toEqual([
    { kind: "question", request: parent, directory: rootDirectory },
    { kind: "permission", request: child, directory: childDirectory },
    { kind: "question", request: grandchild, directory: grandchildDirectory },
  ])
  expect(activity.running("ses_parent")).toEqual(["ses_child"])
  expect(activity.pending("ses_child").map((item) => item.request.id)).toEqual(["per_child", "que_grandchild"])
  expect(activity.pending("ses_grandchild").map((item) => item.request.id)).toEqual(["que_grandchild"])
})

test("root resolves ancestry, stops at missing metadata, and returns undefined for an unknown session", async () => {
  const { activity } = start([
    session("ses_parent"),
    session("ses_child", childDirectory, "ses_parent"),
    session("ses_grandchild", grandchildDirectory, "ses_child"),
    session("ses_orphan", rootDirectory, "ses_missing"),
  ])
  await load(activity)
  expect(activity.root("ses_parent")?.id).toBe("ses_parent")
  expect(activity.root("ses_grandchild")?.id).toBe("ses_parent")
  expect(activity.root("ses_orphan")?.id).toBe("ses_orphan")
  expect(activity.root("ses_missing")).toBeUndefined()
  expect(activity.pending("ses_missing")).toEqual([])
  expect(activity.running("ses_missing")).toEqual([])
})

test("cyclic parent metadata does not loop or duplicate descendant requests and statuses", async () => {
  snapshots[rootDirectory].permissions = [permission("per_cycle", "ses_b")]
  snapshots[rootDirectory].status = { ses_b: { type: "busy" } }
  const { activity } = start([
    session("ses_a", rootDirectory, "ses_b"),
    session("ses_b", rootDirectory, "ses_a"),
    session("ses_self", rootDirectory, "ses_self"),
  ])
  await load(activity)
  expect(["ses_a", "ses_b"]).toContain(activity.root("ses_a")?.id ?? "")
  expect(["ses_a", "ses_b"]).toContain(activity.root("ses_b")?.id ?? "")
  expect(activity.root("ses_self")?.id).toBe("ses_self")
  expect(activity.pending("ses_a").map((item) => item.request.id)).toEqual(["per_cycle"])
  expect(activity.running("ses_a")).toEqual(["ses_b"])
})

test("a failed first snapshot reports an explicit error instead of a successful empty result", async () => {
  failures.add(`${rootDirectory}:/oc/permission`)
  const { activity } = start()
  await load(activity)
  expect(activity.pending("ses_parent")).toEqual([])
  expect(activity.error("ses_parent")).toContain(rootDirectory)
  expect(activity.error("ses_parent")).toContain("Unable to refresh")
  expect(activity.error("ses_unknown", rootDirectory)).toContain("Unable to refresh")
  expect(activity.error("ses_unrelated")).toBe("")
  failures.clear()
  await activity.refreshDirectory(rootDirectory)
  expect(activity.error("ses_parent")).toBe("")
})

test.each(["/oc/permission", "/oc/question"])(
  "partial %s failure retains pending requests while successful status refreshes apply",
  async (endpoint) => {
    snapshots[childDirectory].permissions = [permission("per_retained")]
    snapshots[childDirectory].questions = [question("que_retained", "ses_child")]
    const { activity } = start()
    await load(activity)
    failures.add(`${childDirectory}:${endpoint}`)
    snapshots[childDirectory].status = { ses_child: { type: "retry" } }
    await activity.refreshDirectory(childDirectory)
    expect(activity.pending("ses_parent").map((item) => item.request.id)).toEqual(["per_retained", "que_retained"])
    expect(activity.running("ses_parent")).toEqual(["ses_child"])
    expect(activity.error("ses_parent")).toContain(childDirectory)
    expect(activity.error("ses_unrelated")).toBe("")
    failures.clear()
    snapshots[childDirectory].permissions = []
    snapshots[childDirectory].questions = []
    await activity.refreshDirectory(childDirectory)
    expect(activity.pending("ses_parent")).toEqual([])
    expect(activity.error("ses_parent")).toBe("")
  },
)

test("a failed status snapshot retains running state while successful request snapshots repair pending state", async () => {
  snapshots[childDirectory].status = { ses_child: { type: "busy" } }
  snapshots[childDirectory].permissions = [permission("per_old")]
  const { activity } = start()
  await load(activity)
  failures.add(`${childDirectory}:/oc/session/status`)
  snapshots[childDirectory].permissions = []
  snapshots[childDirectory].questions = [question("que_new", "ses_child")]
  await activity.refreshDirectory(childDirectory)
  expect(activity.running("ses_parent")).toEqual(["ses_child"])
  expect(activity.pending("ses_parent").map((item) => item.request.id)).toEqual(["que_new"])
  expect(activity.error("ses_parent")).toContain(childDirectory)
})

test.each(["permission", "question"] as const)(
  "%s asked during an older empty snapshot remains pending",
  async (kind) => {
    const { activity } = start()
    await load(activity)
    const held = holdSnapshot(activity, childDirectory)
    const item =
      kind === "permission"
        ? { kind, request: permission("req_new"), directory: childDirectory }
        : { kind, request: question("req_new", "ses_child"), directory: childDirectory }
    ActivityEvents.current.send(childDirectory, `${kind}.asked`, item.request)
    expect(activity.pending("ses_parent")).toEqual([item])
    held.release()
    await held.loading
    expect(activity.pending("ses_parent")).toEqual([item])
  },
)

test.each(["permission", "question"] as const)(
  "%s replied during a stale pending snapshot is not resurrected",
  async (kind) => {
    snapshots[childDirectory].permissions = kind === "permission" ? [permission("req_old")] : []
    snapshots[childDirectory].questions = kind === "question" ? [question("req_old", "ses_child")] : []
    const { activity } = start()
    await load(activity)
    const held = holdSnapshot(activity, childDirectory)
    ActivityEvents.current.send(childDirectory, `${kind}.replied`, {
      sessionID: "ses_child",
      requestID: "req_old",
      reply: "once",
      answers: [["Yes"]],
    })
    expect(activity.pending("ses_parent")).toEqual([])
    held.release()
    await held.loading
    expect(activity.pending("ses_parent")).toEqual([])
  },
)

test("asked then replied events replay in order over an in-flight snapshot", async () => {
  const { activity } = start()
  await load(activity)
  const held = holdSnapshot(activity, childDirectory)
  ActivityEvents.current.send(childDirectory, "permission.asked", permission("per_answered"))
  ActivityEvents.current.send(childDirectory, "permission.replied", {
    sessionID: "ses_child",
    requestID: "per_answered",
    reply: "once",
  })
  ActivityEvents.current.send(childDirectory, "question.asked", question("que_rejected", "ses_child"))
  ActivityEvents.current.send(childDirectory, "question.rejected", {
    sessionID: "ses_child",
    requestID: "que_rejected",
  })
  held.release()
  await held.loading
  expect(activity.pending("ses_parent")).toEqual([])
})

test("a snapshot that already contains an asked request does not duplicate it on replay", async () => {
  const { activity } = start()
  await load(activity)
  snapshots[childDirectory].questions = [question("que_same", "ses_child")]
  const held = holdSnapshot(activity, childDirectory)
  ActivityEvents.current.send(childDirectory, "question.asked", question("que_same", "ses_child"))
  held.release()
  await held.loading
  expect(activity.pending("ses_parent").map((item) => item.request.id)).toEqual(["que_same"])
})

test("status events during a snapshot win over its stale running state", async () => {
  snapshots[childDirectory].status = { ses_child: { type: "busy" } }
  const { activity } = start()
  await load(activity)
  const held = holdSnapshot(activity, childDirectory)
  ActivityEvents.current.send(childDirectory, "session.idle", { sessionID: "ses_child" })
  held.release()
  await held.loading
  expect(activity.running("ses_parent")).toEqual([])
})

test("reconnect repairs missed requests and statuses without clearing disconnect errors on an ordinary refresh", async () => {
  snapshots[childDirectory].permissions = [permission("per_answered_offline")]
  snapshots[childDirectory].status = { ses_child: { type: "busy" } }
  const { activity, refreshes } = start()
  await load(activity)
  expect(ActivityEvents.current.url).toBe("/oc/global/event")
  ActivityEvents.current.onopen?.()
  await load(activity)
  ActivityEvents.current.onerror?.()
  expect(activity.error("ses_parent")).toContain("connection lost")
  await activity.refreshDirectory(rootDirectory)
  expect(activity.error("ses_parent")).toContain("connection lost")
  snapshots[childDirectory].permissions = []
  snapshots[childDirectory].status = { ses_child: { type: "idle" } }
  snapshots[grandchildDirectory].questions = [question("que_missed")]
  snapshots[grandchildDirectory].status = { ses_grandchild: { type: "retry" } }
  const calls = fetchSpy.mock.calls.length
  ActivityEvents.current.onopen?.()
  expect(fetchSpy.mock.calls.length).toBe(calls + 12)
  await load(activity)
  expect(refreshes).toHaveLength(2)
  expect(activity.pending("ses_parent")).toEqual([
    { kind: "question", request: question("que_missed"), directory: grandchildDirectory },
  ])
  expect(activity.running("ses_parent")).toEqual(["ses_grandchild"])
  expect(activity.error("ses_parent")).toBe("")
})

test("an unknown child's asked request joins its family when metadata arrives and keeps the event's owner directory", async () => {
  const { activity, setSessions } = start([session("ses_parent")])
  await activity.refreshDirectory(rootDirectory)
  const request = question("que_early", "ses_late_child")
  ActivityEvents.current.send(childDirectory, "question.asked", request)
  expect(activity.pending("ses_parent")).toEqual([])
  expect(activity.pending("ses_late_child")).toEqual([{ kind: "question", request, directory: childDirectory }])
  setSessions([session("ses_parent"), session("ses_late_child", childDirectory, "ses_parent")])
  expect(activity.root("ses_late_child")?.id).toBe("ses_parent")
  expect(activity.pending("ses_parent")).toEqual([{ kind: "question", request, directory: childDirectory }])
})

test("immutable request wrappers and payloads retain identity across status events and equivalent snapshots", async () => {
  snapshots[childDirectory].permissions = [permission("per_stable")]
  snapshots[childDirectory].questions = [question("que_stable", "ses_child")]
  const { activity } = start()
  await load(activity)
  const [permissionItem, questionItem] = activity.pending("ses_parent")
  Object.freeze(permissionItem)
  Object.freeze(permissionItem.request)
  Object.freeze(questionItem)
  Object.freeze(questionItem.request)
  ActivityEvents.current.send(childDirectory, "session.status", { sessionID: "ses_child", status: { type: "busy" } })
  expect(activity.pending("ses_parent")[0]).toBe(permissionItem)
  expect(activity.pending("ses_parent")[1]).toBe(questionItem)
  await activity.refreshDirectory(childDirectory)
  expect(activity.pending("ses_parent")[0]).toBe(permissionItem)
  expect(activity.pending("ses_parent")[1]).toBe(questionItem)
  expect(activity.pending("ses_parent")[1].request).toBe(questionItem.request)
  ActivityEvents.current.send(childDirectory, "question.asked", question("que_stable", "ses_child"))
  expect(activity.pending("ses_parent")[1]).toBe(questionItem)
})

test("a rejected snapshot settling after disposal cannot change errors or pending state", async () => {
  snapshots[childDirectory].permissions = [permission("per_retained")]
  const { activity } = start()
  await load(activity)
  const before = activity.pending("ses_parent")[0]
  failures.add(`${childDirectory}:/oc/permission`)
  snapshots[childDirectory].questions = [question("que_late", "ses_child")]
  const held = holdSnapshot(activity, childDirectory)
  dispose()
  held.release()
  await held.loading
  expect(ActivityEvents.current.closed).toBe(true)
  expect(activity.error("ses_parent")).toBe("")
  expect(activity.pending("ses_parent")).toEqual([before])
  expect(activity.pending("ses_parent")[0]).toBe(before)
})

test("a queued EventSource error after disposal cannot change the public error state", async () => {
  const { activity } = start()
  await load(activity)
  const queuedError = ActivityEvents.current.onerror
  const before = activity.error("ses_parent")
  dispose()
  expect(ActivityEvents.current.closed).toBe(true)
  queuedError?.()
  expect(activity.error("ses_parent")).toBe(before)
})
