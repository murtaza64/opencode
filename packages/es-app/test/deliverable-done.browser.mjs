// Desk2814: a requested deliverable Surface is the Try item. Against the real dashboard Surface store
// (src/fixtures/surfaces-host.py over dotfiles bin/es_dashboard_surfaces.py), through the app's own /es/api routes:
// the Needs you row is one deterministic Try line; showing its revision in the foreground reader marks it seen and
// clears it (Desk2951), holding across a reload; Mark unread brings it back; a newer revision resurfaces and only
// showing it clears it; an exact-retry publish never brings it back; a hidden window or a failed load never marks.
// The page's /es/api surface routes go to that store the way this host's listener forwards them (its origin, the
// operator cookie). Run from packages/es-app: node test/deliverable-done.browser.mjs
import { spawn } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { createRequire } from "node:module"
import { homedir, tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { startPanelPreview } from "./composer-panel-preview.mjs"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const home = await mkdtemp(path.join(tmpdir(), "es-surfaces-host-"))
const host = spawn("uv", ["run", "--script", fileURLToPath(new URL("../src/fixtures/surfaces-host.py", import.meta.url))], {
  env: { ...process.env, HOME: home, DOTFILES_BIN: process.env.DOTFILES_BIN ?? path.join(homedir(), "dotfiles/bin"), UV_CACHE_DIR: process.env.UV_CACHE_DIR ?? path.join(homedir(), ".cache/uv") },
  stdio: ["ignore", "pipe", "inherit"],
})
const store = `http://127.0.0.1:${(await new Promise((resolve) => host.stdout.once("data", resolve))).toString().trim()}`
for (let wait = 50; !(await fetch(`${store}/api/surfaces`).then((response) => response.status < 500, () => false)); wait *= 2) await new Promise((resolve) => setTimeout(resolve, wait))
const publish = async (summary, id = "report") =>
  (await (await fetch(`${store}/__fixture/publish`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id, title: "API tests", summary }) })).json()).revision
const jar = new Map()
const send = async (pathname, init = {}) => {
  const headers = { ...init.headers, origin: store, ...(jar.size ? { cookie: [...jar].map(([name, value]) => `${name}=${value}`).join("; ") } : {}) }
  const response = await fetch(`${store}${pathname}`, { ...init, headers })
  for (const cookie of response.headers.getSetCookie()) { const [name, value] = cookie.split(";")[0].split("="); jar.set(name, value) }
  return response
}
await send("/api/attention/session", { method: "POST", headers: { "content-type": "application/json", "X-Attention-CSRF": "1" }, body: "{}" })
const stored = async () => (await (await send("/api/surfaces")).json()).surfaces.find((item) => item.id === "report")

