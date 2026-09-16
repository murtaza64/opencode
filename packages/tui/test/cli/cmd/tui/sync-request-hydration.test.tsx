/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import type { GlobalEvent, PermissionRequest, QuestionRequest } from "@opencode-ai/sdk/v2"
import { tmpdir } from "../../../fixture/fixture"
import { createEventSource, directory, json, mount, wait } from "./sync-fixture"

const permission: PermissionRequest = {
  id: "per_old",
  sessionID: "ses_requests",
  permission: "bash",
  patterns: ["old"],
  always: ["*"],
  metadata: {},
}
const question: QuestionRequest = {
  id: "que_old",
  sessionID: "ses_requests",
  questions: [{ header: "Choice", question: "Old question?", options: [] }],
}

test("bootstrap snapshots preserve concurrent asks, updates, and reply tombstones", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  const permissions = Promise.withResolvers<Response>()
  const questions = Promise.withResolvers<Response>()
  let delayed = false
  const requested: string[] = []
  const { app, emit, sync } = await mount((url) => {
    if (!delayed) return
    if (url.pathname === "/permission") {
      requested.push("permission")
      return permissions.promise
    }
    if (url.pathname === "/question") {
      requested.push("question")
      return questions.promise
    }
  }, tmp.path)
  try {
    delayed = true
    const hydration = sync.bootstrap()
    await wait(() => requested.length === 2)
    emit({
      directory,
      payload: {
        id: "evt_p_reply",
        type: "permission.replied",
        properties: { sessionID: permission.sessionID, requestID: permission.id, reply: "once" },
      },
    })
    emit({
      directory,
      payload: {
        id: "evt_q_reply",
        type: "question.replied",
        properties: { sessionID: question.sessionID, requestID: question.id, answers: [] },
      },
    })
    emit({
      directory,
      payload: {
        id: "evt_q_reject",
        type: "question.rejected",
        properties: { sessionID: question.sessionID, requestID: "que_rejected" },
      },
    })
    emit({
      directory,
      payload: { id: "evt_p_ask", type: "permission.asked", properties: { ...permission, id: "per_live" } },
    })
    emit({
      directory,
      payload: { id: "evt_q_ask", type: "question.asked", properties: { ...question, id: "que_live" } },
    })
    emit({
      directory,
      payload: {
        id: "evt_p_update",
        type: "permission.asked",
        properties: { ...permission, id: "per_updated", patterns: ["new"] },
      },
    })
    emit({
      directory,
      payload: {
        id: "evt_q_update",
        type: "question.asked",
        properties: {
          ...question,
          id: "que_updated",
          questions: [{ header: "New", question: "New question?", options: [] }],
        },
      },
    })
    await wait(() => sync.data.question.ses_requests?.some((item) => item.id === "que_updated") ?? false)
    permissions.resolve(json([permission, { ...permission, id: "per_updated" }, { ...permission, id: "per_snapshot" }]))
    questions.resolve(
      json([
        question,
        { ...question, id: "que_rejected" },
        { ...question, id: "que_updated" },
        { ...question, id: "que_snapshot" },
      ]),
    )
    await hydration
    expect(sync.data.permission.ses_requests.map((item) => item.id)).toEqual([
      "per_live",
      "per_snapshot",
      "per_updated",
    ])
    expect(sync.data.question.ses_requests.map((item) => item.id)).toEqual(["que_live", "que_snapshot", "que_updated"])
    expect(sync.data.permission.ses_requests[2].patterns).toEqual(["new"])
    expect(sync.data.question.ses_requests[2].questions[0].question).toBe("New question?")
    emit({
      directory,
      payload: {
        id: "evt_p_after",
        type: "permission.replied",
        properties: { sessionID: permission.sessionID, requestID: "per_snapshot", reply: "once" },
      },
    })
    emit({
      directory,
      payload: {
        id: "evt_q_after",
        type: "question.rejected",
        properties: { sessionID: question.sessionID, requestID: "que_snapshot" },
      },
    })
    await wait(() => sync.data.question.ses_requests.length === 2)
    expect(sync.data.permission.ses_requests.map((item) => item.id)).toEqual(["per_live", "per_updated"])
  } finally {
    app.renderer.destroy()
  }
})

test("authoritative empty snapshots remove missed replies only in their directory and workspace", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  let empty = false
  const { app, emit, sync } = await mount((url) => {
    if (url.pathname === "/permission") return json(empty ? [] : [permission])
    if (url.pathname === "/question") return json(empty ? [] : [question])
  }, tmp.path)
  try {
    emit({
      directory: "/another",
      payload: {
        id: "evt_other_p",
        type: "permission.asked",
        properties: { ...permission, id: "per_other", sessionID: "ses_other" },
      },
    })
    emit({
      directory,
      workspace: "wrk_other",
      payload: {
        id: "evt_other_q",
        type: "question.asked",
        properties: { ...question, id: "que_other", sessionID: "ses_other" },
      },
    })
    await wait(() => sync.data.question.ses_other?.length === 1)
    empty = true
    await sync.bootstrap()
    expect(sync.data.permission.ses_requests).toEqual([])
    expect(sync.data.question.ses_requests).toEqual([])
    expect(sync.data.permission.ses_other.map((item) => item.id)).toEqual(["per_other"])
    expect(sync.data.question.ses_other.map((item) => item.id)).toEqual(["que_other"])
  } finally {
    app.renderer.destroy()
  }
})

