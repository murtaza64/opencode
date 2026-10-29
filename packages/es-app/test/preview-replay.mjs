// Replay for the disposable tool-runs preview: rebuilds the session transcript from t=0 over the same SSE events a
// live session sends (message.removed, message.updated, message.part.updated, session.status, dashboard "mail"),
// without a page reload, so Filament and the icon rows animate arrivals again. Tool calls arrive running, then
// settle; mail records appear with the input they carry. Fixture-only: no real mail, provider or daemon.
//
// Controls (preview origin only): the "Replay" buttons fixed at the bottom-left corner, or a page URL with
// `?replay=cases` (icon-chip and mail cases), `?replay=cache` (cache continuity cases, then the rest), `?replay=all`
// (the whole fixture), `?replay=motion` (the 20 s motion scenario) or `?replay=phases` (the ten assistant phases),
// which starts once on load.

const CLIENT = `(() => {
  const start = (scope) => fetch("/__preview/replay?scope=" + scope, { method: "POST" })
  const bar = document.createElement("div")
  bar.id = "preview-replay"
  bar.setAttribute("role", "group")
  bar.setAttribute("aria-label", "Preview replay")
  // Sits in the sidebar's bottom corner, clear of the composer controls.
  bar.style.cssText = "position:fixed;inset-block-end:10px;inset-inline-start:10px;z-index:2147483647;display:flex;flex-wrap:wrap;gap:4px;" +
    "max-inline-size:220px;padding:6px;border-radius:8px;background:rgba(20,22,30,.92);border:1px solid rgba(255,255,255,.15);font:12px system-ui"
  for (const [scope, label] of [["phases", "Replay phases"], ["motion", "Replay motion"], ["cases", "Replay mail + tool cases"], ["cache", "Replay cache cases"], ["all", "Replay all"]]) {
    const button = document.createElement("button")
    button.type = "button"
    button.textContent = label
    button.dataset.scope = scope
    button.style.cssText = "cursor:pointer;padding:4px 8px;border-radius:6px;border:1px solid rgba(255,255,255,.25);background:transparent;color:#e0e4f0"
    button.onclick = () => start(scope)
    bar.append(button)
  }
  const mount = () => document.body.append(bar)
  document.readyState === "loading" ? document.addEventListener("DOMContentLoaded", mount) : mount()
  const auto = new URLSearchParams(location.search).get("replay")
  if (["phases", "motion", "cases", "cache", "all"].includes(auto)) setTimeout(() => start(auto), 1500)
})()`

/** Vite plugin: the replay buttons and the `POST /__preview/replay?scope=phases|motion|cases|cache|all` endpoint. */
export const replayPlugin = (state) => ({
  name: "preview-replay",
  transformIndexHtml: () => [{ tag: "script", injectTo: "body", children: CLIENT }],
  // Returns nothing: a function returned from configureServer would run as a post middleware hook.
  configureServer: (server) => {
    server.middlewares.use((request, response, next) => {
      if (request.url === "/__preview/phase") {
        response.setHeader("content-type", "application/json")
        return response.end(JSON.stringify({ phase: state.phase?.() ?? null }))
      }
      if (!request.url?.startsWith("/__preview/replay") || request.method !== "POST") return next()
      const requested = new URL(request.url, "http://preview").searchParams.get("scope")
      const scope = ["all", "cache", "motion", "phases"].includes(requested) ? requested : "cases"
      void state.replay?.(scope)
      response.statusCode = 204
      response.end()
    })
  },
})

/**
 * Binds replay to a started fixture. `firstCase` and `firstCache` start the "cases" and "cache" scopes; `mailRecords` are the
 * session's mail records, revealed with the input that carries them or, when standalone, by their sent time;
 * `lateUsage` lists steps that finish with zero cache usage before their reported usage arrives.
 */
