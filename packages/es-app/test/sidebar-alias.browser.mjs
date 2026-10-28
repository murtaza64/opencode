import { createRequire } from "node:module"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { build, preview } from "vite"
import { startPanelPreview } from "./composer-panel-preview.mjs"
import { directory, session } from "./composer-fixture.mjs"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const scratch = await mkdtemp(path.join(tmpdir(), "sidebar-alias-"))
const site = await startPanelPreview([{
  name: "sidebar-alias:isolated-deps",
  config: () => ({ cacheDir: path.join(scratch, "vite"), optimizeDeps: { include: ["@opencode-ai/ui > @shikijs/stream", "@opencode-ai/ui > remend"] } }),
}])
if (process.argv.includes("--built")) await build({ logLevel: "error", build: { outDir: path.join(scratch, "dist") } })
const built = process.argv.includes("--built") ? await preview({ build: { outDir: path.join(scratch, "dist") }, preview: { host: "127.0.0.1", port: 0 } }) : undefined
const origin = built ? `http://127.0.0.1:${built.httpServer.address().port}` : site.origin
const alias = "/fixture symlink with spaces/a&b?#"
let dashboardDirectory = alias
let globalDirectory = directory
let detailDirectory = directory
const browser = await chromium.launch({ channel: "chrome", headless: true })
const context = await browser.newContext()
const page = await context.newPage()
const errors = []
page.on("pageerror", (error) => errors.push(error.message))
await context.addInitScript(() => { window.aliasDocument = crypto.randomUUID() })
await context.route("**/es/api/state?*", async (route) => {
  const response = await route.fetch()
  const state = await response.json()
  state.threads[0].sessions[0].directory = dashboardDirectory
  await route.fulfill({ response, json: state })
})
await context.route("**/oc/experimental/session*", async (route) => {
  const response = await route.fetch()
  const sessions = await response.json()
  sessions.find((session) => session.id === "ses_a").directory = globalDirectory
  await route.fulfill({ response, json: sessions })
})
await context.route("**/oc/session/ses_a?*", (route) => route.fulfill({ json: { ...session("ses_a"), directory: detailDirectory } }))
const publish = (directory, type, properties) => {
  for (const [response, stream] of site.fixture.eventStreams) {
    if (stream.path === "/global/event") response.write(`data: ${JSON.stringify({ directory, payload: { type, properties } })}\n\n`)
  }
}
const row = (id) => page.locator(`.sidebar a[href*="/session/${id}?"]`)
const pinned = page.locator(".pinned-section .nav-item")
const pin = (title) => page.getByRole("button", { name: `Pin ${title}`, exact: true })
const unpin = (title) => page.getByRole("button", { name: `Unpin ${title}`, exact: true })
try {
  await page.goto(`${origin}/session/ses_a?directory=${encodeURIComponent(alias)}`)
  const document = await page.evaluate(() => window.aliasDocument)
  await expect(row("ses_a")).toHaveClass(/\bactive\b/)
  await pin("Composer fixture").click()
  await expect(pinned).toHaveText([/Composer fixture/])
  await page.locator(".es-switcher").selectOption("__all__")
  await expect(row("ses_a")).toHaveAttribute("href", `/session/ses_a?directory=${encodeURIComponent(directory)}`)
  await expect(pinned).toHaveText([/Composer fixture/])
  await page.locator(".es-switcher").selectOption("fixture")
  dashboardDirectory = directory
  site.fixture.emitDashboard("changed")
  await expect(row("ses_a")).toHaveAttribute("href", `/session/ses_a?directory=${encodeURIComponent(directory)}`)
  await expect(row("ses_a")).toHaveClass(/\bactive\b/)
  await expect(pinned).toHaveText([/Composer fixture/])
  await expect(unpin("Composer fixture")).toHaveText("\u2665\ufe0e")
  await pin("Other session").click()
  await expect(pinned).toHaveText([/Composer fixture/, /Other session/])
  await page.locator(".es-switcher").selectOption("__all__")
  globalDirectory = alias
  publish(alias, "session.updated", { sessionID: "ses_a", info: { ...session("ses_a"), slug: "fixture", directory: alias } })
  await expect(row("ses_a")).toHaveAttribute("href", `/session/ses_a?directory=${encodeURIComponent(alias)}`)
  await expect(pinned).toHaveText([/Composer fixture/, /Other session/])
  await expect(row("ses_a")).toHaveClass(/\bactive\b/)
  publish(alias, "session.status", { sessionID: "ses_a", status: { type: "idle" } })
  await expect(row("ses_a").locator(".dot")).not.toHaveClass(/busy/)
  globalDirectory = directory
  publish(directory, "session.updated", { sessionID: "ses_a", info: { ...session("ses_a"), slug: "fixture", directory } })
  await expect(row("ses_a")).toHaveAttribute("href", `/session/ses_a?directory=${encodeURIComponent(directory)}`)
  await expect(row("ses_a").locator(".dot")).not.toHaveClass(/busy/)
  publish(alias, "session.status", { sessionID: "ses_a", status: { type: "busy" } })
  await expect(row("ses_a").locator(".dot")).toHaveClass("dot busy")
  detailDirectory = alias
  await row("ses_b").click()
  await expect(row("ses_b")).toHaveClass(/\bactive\b/)
  await row("ses_a").click()
  await expect(row("ses_a")).toHaveClass(/\bactive\b/)
  await expect(page.locator(".topbar")).toContainText("Composer fixture")
  await unpin("Composer fixture").click()
  await expect(pinned).toHaveText([/Other session/])
  await expect(pin("Composer fixture")).toHaveText("\u2661\ufe0e")
  expect(JSON.parse(await page.evaluate(() => localStorage.getItem("es-app-sidebar-pins")))).toEqual([
    JSON.stringify([directory, "ses_b"]),
  ])
  await pin("Composer fixture").click()
  await expect(pinned).toHaveText([/Other session/, /Composer fixture/])
  const stored = await context.storageState()
  const restored = await browser.newContext({ storageState: stored })
  await restored.addInitScript((directory) => {
    const key = "es-app-sidebar-pins"
    localStorage.setItem(key, JSON.stringify([
      ...JSON.parse(localStorage.getItem(key) ?? "[]"), JSON.stringify([directory, "ses_a"]),
    ]))
  }, alias)
  try {
    const next = await restored.newPage()
    await next.goto(`${origin}/session/ses_a?directory=${encodeURIComponent(directory)}`)
    await expect(next.locator(".pinned-section .nav-item")).toHaveText([/Other session/, /Composer fixture/])
    await next.getByRole("button", { name: "Unpin Composer fixture", exact: true }).click()
    await expect(next.locator(".pinned-section .nav-item")).toHaveText([/Other session/])
    expect(JSON.parse(await next.evaluate(() => localStorage.getItem("es-app-sidebar-pins")))).toEqual([
      JSON.stringify([directory, "ses_b"]),
    ])
  } finally {
    await restored.close()
  }
  expect(await page.evaluate(() => window.aliasDocument)).toBe(document)
  expect(errors).toEqual([])
  expect(site.fixture.calls.filter((call) => !["GET", "HEAD", "OPTIONS"].includes(call.method))).toEqual([])
  console.log(`PASS sidebar aliases (${built ? "built" : "dev"}): dashboard/global/detail spelling changes preserve pins, ordering, active navigation, status transitions and persistence without reload or API mutations`)
} finally {
  await browser.close()
  if (built) await new Promise((resolve) => { built.httpServer.closeAllConnections(); built.httpServer.close(resolve) })
  await site.close()
  await rm(scratch, { recursive: true, force: true })
}
