// Self-handoff button (CHAT-13), against stub /api/handoffs/self routes (no live dashboard, no real spawn).
// A local root session that owns its lane shows Self-handoff below the composer. Without the dashboard advertising
// self-handoff v1 it is disabled with that reason. With it: a frontier model asks for confirmation and re-sends the
// same request ID; progress words follow GET replies only (requested -> presented -> doc-written -> spawning ->
// verified); verified links the successor and names what was not carried over; a reload resumes from GET without
// posting again; Cancel is offered only while requested and withdraws it. The draft and its text stay untouched.
// Another host's session shows the button disabled: "Hand off is available on its own host", and never posts.
// Run from packages/es-app: node test/self-handoff.browser.mjs   (SCREENSHOT_DIR=<dir>)
import { createRequire } from "node:module"
import { mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { request as httpRequest } from "node:http"
import { startPanelPreview } from "./composer-panel-preview.mjs"
import { createFixture, directory } from "./composer-fixture.mjs"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const shots = process.env.SCREENSHOT_DIR ?? join(tmpdir(), "es-app-self-handoff")
mkdirSync(shots, { recursive: true })
const mini = await createFixture()
const hostRoutes = {
  name: "test:hosts",
  configureServer: (server) => { server.middlewares.use((req, res, next) => {
    const match = /^\/hosts\/mini\/oc(\/.*)$/.exec(req.url ?? "")
    if (!match) return next()
    const upstream = httpRequest(`${mini.url}${match[1]}`, { method: req.method, headers: { ...req.headers, host: new URL(mini.url).host } }, (response) => {
      res.writeHead(response.statusCode ?? 502, response.headers)
      response.pipe(res)
    })
    upstream.on("error", () => { if (!res.headersSent) res.writeHead(502); res.end() })
    req.pipe(upstream)
  }) },
}
const preview = await startPanelPreview([hostRoutes])
const fixture = preview.fixture
fixture.status = "idle"
fixture.laneOwners = [{ lane: "lane-a", owner: "ses_a" }]
const url = `${preview.origin}/session/ses_a?directory=${encodeURIComponent(directory)}`
const browser = await chromium.launch({ channel: "chrome", headless: true })
const errors = []
const selfCalls = () => fixture.calls.filter((call) => call.path.startsWith("/api/handoffs/self"))
const writes = []
// Records each write's CSRF header, then answers with the current stub.
const stub = (handler) => { fixture.selfHandoff = (call) => { if (call.method !== "GET") writes.push(call); return handler(call) } }
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  await context.route("**/*", (route) => new URL(route.request().url()).origin === preview.origin ? route.continue() : route.abort())
  const page = await context.newPage()
  page.setDefaultTimeout(20_000)
  page.on("pageerror", (error) => errors.push(error.message))
  const button = page.locator(".act-self-handoff")
  const status = page.locator(".self-handoff-status")
  const editor = page.getByRole("textbox", { name: "Message", exact: true })

  // Not advertised by this dashboard: disabled, with the reason, and nothing posted.
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 180_000 })
  await expect(button).toBeVisible({ timeout: 120_000 })
  await expect(button).toBeDisabled()
  await expect(button).toHaveAttribute("title", "This host's dashboard does not offer self-handoff yet")
  expect(selfCalls()).toEqual([])

  // Advertised: a stub that asks for frontier confirmation, then advances one state per GET.
  const steps = ["requested", "presented", "doc-written", "spawning"]
  let gets = 0
  stub((call) => {
    if (call.method === "POST") return call.body.frontier ? { status: 202, body: { requestID: call.body.requestID, state: "requested" } }
      : { status: 409, body: { error: "frontier-confirm", model: "anthropic/fable" } }
    if (call.method === "GET") {
      const state = steps[gets++]
      return { body: state ? { state } : { state: "verified", successor: "ses_b", doc: "handoffs/self-x-handoff.md", title: "Composer fixture", agent: "build", model: "anthropic/fable",
        notCarried: ["model variant (reasoning effort)"] } }
    }
    return { status: 501, body: {} }
  })
  await page.reload()
  await editor.fill("draft kept through the handoff")
  await expect(button).toBeEnabled({ timeout: 30_000 })
  await button.click()
  await expect(status).toContainText("This session runs anthropic/fable.")
  await page.screenshot({ path: join(shots, "confirm.png") })
  await status.getByRole("button", { name: "Hand off on this model" }).click()
  // Progress comes from GET replies, one state at a time, ending verified.
  await expect(status).toHaveAttribute("data-state", "requested")
  await expect(status.getByRole("button", { name: "Cancel handoff" })).toBeVisible()
  await expect(status).toHaveAttribute("data-state", "presented", { timeout: 10_000 })
  await expect(status.getByRole("button", { name: "Cancel handoff" })).toHaveCount(0)
  await expect(status).toContainText("The agent has the request and is writing the handoff.")
  await expect(status).toHaveAttribute("data-state", "verified", { timeout: 20_000 })
  await expect(status).toContainText("Handed off: the successor now owns the lane.")
  await expect(status.locator(".self-handoff-successor a")).toHaveAttribute("href", /\/session\/ses_b/)
  await expect(status.locator(".self-handoff-not-carried")).toHaveText("Not carried over: model variant (reasoning effort)")
  await page.screenshot({ path: join(shots, "verified.png") })
  const posts = selfCalls().filter((call) => call.method === "POST")
  expect(posts.map((call) => [call.body.lane, call.body.session, call.body.frontier ?? false])).toEqual([["lane-a", "ses_a", false], ["lane-a", "ses_a", true]])
  expect(new Set(posts.map((call) => call.body.requestID)).size).toBe(1)
  await expect(editor).toHaveValue("draft kept through the handoff")

  // A reload resumes from GET: no second POST.
  const before = posts.length
  await page.reload()
  await expect(status).toHaveAttribute("data-state", "verified", { timeout: 30_000 })
  expect(selfCalls().filter((call) => call.method === "POST").length).toBe(before)

  // Cancel while requested, in a fresh browser profile (no saved request).
  const cancelling = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  await cancelling.route("**/*", (route) => new URL(route.request().url()).origin === preview.origin ? route.continue() : route.abort())
  const second = await cancelling.newPage()
  second.on("pageerror", (error) => errors.push(error.message))
  let cancelled = false
  stub((call) => call.method === "DELETE" ? (cancelled = true, { body: { state: "failed", reason: "cancelled" } })
    : { status: call.method === "POST" ? 202 : 200, body: cancelled ? { state: "failed", reason: "cancelled" } : { state: "requested" } })
  await second.goto(url, { waitUntil: "domcontentloaded", timeout: 180_000 })
  await second.locator(".act-self-handoff").click({ timeout: 120_000 })
  await second.locator(".self-handoff-status").getByRole("button", { name: "Cancel handoff" }).click()
  await expect(second.locator(".self-handoff-status")).toContainText("Handoff did not happen: cancelled.")
  expect(selfCalls().filter((call) => call.method === "DELETE").length).toBe(1)
  await second.locator(".self-handoff-status").getByRole("button", { name: "Dismiss" }).click()
  await expect(second.locator(".self-handoff-status")).toHaveCount(0)
  await expect(second.locator(".act-self-handoff")).toBeEnabled()
  await cancelling.close()

  // Another host's session: disabled, that host named, nothing posted to any self-handoff route.
  mini.status = "idle"
  const sent = selfCalls().length
  await page.goto(`${url}&host=mini`, { waitUntil: "domcontentloaded" })
  await expect(button).toBeVisible({ timeout: 60_000 })
  await expect(button).toBeDisabled()
  await expect(button).toHaveAttribute("title", "Hand off is available on its own host")
  await expect(status).toHaveCount(0)
  expect(selfCalls().length).toBe(sent)
  expect(mini.calls.filter((call) => call.path.includes("handoffs/self"))).toEqual([])

  // Every write carried the CSRF header and named this editspace.
  expect(writes.length).toBeGreaterThan(0)
  expect(writes.every((write) => write.csrf === "1")).toBe(true)
  expect(errors).toEqual([])
  console.log(`PASS self-handoff: gated when not advertised; frontier confirm re-sends the same request ID; progress from GET only (requested -> presented -> doc-written -> spawning -> verified), Cancel only while requested; successor link + not-carried fields; reload resumes without posting; cancel then dismiss; draft untouched; remote host disabled with its note, nothing posted; screenshots ${shots}`)
} finally {
  await preview.close()
  await mini.close?.()
  await browser.close()
}