export const createReplay = (fixture, options) => {
  const full = structuredClone(fixture.messages)
  const records = options.mailRecords
  const step = options.stepMs ?? 420
  let run = 0
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  return async (scope) => {
    const token = ++run
    const live = () => token === run
    const first = scope === "all" ? undefined : scope === "cache" ? options.firstCache : options.firstCase
    const start = first ? Math.max(0, full.findIndex((message) => message.info.id === first)) : 0
    const status = fixture.status
    for (const message of fixture.messages.slice(start)) fixture.emit("message.removed", { sessionID: "ses_a", messageID: message.info.id })
    fixture.messages = structuredClone(full.slice(0, start))
    const kept = new Set(fixture.messages.map((message) => message.info.time.created))
    const firstTime = full[start]?.info.time.created ?? 0
    fixture.revealedMail = new Set(records.filter((record) => record.created_ms < firstTime || kept.has(record.created_ms)).map((record) => record.id))
    fixture.emitDashboard("mail")
    fixture.setStatus("busy")
    const reveal = (until) => {
      const due = records.filter((record) => !record.promotedBy && !fixture.revealedMail.has(record.id) && record.created_ms <= until)
      if (!due.length) return false
      due.forEach((record) => fixture.revealedMail.add(record.id))
      fixture.emitDashboard("mail")
      return true
    }
    for (const original of full.slice(start)) {
      if (!live()) return
      if (reveal(original.info.time.created - 1)) await wait(step * 2)
      const carried = records.find((record) => record.promotedBy === original.info.id)
      if (carried) {
        fixture.revealedMail.add(carried.id)
        fixture.emitDashboard("mail")
      }
      const done = original.info.role === "assistant" && original.info.time.completed
      // A step starts without usage; its reported tokens arrive when it finishes (late usage).
      const info = original.info.role === "assistant"
        ? { ...original.info, time: { created: original.info.time.created }, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } } : original.info
      const message = { info, parts: [] }
      fixture.messages.push(message)
      fixture.emit("message.updated", { info })
      await wait(step)
      for (const part of original.parts) {
        if (!live()) return
        const state = part.type === "tool" ? part.state : undefined
        if (state && state.status !== "running") {
          const running = { ...part, state: { status: "running", input: state.input, title: state.title ?? part.tool, metadata: {}, time: { start: state.time.start } } }
          message.parts.push(running)
          fixture.emit("message.part.updated", { part: running })
          await wait(step * 2.5)
          if (!live()) return
          message.parts[message.parts.length - 1] = part
        } else message.parts.push(part)
        fixture.emit("message.part.updated", { part })
        await wait(step)
      }
      if (done && options.lateUsage?.includes(original.info.id)) {
        // Finished with usage still unreported; the provider's numbers follow later on the same message.
        const provisional = { ...original.info, tokens: { ...original.info.tokens, cache: { read: 0, write: 0 } } }
        message.info = provisional
        fixture.emit("message.updated", { info: provisional })
        await wait(step * 5)
        if (!live()) return
      }
      if (done) {
        message.info = original.info
        fixture.emit("message.updated", { info: original.info })
      }
    }
    if (!live()) return
    reveal(Number.POSITIVE_INFINITY)
    fixture.setStatus(status)
  }
}

/**
 * The 20 s motion scenario (living-chat #263 recordings): appended after the fixture as a new turn, from t=0, with
 * no scroll scripting. 1. one text part streams the same ~120 words three times at the same character rate, in
 * 4-, 40- and 400-character deltas (chunk-size invariance); 2. a bash call runs 4 s, then completes; 3. an edit
 * completes with filediff (file name and +x/-x); 4. an incoming mail with a scheduled wake; 5. a new user message;
 * 6. the session goes idle for 3 s. Fixture data only.
 */
