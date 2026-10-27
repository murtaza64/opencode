// Decisions never depend on a brief: with automatic briefs on, a host that reports no usable desk model,
// and one item whose brief job failed, every Needs-you row opens its decision and the decision can be
// answered as written. Also: no brief job is started on such a host. No runtime writes.
import assert from "node:assert/strict"
import { createRequire } from "node:module"
import { startAttentionPreview } from "./attention-preview.mjs"
import { directory } from "./composer-fixture.mjs"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const now = Date.now()
const send = (res, body, status = 200) => { res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(body)) }
const session = (id, extra = {}) => ({ id, slug: id, projectID: "fixture", directory, title: id, version: "1", time: { created: now - 120_000, updated: now - 30_000 }, ...extra })
let modelReads = 0
const creates = []
const preview = await startAttentionPreview([{
  name: "no-brief-host",
  configureServer(server) {
    // This host's dashboard: the work model is configured but its provider is not signed in here.
    server.middlewares.use("/es/api/frontdesk/model", (req, res) => {
      modelReads++
      send(res, { model: { providerID: "duolingo-openai", modelID: "gpt-6.1-sol" }, available: false, reason: "duolingo-openai is not signed in on this host" })
    })
    server.middlewares.use("/es/api/frontdesk/conversation", (req, res) => send(res, { threads: [], documents: [] }))
    server.middlewares.use("/oc/session", (req, res, next) => {
      const [, id, tail] = new URL(req.url, "http://preview").pathname.split("/")
      if (req.method === "POST" && !id) { creates.push(req.url); return send(res, { error: "unexpected create" }, 500) }
      if (id?.startsWith("ses_fdbrief_") && !tail) return send(res, session(id, { time: { created: now, updated: now, archived: now } }))
      // decision_1 has a brief job from earlier that failed.
      if (id?.startsWith("ses_fdbrief_") && tail === "children") return send(res, [session("ses_fdjob_failed000000000000000", { parentID: id,
        metadata: { frontDesk: { kind: "brief", requestID: "r", source: "attention:fixture:decision_1", revision: "1", title: "t", refs: [{ id: "C1", label: "c" }], contract: 4 } } })])
      if (id === "ses_fdjob_failed000000000000000" && tail === "message") return send(res, [
        { info: { id: "msg_u", sessionID: id, role: "user", time: { created: now } }, parts: [{ id: "p1", sessionID: id, messageID: "msg_u", type: "text", text: "packet" }] },
        { info: { id: "msg_a", sessionID: id, role: "assistant", time: { created: now, completed: now }, error: { name: "ProviderAuthError" } }, parts: [] }])
      next()
    })
  },
}])
preview.fixture.editspaces = [{ name: "fixture", root: directory }]
const browser = await chromium.launch({ channel: "chrome", headless: true })
const errors = []
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  await context.addInitScript(() => { try { localStorage.setItem("es-app-all-projects", "true"); localStorage.setItem("es-app:front-desk:auto-prepare", "on") } catch {} })
  await context.route("**/*", route => new URL(route.request().url()).origin === preview.origin ? route.continue() : route.abort())
  const page = await context.newPage()
  page.on("pageerror", error => errors.push(error.message))
  page.setDefaultNavigationTimeout(300_000)
  page.setDefaultTimeout(60_000)
  await page.goto(preview.url)
  // Each open row opens its decision, whatever its brief state.
  for (const [key, id, title] of [["attention:fixture:decision_1", "decision_1", "Choose the bounded implementation scope"], ["attention:other:other_decision", "other_decision", "Other project decision"]]) {
    await page.locator(`.desk-item[data-desk-item="${key}"]`).click()
    const card = page.locator(`[data-attention-id="${id}"]`)
    await expect(card).toBeVisible()
    await expect(card).toContainText(title)
    await expect(card.getByRole("radio").first()).toBeEnabled()
  }
  // The failed brief is one quiet line; briefs say why they are unavailable here; the decision is answerable.
  await page.locator('.desk-item[data-desk-item="attention:fixture:decision_1"]').click()
  const card = page.locator('[data-attention-id="decision_1"]')
  await expect(card).toContainText("Brief failed.")
  await expect(card).toContainText("Keep the homepage focused on human choices.")
  await expect(card).toContainText("Briefs unavailable on this host: duolingo-openai is not signed in on this host.")
  await expect(card.getByRole("button", { name: "Prepare again" })).toBeDisabled()
  await card.getByRole("radio", { name: "Small scope", exact: true }).check()
  await card.getByRole("button", { name: "Send Small scope", exact: true }).click()
  await expect(page.locator(".home-notice")).toContainText("Answer saved")
  const answers = preview.ledger.calls.filter(call => call.path === "/decision_1/commands")
  assert.equal(answers.length, 1)
  assert.equal(answers[0].body.choice_id, "small")
  assert.equal(creates.length, 0, "no brief job is created on a host without a usable desk model")
  assert.ok(modelReads >= 1 && modelReads <= 3, `host model read once per page, saw ${modelReads}`)
  if (errors.length) throw Error(errors.join("\n"))
  console.log("PASS decisions without briefs: every Needs-you row opens its decision, failed brief is one quiet line, unavailable-on-host reason shown, answer sent once, no brief job created, host model read once")
} finally {
  await browser.close()
  await preview.close()
}
