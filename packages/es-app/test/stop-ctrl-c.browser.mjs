// KEY-02: Ctrl+C Ctrl+C stops the busy session's turn, once, on that session's own host.
// Preserved: Esc Esc no longer stops; one Ctrl+C does nothing; Ctrl+C with selected text copies
// and does not count; held-key repeats and IME composition never count; idle does nothing;
// a modal dialog swallows it. Disposable fixtures; never touches a live session.
// Run from packages/es-app: node test/stop-ctrl-c.browser.mjs
import { createRequire } from "node:module"
import { request as httpRequest } from "node:http"
import { startPanelPreview } from "./composer-panel-preview.mjs"
import { createFixture, directory } from "./composer-fixture.mjs"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const remote = await createFixture()
const hostRoutes = {
  name: "test:hosts",
  configureServer: (server) => { server.middlewares.use((req, res, next) => {
    const match = /^\/hosts\/peer\/oc(\/.*)$/.exec(req.url ?? "")
    if (!match) return next()
    const upstream = httpRequest(`${remote.url}${match[1]}`, { method: req.method, headers: { ...req.headers, host: new URL(remote.url).host } }, (response) => {
      res.writeHead(response.statusCode ?? 502, response.headers)
      response.pipe(res)
    })
    upstream.on("error", () => { if (!res.headersSent) res.writeHead(502); res.end() })
    req.pipe(upstream)
  }) },
}
const preview = await startPanelPreview([hostRoutes])
const local = preview.fixture
const aborts = (fixture) => fixture.calls.filter((call) => call.method === "POST" && call.path.endsWith("/abort")).map((call) => call.path)

const browser = await chromium.launch({ headless: true,
  ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : { channel: "chrome" }) })
const errors = []
const open = async (query = "") => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  await context.addInitScript(() => Object.defineProperty(Navigator.prototype, "platform", { get: () => "Linux x86_64" }))
  await context.route("**/*", (route) => new URL(route.request().url()).origin === preview.origin ? route.continue() : route.abort())
  const page = await context.newPage()
  page.on("pageerror", (error) => errors.push(error.message))
  if (query) {
    await page.route("**/__es/host", (route) => route.fulfill({ json: { id: "home", label: "Home", remote: true, profile: "personal", hosts: [], work: [
      { id: "home", label: "Home", origin: preview.origin, profile: "personal", default: true },
      { id: "peer", label: "Peer", origin: preview.origin, profile: "personal" },
    ] } }))
    await page.route("**/__es/events", (route) => route.fulfill({ json: { protocol: null } }))
  }
  await page.goto(`${preview.origin}/session/ses_a?directory=${encodeURIComponent(directory)}${query}`, { waitUntil: "domcontentloaded", timeout: 180_000 })
  await page.locator(".prompt-box textarea").waitFor({ timeout: 60_000 })
  return { page, context }
}
const reset = (fixture, status) => {
  fixture.calls.length = 0
  fixture.setStatus(status)
}

