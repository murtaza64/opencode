// Same session ID on two hosts: the sidebar marks only the open host's row as current. Local and the Mac Mini
// both hold ses_a; opening ?host=mini highlights the Mini row (list and pinned band), never Local's, and back.
// Run from packages/es-app: node test/sidebar-same-id.browser.mjs
import { createRequire } from "node:module"
import { startPanelPreview } from "./composer-panel-preview.mjs"
import { directory } from "./composer-fixture.mjs"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const preview = await startPanelPreview()
const browser = await chromium.launch({ headless: true,
  ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : { channel: "chrome" }) })
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
const errors = []
page.on("pageerror", (error) => errors.push(error.message))
const miniRoot = "/Users/mini/fixture"
const miniSession = { id: "ses_a", title: "Mini copy of a", directory: miniRoot, time: { created: 1, updated: Date.now() } }
await page.route("**/__es/host", (route) => route.fulfill({ json: { id: "local", label: "Local", remote: false, hosts: [], work: [
  { id: "local", label: "Local", origin: preview.fixture.url },
  { id: "mini", label: "Mac Mini", origin: "http://127.0.0.1:65001", default: true },
] } }))
await page.route("**/hosts/mini/**", (route) => {
  const path = new URL(route.request().url()).pathname
  if (path === "/hosts/mini/oc/experimental/session") return route.fulfill({ json: [miniSession] })
  if (path === "/hosts/mini/oc/session/ses_a") return route.fulfill({ json: { ...miniSession, slug: "a", projectID: "p", version: "1" } })
  if (path === "/hosts/mini/oc/session/status") return route.fulfill({ json: {} })
  if (path === "/hosts/mini/oc/session/ses_a/input") return route.fulfill({ json: { items: [], next: null } })
  if (path === "/hosts/mini/oc/config/providers") return route.fulfill({ json: { providers: [], default: {} } })
  if (path === "/hosts/mini/es/api/attention") return route.fulfill({ json: { records: [], projects: [], partial: false } })
  if (path === "/hosts/mini/es/api/editspaces") return route.fulfill({ json: { editspaces: [{ name: "fixture", root: `${miniRoot}/.editspace` }], default: "fixture" } })
  return route.fulfill({ json: [] })
})
const list = ".sidebar [role=tabpanel] > .session-entry"
const miniRow = () => page.locator(`${list} .nav-item[data-host-key='mini:ses_a']`)
const localRow = () => page.locator(`${list} .nav-item:not([data-host-key])`, { hasText: "Composer fixture" })
const current = () => page.locator(".sidebar [aria-current=page]")
try {
  await page.goto(`${preview.url.replace(/\/$/, "")}/session/ses_a?directory=${encodeURIComponent(directory)}&host=mini`)
  await expect(miniRow()).toHaveAttribute("aria-current", "page")
  await expect(miniRow()).toHaveClass(/\bactive\b/)
  await expect(localRow()).not.toHaveAttribute("aria-current", "page")
  await expect(localRow()).not.toHaveClass(/\bactive\b/)

  // Opening Local's ses_a from the list moves the mark to Local only.
  await localRow().click()
  await expect(page).not.toHaveURL(/host=mini/)
  await expect(localRow()).toHaveAttribute("aria-current", "page")
  await expect(miniRow()).not.toHaveAttribute("aria-current", "page")
  await expect(miniRow()).not.toHaveClass(/\bactive\b/)

  // Pinned band: both copies pinned; the mark follows the host there too.
  await page.locator(`${list}:has(.nav-item[data-host-key='mini:ses_a']) .pin-action`).click()
  await page.locator(`${list}:has(.nav-item:not([data-host-key]))`, { hasText: "Composer fixture" }).locator(".pin-action").click()
  await expect(page.locator(".sidebar .nav-item[data-host-key='mini:ses_a']")).toHaveCount(1)
  await miniRow().or(page.locator(".sidebar .nav-item[data-host-key='mini:ses_a']")).first().click()
  await expect(page).toHaveURL(/host=mini/)
  await expect(current()).toHaveCount(1)
  await expect(current()).toHaveAttribute("data-host-key", "mini:ses_a")
  expect(errors).toEqual([])
  console.log("sidebar-same-id: PASS")
} finally {
  await browser.close()
  await preview.close()
}
