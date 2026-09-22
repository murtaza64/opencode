import { createServer } from "node:http"

export const directory = "/fixture with spaces/a&b?#"
export const imageCapability = {
  version: 1,
  encoding: "data-url",
  mimeTypes: ["image/png", "image/jpeg", "image/webp", "image/gif"],
  maxCount: 8,
  maxBytes: 5242880,
  maxTotalBytes: 10485760,
  maxWidth: 8192,
  maxHeight: 8192,
  maxPixels: 16777216,
  animated: false,
  compressedMetadata: false,
}
export const session = (id) => ({
  id,
  title: id === "ses_a" ? "Composer fixture" : "Other session",
  directory,
  projectID: "fixture",
  version: "1",
  agent: "build",
  time: { created: 1, updated: 2 },
})
export const createFixture = async () => {
  const streams = new Set()
  const sockets = new Set()
  const fixture = {
    status: "busy",
    capabilities: true,
    images: undefined,
    rejectImages: false,
    failSnapshot: false,
    holdInput: false,
    holdNormal: false,
    loseNormal: false,
    normalReplies: [],
    loseInput: false,
    holdAside: false,
    failCancel: false,
    noActiveAside: false,
    acceptedAckLost: false,
    promoteOnCancel: false,
    receipts: [],
    messages: undefined,
    messagesB: [],
    children: new Map(),
    permissions: undefined,
    questions: [],
    archived: new Set(),
    deleted: new Set(),
    failAction: "",
    holdAction: false,
    actionReplies: [],
    calls: [],
    eventStreams: new Map(),
    eventAuthorization: undefined,
    unexpected: [],
    inputReplies: [],
    asideReplies: [],
    emit(type, properties) {
      for (const response of streams) response.write(`data: ${JSON.stringify({ type, properties })}\n\n`)
    },
    setStatus(type) {
      fixture.status = type
      fixture.emit("session.status", { sessionID: "ses_a", status: { type } })
    },
    disconnect() {
      for (const response of streams) response.end()
      streams.clear()
    },
  }
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, "http://fixture")
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null
    fixture.calls.push({
      method: request.method,
      path: url.pathname,
      directory: url.searchParams.get("directory"),
      es: url.searchParams.get("es"),
      body,
    })
    const json = (value, status = 200) => {
      response.writeHead(status, { "content-type": "application/json" })
      response.end(JSON.stringify(value))
    }
    const childMatch = /^\/session\/([^/]+)(\/message)?$/.exec(url.pathname)
    const child = childMatch && fixture.children.get(childMatch[1])
    if (child && request.method === "GET") {
      const messages = !!childMatch[2]
      const complete = () => json(messages ? child.messages : child.session, child.failure || 200)
      if (messages && url.searchParams.get("directory") !== child.session.directory)
        return json({ error: "wrong child directory" }, 400)
      if (child.hold === (messages ? "messages" : "metadata")) {
        child.replies.push(complete)
        response.on("close", () => { child.closed++ })
        return
      }
      return complete()
    }
    if (["/event", "/global/event", "/api/events", "/api/notification-events"].includes(url.pathname)) {
      if (fixture.eventAuthorization && request.headers.authorization !== fixture.eventAuthorization) {
        response.writeHead(401, { "www-authenticate": 'Basic realm="fixture"', "content-type": "application/json" })
        response.end(JSON.stringify({ error: "Authentication required" }))
        return
      }
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" })
      response.write(url.pathname.startsWith("/api/") ? "data: connected\n\n" : ": connected\n\n")
      fixture.eventStreams.set(response, {
        path: url.pathname,
        directory: url.searchParams.get("directory"),
        es: url.searchParams.get("es"),
        lastEventId: request.headers["last-event-id"],
      })
      if (url.pathname === "/event") streams.add(response)
      response.on("close", () => {
        streams.delete(response)
        fixture.eventStreams.delete(response)
      })
      return
    }
    if (url.pathname === "/experimental/capabilities")
      return json(
        fixture.capabilities
          ? {
              sessionAside: { version: 1, cancel: true, images: fixture.images },
              sessionInput: {
                version: 1,
                delivery: ["queue", "steer"],
                list: true,
                cancel: true,
                images: fixture.images,
              },
            }
          : {},
      )
    if (url.pathname === "/api/editspaces")
      return json({ editspaces: [{ name: "fixture", root: directory }], default: "fixture" })
    if (url.pathname === "/api/state")
      return json({
        editspace: "fixture",
        root: directory,
        generated_at: 1,
        threads: ["ses_a", "ses_b"]
          .filter((id) => !fixture.deleted.has(id))
          .map((id) => ({
            key: id,
            kind: "session",
            title: session(id).title,
            sessions: [session(id)],
            lanes: [],
            tickets: [],
            prs: [],
          })),
        attention: [],
        frontier: [],
        unattached_prs: [],
        sessions: [session("ses_a"), session("ses_b")],
      })
    if (url.pathname === "/api/notifications") return json({ notifications: [] })
    if (url.pathname === "/api/issues") return json({ backend: "gh", repo: "fixture/test", issues: [] })
    if (url.pathname === "/api/docs") return json({ roots: [], sources: [] })
    if (["/experimental/session", "/session"].includes(url.pathname))
      return json(
        ["ses_a", "ses_b"]
          .filter((id) => !fixture.deleted.has(id))
          .map((id) => ({
            ...session(id),
            time: { ...session(id).time, ...(fixture.archived.has(id) ? { archived: 5 } : {}) },
          })),
      )
    if (url.pathname === "/session/status") return json({ ses_a: { type: fixture.status }, ses_b: { type: "idle" } })
    if (url.pathname === "/config/providers")
      return json({
        providers: [{ id: "fixture", models: { test: { id: "test", name: "Fixture model" } } }],
        default: { fixture: "test" },
      })
    if (url.pathname === "/agent")
      return fixture.failAgents
        ? json({ error: "agent list unavailable" }, 503)
        : json([
            { name: "build", mode: "primary" },
            { name: "plan", mode: "all" },
            { name: "explore", mode: "subagent" },
            { name: "hidden", mode: "primary", hidden: true },
          ])
    if (url.pathname === "/permission")
      return json(
        fixture.permissions ?? [
          { id: "permission-1", sessionID: "ses_a", permission: "bash", patterns: ["fixture command"], metadata: {} },
        ],
      )
    if (url.pathname === "/question") return json(fixture.questions)
    const match = /^\/session\/(ses_[ab])(.*)$/.exec(url.pathname)
    if (match) {
      const [, id, action] = match
      const operation =
        request.method === "POST" && action === "/fork"
          ? "fork"
          : request.method === "POST" && action === "/abort"
            ? "abort"
            : request.method === "PATCH" && !action
              ? "archive"
              : request.method === "DELETE" && !action
                ? "delete"
                : undefined
      if (operation) {
        if (fixture.failAction === operation) return json({ error: `${operation} unavailable` }, 503)
        const complete = () => {
          if (operation === "archive") fixture.archived.add(id)
          if (operation === "delete") fixture.deleted.add(id)
          if (operation === "abort") fixture.setStatus("idle")
          return json(operation === "fork" ? session("ses_b") : session(id))
        }
        if (fixture.holdAction) {
          fixture.actionReplies.push(complete)
          return
        }
        return complete()
      }
      if (!action)
        return json(
          { ...session(id), time: { ...session(id).time, ...(fixture.archived.has(id) ? { archived: 5 } : {}) } },
          fixture.failSnapshot ? 503 : 200,
        )
      if (action === "/message")
        return json(
          id === "ses_a"
            ? (fixture.messages ?? [
                {
                  info: {
                    id: "msg_user",
                    sessionID: id,
                    role: "user",
                    agent: "build",
                    model: { providerID: "fixture", modelID: "test" },
                    time: { created: 1 },
                  },
                  parts: [],
                },
                {
                  info: {
                    id: "msg_zcompaction",
                    sessionID: id,
                    role: "assistant",
                    agent: "compaction",
                    parentID: "msg_user",
                    providerID: "fixture",
                    modelID: "test",
                    mode: "compaction",
                    path: { cwd: directory, root: directory },
                    cost: 0,
                    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
                    time: { created: 2, completed: 3 },
                  },
                  parts: [],
                },
              ])
            : fixture.messagesB,
        )
      if (action === "/prompt_async" && request.method === "POST") {
        if (fixture.rejectImages && body.parts.some((part) => part.type === "file"))
          return json({ error: "Selected model does not support image input" }, 400)
        if (fixture.loseNormal) {
          fixture.loseNormal = false
          response.destroy()
          return
        }
        const complete = () => {
          response.writeHead(204)
          response.end()
        }
        if (fixture.holdNormal) {
          fixture.normalReplies.push(complete)
          return
        }
        complete()
        return
      }
      if (action === "/input") {
        if (request.method === "GET")
          return json({
            items: fixture.receipts.filter((item) => item.sessionID === id && item.state === "pending"),
            next: null,
          })
        if (fixture.rejectImages && body.images?.length)
          return json({ error: "Selected model does not support image input" }, 400)
        const receipt = fixture.receipts.find((item) => item.requestID === body.requestID) ?? {
          ...body,
          sessionID: id,
          agent: body.agent ?? "build",
          admittedSeq: fixture.receipts.length + 1,
          timeCreated: Date.now(),
          state: "pending",
        }
        if (fixture.loseInput) {
          fixture.loseInput = false
          response.destroy()
          return
        }
        if (!fixture.receipts.includes(receipt)) fixture.receipts.push(receipt)
        if (fixture.acceptedAckLost) {
          fixture.acceptedAckLost = false
          response.destroy()
          return
        }
        if (fixture.holdInput) {
          fixture.inputReplies.push(() => json(receipt))
          return
        }
        return json(receipt)
      }
      if (action.startsWith("/input/")) {
        const receipt = fixture.receipts.find((item) => item.requestID === decodeURIComponent(action.slice(7)))
        if (!receipt) return json({ error: "not found" }, 404)
        if (request.method === "DELETE") {
          if (fixture.promoteOnCancel) {
            Object.assign(receipt, { state: "promoted", messageID: "msg_promoted", timePromoted: Date.now() })
            return json({ error: "already promoted" }, 409)
          }
          receipt.state = "cancelled"
          receipt.timeCancelled = Date.now()
        }
        return json(receipt)
      }
      if (action === "/aside") {
        if (fixture.rejectImages && body.images?.length)
          return json({ error: "Selected model does not support image input" }, 400)
        const answer = () =>
          json({
            requestID: body.requestID,
            text: "ASIDE ONLY\n" + "A long snapshot answer. ".repeat(220),
            snapshot: {
              capturedAt: 1789501950000,
              throughMessageID: "msg_boundary",
              excludedMessageCount: 2,
              activity: { status: fixture.status, tools: [] },
            },
          })
        if (fixture.holdAside) {
          fixture.asideReplies.push(answer)
          return
        }
        return answer()
      }
      if (action.startsWith("/aside/") && request.method === "DELETE")
        return json(
          fixture.failCancel ? { error: "cancel unavailable" } : !fixture.noActiveAside,
          fixture.failCancel ? 503 : 200,
        )
    }
    fixture.unexpected.push(`${request.method} ${url.pathname}`)
    return json({ error: "Unexpected fixture request" }, 501)
  })
  server.on("connection", (socket) => {
    sockets.add(socket)
    socket.on("close", () => sockets.delete(socket))
  })
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  return Object.assign(fixture, {
    url: `http://127.0.0.1:${server.address().port}`,
    close: async () => {
      sockets.forEach((socket) => socket.destroy())
      await new Promise((resolve) => server.close(resolve))
    },
  })
}
