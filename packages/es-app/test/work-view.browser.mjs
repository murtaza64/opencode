// Work view (U1a): Local and Mac Mini sessions in one sidebar list, with a third Work view host that
// never answers. Same session ID on both hosts stays two rows; Mini rows open on the Mini's own
// listener; the offline host is shown as unreachable (never empty, never merged); New session
// defaults to the Mini and only uses Local by explicit choice; pins of Mini rows are host-keyed.
import { createRequire } from "node:module"
import { startPanelPreview } from "./composer-panel-preview.mjs"
import { directory } from "./composer-fixture.mjs"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const preview = await startPanelPreview()
const browser = await chromium.launch({ channel: "chrome", headless: true })
const page = await browser.newPage()
const mini = "http://127.0.0.1:65001"
const miniRoot = "/Users/mini/fixture"
const hostReads = { mini: 0, wing: 0 }
const miniSessions = [
  { id: "ses_a", title: "Mini copy of a", directory: miniRoot, time: { created: 1, updated: Date.now() } },
  { id: "ses_mini", title: "Mini only", directory: `${miniRoot}/.editspace/lanes/x/repos/o/r`, time: { created: 1, updated: Date.now() - 1000 } },
  { id: "ses_elsewhere", title: "Mini other project", directory: "/Users/mini/other", time: { created: 1, updated: Date.now() } },
]
let miniDown = false
await page.route("**/__es/host", (route) => route.fulfill({ json: { id: "local", label: "Local", remote: false, hosts: [], work: [
  { id: "local", label: "Local", origin: preview.fixture.url },
  { id: "mini", label: "Mac Mini", origin: mini, default: true },
  { id: "wing", label: "Wingman", origin: "http://127.0.0.1:65002" },
] } }))
await page.route("**/hosts/mini/**", (route) => {
  hostReads.mini++
  if (miniDown) return route.abort("connectionrefused")
  const url = new URL(route.request().url())
  if (url.pathname === "/hosts/mini/oc/experimental/session") return route.fulfill({ json: miniSessions })
  if (url.pathname === "/hosts/mini/es/api/editspaces") return route.fulfill({ json: { editspaces: [{ name: "fixture", root: `${miniRoot}/.editspace` }], default: "fixture" } })
  return route.fulfill({ status: 403, body: "not exposed" })
})
await page.route("**/hosts/wing/**", (route) => {
  hostReads.wing++
  return route.fulfill({ status: 502, contentType: "application/json", body: '{"error":"Host unavailable"}' })
})
// Navigation to the Mini's listener is the shell's job (it opens the Mini tab); record it here.
const opened = []
await page.route(`${mini}/**`, (route) => {
  opened.push(route.request().url())
  return route.fulfill({ contentType: "text/html", body: "<title>Mini listener</title>" })
})
try {
  await page.goto(preview.url)
  const rows = page.locator(".sidebar > .session-entry .nav-item")
  // Both copies of ses_a are listed, each on its host; the Mini's other project is not in this project's view.
  await expect(page.getByRole("link", { name: /^Mini copy of a, on Mac Mini$/ })).toBeVisible()
  await expect(page.getByRole("link", { name: /^Mini only, on Mac Mini$/ })).toBeVisible()
  await expect(page.locator(".sidebar .nav-item", { hasText: "Mini other project" })).toHaveCount(0)
  await expect(page.locator(".sidebar > .session-entry .nav-item[data-host-key='mini:ses_a']")).toHaveCount(1)
  await expect(rows.filter({ hasText: "Composer fixture" })).toHaveCount(1)
  await expect(rows.filter({ hasText: "Composer fixture" }).locator(".sr-only")).toHaveText(", on Local")
  await expect(page.locator(".host-glyph").first()).toBeVisible()
  // The host that never answers is unreachable, distinct from empty, with a retry.
  const wing = page.locator(".host-status", { hasText: "Wingman" })
  await expect(wing).toContainText(/Wingman · unreachable since/)
  await expect(page.locator(".host-status", { hasText: "Mac Mini" })).toHaveCount(0)
  // Pins of a Mini row are kept under the Mini's prefix; local pins are untouched.
  await page.getByRole("button", { name: "Pin Mini only on Mac Mini" }).click()
  await expect(page.locator(".sidebar .pinned-section .nav-item")).toHaveText([/Mini only/])
  expect(JSON.parse(await page.evaluate(() => localStorage.getItem("host:mini:es-app-sidebar-pins")))).toEqual([JSON.stringify([`${miniRoot}/.editspace/lanes/x/repos/o/r`, "ses_mini"])])
  expect(await page.evaluate(() => localStorage.getItem("es-app-sidebar-pins"))).toBeNull()
  await page.reload()
  await expect(page.locator(".sidebar .pinned-section .nav-item")).toHaveText([/Mini only/])
  // New session: the destination is shown first and defaults to the Mini.
  await page.getByRole("link", { name: "New session" }).first().click()
  await expect(page.getByLabel("Run on")).toHaveValue("mini")
  await expect(page.getByRole("link", { name: "Start on Mac Mini" })).toHaveAttribute("href", `${mini}/new?host=mini`)
  await expect(page.getByLabel("Message")).toHaveCount(0)
  await page.getByLabel("Run on").selectOption("local")
  await expect(page).toHaveURL(/\/new\?host=local$/)
  await expect(page.getByLabel("Message")).toBeVisible()
  await expect(page.getByRole("button", { name: /Start on Local/ })).toBeVisible()
  // The Mini goes away: its rows stay listed, dimmed and disabled; New session never falls back.
  miniDown = true
  await page.goto(new URL("/new", preview.url).href)
  await expect(page.getByRole("alert")).toHaveText("Mac Mini is unreachable. Choose Local or try again.")
  await expect(page.getByRole("button", { name: "Start on Mac Mini" })).toBeDisabled()
  await expect(page.getByLabel("Message")).toHaveCount(0)
  await page.goto(preview.url)
  await expect(page.locator(".host-status", { hasText: "Mac Mini" })).toContainText(/unreachable since/)
  miniDown = false
  await page.locator(".host-status", { hasText: "Mac Mini" }).getByRole("button", { name: "Retry" }).click()
  await expect(page.locator(".host-status", { hasText: "Mac Mini" })).toHaveCount(0)
  // Opening a Mini row goes to the Mini's own listener, never a local route.
  await page.getByRole("link", { name: /^Mini copy of a, on Mac Mini$/ }).click()
  await expect.poll(() => opened.at(-1)).toBe(`${mini}/session/ses_a?directory=${encodeURIComponent(miniRoot)}`)
  expect(preview.fixture.calls.filter((call) => !["GET", "HEAD", "OPTIONS"].includes(call.method))).toEqual([])
  console.log(`PASS work view: two hosts listed apart (same id), offline host shown unreachable, Mini default create without fallback, host-keyed pins, Mini row opens on its listener; host reads mini=${hostReads.mini} wing=${hostReads.wing}; zero mutations`)
} finally {
  await browser.close()
  await preview.close()
}
