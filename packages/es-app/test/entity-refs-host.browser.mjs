// An unqualified Surface link in a Mac Mini session viewed from the Laptop resolves on the Mini (DD #1273): the token
// shows the Mini's Surface (from the Mini's held Surface list), its card names the Mac Mini, and it opens
// /?item=mini~surface:<id>. 'Not found' only when the Mini's list was read without it.
// Run from packages/es-app: node test/entity-refs-host.browser.mjs
import { createRequire } from "node:module"
import { request as httpRequest } from "node:http"
import { startPanelPreview } from "./composer-panel-preview.mjs"
import { createFixture, directory } from "./composer-fixture.mjs"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const mini = await createFixture()
mini.status = "idle"
mini.permissions = []
mini.questions = []
mini.surfaces = [{ id: "opencode-feedback-fixture", title: "Feedback fixture", summary: "Feedback states", kind: "path", owner: "ux-feel", lane: "ux-feel", editspace: "fixture",
  updated_at: Date.now() - 60_000, revision: 2, health: { state: "ok" } }]
const now = Date.now()
mini.messages = [
  { info: { id: "msg_1u", sessionID: "ses_a", role: "user", agent: "build", model: { providerID: "fixture", modelID: "test" }, time: { created: now - 60_000 } },
    parts: [{ id: "prt_1u", messageID: "msg_1u", sessionID: "ses_a", type: "text", text: "where?" }] },
  { info: { id: "msg_2a", parentID: "msg_1u", sessionID: "ses_a", role: "assistant", agent: "build", mode: "build", providerID: "fixture", modelID: "test", finish: "stop",
    path: { cwd: directory, root: directory }, time: { created: now - 50_000, completed: now - 49_000 }, cost: 0, tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } } },
    parts: [{ id: "prt_2a", messageID: "msg_2a", sessionID: "ses_a", type: "text", text: "See [Feedback fixture](/?surface=opencode-feedback-fixture) and [gone](/?surface=gone-board)." }] },
]
const hostRoutes = { name: "test:hosts", configureServer: (server) => { server.middlewares.use((req, res, next) => {
  const match = /^\/hosts\/mini\/(?:oc|es)(\/.*)$/.exec(req.url ?? "")
  if (!match) return next()
  const upstream = httpRequest(`${mini.url}${match[1]}`, { method: req.method, headers: { ...req.headers, host: new URL(mini.url).host } }, (response) => {
    res.writeHead(response.statusCode ?? 502, response.headers)
    response.pipe(res)
  })
  upstream.on("error", () => { if (!res.headersSent) res.writeHead(502); res.end() })
  req.pipe(upstream)
}) } }
const preview = await startPanelPreview([hostRoutes])
preview.fixture.status = "idle"
const browser = await chromium.launch({ channel: "chrome", headless: true })
const errors = []
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  await context.route("**/__es/host", (route) => route.fulfill({ json: { id: "local", label: "Local", remote: false, hosts: [], work: [
    { id: "local", label: "Local", origin: preview.origin }, { id: "mini", label: "Mac Mini", origin: "https://mini.example.ts.net" }] } }))
  await context.route("**/__es/events", (route) => route.fulfill({ json: { protocol: null } }))
  const page = await context.newPage()
  page.setDefaultTimeout(30_000)
  page.on("pageerror", (error) => errors.push(error.message))
  await page.goto(`${preview.origin}/session/ses_a?directory=${encodeURIComponent(directory)}&host=mini`, { waitUntil: "domcontentloaded", timeout: 180_000 })
  const message = page.locator('[data-find-message="msg_2a"]')
  await expect(message).toContainText("See", { timeout: 120_000 })
  const token = message.locator(".eref.s").filter({ hasText: "Feedback fixture" })
  await expect(token).toHaveAttribute("aria-label", /^Surface: Feedback fixture, revision 2, on Mac Mini$/, { timeout: 60_000 })
  expect(await token.getAttribute("href")).toBe("/?item=mini~surface%3Aopencode-feedback-fixture")
  await token.hover()
  await expect(page.locator(".eref-card")).toContainText("Mac Mini")
  await expect(page.locator(".eref-card")).not.toContainText("not found")
  await expect(message.locator(".eref.s.missing")).toHaveAttribute("aria-label", "Surface: gone, not found on Mac Mini")
  expect(errors).toEqual([])
  console.log("PASS entity refs host: unqualified Surface link in a Mini session resolves on the Mini (title, rev, Mac Mini in label/card), opens mini~surface:<id>; absent from the Mini's list -> not found on Mac Mini")
} finally {
  await preview.close()
  await mini.close?.()
  await browser.close()
}
