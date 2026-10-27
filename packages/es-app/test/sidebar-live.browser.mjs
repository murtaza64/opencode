import { createRequire } from "node:module"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { build, preview } from "vite"
import { startPanelPreview } from "./composer-panel-preview.mjs"
import { directory, session } from "./composer-fixture.mjs"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const scratch = await mkdtemp(path.join(tmpdir(), "sidebar-live-"))
const site = await startPanelPreview([{
  name: "sidebar-live:isolated-deps",
  config: () => ({ cacheDir: path.join(scratch, "vite"), optimizeDeps: { include: ["@opencode-ai/ui > @shikijs/stream", "@opencode-ai/ui > remend"] } }),
}])
site.fixture.workspaceSessions.push({ ...session("ses_c"), title: "مرحبا mixed session", time: { created: 1, updated: Date.now() - 86400000 } })
if (process.argv.includes("--built")) await build({ logLevel: "error", build: { outDir: path.join(scratch, "dist") } })
const built = process.argv.includes("--built") ? await preview({ build: { outDir: path.join(scratch, "dist") }, preview: { host: "127.0.0.1", port: 0 } }) : undefined
const origin = built ? `http://127.0.0.1:${built.httpServer.address().port}` : site.origin
const url = `${origin}/session/ses_a?directory=${encodeURIComponent(directory)}`
const browser = await chromium.launch({ channel: "chrome", headless: true })
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
const deployed = process.argv.includes("--deployed")
const stateOnly = process.argv.includes("--state-only")
const isolate = async (context) => {
  // Fulfilled static documents have no remote IP classification in Chrome.
  await context.grantPermissions(["local-network-access"], { origin })
  await context.route("**/*", async (route) => {
    const target = new URL(route.request().url())
    if (target.origin !== origin) return route.abort()
    // Replay only the deployed static artifact; every API/event stays on the fixture.
    if (deployed && (route.request().isNavigationRequest() || target.pathname.startsWith("/assets/"))) {
      const response = await route.fetch({ url: `http://127.0.0.1:3181${target.pathname}${target.search}` })
      return route.fulfill({ response })
    }
    return route.continue()
  })
}
await isolate(context)
const page = await context.newPage()
const errors = []
page.on("pageerror", (error) => errors.push(error.message))
await context.addInitScript(() => { window.sidebarDocument = crypto.randomUUID() })
await context.route("**/es/api/state?*", async (route) => {
  const response = await route.fetch()
  const state = await response.json()
  state.threads.forEach((thread, index) => {
    thread.sessions[0].updated ??= Date.now() - index * 86400000
  })
  await route.fulfill({ response, json: state })
})
const row = (id) => page.locator(`.sidebar a[href*="/session/${id}?"]`)
const pinned = () => page.locator(".sidebar .pin-action.pinned, .sidebar .mini-pin.pinned")
const publish = (type) => {
  site.fixture.status = type
  for (const [response, stream] of site.fixture.eventStreams) {
    if (stream.path === "/global/event") response.write(`data: ${JSON.stringify({ directory, payload: {
      type: "session.status", properties: { sessionID: "ses_a", status: { type } },
    } })}\n\n`)
  }
}
// Sidebar rows never animate: a busy row shows the static halo, with no animation and no JS clock.
const staticHalo = async () => {
  const dot = row("ses_a").locator(".dot")
  expect(await dot.evaluate((el) => ({ opacity: getComputedStyle(el, "::after").opacity, animation: getComputedStyle(el, "::after").animationName })))
    .toEqual({ opacity: "0.3", animation: "none" })
}
try {
  await page.goto(url)
  const document = await page.evaluate(() => window.sidebarDocument)
  await expect(row("ses_a").locator(".dot")).toHaveClass("dot busy")
  await expect.poll(() => [...site.fixture.eventStreams.values()].some((stream) => stream.path === "/global/event")).toBe(true)
  for (const direction of ["ltr", "rtl"]) {
    await page.evaluate((direction) => {
      document.documentElement.dir = direction
      document.documentElement.lang = direction === "rtl" ? "ar" : "en"
    }, direction)
    for (const compact of [false, true]) {
      if (compact) await page.getByRole("button", { name: "Collapse sidebar" }).click()
      await row("ses_a").click()
      await expect(row("ses_a")).toHaveClass(/\bactive\b/)
      await row("ses_b").click()
      await expect(row("ses_b")).toHaveClass(/\bactive\b/)
      await expect(row("ses_a")).not.toHaveClass(/\bactive\b/)
      publish("idle")
      await expect(row("ses_a").locator(".dot")).not.toHaveClass(/busy/)
      publish("busy")
      await expect(row("ses_a").locator(".dot")).toHaveClass("dot busy")
      if (!stateOnly) await staticHalo()
      await page.getByRole("button", { name: "Pin Other session", exact: true }).click()
      await expect(pinned()).toHaveCount(1)
      await expect(page.getByRole("button", { name: "Unpin Other session", exact: true })).toHaveText("◆")
      await expect(row("ses_b")).toHaveClass(/\bactive\b/)
      await page.getByRole("button", { name: "Pin Composer fixture", exact: true }).focus()
      await page.keyboard.press("Enter")
      await expect(pinned()).toHaveCount(2)
      expect(JSON.parse(await page.evaluate(() => localStorage.getItem("es-app-sidebar-pins")))).toEqual([
        JSON.stringify([directory, "ses_b"]), JSON.stringify([directory, "ses_a"]),
      ])
      expect(await page.locator(".sidebar a[href*='/session/']").evaluateAll((rows) => rows.map((row) => new URL(row.href).pathname))).toEqual([
        "/session/ses_b", "/session/ses_a", "/session/ses_c",
      ])
      await page.getByRole("button", { name: "Unpin Other session", exact: true }).click()
      await expect(pinned()).toHaveCount(1)
      await expect(page.getByRole("button", { name: "Pin Other session", exact: true })).toHaveText("◇")
      await expect(row("ses_b")).toHaveClass(/\bactive\b/)
      await page.getByRole("button", { name: "Unpin Composer fixture", exact: true }).click()
      await expect(pinned()).toHaveCount(0)
      if (compact) await page.locator(".sidebar-mini > .mini-btn").click()
    }
  }
  await page.locator(".es-switcher").selectOption("__all__")
  await expect(row("ses_c")).toContainText("مرحبا mixed session")
  await row("ses_b").click()
  const pinning = page.getByRole("button", { name: "Pin Other session", exact: true }).click()
  const updated = { ...site.fixture.workspaceSessions[0], slug: "fixture", title: "Updated مرحبا session", time: { created: 1, updated: Date.now() } }
  site.fixture.workspaceSessions[0] = updated
  for (const [response, stream] of site.fixture.eventStreams) {
    if (stream.path === "/global/event") response.write(`data: ${JSON.stringify({ directory, payload: {
      type: "session.updated", properties: { sessionID: updated.id, info: updated },
    } })}\n\n`)
  }
  publish("idle")
  await pinning
  await expect(row("ses_c")).toContainText("Updated مرحبا session")
  await expect(row("ses_b")).toHaveClass(/\bactive\b/)
  await expect(pinned()).toHaveCount(1)
  await page.getByRole("button", { name: "Unpin Other session", exact: true }).click()
  await expect(pinned()).toHaveCount(0)
  // Exercise safety-net hydration after a long idle without replacing the document.
  await page.clock.install()
  await page.clock.fastForward(65000)
  await page.clock.resume()
  await expect(row("ses_b")).toHaveClass(/\bactive\b/)
  publish("busy")
  await expect(row("ses_a").locator(".dot")).toHaveClass("dot busy")
  // A missed idle event must reconcile when the global stream reconnects.
  const globalReads = site.fixture.calls.filter((call) => call.path === "/global/event").length
  site.fixture.status = "idle"
  for (const [response, stream] of site.fixture.eventStreams) if (stream.path === "/global/event") response.end()
  await expect.poll(() => site.fixture.calls.filter((call) => call.path === "/global/event").length, { timeout: 10000 }).toBeGreaterThan(globalReads)
  await expect(row("ses_a").locator(".dot")).not.toHaveClass(/busy/)
  publish("busy")
  await expect(row("ses_a").locator(".dot")).toHaveClass("dot busy")
  if (!stateOnly) await staticHalo()
  if (!stateOnly) {
    await page.locator(".sidebar").evaluate((el) => { el.style.transform = "translateY(-200vh)" })
    await page.locator(".sidebar").evaluate((el) => { el.style.transform = "" })
    await staticHalo()
  }
  await page.getByRole("button", { name: "Pin Other session", exact: true }).click()
  const saved = await context.storageState()
  const restored = await browser.newContext({ storageState: saved, reducedMotion: "reduce" })
  await isolate(restored)
  try {
    const restoredPage = await restored.newPage()
    await restoredPage.goto(url)
    await expect(restoredPage.locator(".pinned-section .nav-item")).toHaveText([/Other session/])
    const dot = restoredPage.locator('.sidebar a[href*="/session/ses_a?"] .dot.busy')
    await expect(dot).toBeVisible()
    await expect.poll(() => dot.evaluate((el) => getComputedStyle(el, "::after").opacity)).toBe("0.3")
  } finally {
    await restored.close()
  }
  expect(await page.evaluate(() => window.sidebarDocument), "same document throughout live checks").toBe(document)
  expect(errors).toEqual([])
  expect(site.fixture.calls.filter((call) => !["GET", "HEAD", "OPTIONS"].includes(call.method))).toEqual([])
  console.log(`PASS sidebar live (${deployed ? "deployed3181" : built ? "built" : "dev"}${stateOnly ? ", state-only" : ""}): LTR/RTL expanded/compact navigation, busy/idle/busy${stateOnly ? "" : " pulse"}, pin/unpin order/icons/persistence, concurrent session.updated, idle hydration, global reconnect, reduced motion; no reload or mutations`)
} finally {
  await browser.close()
  if (built) await new Promise((resolve) => { built.httpServer.closeAllConnections(); built.httpServer.close(resolve) })
  await site.close()
  await rm(scratch, { recursive: true, force: true })
}
