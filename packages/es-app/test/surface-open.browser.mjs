// #267 blank surface pane: a static deliverable (shaped like api-tests: one inline style, no script, no
// subresources) opened in the Front Desk through the real app route (vite surfaces plugin -> surface-proxy ->
// loopback upstream). Opens it by direct URL and by sidebar click, each with the capability mint delayed, and
// asserts the report's text actually commits inside the frame after the address arrives. Records the pane
// state (iframe count, error/loading text) when it does not. Read-only: no source change.
// Run from packages/es-app: node test/surface-open.browser.mjs [delayMs]
import { createRequire } from "node:module"
import { createServer } from "node:http"
import { startPanelPreview } from "./composer-panel-preview.mjs"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const delay = Number(process.argv[2] ?? 1500)
const report = `<!doctype html><meta charset="utf-8"><title>API tests</title>
<style>body{background:#10161d;color:#e4eaef;font:14px system-ui;margin:24px}</style>
<h1>API tests: where things stand</h1><p id="marker">Static report body marker</p>
<p><a href="https://static.internal.duolingo.com/x">source</a></p>`
const upstream = await new Promise((resolve) => {
  const server = createServer((req, res) => {
    res.writeHead(req.url === "/" ? 200 : 404, { "content-type": "text/html; charset=utf-8" })
    res.end(req.url === "/" ? report : "missing")
  })
  server.listen(0, "127.0.0.1", () => resolve({ server, origin: `http://127.0.0.1:${server.address().port}` }))
})
const preview = await startPanelPreview()
const now = Date.now()
preview.fixture.surfaces = [{
  id: "api-tests", title: "API tests: where things stand", summary: null, kind: "path", owner: "api-lead", lane: "api-lead",
  editspace: "api-testing", updated_at: now, created_at: now, revision: 2, purpose: "deliverable", seen: false,
  health: { state: "ok", checked_at: now, last_ok_at: now }, upstream: `${upstream.origin}/`,
}]
const browser = await chromium.launch({ channel: "chrome", headless: true })
const results = []
const pane = async (page) => ({
  url: new URL(page.url()).search,
  iframes: await page.locator(".desk-surface iframe").count(),
  state: (await page.locator(".desk-surface .desk-surface-state").allInnerTexts()).join(" | "),
  head: (await page.locator(".desk-surface h2").allInnerTexts()).join(""),
})
const run = async (name, open) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  const page = await context.newPage()
  const console = []
  page.on("console", (message) => console.push(message.text()))
  let minted = 0
  await page.route("**/__es/surface/api-tests", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, delay))
    minted = Date.now()
    await route.continue()
  })
  try {
    await open(page)
    await expect(page.locator(".desk-surface h2")).toContainText("API tests")
    await expect.poll(() => minted, { timeout: delay + 10_000 }).toBeGreaterThan(0)
    const frame = page.frameLocator(".desk-surface iframe")
    await expect(frame.locator("#marker")).toHaveText("Static report body marker", { timeout: 10_000 })
    results.push(`PASS ${name}: content committed ${Date.now() - minted} ms after the address`)
  } catch (error) {
    process.exitCode = 1
    results.push(`FAIL ${name}: ${String(error).split("\n")[0]} pane=${JSON.stringify(await pane(page))} console=${JSON.stringify(console.filter((line) => /frame|Content Security|surface/i.test(line)))}`)
  } finally {
    await context.close()
  }
}
try {
  await run("direct URL /?surface=api-tests", (page) => page.goto(`${preview.origin}/?surface=api-tests`, { waitUntil: "domcontentloaded", timeout: 180_000 }))
  await run("sidebar click", async (page) => {
    await page.goto(`${preview.origin}/`, { waitUntil: "domcontentloaded", timeout: 180_000 })
    await page.locator("[data-deliverable='api-tests']").click()
  })
  // The capability mint never answers: the pane must say it is opening (or failed), never stay silently blank.
  {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
    const page = await context.newPage()
    await page.route("**/__es/surface/api-tests", () => {})
    try {
      await page.goto(`${preview.origin}/?surface=api-tests`, { waitUntil: "domcontentloaded", timeout: 180_000 })
      await expect(page.locator(".desk-surface h2")).toContainText("API tests")
      await expect(page.locator(".desk-surface .desk-surface-state, .desk-surface [role=alert], .desk-surface iframe")).not.toHaveCount(0, { timeout: 15_000 })
      results.push("PASS never-answering address: the pane shows a state")
    } catch (error) {
      process.exitCode = 1
      results.push(`FAIL never-answering address: silent blank ${JSON.stringify(await pane(page))}`)
    } finally {
      await context.close()
    }
  }
  await run("session page -> desk route -> click", async (page) => {
    await page.goto(preview.url, { waitUntil: "domcontentloaded", timeout: 180_000 })
    await page.goto(`${preview.origin}/`, { waitUntil: "domcontentloaded" })
    await page.locator("[data-deliverable='api-tests']").click()
  })
} finally {
  console.log(`delay=${delay}ms\n${results.join("\n")}`)
  await browser.close()
  await preview.close()
  upstream.server.close()
}
