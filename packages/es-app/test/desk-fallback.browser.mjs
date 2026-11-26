// Front Desk placement (Root 2962): the Work desk's home is the Mac Mini. While it answers, the desk chat is the
// Mini's desk (ses_a on the Mini; the same id as Local's desk, on a different host). When the Mini stays unreachable past the hold, input goes to this computer's own
// existing desk (ses_a on Local) with a notice and a host chip; no new conversation is created. When the Mini holds
// up again, the desk fails back to the Mini's desk. Two disposable fixture Cores; nothing live.
// Run from packages/es-app: node test/desk-fallback.browser.mjs
import { createRequire } from "node:module"
import { request as httpRequest } from "node:http"
import { startAttentionPreview } from "./attention-preview.mjs"
import { createFixture, directory } from "./composer-fixture.mjs"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const mini = await createFixture()
let miniDown = false
// Open proxied requests to the Mini; going down drops them, as a lost host does (held streams would otherwise
// exhaust the browser's per-origin connections, which a real outage does not).
const open = new Set()
const setMiniDown = (down) => { miniDown = down; if (down) for (const res of open) res.destroy() }
const hostRoutes = {
  name: "test:hosts",
  configureServer: (server) => { server.middlewares.use((req, res, next) => {
    const match = /^\/hosts\/mini(\/.*)$/.exec(req.url ?? "")
    if (!match) return next()
    if (miniDown) {
      res.writeHead(502, { "content-type": "application/json" })
      return res.end('{"error":"Host unavailable"}')
    }
    if (match[1].startsWith("/es/api/frontdesk/pointer")) {
      res.writeHead(200, { "content-type": "application/json" })
      return res.end(JSON.stringify({ home: true, revision: 1, session: "ses_a", directory }))
    }
    const oc = /^\/oc(\/.*)$/.exec(match[1])
    if (!oc) return next()
    open.add(res)
    res.on("close", () => open.delete(res))
    const upstream = httpRequest(`${mini.url}${oc[1]}`, { method: req.method, headers: { ...req.headers, host: new URL(mini.url).host } }, (response) => {
      res.writeHead(response.statusCode ?? 502, response.headers)
      response.pipe(res)
    })
    upstream.on("error", () => { if (!res.headersSent) res.writeHead(502); res.end() })
    req.pipe(upstream)
  }) },
}
const preview = await startAttentionPreview([hostRoutes])
const local = preview.fixture
mini.messages = [{
  info: { id: "msg_m1", sessionID: "ses_a", role: "user", agent: "build", model: { providerID: "fixture", modelID: "test" }, time: { created: 1 } },
  parts: [{ id: "prt_m1", messageID: "msg_m1", sessionID: "ses_a", type: "text", text: "Hello from the Mini desk" }],
}]
mini.permissions = []
mini.questions = []
local.permissions = []

const browser = await chromium.launch({ headless: true, channel: "chrome" })
const context = await browser.newContext({ viewport: { width: 1500, height: 900 } })
// This computer's own earlier desk, kept as its pointer while the home is the Mini.
await context.addInitScript((value) => { if (window === window.top) localStorage.setItem("es-app:front-desk:1", JSON.stringify(value)) }, { session: "ses_a", directory })
await context.route("**/*", (route) => new URL(route.request().url()).origin === preview.origin ? route.continue() : route.abort())
const page = await context.newPage()
const errors = []
page.on("pageerror", (error) => errors.push(error.message))
await page.route("**/__es/host", (route) => route.fulfill({ json: { id: "local", label: "Laptop", remote: false, hosts: [], work: [
  { id: "local", label: "Laptop", origin: preview.origin },
  { id: "mini", label: "Mac Mini", origin: "https://mini.example.ts.net", default: true },
] } }))
await page.route("**/__es/events", (route) => route.fulfill({ json: { protocol: null } }))
const chat = () => page.locator(".desk-companion")
const chip = () => chat().locator(".desk-host")
const created = (fixture) => fixture.calls.filter((call) => call.method === "POST" && call.path === "/session")
const step = (name) => console.log(`${new Date().toISOString()} ${name}`)
try {
  await page.goto(preview.url, { waitUntil: "domcontentloaded", timeout: 180_000 })
  await expect(chat().locator(".desk-chat textarea")).toBeVisible({ timeout: 120_000 })
  await expect(chip()).toContainText("Mac Mini")
  await expect(chat().locator(".transcript")).toContainText("Hello from the Mini desk")
  step("HOME: chat is the Mini's desk, chip Mac Mini")

  setMiniDown(true)
  await expect(chat().getByText("which is unreachable")).toBeVisible({ timeout: 30_000 })
  await expect(chat().getByText("using this computer's Porter")).toHaveCount(0)
  step("DOWN: read-only offline line during the hold; no fallback yet")

  await expect(chat().getByText("Mac Mini unreachable; using this computer's Porter.")).toBeVisible({ timeout: 100_000 })
  await expect(chip()).toContainText("Laptop")
  await expect(chip()).toHaveAttribute("data-placed", "fallback")
  await expect(chat().locator(".transcript")).not.toContainText("Hello from the Mini desk")
  const editor = chat().locator(".prompt-box").getByRole("textbox", { name: "Message", exact: true })
  await editor.fill("Sent while the Mini is down")
  await chat().locator(".prompt-box").getByRole("button", { name: "Steer", exact: true }).click()
  await expect.poll(() => local.calls.some((call) => call.method === "POST" && ["/session/ses_a/input", "/session/ses_a/prompt_async"].includes(call.path) && JSON.stringify(call.body ?? "").includes("Sent while the Mini is down")), { timeout: 30_000 }).toBe(true)
  expect(created(local), "fallback never creates a conversation").toHaveLength(0)
  step("FALLBACK: this computer's own desk ses_a, chip Laptop (fallback), send reached Local ses_a")

  setMiniDown(false)
  await expect(chat().getByText("Mac Mini is back")).toBeVisible({ timeout: 30_000 })
  await expect(chip()).toHaveAttribute("data-placed", "fallback")
  step("UP: stays on fallback during the hold")
  await expect(chip()).toHaveAttribute("data-placed", "home", { timeout: 100_000 })
  await expect(chip()).toContainText("Mac Mini")
  await expect(chat().locator(".transcript")).toContainText("Hello from the Mini desk")
  expect(created(local)).toHaveLength(0)
  expect(created(mini)).toHaveLength(0)
  expect(errors, errors.join("\n")).toEqual([])
  step("FAILBACK: chat is the Mini's desk again; no conversation created on either host")
  console.log("PASS desk-fallback")
} catch (error) {
  console.error("FAIL desk-fallback", error)
  console.error("capability reads", JSON.stringify(local.calls.filter((call) => call.path === "/experimental/capabilities").map((call) => call.directory)))
  console.error("composer notes", await chat().locator(".prompt-box").innerText().catch(() => "?"))
  console.error("local calls tail", JSON.stringify(local.calls.slice(-15).map((call) => `${call.method} ${call.path}`)))
  await page.screenshot({ path: `${process.env.TMPDIR ?? "/tmp"}/desk-fallback-fail.png` }).catch(() => undefined)
  process.exitCode = 1
} finally {
  await browser.close()
  await preview.close?.()
  process.exit(process.exitCode ?? 0)
}
