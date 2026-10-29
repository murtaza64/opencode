// Replay for the disposable tool-runs preview: rebuilds the session transcript from t=0 over the same SSE events a
// live session sends (message.removed, message.updated, message.part.updated, session.status, dashboard "mail"),
// without a page reload, so Filament and the icon rows animate arrivals again. Tool calls arrive running, then
// settle; mail records appear with the input they carry. Fixture-only: no real mail, provider or daemon.
//
// Controls (preview origin only): the "Replay" buttons fixed at the bottom-left corner, or a page URL with
// `?replay=cases` (icon-chip and mail cases), `?replay=cache` (cache continuity cases, then the rest), `?replay=all`
// (the whole fixture) or `?replay=motion` (the 20 s motion scenario below), which starts once on load.

const CLIENT = `(() => {
  const start = (scope) => fetch("/__preview/replay?scope=" + scope, { method: "POST" })
  const bar = document.createElement("div")
  bar.id = "preview-replay"
  bar.setAttribute("role", "group")
  bar.setAttribute("aria-label", "Preview replay")
  // Sits in the sidebar's bottom corner, clear of the composer controls.
  bar.style.cssText = "position:fixed;inset-block-end:10px;inset-inline-start:10px;z-index:2147483647;display:flex;flex-wrap:wrap;gap:4px;" +
    "max-inline-size:220px;padding:6px;border-radius:8px;background:rgba(20,22,30,.92);border:1px solid rgba(255,255,255,.15);font:12px system-ui"
  for (const [scope, label] of [["motion", "Replay motion"], ["cases", "Replay mail + tool cases"], ["cache", "Replay cache cases"], ["all", "Replay all"]]) {
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
  if (["motion", "cases", "cache", "all"].includes(auto)) setTimeout(() => start(auto), 1500)
})()`

/** Vite plugin: the replay buttons and the `POST /__preview/replay?scope=motion|cases|cache|all` endpoint. */
export const replayPlugin = (state) => ({
  name: "preview-replay",
  transformIndexHtml: () => [{ tag: "script", injectTo: "body", children: CLIENT }],
  // Returns nothing: a function returned from configureServer would run as a post middleware hook.
  configureServer: (server) => {
    server.middlewares.use((request, response, next) => {
      if (!request.url?.startsWith("/__preview/replay") || request.method !== "POST") return next()
      const requested = new URL(request.url, "http://preview").searchParams.get("scope")
      const scope = ["all", "cache", "motion"].includes(requested) ? requested : "cases"
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