export const createMotion = (fixture, options) => {
  const words = "Reading the composer, the transcript and the activity rows to see where each streamed word lands " +
    "and how the thread follows it; every sentence here is plain filler text of an ordinary assistant reply, " +
    "long enough to show a steady stream without any tool calls, mail or markup in between the words, so the " +
    "rate, not the delivery chunking, is what the gutter should respond to over these three passes."
  const rate = 250 // characters per second, the same for every chunk size
  let run = 0
  return async () => {
    const token = ++run
    const live = () => token === run
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
    const base = Date.now()
    const ids = { user: `msg_m${base}u`, reply: `msg_m${base}a`, mail: `msg_m${base}m`, next: `msg_m${base}n` }
    const at = (offset) => base + offset
    const emitMessage = (info, parts) => {
      fixture.messages.push({ info, parts })
      fixture.emit("message.updated", { info })
      parts.forEach((part) => fixture.emit("message.part.updated", { part }))
    }
    const reply = { id: ids.reply, parentID: ids.user, sessionID: "ses_a", role: "assistant", agent: "build", mode: "build", providerID: "fixture",
      modelID: "test", path: { cwd: options.directory, root: options.directory }, time: { created: at(1) }, cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } }
    const part = (extra) => ({ messageID: ids.reply, sessionID: "ses_a", ...extra })
    fixture.setStatus("busy")
    emitMessage({ id: ids.user, sessionID: "ses_a", role: "user", agent: "build", model: { providerID: "fixture", modelID: "test" }, time: { created: at(0) } },
      [{ id: `${ids.user}_text`, messageID: ids.user, sessionID: "ses_a", type: "text", text: "Motion scenario: stream, a tool, an edit, mail, then a new prompt." }])
    emitMessage(reply, [])
    const message = fixture.messages.at(-1)
    // 1. Three passes of the same words, each at `rate` characters per second.
    let text = ""
    const stream = { id: `${ids.reply}_text`, type: "text" }
    message.parts.push(part({ ...stream, text }))
    for (const chunk of [4, 40, 400]) {
      const pass = (text ? "\n\n" : "") + words
      for (let offset = 0; offset < pass.length; offset += chunk) {
        if (!live()) return
        text += pass.slice(offset, offset + chunk)
        message.parts[0] = part({ ...stream, text })
        fixture.emit("message.part.updated", { part: message.parts[0] })
        await wait(Math.round((chunk / rate) * 1000))
      }
    }
    // 2. A bash call runs 4 s, then completes.
    const shell = (state) => part({ id: `${ids.reply}_bash`, type: "tool", tool: "bash", callID: `${ids.reply}_bash`, state })
    const start = Date.now()
    message.parts.push(shell({ status: "running", input: { command: "bun test src/composer", description: "Unit tests" }, title: "bash", metadata: {}, time: { start } }))
    fixture.emit("message.part.updated", { part: message.parts.at(-1) })
    await wait(4000)
    if (!live()) return
    message.parts[message.parts.length - 1] = shell({ status: "completed", input: { command: "bun test src/composer", description: "Unit tests" },
      output: "42 pass\n0 fail", title: "bash", metadata: { exit: 0 }, time: { start, end: Date.now() } })
    fixture.emit("message.part.updated", { part: message.parts.at(-1) })
    await wait(700)
    // 3. An edit completes with its file and line counts.
    const edit = part({ id: `${ids.reply}_edit`, type: "tool", tool: "edit", callID: `${ids.reply}_edit`, state: { status: "completed",
      input: { filePath: "/workspace/src/components/direct-composer.tsx", oldString: "a", newString: "b" }, output: "Edit applied successfully.", title: "edit",
      metadata: { diff: "-a\n+b", filediff: { file: "/workspace/src/components/direct-composer.tsx", additions: 6, deletions: 2 } }, time: { start: Date.now() - 300, end: Date.now() } } })
    message.parts.push(edit)
    fixture.emit("message.part.updated", { part: edit })
    message.info = { ...reply, time: { created: reply.time.created, completed: Date.now() }, finish: "stop" }
    fixture.emit("message.updated", { info: message.info })
    await wait(1200)
    if (!live()) return
    // 4. Incoming mail that woke the agent (scheduled), with its record.
    const sent = Date.now()
    options.addMail?.({ id: `mail_motion_${base}`, created_ms: sent, ts: new Date(sent).toISOString(), from: "ux-feel", to: "transcript-scan",
      direction: "received", kind: "notice", text: "Motion check: the gutter looks steady.",
      deliveries: [{ message_id: `mail_motion_${base}`, recipient: "transcript-scan", session: "ses_a", mode: "wake", state: "handled", request_id: null,
        error: null, presented_at: null, handled_at: null, wake: "caused", wake_observations: [{ outcome: "scheduled", observedAt: sent }] }] })
    emitMessage({ id: ids.mail, sessionID: "ses_a", role: "user", agent: "build", model: { providerID: "fixture", modelID: "test" }, time: { created: sent },
      source: { type: "editspace-mail", id: `mail_motion_${base}`, sender: "ux-feel", recipient: "transcript-scan", kind: "notice" } },
      [{ id: `${ids.mail}_text`, messageID: ids.mail, sessionID: "ses_a", type: "text", text: "Motion check: the gutter looks steady." }])
    fixture.emitDashboard("mail")
    await wait(1500)
    if (!live()) return
    // 5. A new user message, then 6. idle for 3 s.
    emitMessage({ id: ids.next, sessionID: "ses_a", role: "user", agent: "build", model: { providerID: "fixture", modelID: "test" }, time: { created: Date.now() } },
      [{ id: `${ids.next}_text`, messageID: ids.next, sessionID: "ses_a", type: "text", text: "Thanks, that is all for now." }])
    await wait(800)
    fixture.setStatus("idle")
  }
}

