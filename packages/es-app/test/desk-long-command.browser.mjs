// A decision whose brief quotes a long command (BUG03, dotfiles#240): the command scrolls inside its own
// block, so the desk never grows past the window, the queue, decision and chat columns do not overlap,
// and the question, answer box and actions stay in view. Copy, IDs and focus are unchanged.
// Disposable in-memory fixture; the command is display-only and never run.
// Run from packages/es-app: node test/desk-long-command.browser.mjs [--shots DIR]
import assert from "node:assert/strict"
import { createRequire } from "node:module"
import path from "node:path"
import { startAttentionPreview } from "./attention-preview.mjs"
import { directory } from "./composer-fixture.mjs"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const shots = process.argv.includes("--shots") ? process.argv[process.argv.indexOf("--shots") + 1] : undefined
const now = Date.now()
const COMMAND = "es agent spawn --editspace fixture --title 'fixture-inventory: interactive domain redesign' --repo example/fixture --agent design --model fixture/frontier-design-model --handoff /tmp/fixture/lanes/fixture-inventory/handoffs/20261027T-interactive-domain-redesign.md"
const record = { id: "launch", editspace: "fixture", revision: 1, status: "open", kind: "decision", producer_session: "ses_a", origin_session: "ses_a", source_ref: { session_id: "ses_a", directory },
  decision: null, delivery_state: "not-requested", created_at: now - 60_000, updated_at: now, snoozed_until: null, gate_key: "launch:v1",
  title: "Launch the requested frontier design session",
  context: `A frontier design agent should revisit the explicit promotion step. The brief is ready, but launching this model requires a command from your terminal. Run in a human terminal, not the agent shell:\n${COMMAND}\nAfter running the command, reply with its result.`,
  options: [{ id: "ran", label: "I ran it" }, { id: "skip", label: "Not now" }], recommendation: "ran" }
const result = {
  question: "Launch the interactive design session to explore automatically usable transitions?",
  context: "A frontier design agent will revisit the explicit promotion step once you start it from your terminal.",
  choices: [{ id: "ran", outcome: "The design session starts and the agent continues" }, { id: "skip", outcome: "The design session remains unstarted" }],
  commands: [{ label: "Start the interactive design session", where: "A human terminal, not the agent shell", option: "ran", command: COMMAND }],
  sources: [], facts: [], timeline: [], gaps: [],
}
const message = (id, sessionID, role, text) => ({
  info: { id, sessionID, role, time: { created: now - 60_000, ...(role === "assistant" ? { completed: now - 30_000 } : {}) }, ...(role === "assistant" ? { modelID: "fixture", providerID: "fixture", mode: "build", path: { cwd: directory, root: directory }, cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, parentID: "msg_user" } : { agent: "build", model: { providerID: "fixture", modelID: "fixture" } }) },
  parts: [{ id: `${id}_part`, sessionID, messageID: id, type: "text", text }],
})
const session = (id, extra = {}) => ({ id, slug: id, projectID: "fixture", directory, title: id, version: "1", time: { created: now - 120_000, updated: now - 30_000 }, ...extra })
const send = (res, body) => { res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(body)) }
const preview = await startAttentionPreview([{
  name: "long-command-brief-fixture",
  configureServer(server) {
    server.middlewares.use("/es/api/frontdesk/conversation", (_req, res) => send(res, { threads: [] }))
    server.middlewares.use("/oc/session", (req, res, next) => {
      const [, id, tail] = new URL(req.url, "http://preview").pathname.split("/")
      if (id?.startsWith("ses_fdbrief_") && !tail) return send(res, session(id, { time: { created: now, updated: now, archived: now } }))
      if (id?.startsWith("ses_fdbrief_") && tail === "children") return send(res, [session("ses_brief_launch", { parentID: id, metadata: { frontDesk: {
        kind: "brief", requestID: "ses_brief_launch", source: "attention:fixture:launch", revision: "1", title: record.title, refs: [], contract: 4 } } })])
      if (id === "ses_brief_launch" && tail === "message") return send(res, [message("msg_user", id, "user", "packet"), message("msg_reply", id, "assistant", JSON.stringify(result))])
      next()
    })
  },
}])
preview.fixture.editspaces = [{ name: "fixture", root: directory }]
preview.ledger.records.splice(0, preview.ledger.records.length, record)
const browser = await chromium.launch({ channel: "chrome", headless: true })

const open = async ({ width, height, rtl = false }) => {
  const context = await browser.newContext({ viewport: { width, height } })
  await context.addInitScript(value => { try {
    localStorage.setItem("es-app-all-projects", "true"); localStorage.setItem("es-app:front-desk:auto-prepare", "off"); localStorage.setItem("es-app:front-desk:chat-hidden", "0")
    localStorage.setItem("es-app:front-desk:1", JSON.stringify(value))
  } catch {} }, { session: "ses_a", directory })
  await context.route("**/*", route => new URL(route.request().url()).origin === preview.origin ? route.continue() : route.abort())
  const page = await context.newPage()
  page.setDefaultNavigationTimeout(300_000)
  page.setDefaultTimeout(90_000)
  const errors = []
  page.on("pageerror", error => errors.push(error.message))
  await page.goto(`${preview.origin}/?item=${encodeURIComponent("attention:fixture:launch")}`)
  if (rtl) await page.evaluate(() => { document.documentElement.dir = "rtl" })
  // Narrow windows open the Front desk chat as a sheet over the content; close it to reach the decision.
  if (width <= 900 && await page.locator(".desk-companion.sheet:not(.closed)").count()) await page.locator('[data-nav="front-desk"]').click()
  const card = page.locator('[data-attention-id="launch"]')
  await expect(card.locator(".desk-command pre")).toHaveText(COMMAND, { timeout: 120_000 })
  return { page, card, errors, close: () => context.close() }
}