const preview = await startPanelPreview()
const browser = await chromium.launch({ channel: "chrome", headless: true })
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
page.setDefaultTimeout(30_000)
const writes = []
const results = []
const storeErrors = new Set()
// A store that does not answer fails that request in the page (as a listener would), never this script.
const forward = async (route, pathname, init) => {
  const response = await send(pathname, init).catch((error) => (storeErrors.add(String(error.cause?.code ?? error)), undefined))
  // A request still in flight when its page navigates or closes is dropped quietly.
  if (!response) return route.abort("connectionreset").catch(() => undefined)
  return route.fulfill({ status: response.status, contentType: "application/json", body: await response.text() }).catch(() => undefined)
}
await page.route("**/es/api/surfaces", (route) => forward(route, "/api/surfaces"))
await page.route("**/es/api/frontdesk/deliverables/seen", (route) => {
  const request = route.request()
  writes.push(JSON.parse(request.postData()))
  return forward(route, "/api/frontdesk/deliverables/seen", { method: "POST", headers: { "content-type": "application/json", "X-Attention-CSRF": request.headers()["x-attention-csrf"] ?? "" }, body: request.postData() })
})
// The frame content is not what this checks; an empty frame keeps the reader settled.
// The first mint waits until the test has checked that Done is not offered before the frame is on screen.
let releaseMint
const firstMint = new Promise((resolve) => { releaseMint = resolve })
await page.route("**/__es/surface/report", async (route) => { await firstMint; return route.fulfill({ json: { src: "about:blank" } }) })
// The race surface's mint waits until the test has republished it, so the frame loads after a newer revision exists.
let releaseRace
const raceMint = new Promise((resolve) => { releaseRace = resolve })
await page.route("**/__es/surface/race", async (route) => { await raceMint; return route.fulfill({ json: { src: "about:blank" } }) })
await page.route("**/__es/surface/hidden", (route) => route.fulfill({ json: { src: "about:blank" } }))
await page.route("**/__es/surface/broken", (route) => route.fulfill({ status: 502, json: { error: "upstream unavailable" } }))
const band = page.locator("nav.sidebar section.needs-you-band")
const row = band.locator("[data-nav-item='surface:report']")
const reader = page.locator(".surface-head")
const step = (name) => results.push(`PASS ${name}`)
try {
  await publish("first")
  await page.goto(`${preview.origin}/`, { waitUntil: "domcontentloaded", timeout: 180_000 })
  await expect(row).toHaveAttribute("aria-label", "Try · API tests · Fixture lead · rev 1", { timeout: 60_000 })
  await expect(row.locator(".nav-kind")).toHaveText("Try")
  step("Needs you shows one deterministic Try line")

  await row.click()
  await expect(page).toHaveURL(`${preview.origin}/?item=${encodeURIComponent("surface:report")}`)
  await expect(reader.locator("h2")).toHaveText("API tests")
  await reader.locator(".surface-owner-chip").click()
  await expect(reader.locator("[data-requested-in]")).toContainText("Open the conversation it was asked in")
  await reader.locator(".surface-owner-chip").click()
  await page.waitForTimeout(1_000)
  await expect(reader.locator(".surface-head-done")).toHaveCount(0)
  if (writes.length || (await stored()).seen) throw new Error(`selecting before the frame wrote seen: ${JSON.stringify(writes)}`)
  releaseMint()
  await expect(reader.locator(".surface-done")).toHaveText("✓ Seen")
  await expect(reader.locator(".surface-head-rev")).toHaveText("rev 1")
  await expect(reader.locator(".surface-owner-chip")).toBeVisible()
  await expect(reader.getByRole("button", { name: "More" })).toBeVisible()
  await expect(row).toHaveCount(0)
  expect(writes).toEqual([{ id: "report", revision: 1, seen: true }])
  step("selecting writes nothing until the frame shows the revision; showing it in the foreground marks it seen and clears Needs you")

  await page.reload({ waitUntil: "domcontentloaded" })
  await expect(reader.locator(".surface-done")).toHaveText("✓ Seen", { timeout: 60_000 })
  await expect(row).toHaveCount(0)
  expect(writes).toHaveLength(1)
  step("seen holds across a reload with no second write (server seen)")

  // Seen is a status; Mark unread lives in ⋯.
  await reader.locator(".surface-more summary").click()
  await reader.getByRole("button", { name: "Mark unread" }).click()
  await expect(row).toBeVisible()
  await page.waitForTimeout(2_000)
  expect(writes.at(-1)).toEqual({ id: "report", revision: 1, seen: false })
  await expect(reader.getByRole("button", { name: "Mark seen", exact: true })).toBeVisible()
  await reader.getByRole("button", { name: "Mark seen", exact: true }).click()
  await expect(row).toHaveCount(0)
  step("Mark unread brings it back and stays unread while open; Mark seen clears it")

  // A newer revision lands while the reader is open (the page polls every 15 s).
  if (await publish("second") !== 2) throw new Error("expected revision 2")
  await expect(row).toHaveAttribute("aria-label", /^Try · API tests · Fixture lead · rev 2/, { timeout: 30_000 })
  await expect(reader.locator("[data-newer]")).toHaveText("rev 2 ↻")
  await expect(reader.locator(".surface-head-done")).toHaveAttribute("data-revision", "1")
  await expect(reader.locator(".surface-done")).toHaveText("✓ Seen")
  expect(writes.filter(write => write.revision === 2)).toEqual([])
  await reader.locator("[data-newer]").click()
  await expect(reader.locator(".surface-head-done")).toHaveAttribute("data-revision", "2")
  await expect(row).toHaveCount(0)
  expect(writes.at(-1)).toEqual({ id: "report", revision: 2, seen: true })
  step("a newer revision resurfaces; the open old revision never clears it; showing the newer one does")

  if (await publish("second") !== 2) throw new Error("exact retry bumped the revision")
  await page.reload({ waitUntil: "domcontentloaded" })
  await expect(reader.locator(".surface-done")).toHaveText("✓ Seen", { timeout: 60_000 })
  await expect(row).toHaveCount(0)
  step("an exact-retry publish does not bring it back")

  // Republished between the list read and the frame load: the frame may show either revision, so nothing is marked
  // until the newer one is loaded.
  await publish("first", "race")
  const before = writes.length
  await page.goto(`${preview.origin}/?item=${encodeURIComponent("surface:race")}`, { waitUntil: "domcontentloaded" })
  await expect(reader.locator("h2")).toHaveText("API tests", { timeout: 60_000 })
  if (await publish("second", "race") !== 2) throw new Error("expected race revision 2")
  releaseRace()
  await expect(reader.locator("[data-newer]")).toHaveText("rev 2 ↻")
  await page.waitForTimeout(1_000)
  expect(writes.length).toBe(before)
  await reader.locator("[data-newer]").click()
  await expect(reader.locator(".surface-done")).toHaveText("✓ Seen")
  expect(writes.at(-1)).toEqual({ id: "race", revision: 2, seen: true })
  step("a republish racing the frame load marks nothing until the newer revision is shown")

  // A hidden window never marks; becoming visible with the frame shown does.
  await publish("first", "hidden")
  await page.goto(`${preview.origin}/?item=${encodeURIComponent("surface:hidden")}`, { waitUntil: "domcontentloaded" })
  await page.evaluate(() => { Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" }); document.dispatchEvent(new Event("visibilitychange")) })
  await expect(reader.locator(".surface-head-done")).toHaveAttribute("data-revision", "1", { timeout: 60_000 })
  await page.waitForTimeout(1_500)
  if (writes.some(write => write.id === "hidden")) throw new Error("a hidden window marked seen")
  await page.evaluate(() => { Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" }); document.dispatchEvent(new Event("visibilitychange")) })
  await expect(reader.locator(".surface-done")).toHaveText("✓ Seen")
  expect(writes.at(-1)).toEqual({ id: "hidden", revision: 1, seen: true })
  step("a hidden window never marks seen; it marks once the window is visible")

  // A frame address that fails to mint never marks.
  await publish("first", "broken")
  await page.goto(`${preview.origin}/?item=${encodeURIComponent("surface:broken")}`, { waitUntil: "domcontentloaded" })
  await expect(page.getByRole("alert")).toContainText("Cannot open this surface", { timeout: 60_000 })
  await page.waitForTimeout(1_500)
  if (writes.some(write => write.id === "broken") || (await (await send("/api/surfaces")).json()).surfaces.find(item => item.id === "broken").seen) throw new Error("a failed load marked seen")
  step("a failed frame load never marks seen")
} catch (error) {
  process.exitCode = 1
  results.push(`FAIL ${String(error)} writes=${writes.length} first=${JSON.stringify(writes.slice(0, 3))}${storeErrors.size ? ` store=${[...storeErrors]}` : ""}`)
} finally {
  console.log(results.join("\n"))
  await browser.close()
  await preview.close()
  // Close the store last: the page's in-flight requests end with the browser.
  host.kill()
  await rm(home, { recursive: true, force: true })
}
