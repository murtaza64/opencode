// M2 slice 2b (h-r N1): a Personal aggregator (excalibur) opens a pinned-SSH peer's session (ygnium, readOnly). The view
// reads ygnium's transcript through /hosts/ygnium/oc, says "read only", and offers no composer and no rename, so
// nothing is written to either Core.
// Run from packages/es-app: node test/read-only-peer.browser.mjs
import { createRequire } from "node:module"
import { request as httpRequest } from "node:http"
import { startPanelPreview } from "./composer-panel-preview.mjs"
import { createFixture, directory } from "./composer-fixture.mjs"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const ygnium = await createFixture()
const hostRoutes = {
  name: "test:hosts",
  configureServer: (server) => { server.middlewares.use((req, res, next) => {
    const match = /^\/hosts\/ygnium\/oc(\/.*)$/.exec(req.url ?? "")
    if (!match) return next()
    const upstream = httpRequest(`${ygnium.url}${match[1]}`, { method: req.method, headers: { ...req.headers, host: new URL(ygnium.url).host } }, (response) => {
      res.writeHead(response.statusCode ?? 502, response.headers)
      response.pipe(res)
    })
    upstream.on("error", () => { if (!res.headersSent) res.writeHead(502); res.end() })
    req.pipe(upstream)
  }) },
}
const preview = await startPanelPreview([hostRoutes])
const local = preview.fixture
ygnium.messages = [{
  info: { id: "msg_y1", sessionID: "ses_a", role: "user", agent: "build", model: { providerID: "fixture", modelID: "test" }, time: { created: 1 } },
  parts: [{ id: "prt_y1", messageID: "msg_y1", sessionID: "ses_a", type: "text", text: "Hello from the Ygnium transcript" }],
}]
ygnium.permissions = []
ygnium.questions = []
const writes = (fixture) => fixture.calls.filter((call) => !["GET", "HEAD", "OPTIONS"].includes(call.method))

const browser = await chromium.launch({ headless: true,
  ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : { channel: "chrome" }) })
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
await context.route("**/*", (route) => new URL(route.request().url()).origin === preview.origin ? route.continue() : route.abort())
const page = await context.newPage()
const errors = []
page.on("pageerror", (error) => errors.push(error.message))
await page.route("**/__es/host", (route) => route.fulfill({ json: { id: "excalibur", label: "Excalibur", remote: true, profile: "personal", hosts: [], work: [
  { id: "excalibur", label: "Excalibur", origin: preview.origin, profile: "personal", default: true },
  { id: "ygnium", label: "Ygnium", origin: preview.origin, profile: "personal", readOnly: true },
] } }))
await page.route("**/__es/events", (route) => route.fulfill({ json: { protocol: null } }))
try {
  await page.goto(`${preview.origin}/session/ses_a?directory=${encodeURIComponent(directory)}&host=ygnium`, { waitUntil: "domcontentloaded", timeout: 180_000 })
  await expect(page.locator(".session-page[data-host='ygnium']")).toBeVisible()
  await expect(page.locator(".transcript")).toContainText("Hello from the Ygnium transcript")
  await expect(page.locator("[data-read-only]")).toHaveText("read only")
  await expect(page.locator("[data-read-only-note]")).toContainText("this session is on Ygnium")
  await expect(page.locator(".prompt-box")).toHaveCount(0)
  await expect(page.getByRole("button", { name: "Rename session" })).toHaveCount(0)
  await expect(page.locator(".session-title-button")).toBeDisabled()
  await page.waitForTimeout(1000)
  expect(writes(ygnium)).toEqual([])
  expect(writes(local)).toEqual([])
  expect(errors).toEqual([])
  console.log("PASS read-only peer: transcript read from ygnium; read only label; no composer or rename; no writes to either Core")
} finally {
  await browser.close()
  await preview.close()
  await ygnium.close?.()
}