// Geometry of the desk in CSS px: every horizontal scroller that should not scroll, and the parts that must stay in view.
const measure = page => page.evaluate(() => {
  const rect = selector => { const box = document.querySelector(selector)?.getBoundingClientRect(); return box && { left: Math.round(box.left), right: Math.round(box.right) } }
  const scrolled = [...document.querySelectorAll("*")].filter(el => el.scrollLeft !== 0 && !el.closest(".desk-command")).map(el => `${el.tagName.toLowerCase()}.${[...el.classList].join(".")} scrollLeft=${el.scrollLeft}`)
  const wide = [document.documentElement, document.body, document.querySelector(".content"), document.querySelector(".desk"), document.querySelector(".desk-evidence")]
    .filter(el => el && el.scrollWidth > el.clientWidth + 1).map(el => `${el.tagName.toLowerCase()}.${[...el.classList].join(".")} ${el.scrollWidth}>${el.clientWidth}`)
  return { width: innerWidth, desk: rect(".desk"), queue: rect("nav.sidebar"), evidence: rect(".desk-evidence"), chat: rect(".desk-companion:not(.closed) .desk-chat"), question: rect(".home-question"),
    pre: rect(".desk-command pre"), copy: rect(".desk-command-copy"), answer: rect(".home-answer textarea"), send: rect(".home-answer button.home-primary"), scrolled, wide }
})
const expectBounded = (name, box, { columns = true } = {}) => {
  assert.deepEqual(box.wide, [], `${name}: nothing in the desk scrolls sideways ${JSON.stringify(box)}`)
  assert.deepEqual(box.scrolled, [], `${name}: no ancestor is scrolled sideways`)
  assert(box.desk.left >= 0 && box.desk.right <= box.width, `${name}: desk inside the window ${JSON.stringify(box)}`)
  for (const part of ["question", "pre", "copy", "answer", "send"])
    assert(box[part].left >= box.evidence.left - 1 && box[part].right <= box.evidence.right + 1, `${name}: ${part} inside the decision column ${JSON.stringify(box)}`)
  assert(box.copy.left >= box.pre.right || box.copy.right <= box.pre.left, `${name}: Copy sits beside the command, not over it ${JSON.stringify(box)}`)
  // Below the docked width the chat floats and starts closed; only a docked chat is a column.
  if (!columns || !box.chat) return
  const [start, end] = box.queue.left < box.chat.left ? [box.queue, box.chat] : [box.chat, box.queue]
  assert(start.right <= box.evidence.left + 1 && box.evidence.right <= end.left + 1, `${name}: sidebar, decision and chat do not overlap ${JSON.stringify(box)}`)
  assert(box.chat.left >= 0 && box.chat.right <= box.width, `${name}: chat inside the window ${JSON.stringify(box)}`)
}

let failed = false
const check = async (name, viewport, extra = {}) => {
  const desk = await open({ ...viewport, ...extra })
  try {
    const before = await measure(desk.page)
    if (shots) await desk.page.screenshot({ path: path.join(shots, `${name}.png`) })
    console.log(`${name} ${JSON.stringify(before)}`)
    expectBounded(name, before, { columns: viewport.width > 900 })
    // The command itself scrolls, and focusing Copy (keyboard path) scrolls nothing else.
    const pre = await desk.card.locator(".desk-command pre").evaluate(el => ({ scroll: el.scrollWidth, client: el.clientWidth }))
    assert(pre.scroll > pre.client, `${name}: long command scrolls inside its block ${JSON.stringify(pre)}`)
    await desk.card.getByRole("button", { name: "Copy command" }).focus()
    await expect(desk.card.getByRole("button", { name: "Copy command" })).toBeFocused()
    expectBounded(`${name} after focusing Copy`, await measure(desk.page), { columns: viewport.width > 900 })
    // A sideways trackpad swipe over the question (the reported clipped state) moves nothing.
    const question = await desk.card.locator(".home-question").boundingBox()
    await desk.page.mouse.move(question.x + 10, question.y + 5)
    await desk.page.mouse.wheel(extra.rtl ? -600 : 600, 0)
    await desk.page.waitForTimeout(200)
    if (shots) await desk.page.screenshot({ path: path.join(shots, `${name}-swiped.png`) })
    expectBounded(`${name} after a sideways swipe`, await measure(desk.page), { columns: viewport.width > 900 })
    await desk.card.locator(".home-answer textarea").click()
    await expect(desk.card.locator(".home-answer textarea")).toBeFocused()
    assert.deepEqual(desk.errors, [])
    console.log(`PASS ${name}`)
  } catch (error) {
    failed = true
    console.error(`FAIL ${name}: ${error.message}`)
  } finally {
    await desk.close()
  }
}

try {
  // The reported window: 1808x1602 device px at 2x, just above the 900px narrow breakpoint.
  await check("reported-904x801", { width: 904, height: 801 })
  await check("desktop-1280x800", { width: 1280, height: 800 })
  await check("wide-1808x1602", { width: 1808, height: 1602 })
  // 125% zoom of a 1440 window.
  await check("zoom125-1152x720", { width: 1152, height: 720 })
  await check("rtl-1280x800", { width: 1280, height: 800 }, { rtl: true })
  await check("narrow-600x800", { width: 600, height: 800 })
} finally {
  await browser.close()
  await preview.close()
}
if (failed) process.exit(1)
console.log("desk-long-command: PASS")