try {
  // Busy local session, focus in the composer (Insert).
  reset(local, "busy")
  const { page, context } = await open()
  const box = page.locator(".prompt-box textarea")
  await box.focus()
  await page.waitForTimeout(300)

  await page.keyboard.press("Escape")
  await page.keyboard.press("Escape")
  await page.keyboard.press("Escape")
  await page.waitForTimeout(500)
  expect(aborts(local), "Esc Esc no longer stops").toEqual([])

  await page.keyboard.press("Control+c")
  await page.waitForTimeout(600)
  await page.keyboard.press("Control+c")
  await page.waitForTimeout(500)
  expect(aborts(local), "two Ctrl+C 600 ms apart do not stop").toEqual([])

  // Selected text: Ctrl+C is a copy and does not count toward the pair.
  await box.fill("copy me")
  await box.evaluate((el) => el.setSelectionRange(0, 4))
  await page.evaluate(() => { window.ctrlC = []; window.addEventListener("keydown", (event) => { if (event.key === "c") window.ctrlC.push(event.defaultPrevented) }) })
  await page.keyboard.press("Control+c")
  expect(await page.evaluate(() => window.ctrlC), "copy is not prevented").toEqual([false])
  await box.evaluate((el) => el.setSelectionRange(7, 7))
  await page.keyboard.press("Control+c")
  await page.waitForTimeout(500)
  expect(aborts(local), "Ctrl+C on a selection then Ctrl+C does not stop").toEqual([])
  await box.fill("")

  // Held key: the browser's repeat events never count.
  await page.keyboard.down("Control")
  await page.evaluate(() => {
    const target = document.querySelector(".prompt-box textarea")
    for (const repeat of [false, true, true])
      target.dispatchEvent(new KeyboardEvent("keydown", { key: "c", code: "KeyC", ctrlKey: true, repeat, bubbles: true, cancelable: true }))
  })
  await page.keyboard.up("Control")
  await page.waitForTimeout(500)
  expect(aborts(local), "key repeat does not count").toEqual([])

  // IME composition: Ctrl+C during composition never counts.
  await page.waitForTimeout(450)
  await page.evaluate(() => {
    const target = document.querySelector(".prompt-box textarea")
    for (let i = 0; i < 2; i++)
      target.dispatchEvent(new KeyboardEvent("keydown", { key: "c", code: "KeyC", ctrlKey: true, isComposing: true, bubbles: true, cancelable: true }))
  })
  await page.waitForTimeout(500)
  expect(aborts(local), "IME composition does not count").toEqual([])

  // The pair stops exactly once.
  await page.waitForTimeout(450)
  await page.keyboard.press("Control+c")
  await page.keyboard.press("Control+c")
  await expect.poll(() => aborts(local)).toEqual(["/session/ses_a/abort"])
  await page.keyboard.press("Control+c")
  await page.keyboard.press("Control+c")
  await page.waitForTimeout(500)
  expect(aborts(local), "idle after stop: no second abort").toEqual(["/session/ses_a/abort"])

  // Focus outside the composer (transcript) works the same; a modal swallows it.
  reset(local, "busy")
  await page.waitForTimeout(300)
  await page.locator(".transcript").click({ position: { x: 5, y: 5 } })
  await page.evaluate(() => { window.getSelection()?.removeAllRanges(); document.activeElement instanceof HTMLElement && document.activeElement.blur() })
  await page.keyboard.press("Shift+Slash")
  await expect(page.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeVisible()
  await expect(page.getByRole("dialog", { name: "Keyboard shortcuts" }).getByText("Ctrl+C", { exact: true })).toBeVisible()
  await page.keyboard.press("Control+c")
  await page.keyboard.press("Control+c")
  await page.waitForTimeout(500)
  expect(aborts(local), "modal open: no stop").toEqual([])
  await page.keyboard.press("Escape")
  await expect(page.getByRole("dialog", { name: "Keyboard shortcuts" }), "Esc still closes the dialog").toHaveCount(0)
  await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur())
  await page.waitForTimeout(450)
  await page.keyboard.press("Control+c")
  await page.keyboard.press("Control+c")
  await expect.poll(() => aborts(local)).toEqual(["/session/ses_a/abort"])
  await context.close()

  // Remote (writable) host: the stop goes to that host only.
  reset(local, "idle")
  reset(remote, "busy")
  const peer = await open("&host=peer")
  await expect(peer.page.locator(".session-page[data-host='peer']")).toBeVisible()
  await peer.page.locator(".prompt-box textarea").focus()
  await peer.page.waitForTimeout(300)
  await peer.page.keyboard.press("Control+c")
  await peer.page.keyboard.press("Control+c")
  await expect.poll(() => aborts(remote)).toEqual(["/session/ses_a/abort"])
  expect(aborts(local), "local host untouched").toEqual([])
  await peer.context.close()

  expect(errors).toEqual([])
  console.log("PASS Ctrl+C Ctrl+C stop: one abort on the session's own host (local and remote); Esc Esc, single Ctrl+C, Ctrl+C with selection, key repeat, IME composition and an open dialog never stop; Esc still closes the dialog; overlay lists Ctrl+C")
} finally {
  await browser.close()
  await preview.close()
  await remote.close?.()
}