/**
 * The ten assistant phases (living-chat CHAT10, composer PHASE-MAP), in order, each held ~3 s and announced through
 * the page's own signals only: 1. working: busy with an empty assistant message; 2. thinking: a reasoning part with
 * time.start and no end, growing, then ended; 3. writing: an open text part growing, then ended; 4. tool: bash
 * running, then done; 5. delegated: a task tool running, then done; 6. blocked: a permission request, then answered;
 * 7. retry: session.status retry with `next`; 8. offline: the event stream drops and reconnects are refused;
 * 9. complete: the message finishes and the session goes idle; 10. idle. `GET /__preview/phase` names the current
 * step for capture tooling. Reasoning text is filler; fixture data only.
 */
export const createPhases = (fixture, options) => {
  let run = 0
  return async () => {
    const token = ++run
    const live = () => token === run
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
    const hold = options.holdMs ?? 3000
    const base = Date.now()
    const ids = { user: `msg_p${base}u`, reply: `msg_p${base}a` }
    const step = (name) => { fixture.phase = name }
    const user = { id: ids.user, sessionID: "ses_a", role: "user", agent: "build", model: { providerID: "fixture", modelID: "test" }, time: { created: base } }
    const reply = { id: ids.reply, parentID: ids.user, sessionID: "ses_a", role: "assistant", agent: "build", mode: "build", providerID: "fixture",
      modelID: "test", path: { cwd: options.directory, root: options.directory }, time: { created: base + 1 }, cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } }
    const part = (extra) => ({ messageID: ids.reply, sessionID: "ses_a", ...extra })
    const message = { info: reply, parts: [] }
    const put = (value) => {
      const index = message.parts.findIndex((item) => item.id === value.id)
      if (index < 0) message.parts.push(value)
      else message.parts[index] = value
      fixture.emit("message.part.updated", { part: value })
    }
    fixture.refuseEvents = false
    fixture.permissions = []
    // 1. working
    step("working")
    fixture.setStatus("busy")
    fixture.messages.push({ info: user, parts: [{ id: `${ids.user}_text`, messageID: ids.user, sessionID: "ses_a", type: "text", text: "Phase replay: walk every head state." }] })
    fixture.emit("message.updated", { info: user })
    fixture.emit("message.part.updated", { part: fixture.messages.at(-1).parts[0] })
    fixture.messages.push(message)
    fixture.emit("message.updated", { info: reply })
    await wait(hold)
    if (!live()) return
    // 2. thinking: an open reasoning part that grows, then ends.
    step("thinking")
    const thoughtStart = Date.now()
    let thought = ""
    for (let index = 0; index < 20; index++) {
      thought += "considering the next step "
      put(part({ id: `${ids.reply}_r`, type: "reasoning", text: thought, time: { start: thoughtStart } }))
      await wait(200)
      if (!live()) return
    }
    put(part({ id: `${ids.reply}_r`, type: "reasoning", text: thought, time: { start: thoughtStart, end: Date.now() } }))
    // 3. writing: an open text part that grows, then ends.
    step("writing")
    const textStart = Date.now()
    let text = ""
    for (let index = 0; index < 15; index++) {
      text += "Writing the answer one clause at a time. "
      put(part({ id: `${ids.reply}_t`, type: "text", text, time: { start: textStart } }))
      await wait(200)
      if (!live()) return
    }
    put(part({ id: `${ids.reply}_t`, type: "text", text, time: { start: textStart, end: Date.now() } }))
    // 4. tool
    step("tool")
    const tool = (id, name, input, state) => put(part({ id: `${ids.reply}_${id}`, type: "tool", tool: name, callID: `${ids.reply}_${id}`, state: { input, title: name, metadata: {}, ...state } }))
    const shellStart = Date.now()
    tool("bash", "bash", { command: "bun test", description: "Unit tests" }, { status: "running", time: { start: shellStart } })
    await wait(hold)
    if (!live()) return
    tool("bash", "bash", { command: "bun test", description: "Unit tests" }, { status: "completed", output: "42 pass", metadata: { exit: 0 }, time: { start: shellStart, end: Date.now() } })
    // 5. delegated
    step("delegated")
    const taskStart = Date.now()
    tool("task", "task", { description: "Review the diff", subagent_type: "review", prompt: "Review." }, { status: "running", time: { start: taskStart } })
    await wait(hold)
    if (!live()) return
    tool("task", "task", { description: "Review the diff", subagent_type: "review", prompt: "Review." }, { status: "completed", output: "No findings.", time: { start: taskStart, end: Date.now() } })
    // 6. blocked: a permission request, then answered.
    step("blocked")
    const permission = { id: `per_${base}`, sessionID: "ses_a", permission: "bash", patterns: ["rm -rf build"], metadata: {} }
    // Permission events reach the page's activity store through the global stream, wrapped with their directory.
    const global = (type, properties) => {
      for (const [response, entry] of fixture.eventStreams)
        if (entry.path === "/global/event") response.write(`data: ${JSON.stringify({ directory: options.directory, payload: { type, properties } })}\n\n`)
    }
    fixture.permissions = [permission]
    global("permission.asked", permission)
    await wait(hold)
    if (!live()) return
    fixture.permissions = []
    global("permission.replied", { sessionID: "ses_a", requestID: permission.id, reply: "once" })
    // 7. retry
    step("retry")
    fixture.status = "retry"
    fixture.emit("session.status", { sessionID: "ses_a", status: { type: "retry", attempt: 1, message: "Fixture provider overloaded", next: Date.now() + hold } })
    await wait(hold)
    if (!live()) return
    fixture.setStatus("busy")
    // 8. offline: the stream drops and stays down.
    step("offline")
    fixture.refuseEvents = true
    fixture.disconnect()
    await wait(hold)
    fixture.refuseEvents = false
    if (!live()) return
    await wait(1500)
    // 9. complete
    step("complete")
    message.info = { ...reply, time: { created: reply.time.created, completed: Date.now() }, finish: "stop" }
    fixture.emit("message.updated", { info: message.info })
    fixture.setStatus("idle")
    await wait(hold)
    if (!live()) return
    // 10. idle
    step("idle")
    await wait(hold)
    if (live()) step("done")
  }
}
