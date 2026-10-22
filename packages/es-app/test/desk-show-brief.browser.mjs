// Front desk: the Sources fold "Show" control brings its brief into view and focus, whatever was
// selected before. Disposable in-memory fixture only; no writes leave the page.
// Run from packages/es-app: node test/desk-show-brief.browser.mjs
import { createRequire } from "node:module"
import { startAttentionPreview } from "./attention-preview.mjs"
import { directory } from "./composer-fixture.mjs"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const now = Date.now()
const result = {
  ask: "Ship the homepage as decisions-only now, or keep today's layout for a later pass?",
  whyNow: "The homepage change is paused until you pick a scope.",
  whyYou: "", ifWait: "The homepage keeps today's mixed layout.", unknown: "", sources: [],
  choices: [{ id: "small", outcome: "The homepage lists only what needs you.", chips: [], risk: "" }, { id: "defer", outcome: "Nothing changes this week.", chips: [], risk: "" }],
  summary: "",
  visual: { title: "Homepage after each option", html: `<div style="height:260px">Small scope · Defer</div>` },
  flow: [], facts: [], timeline: [], gaps: [],
}
const briefs = [
  { id: "ses_brief_scope", source: "attention:fixture:decision_1", revision: "1", title: "Choose the bounded implementation scope", ready: true },
  // Every attention item already has a current brief, so automatic preparation starts nothing.
  { id: "ses_brief_other", source: "attention:other:other_decision", revision: "1", title: "Other project decision", ready: true },
  // Bound to an older revision of a live item: listed as not current, with no Show control.
  { id: "ses_brief_stale", source: "attention:other:other_decision", revision: "0", title: "Other project decision", ready: true },
]
const send = (res, body) => { res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(body)) }
const session = (id, extra = {}) => ({ id, slug: id, projectID: "fixture", directory, title: id, version: "1", time: { created: now - 120_000, updated: now - 30_000 }, ...extra })
const message = (id, sessionID, role, text) => ({
  info: { id, sessionID, role, time: { created: now - 60_000, ...(role === "assistant" ? { completed: now - 30_000 } : {}) }, ...(role === "assistant" ? { modelID: "fixture", providerID: "fixture", mode: "build", path: { cwd: directory, root: directory }, cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, parentID: "msg_brief_user" } : { agent: "build", model: { providerID: "fixture", modelID: "fixture" } }) },
  parts: [{ id: `${id}_part`, sessionID, messageID: id, type: "text", text }],
})
const preview = await startAttentionPreview([{
  name: "desk-show-brief-fixture",
  configureServer(server) {
    server.middlewares.use("/oc/session", (req, res, next) => {
      const [, id, tail] = new URL(req.url, "http://fixture").pathname.split("/")
      if (id?.startsWith("ses_fdbrief_") && !tail) return send(res, session(id, { title: "Front desk briefs", time: { created: now, updated: now, archived: now } }))
      if (id?.startsWith("ses_fdbrief_") && tail === "children") return send(res, briefs.map(brief => session(brief.id, { parentID: id, title: `Brief: ${brief.title}`, metadata: { frontDesk: { kind: "brief", requestID: brief.id, source: brief.source, revision: brief.revision, title: brief.title, refs: [] , contract: 2 } } })))
      const brief = briefs.find(item => item.id === id)
      if (brief && tail === "message") return send(res, [message("msg_brief_user", brief.id, "user", "Explain this request."), message("msg_brief_reply", brief.id, "assistant", JSON.stringify(result))])
      next()
    })
  },
}])
const fixture = preview.fixture
fixture.permissions = [{ id: "per_tests", sessionID: "ses_b", permission: "bash", patterns: ["bun test"], always: ["bun *"], metadata: { command: "bun test", description: "Synthetic per_tests" } }]

