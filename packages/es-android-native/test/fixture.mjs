// Private fixture standing in for OpenCode Core (/oc) and the es dashboard (/es) behind the
// paired gateway. Serves synthetic data in the verified live shapes and records every write
// so emulator checks can assert exact bodies. Never points at real services.
import http from "node:http"

const now = Date.now()
const minutes = (count) => now - count * 60_000
export const directory = "/fixture/opencode/lanes/composer-float/repos/murtaza64/opencode"

const session = (id, title, live, updated, directory) => ({ id, title, live, updated, cost: 1.42, directory, digesting: false })
const lane = (name, activity, status = "active", owner = "ses_owner") => ({
  lane: name, owner, activity, activity_at: new Date(minutes(7)).toISOString(), activity_session: `ses_${name}`,
  issue: `https://github.com/murtaza64/dotfiles/issues/2${name.length}`, status, dir: `/fixture/opencode/lanes/${name}`, repos: ["murtaza64/opencode"], tickets: [],
})
const thread = (key, title, description, lanes, sessions) => ({ kind: "session", key, title, description, curated: true, curated_status: "active", lineage: { split_from: [], merged_from: [] }, tickets: [], lanes, sessions, digest: null, prs: [], activity: minutes(5), brief: null })

export const state = {
  opencode: {
    editspace: "opencode", root: "/fixture/opencode", generated_at: now / 1000, attention: [],
    threads: [
      thread("th-composer", "Composer float and steer timing", "Pin the composer while the transcript scrolls; promote steers at tool boundaries.",
        [lane("composer-float", "implementing: pinned composer passes browser fixture; wiring steer promotion", "active", "ses_composer")],
        [session("ses_composer", "Composer float", "busy", minutes(1), directory)]),
      thread("th-handoff", "Handoff reliability", "Show pending handoff progress in the sidebar.",
        [lane("handoff-reliability", "parked: awaiting review (dotfiles#245)", "parked", "ses_handoff")],
        [session("ses_handoff", "Handoff progress", "idle", minutes(38), "/fixture/opencode/lanes/handoff-reliability")]),
      thread("th-front-desk", "Front desk briefs", "Automatic readable briefs for attention items.",
        [lane("front-desk", "verifying brief fixture on 3181", "active", "ses_desk_lane")],
        [session("ses_desk_lane", "Front desk briefs", "busy", minutes(3), "/fixture/opencode/lanes/front-desk")]),
    ],
    sessions: [session("ses_composer", "Composer float", "busy", minutes(1), directory), session("ses_handoff", "Handoff progress", "idle", minutes(38), "/fixture/opencode/lanes/handoff-reliability")],
    frontier: [], drift: [], digesting: [], briefing: [], wingman: [], curating: false, curated_at: now / 1000, wingman_error: "",
  },
  dotfiles: {
    editspace: "dotfiles", root: "/fixture/dotfiles", generated_at: now / 1000, attention: [],
    threads: [
      thread("th-attention", "Attention delivery retries", "Retry blocked answer delivery with a visible reason.",
        [lane("attention-delivery", "", "active", "ses_att")],
        [session("ses_att", "Delivery retry", "idle", minutes(125), "/fixture/dotfiles/lanes/attention-delivery")]),
    ],
    sessions: [], frontier: [], drift: [], digesting: [], briefing: [], wingman: [], curating: false, curated_at: now / 1000, wingman_error: "",
  },
  manadj: {
    editspace: "manadj", root: "/fixture/manadj", generated_at: now / 1000, attention: [],
    threads: [
      thread("th-onehand", "One-hand portrait layout", "Thumb-reach palettes for the phone deck.",
        [lane("android-onehand", "measuring reach zones on 6.1in emulator", "active", "ses_onehand")],
        [session("ses_onehand", "One-hand layout", "busy", minutes(9), "/fixture/manadj/lanes/android-onehand")]),
    ],
    sessions: [], frontier: [], drift: [], digesting: [], briefing: [], wingman: [], curating: false, curated_at: now / 1000, wingman_error: "",
  },
}

const record = (id, extra) => ({
  id, kind: "decision", status: "open", editspace: "opencode", lane: "composer-float", gate_key: `fixture:${id}:v1`,
  origin_session: "ses_composer", producer_session: "ses_composer", source_ref: { session_id: "ses_composer", directory },
  options: [], recommendation: null, delivery_state: "not-requested", delivery: null, decision: null, decided_at: null,
  resolution: null, resolved_at: null, snoozed_until: null, answer: null, revision: 3, created_at: minutes(22), updated_at: minutes(12), ...extra,
})

