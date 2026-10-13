import { createRequire } from "node:module"
import { startPanelPreview } from "./composer-panel-preview.mjs"
import { directory } from "./composer-fixture.mjs"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const preview = await startPanelPreview()
const browser = await chromium.launch({ channel: "chrome", headless: true })
const page = await browser.newPage()
let owner = "ses_a"
const edges = []
const writes = []
await page.route("**/es/api/state?*", async (route) => {
  const result = await (await fetch(`${preview.fixture.url}/api/state`)).json()
  result.threads.forEach((thread) => {
    thread.lanes = thread.key === owner ? [{ lane: "work", owner, status: "active" }] : []
  })
  await route.fulfill({ json: result })
})
await page.route("**/es/api/handoffs?*", async (route) => {
  if (route.request().method() === "GET") return route.fulfill({ json: { handoffs: edges } })
  const body = route.request().postDataJSON()
  writes.push(body)
  if (owner !== body.predecessor) return route.fulfill({ status: 409, json: { error: "owner_changed" } })
  owner = "ses_b"
  const edge = { lane: body.lane, predecessor: body.predecessor, successor: owner }
  edges.push(edge)
  return route.fulfill({ json: edge })
})
try {
  await page.goto(preview.url)
  await expect(page.getByRole("button", { name: "Hand off" })).toBeVisible()
  await page.getByRole("button", { name: "Pin Composer fixture" }).click()
  await page.getByRole("textbox", { name: "Message" }).fill("unsent work")
  await page.getByRole("button", { name: "Hand off" }).click()
  await page.getByRole("textbox", { name: "Successor task" }).fill("Continue work")
  await page.getByRole("textbox", { name: "Handoff notes" }).fill("See work log")
  await page.getByRole("button", { name: "Create successor" }).click()
  await expect(page).toHaveURL(/\/session\/ses_b\?/)
  await expect(page.getByRole("textbox", { name: "Message" })).toHaveValue("unsent work")
  await expect(page.locator(".pinned-section .nav-item")).toHaveText([/Other session/])
  await expect(page.locator(".handoff-crumb")).toContainText(["predecessor (work): ses_a"])
  await page.locator(".handoff-crumb a").click()
  await expect(page).toHaveURL(/\/session\/ses_a\?/)
  await expect(page.locator(".handoff-crumb")).toContainText(["successor (work): ses_b"])
  await expect(page.getByRole("textbox", { name: "Message" })).toHaveValue("unsent work")
  expect(writes).toEqual([{ lane: "work", predecessor: "ses_a", task: "Continue work", handoff: "See work log" }])
  expect(preview.fixture.calls.filter((call) => call.method === "POST" && call.path.includes("prompt"))).toEqual([])
  console.log("PASS handoff: single operation, pin and draft continuity, separate transcripts and lineage")
} finally {
  await browser.close()
  await preview.close()
}
