import { createRequire } from "node:module"
import { startPanelPreview } from "./composer-panel-preview.mjs"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const preview = await startPanelPreview()
const fixture = preview.fixture
const browser = await chromium.launch({ channel: "chrome", headless: true })
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
await page.context().route("**/*", route => new URL(route.request().url()).origin === preview.origin ? route.continue() : route.abort())
const actions = () => page.getByRole("group", { name: "Session actions", exact: true }).first()
const patches = () => fixture.calls.filter(call => call.method === "PATCH" && call.body?.time)
try {
  await page.goto(preview.url, { waitUntil: "domcontentloaded" })
  await actions().getByRole("button", { name: "Archive", exact: true }).click()
  await expect(actions().getByText("Archived", { exact: true })).toBeVisible()
  expect(patches().at(-1).body.time.archived).toBeGreaterThan(0)

  await actions().getByRole("button", { name: "Restore", exact: true }).click()
  await expect(actions().getByRole("button", { name: "Archive", exact: true })).toBeVisible()
  await expect(actions().getByText("Archived", { exact: true })).toHaveCount(0)
  expect(patches().at(-1)).toMatchObject({ path: "/session/ses_a", body: { time: { archived: null } } })
  expect(patches()).toHaveLength(2)
  console.log("session archive/restore browser check passed")
} finally {
  await browser.close()
  await preview.close()
}