export const fixture = {
  records: [
    record("aaaaaaaa-0000-4000-8000-000000000001", {
      title: "Promote steers at tool boundaries or only at turn end?",
      context: "The composer-float lane can promote a steer either when a tool call completes (more responsive, risks interrupting multi-step edits) or only when the provider turn ends (safer, slower). The browser fixture passes either way.\n\nEvidence: 14 steers in the last day were sent mid-turn; 11 of them arrived after the turn finished anyway.",
      options: [{ id: "boundary", label: "Tool boundary (responsive)" }, { id: "turn-end", label: "Turn end only (safe)" }],
      recommendation: "boundary",
    }),
    record("aaaaaaaa-0000-4000-8000-000000000002", {
      kind: "blocker", editspace: "dotfiles", lane: "attention-delivery", updated_at: minutes(4), created_at: minutes(4),
      title: "Delivery retry needs the lane owner stamp; owner is unverified",
      context: "Answer delivery for 3 records is blocked with owner-unverified. Retrying requires either re-stamping the lane owner or routing to the origin session. Which do you want?",
      options: [{ id: "restamp", label: "Re-stamp lane owner" }, { id: "origin", label: "Route to origin session" }, { id: "wait", label: "Wait for handoff to commit" }],
      recommendation: "wait",
    }),
    record("aaaaaaaa-0000-4000-8000-000000000003", {
      editspace: "manadj", lane: "android-onehand", updated_at: minutes(55), created_at: minutes(60),
      title: "Name for the thumb-reach palette gesture?",
      context: "Open question: the palette appears where the thumb already rests. Naming affects the docs and the settings label.",
      options: [],
    }),
    record("aaaaaaaa-0000-4000-8000-000000000004", {
      status: "snoozed", snoozed_until: now + 3_600_000, title: "Keep the 18dvh sidebar cap on phones?", options: [{ id: "keep", label: "Keep" }, { id: "drop", label: "Drop" }],
    }),
    record("aaaaaaaa-0000-4000-8000-000000000005", {
      status: "answered", delivery_state: "handled", updated_at: minutes(240), title: "Ship the pinned composer behind a flag?",
      options: [{ id: "flag", label: "Behind a flag" }, { id: "direct", label: "Directly" }], recommendation: "flag",
      answer: { id: "ans-1", text: "Behind a flag, default on for me", choice_id: "flag", answered_at: minutes(240) },
      delivery: { state: "handled", reason: null, lane: "composer-float", session: "ses_composer", attempts: 0 },
    }),
    record("aaaaaaaa-0000-4000-8000-000000000006", {
      status: "resolved", delivery_state: "closed", updated_at: minutes(600), title: "Rename lane to composer-float", resolution: "Done by orchestrator",
    }),
  ],
  messages: {
    ses_composer: [
      msg("msg_1", "user", 40, [text("part_1", "Pin the composer at the bottom while the transcript scrolls, then make steers promote at tool boundaries.")]),
      msg("msg_2", "assistant", 39, [
        text("part_2", "I'll pin the composer first. Reading the transcript layout and the existing scroll handling."),
        tool("part_3", "read", "packages/es-app/src/transcript.tsx", "completed"),
        tool("part_4", "bash", "bun test transcript", "completed"),
      ]),
      // CHAT-PARTS fixture: incoming typed mail (task, question, unverified human), a tool-only run, an image
      { info: { id: "msg_m1", sessionID: "ses_composer", role: "user", agent: "build", time: { created: minutes(20) }, source: { type: "editspace-mail", id: "composer-float#7", sender: "es-app", recipient: "composer-float", kind: "task" } }, parts: [{ id: "pm1", sessionID: "ses_composer", messageID: "msg_m1", type: "text", text: "Please land the pinned composer behind a flag and report the bundle hash." }] },
      { info: { id: "msg_t1", sessionID: "ses_composer", role: "assistant", agent: "build", mode: "build", providerID: "fixture", modelID: "test", path: { cwd: directory, root: directory }, time: { created: minutes(19), completed: minutes(19) }, cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } }, parts: [tool("pt1", "read", "packages/es-app/src/composer.ts", "completed"), tool("pt2", "grep", "pinned", "completed")].map((p) => ({ ...p, sessionID: "ses_composer", messageID: "msg_t1" })) },
      { info: { id: "msg_t2", sessionID: "ses_composer", role: "assistant", agent: "build", mode: "build", providerID: "fixture", modelID: "test", path: { cwd: directory, root: directory }, time: { created: minutes(18), completed: minutes(18) }, cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } }, parts: [tool("pt3", "edit", "packages/es-app/src/composer.ts", "completed"), tool("pt4", "bash", "bun test composer", "completed"), tool("pt5", "bash", "bun run build", "completed")].map((p) => ({ ...p, sessionID: "ses_composer", messageID: "msg_t2" })) },
      { info: { id: "msg_m2", sessionID: "ses_composer", role: "user", agent: "build", time: { created: minutes(15) }, source: { type: "editspace-mail", id: "composer-float#8", sender: "front-desk", recipient: "composer-float", kind: "question" } }, parts: [{ id: "pm2", sessionID: "ses_composer", messageID: "msg_m2", type: "text", text: "Should the flag default on for Murtaza only?" }] },
      { info: { id: "msg_m3", sessionID: "ses_composer", role: "user", agent: "build", time: { created: minutes(14) }, source: { type: "editspace-mail", id: "composer-float#9", sender: "human", recipient: "composer-float", kind: "answer" } }, parts: [{ id: "pm3", sessionID: "ses_composer", messageID: "msg_m3", type: "text", text: "Yes, default on for me." }] },
      { info: { id: "msg_i1", sessionID: "ses_composer", role: "user", agent: "build", time: { created: minutes(10) } }, parts: [{ id: "pi1", sessionID: "ses_composer", messageID: "msg_i1", type: "text", text: "Here is the layout I mean." }, { id: "pi2", sessionID: "ses_composer", messageID: "msg_i1", type: "file", mime: "image/png", filename: "layout.png", url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAAAwCAIAAABMZkhfAAAAM0lEQVR4nO3OMQEAAAgDoC2w/0tDYQy4hAgBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBgcMHk1QBA3GeqQcAAAAASUVORK5CYII=" }] },
      msg("msg_3", "assistant", 3, [
        text("part_5", "Composer is pinned and the browser fixture passes. Now wiring steer promotion at tool boundaries; one open question is whether to promote at every tool completion or only at turn end. I published that as a decision."),
        tool("part_6", "edit", "packages/opencode/src/session/input.ts", "running"),
      ]),
    ],
    ses_handoff: [msg("msg_h1", "user", 40, [text("p", "Show pending handoff progress.")]), msg("msg_h2", "assistant", 38, [text("p2", "Parked: progress row renders; awaiting review on dotfiles#245.")])],
  },
  todos: { ses_composer: [{ content: "Pin composer while transcript scrolls", status: "completed", priority: "high" }, { content: "Promote steers at tool boundaries", status: "in_progress", priority: "high" }, { content: "Browser fixture for mid-turn steer", status: "pending", priority: "medium" }] },
  receipts: { ses_composer: [] },
  status: { ses_composer: { type: "busy" }, ses_handoff: { type: "idle" }, ses_desk_lane: { type: "busy" } },
  operator: false,
  writes: [],
  sessions: {},
}

function msg(id, role, minutesAgo, parts) {
  const info = role === "user"
    ? { id, sessionID: "ses_composer", role, agent: "build", model: { providerID: "fixture", modelID: "test" }, time: { created: minutes(minutesAgo) } }
    : { id, sessionID: "ses_composer", role, agent: "build", mode: "build", providerID: "fixture", modelID: "test", path: { cwd: directory, root: directory }, time: { created: minutes(minutesAgo), completed: minutes(minutesAgo) }, cost: 0.02, tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } } }
  return { info, parts: parts.map((part) => ({ ...part, sessionID: "ses_composer", messageID: id })) }
}
function text(id, value) { return { id, type: "text", text: value, time: { start: now, end: now } } }
function tool(id, name, title, status) {
  return { id, type: "tool", tool: name, callID: `call_${id}`, state: { status, input: { command: title }, title, output: status === "completed" ? `ok: ${title}` : undefined, time: { start: now, end: now } } }
}

