// BUG-18 rename another host's session from the top bar. Two fixture Cores, Local and a Mac Mini, both holding ses_a
// titled "Composer fixture" in the same directory. From the Mini's ses_a: Esc cancels (no write), Enter commits the
// title on the Mini only, the composer draft and model stay as they were, and a refused write (host unreachable)
// shows an error with the title unchanged and nothing sent to Local.
// Run from packages/es-app: node test/work-host-rename.browser.mjs
import { createRequire } from "node:module"
import { request as httpRequest } from "node:http"
import { startPanelPreview } from "./composer-panel-preview.mjs"
import { createFixture, directory } from "./composer-fixture.mjs"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const mini = await createFixture()
let miniWritesDown = false
const hostRoutes = {
  name: "test:hosts",
  configureServer: (server) => { server.middlewares.use((req, res, next) => {
    const match = /^\/hosts\/mini\/oc(\/.*)$/.exec(req.url ?? "")
    if (!match) return next()
    if (miniWritesDown && req.method === "PATCH") {
      res.writeHead(502, { "content-type": "application/json" })
      return res.end('{"error":"Host unavailable"}')
    }
    const upstream = httpRequest(`${mini.url}${match[1]}`, { method: req.method, headers: { ...req.headers, host: new URL(mini.url).host } }, (response) => {
      res.writeHead(response.statusCode ?? 502, response.headers)
      response.pipe(res)
    })
    upstream.on("error", () => { if (!res.headersSent) res.writeHead(502); res.end() })
    req.pipe(upstream)
  }) },
}
const preview = await startPanelPreview([hostRoutes])
const local = preview.fixture
const renames = (fixture) => fixture.calls.filter((call) => call.method === "PATCH" && call.path === "/session/ses_a")
const writes = (fixture) => fixture.calls.filter((call) => !["GET", "HEAD", "OPTIONS"].includes(call.method) && call.path !== "/api/attention/session")

const browser = await chromium.launch({ headless: true,
  ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : { channel: "chrome" }) })
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
await context.route("**/*", (route) => new URL(route.request().url()).origin === preview.origin ? route.continue() : route.abort())
const page = await context.newPage()
const errors = []
page.on("pageerror", (error) => errors.push(error.message))
await page.route("**/__es/host", (route) => route.fulfill({ json: { id: "local", label: "Local", remote: false, hosts: [], work: [
  { id: "local", label: "Local", origin: preview.origin },
  { id: "mini", label: "Mac Mini", origin: "https://mini.example.ts.net", default: true },
] } }))
await page.route("**/__es/events", (route) => route.fulfill({ json: { protocol: null } }))
const miniURL = `${preview.origin}/session/ses_a?directory=${encodeURIComponent(directory)}&host=mini`
const title = () => page.getByRole("button", { name: "Rename session" })
const field = () => page.getByRole("textbox", { name: "Session title" })
const editor = () => page.locator(".prompt-box").getByRole("textbox", { name: "Message", exact: true })
const model = () => page.locator(".prompt-box [title*='Change model']").first()
try {
  await page.goto(miniURL, { waitUntil: "domcontentloaded", timeout: 180_000 })
  await expect(page.locator(".session-page[data-host='mini']")).toBeVisible()
  await expect(title()).toHaveText("Composer fixture")
  await editor().fill("Mini draft kept")
  // The model shown comes from the Mini's transcript; wait for it before using it as the baseline.
  await expect(model()).toHaveAttribute("title", /fixture · test/)
  const modelBefore = await model().getAttribute("title")

  // Esc cancels: no write anywhere, focus back on the title.
  await title().click()
  await field().fill("Should not save")
  await field().press("Escape")
  await expect(title()).toHaveText("Composer fixture")
  await expect(title()).toBeFocused()
  expect(renames(mini)).toEqual([])

  // Enter commits on the Mini only.
  await title().click()
  await field().fill("Mini release notes")
  await field().press("Enter")
  await expect(title()).toHaveText("Mini release notes")
  await expect.poll(() => renames(mini).length).toBe(1)
  expect(renames(mini)[0].body).toEqual({ title: "Mini release notes" })
  expect(renames(mini)[0].directory).toBe(directory)
  await expect(editor()).toHaveValue("Mini draft kept")
  await expect(model()).toHaveAttribute("title", modelBefore)
  await expect(page.locator(".session-page[data-host='mini']")).toBeVisible()

  // Local's ses_a (same ID, same directory) keeps its own title.
  await page.goto(`${preview.origin}/session/ses_a?directory=${encodeURIComponent(directory)}`, { waitUntil: "domcontentloaded" })
  await expect(page.locator(".session-page:not([data-host])")).toBeVisible()
  await expect(title()).toHaveText("Composer fixture")
  await page.goto(miniURL, { waitUntil: "domcontentloaded" })
  await expect(title()).toHaveText("Mini release notes")

  // The Mini refuses (unreachable): explicit error, title unchanged, no Local fallback.
  miniWritesDown = true
  await title().click()
  await field().fill("Offline rename")
  await field().press("Enter")
  await expect(page.locator(".session-title-error")).toContainText("Could not rename session")
  await field().press("Escape")
  await expect(title()).toHaveText("Mini release notes")
  miniWritesDown = false

  expect(writes(local)).toEqual([])
  expect(errors).toEqual([])
  console.log(`PASS work host rename: Esc cancels, Enter renames Mini ses_a only (Local ses_a unchanged), draft and model kept, unreachable shows error with title unchanged; Mini renames=${renames(mini).length}, Local writes=0`)
} finally {
  await browser.close()
  await preview.close()
  await mini.close()
}