test("failed request lists preserve known gates while the other list reconciles", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  let failed = false
  const { app, sync } = await mount((url) => {
    if (url.pathname === "/permission") return failed ? json({}, { status: 503 }) : json([permission])
    if (url.pathname === "/question") return json(failed ? [] : [question])
  }, tmp.path)
  try {
    failed = true
    await sync.bootstrap()
    expect(sync.data.permission.ses_requests).toEqual([permission])
    expect(sync.data.question.ses_requests).toEqual([])
  } finally {
    app.renderer.destroy()
  }
})

test("an older overlapping bootstrap cannot resurrect gates after a newer empty snapshot", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  const older = Promise.withResolvers<Response>()
  let delay = false
  let requested = false
  const { app, sync } = await mount((url) => {
    if (url.pathname !== "/question" || !delay) return
    requested = true
    return older.promise
  }, tmp.path)
  try {
    delay = true
    const first = sync.bootstrap()
    await wait(() => requested)
    delay = false
    await sync.bootstrap()
    older.resolve(json([question]))
    await first
    expect(sync.data.question.ses_requests ?? []).toEqual([])
  } finally {
    app.renderer.destroy()
  }
})

test("snapshots use the canonical instance directory instead of an attach path alias", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  const queries: string[] = []
  const { app, emit, sync } = await mount((url) => {
    if (url.pathname === "/path")
      return json({ home: "", state: "", config: "", worktree: "/canonical", directory: "/canonical/work" })
    if (url.pathname === "/permission" || url.pathname === "/question") {
      queries.push(url.searchParams.get("directory")!)
      return json([])
    }
  }, tmp.path)
  try {
    expect(queries).toEqual(["/canonical/work", "/canonical/work"])
    emit({
      directory: "/canonical/work",
      payload: { id: "evt_canonical", type: "question.asked", properties: question },
    })
    await wait(() => sync.data.question.ses_requests?.length === 1)
    await sync.bootstrap()
    expect(sync.data.question.ses_requests).toEqual([])
  } finally {
    app.renderer.destroy()
  }
})

test("an initial connected frame waits for canonical scope before fetching pending requests", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  const events = createEventSource()
  const instancePath = Promise.withResolvers<Response>()
  let pathRequested = false
  const queries: string[] = []
  const mounting = mount(
    (url) => {
      if (url.pathname === "/path") {
        pathRequested = true
        return instancePath.promise
      }
      if (url.pathname === "/permission" || url.pathname === "/question") {
        queries.push(url.searchParams.get("directory")!)
        return json([])
      }
    },
    tmp.path,
    events,
  )
  await wait(() => pathRequested)
  events.emit({ payload: { id: "evt_connected", type: "server.connected", properties: {} } } as GlobalEvent)
  instancePath.resolve(json({ home: "", state: "", config: "", worktree: "/canonical", directory: "/canonical/work" }))
  const { app } = await mounting
  try {
    expect(queries).toEqual(["/canonical/work", "/canonical/work"])
  } finally {
    app.renderer.destroy()
  }
})

test("reconnect during a workspace switch never combines the old directory with the new workspace", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  const instancePath = Promise.withResolvers<Response>()
  let pathRequested = false
  const queries: { directory: string | null; workspace: string | null }[] = []
  const { app, emit, project, sync } = await mount((url) => {
    if (url.pathname === "/experimental/workspace") return json([{ id: "wrk_new" }])
    if (url.pathname === "/path" && url.searchParams.get("workspace") === "wrk_new") {
      pathRequested = true
      return instancePath.promise
    }
    if (
      (url.pathname === "/permission" || url.pathname === "/question") &&
      url.searchParams.get("workspace") === "wrk_new"
    ) {
      queries.push({ directory: url.searchParams.get("directory"), workspace: url.searchParams.get("workspace") })
      return json([])
    }
  }, tmp.path)
  try {
    project.workspace.set("wrk_new")
    const hydration = sync.bootstrap()
    await wait(() => pathRequested)
    emit({ payload: { id: "evt_connected", type: "server.connected", properties: {} } } as GlobalEvent)
    instancePath.resolve(json({ home: "", state: "", config: "", worktree: "/new", directory: "/new/work" }))
    await hydration
    expect(queries).toEqual([
      { directory: "/new/work", workspace: "wrk_new" },
      { directory: "/new/work", workspace: "wrk_new" },
    ])
  } finally {
    app.renderer.destroy()
  }
})