export const createFixture = () => new Promise((resolve) => {
  const streams = new Set()
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, "http://127.0.0.1")
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const raw = Buffer.concat(chunks).toString()
    const body = raw ? JSON.parse(raw) : undefined
    const json = (value, status = 200) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(value)) }
    const path = url.pathname
    if (request.method !== "GET") fixture.writes.push({ method: request.method, path, query: Object.fromEntries(url.searchParams), body, headers: { origin: request.headers.origin, csrf: request.headers["x-attention-csrf"], cookie: request.headers.cookie } })

    // surfaces: registry + one static script-rendered board served at /api/surfaces/<id>/static/
    if (path === "/api/surfaces") return json({ surfaces: [{ id: "fixture-board", title: "Fixture board", summary: "Script-rendered status", kind: "path", owner: "Relay", lane: "orchestrator", editspace: "opencode", updated_at: minutes(30), revision: 2, health: { state: "ok", checked_at: now }, purpose: "board", upstream: "/api/surfaces/fixture-board/static/" }, { id: "fixture-deck", title: "Fixture deck", kind: "path", owner: "front-desk", editspace: "dotfiles", updated_at: minutes(90), revision: 1, health: { state: "error", detail: "index.html missing" }, purpose: "deliverable", seen: false, upstream: "/api/surfaces/fixture-deck/static/" }] })
    if (path.startsWith("/api/surfaces/fixture-board/static/")) {
      const rest = path.slice("/api/surfaces/fixture-board/static/".length)
      if (rest === "" || rest === "index.html") { response.writeHead(200, { "content-type": "text/html; charset=utf-8" }); return response.end(`<!doctype html><meta name=viewport content="width=device-width"><title>Fixture board</title><body style="background:#000;color:#eee;font:20px system-ui;padding:24px"><h1 id=static>Fixture board</h1><p id=dyn>script pending</p><a id=same href="page2.html">page 2</a> <a id=ext href="https://example.com/">external</a><script src="app.js"></script>`) }
      if (rest === "app.js") { response.writeHead(200, { "content-type": "application/javascript" }); return response.end(`document.getElementById("dyn").textContent = "SCRIPT RENDERED " + (3 * 7)`) }
      if (rest === "page2.html") { response.writeHead(200, { "content-type": "text/html; charset=utf-8" }); return response.end(`<!doctype html><body style="background:#000;color:#eee;font:24px system-ui;padding:24px"><h1>PAGE TWO</h1>`) }
      return json({ error: "no such surface file" }, 404)
    }

    // dashboard
    if (path === "/api/editspaces") return json({ editspaces: Object.keys(state).map((name) => ({ name, root: state[name].root })), default: "opencode" })
    if (path === "/api/state") return json(state[url.searchParams.get("es")] ?? state.opencode)
    if (path === "/api/attention/session" && request.method === "GET") return json({ operator: fixture.operator, answer: fixture.operator })
    if (path === "/api/attention/session" && request.method === "POST") {
      fixture.operator = true
      response.writeHead(200, { "content-type": "application/json", "set-cookie": "es_attention_operator=fixture-op; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800" })
      return response.end(JSON.stringify({ operator: true, answer: true }))
    }
    if (path === "/api/attention") {
      const view = url.searchParams.get("view") ?? "open"
      const match = { open: ["open"], snoozed: ["snoozed"], history: ["answered", "decided", "resolved", "withdrawn"], all: null, recorded: ["decided"] }[view]
      const records = fixture.records.filter((item) => !match || match.includes(item.status))
      return json({ records, projects: [{ editspace: "opencode", available: true, observed_at: now }, { editspace: "dotfiles", available: true, observed_at: now }, { editspace: "manadj", available: false, error: "unreachable" }], partial: false, limit: 200, offset: 0 })
    }
    const detail = /^\/api\/attention\/([\w-]+)$/.exec(path)
    if (detail) { const item = fixture.records.find((r) => r.id === detail[1]); return item ? json({ record: item, events: [] }) : json({ error: "not found" }, 404) }
    const command = /^\/api\/attention\/([\w-]+)\/commands$/.exec(path)
    if (command && request.method === "POST") {
      if (!request.headers.cookie?.includes("es_attention_operator")) return json({ error: "operator required" }, 401)
      const item = fixture.records.find((r) => r.id === command[1])
      if (!item) return json({ error: "not found" }, 404)
      if (body.expected_revision !== item.revision) return json({ error: "stale", record: item }, 409)
      item.revision += 1; item.updated_at = Date.now()
      if (body.action === "choose") item.decision = body.choice_id
      if (body.action === "answer") { item.status = "answered"; item.answer = { id: "ans-new", text: body.text, choice_id: body.choice_id ?? null, answered_at: Date.now() }; item.delivery_state = "queued" }
      if (body.action === "snooze") { item.status = "snoozed"; item.snoozed_until = body.snoozed_until }
      if (body.action === "wake") { item.status = "open"; item.snoozed_until = null }
      if (body.action === "resolve") { item.status = "resolved"; item.resolution = body.reason; item.delivery_state = "closed" }
      return json({ record: item })
    }
    if (path === "/api/current-work") return json({ turn: { started_at: minutes(6), elapsed_seconds: 371, status: "busy", user_messages: 1, assistant_messages: 2, tool_calls: 9, active_tools: ["edit"] }, summary: { status: "unavailable", text: null } })
    if (["/api/notification-events", "/api/events", "/event", "/global/event"].includes(path)) {
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" })
      response.write("data: connected\n\n"); streams.add(response); request.on("close", () => streams.delete(response)); return
    }
    if (path === "/api/notifications") return json({ notifications: [] })
    if (path === "/api/mail") return json({ editspace: url.searchParams.get("es"), lane: url.searchParams.get("lane"), messages: [
      { id: "composer-float#7", ts: "2026-10-27T10:00:00Z", from: "es-app", to: "composer-float", kind: "task", deliveries: [{ message_id: "composer-float#7", recipient: "composer-float", session: "ses_composer", mode: "actionable", state: "handled", host: "laptop", request_id: "msg_m1", presented_at: minutes(19), handled_at: minutes(18), wake_observations: [{ outcome: "scheduled", observedAt: minutes(20) }] }] },
      { id: "composer-float#8", ts: "2026-10-27T10:05:00Z", from: "front-desk", to: "composer-float", kind: "question", deliveries: [{ message_id: "composer-float#8", recipient: "composer-float", session: "ses_composer", mode: "actionable", state: "admitted", request_id: "msg_m2", presented_at: null, handled_at: null, wake_observations: [] }] },
      { id: "composer-float#9", ts: "2026-10-27T10:06:00Z", from: "human", to: "composer-float", kind: "answer", deliveries: [{ message_id: "composer-float#9", recipient: "composer-float", session: "ses_composer", mode: "actionable", state: "presented", request_id: "msg_m3", presented_at: minutes(13), handled_at: null, wake_observations: [{ outcome: "coalesced", observedAt: minutes(14) }] }] },
    ] })
    if (path === "/api/wake-events") return json({ events: [{ id: "pr-1", session: url.searchParams.get("session"), host: "laptop", cause: "passive-review", recipient: "composer-float", at: minutes(16), admission: "admitted", outcome: "unknown", covers: ["composer-float#7"] }] })

    // core
    if (path === "/session" && request.method === "GET") return json(Object.values(fixture.sessions))
    if (path === "/session" && request.method === "POST") {
      const info = fixture.sessions[body.id] ?? { id: body.id, slug: "desk", projectID: "fixture", directory: url.searchParams.get("directory"), title: body.title, agent: body.agent, version: "fixture", time: { created: Date.now(), updated: Date.now() } }
      fixture.sessions[body.id] = info; fixture.messages[body.id] ??= []; fixture.receipts[body.id] ??= []
      return json(info)
    }
    if (path === "/session/status") return json(fixture.status)
    if (path === "/agent") return json([{ name: "front-desk", mode: "primary" }, { name: "build", mode: "primary" }])
    if (path === "/permission" || path === "/question") return json([])
    const ses = /^\/session\/([\w-]+)(.*)$/.exec(path)
    if (ses) {
      const [, id, rest] = ses
      if (rest === "" && request.method === "GET") return json(fixture.sessions[id] ?? { id, title: id, directory, time: {} })
      if (rest === "/message") return json(fixture.messages[id] ?? [])
      if (rest === "/todo") return json(fixture.todos[id] ?? [])
      if (rest === "/input" && request.method === "GET") return json({ items: fixture.receipts[id] ?? [], next: null })
      if (rest === "/input" && request.method === "POST") {
        const receipt = { requestID: body.requestID, state: "pending", delivery: body.delivery, text: body.text, agent: body.agent ?? "build", revision: 1, sessionID: id, admittedSeq: 1, timeCreated: Date.now() }
        ;(fixture.receipts[id] ??= []).push(receipt)
        for (const stream of streams) stream.write("data: session.input\n\n")
        return json(receipt)
      }
      const cancel = /^\/input\/([\w-]+)$/.exec(rest)
      if (cancel && request.method === "DELETE") { fixture.receipts[id] = (fixture.receipts[id] ?? []).filter((r) => r.requestID !== cancel[1]); return json({ ok: true }) }
      if (rest === "/abort" && request.method === "POST") { fixture.status[id] = { type: "idle" }; return json(true) }
    }
    fixture.unexpected = [...(fixture.unexpected ?? []), `${request.method} ${path}`]
    json({ error: "fixture: unknown route" }, 404)
  })
  server.listen(0, "127.0.0.1", () => resolve({ url: `http://127.0.0.1:${server.address().port}`, close: () => { for (const stream of streams) stream.destroy(); server.closeAllConnections(); return new Promise((done) => server.close(done)) }, nudge: () => { for (const stream of streams) stream.write("data: nudge\n\n") }, streams: () => streams.size }))
})

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop())) {
  const server = await createFixture()
  console.info(`Desk fixture ${server.url}`)
}