const browser = await chromium.launch({ channel: "chrome", headless: true })
// A short desktop window so the brief starts below the fold of its request.
const context = await browser.newContext({ viewport: { width: 1280, height: 600 } })
// Init scripts also run in the sandboxed brief visual, which has no storage.
await context.addInitScript(() => { if (window === window.top) localStorage.setItem("es-app:front-desk:auto-prepare", "on") })
await context.route("**/*", (route) => new URL(route.request().url()).origin === preview.origin ? route.continue() : route.abort())
const page = await context.newPage()
const errors = []
page.on("pageerror", (error) => errors.push(error.message))
const writes = []
page.on("request", (request) => { if (request.method() !== "GET" && !request.url().includes("/es/api/attention/session")) writes.push(`${request.method()} ${request.url()}`) })

const queue = page.getByRole("complementary", { name: "Desk queue" })
const decision = page.locator('.desk-item[data-desk-item="attention:fixture:decision_1"]')
const permission = page.locator(`.desk-item[data-desk-item="permission:${directory}:per_tests"]`)
const show = queue.getByRole("button", { name: "Show brief: Choose the bounded implementation scope" })
const evidence = page.getByRole("region", { name: "Selected item" })
const brief = evidence.getByRole("region", { name: "Brief" }).first()
const openSources = async () => { if (!await show.isVisible()) await queue.locator(".desk-sources-all > summary").click() }
// The brief's heading line sits inside the visible part of the evidence pane and holds focus.
const expectRevealed = async () => {
  await expect(brief).toBeFocused()
  await expect(brief).toContainText("Ship the homepage as decisions-only now")
  await expect.poll(() => brief.evaluate((el) => {
    const pane = el.closest(".desk-evidence, .desk-grid").getBoundingClientRect()
    const box = el.getBoundingClientRect()
    return box.top >= Math.max(pane.top, 0) - 1 && box.top < Math.min(pane.bottom, innerHeight) - 40
  })).toBe(true)
}
try {
  await page.goto(preview.url, { waitUntil: "domcontentloaded" })
  // A cold Vite dependency optimization can delay the first render.
  await expect(decision).toBeVisible({ timeout: 90_000 })
  await openSources()
  await expect(show).toBeVisible()

  // Stale: a brief for an older revision lists why and offers nothing to show.
  const stale = queue.locator(".desk-job", { hasText: "rev 0" })
  await expect(stale).toContainText("Item changed (revision 0 → 1).")
  await expect(stale.getByRole("button")).toHaveCount(0)

  // No selection: Show selects the item and reveals its brief.
  await show.click()
  await expect(decision).toHaveAttribute("aria-pressed", "true")
  await expectRevealed()

  // Same item, scrolled away: Show brings the brief back instead of doing nothing.
  // A shorter window guarantees the decision card is taller than its pane.
  await page.setViewportSize({ width: 1280, height: 420 })
  await page.locator(".desk-evidence").evaluate((el) => { el.scrollTop = el.scrollHeight })
  await queue.evaluate((el) => el.focus?.())
  await expect(brief).not.toBeFocused()
  await expect.poll(() => brief.evaluate((el) => el.getBoundingClientRect().top < el.closest(".desk-evidence").getBoundingClientRect().top)).toBe(true)
  await show.click()
  await expectRevealed()

  // Another item selected: Show switches the selection to the brief's item.
  await permission.click()
  await expect(permission).toHaveAttribute("aria-pressed", "true")
  await expect(evidence).not.toContainText("Ship the homepage as decisions-only now")
  await openSources()
  await show.click()
  await expect(decision).toHaveAttribute("aria-pressed", "true")
  await expect(permission).toHaveAttribute("aria-pressed", "false")
  await expectRevealed()

  // Narrow window: the evidence stacks below the queue and Show scrolls the page to the brief.
  await page.setViewportSize({ width: 800, height: 600 })
  await page.locator(".desk-grid").evaluate((el) => { el.scrollTop = 0 })
  await openSources()
  await show.scrollIntoViewIfNeeded()
  await show.click()
  await expectRevealed()

  expect(writes).toEqual([])
  expect(errors).toEqual([])
  console.log("desk-show-brief: PASS")
} finally {
  await browser.close()
  await preview.close()
}
