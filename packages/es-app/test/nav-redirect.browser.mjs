// An old /desk?item= link (redirect to the desk) must not poison where the nav leads afterwards: Agent map
// opens /agents and Decisions & inbox returns to the desk item. Installed 9a3d recorded /desk as Agents
// mode's last place, so its Agents tab navigated back to the desk (dotfiles orchestrator #1088).
// Run from packages/es-app: node test/nav-redirect.browser.mjs
import { createRequire } from "node:module"
import { startPanelPreview } from "./composer-panel-preview.mjs"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const preview = await startPanelPreview()
const browser = await chromium.launch({ channel: "chrome", headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
try {
  await page.goto(`${preview.url}/desk?item=attention%3Aalpha%3Ax`, { timeout: 300_000 })
  await expect.poll(() => new URL(page.url()).pathname, { timeout: 60_000 }).not.toBe("/desk")
  await page.getByRole("link", { name: "Agent map" }).first().waitFor({ timeout: 60_000 })
  const stored = await page.evaluate(() => [sessionStorage.getItem("es-app:mode:agents"), sessionStorage.getItem("es-app:mode:desk")])
  expect(stored.some(value => value?.startsWith("/desk"))).toBe(false)
  await page.getByRole("link", { name: "Agent map" }).first().click()
  await expect.poll(() => new URL(page.url()).pathname, { timeout: 10_000 }).toBe("/agents")
  await page.getByRole("link", { name: /^Decisions & inbox/ }).first().click()
  await expect.poll(() => new URL(page.url()).pathname, { timeout: 10_000 }).toBe("/")
  console.info("PASS nav after a /desk redirect: /desk not recorded as an Agents place; Agent map -> /agents; Decisions -> desk")
} finally {
  await browser.close()
  await preview.close()
}
