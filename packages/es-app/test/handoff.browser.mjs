import { createRequire } from "node:module"
import { startPanelPreview } from "./composer-panel-preview.mjs"
import { directory, imageCapability } from "./composer-fixture.mjs"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const preview = await startPanelPreview()
preview.fixture.images = imageCapability
preview.fixture.sessionIDs.push("ses_c")
const browser = await chromium.launch({ channel: "chrome", headless: true })
const page = await browser.newPage()
let owner = "ses_a"
const successors = { ses_a: "ses_b", ses_b: "ses_c" }
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
  owner = successors[body.predecessor]
  const edge = { lane: body.lane, predecessor: body.predecessor, successor: owner }
  edges.push(edge)
  return route.fulfill({ json: edge })
})
const sessionURL = (id) => `${preview.origin}/session/${id}?directory=${encodeURIComponent(directory)}`
const pasteImage = (name, size) => page.locator(".direct-composer textarea:visible").evaluate(async (el, { name, size }) => {
  const canvas = document.createElement("canvas")
  canvas.width = size
  canvas.height = size
  canvas.getContext("2d").fillRect(0, 0, size, size)
  const file = await new Promise((resolve) => canvas.toBlob((blob) => resolve(new File([blob], name, { type: "image/png" })), "image/png"))
  const data = new DataTransfer()
  data.items.add(file)
  el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true }))
}, { name, size })
const handOff = async (task, notes) => {
  await page.getByRole("button", { name: "Hand off" }).click()
  await page.getByRole("textbox", { name: "Successor task" }).fill(task)
  await page.getByRole("textbox", { name: "Handoff notes" }).fill(notes)
  await page.getByRole("button", { name: "Create successor" }).click()
}
try {
  await page.goto(`${preview.url}/agents`)
  await expect(page.getByRole("button", { name: "Hand off" })).toBeVisible()
  await page.getByRole("button", { name: "Pin Composer fixture" }).click()
  await page.getByRole("textbox", { name: "Message" }).fill("unsent work")
  await pasteImage("shared.png", 32)
  await expect(page.locator(".attachment-chip")).toHaveCount(1)
  await handOff("Continue work", "See work log")
  await expect(page).toHaveURL(/\/session\/ses_b\?/)
  await expect(page.getByRole("textbox", { name: "Message" })).toHaveValue("unsent work")
  await expect(page.locator(".attachment-chip")).toHaveCount(1)
  await expect(page.locator(".pinned-section .nav-item")).toHaveText([/Other session/])
  await expect(page.locator(".handoff-crumb")).toContainText(["predecessor (work): ses_a"])
  await page.locator(".handoff-crumb a").click()
  await expect(page).toHaveURL(/\/session\/ses_a\?/)
  await expect(page.locator(".handoff-crumb")).toContainText(["successor (work): ses_b"])
  await expect(page.getByRole("textbox", { name: "Message" })).toHaveValue("unsent work")
  expect(writes).toEqual([{ lane: "work", predecessor: "ses_a", task: "Continue work", handoff: "See work log" }])

  // The predecessor drops its copy of the shared image; the successor's saved copy must survive a reload.
  await page.getByRole("button", { name: "Remove shared.png" }).click()
  await expect(page.locator(".attachment-chip")).toHaveCount(0)
  await page.getByRole("textbox", { name: "Message" }).fill("")
  await page.waitForTimeout(300)
  await page.goto(sessionURL("ses_b"))
  await expect(page.getByRole("textbox", { name: "Message" })).toHaveValue("unsent work")
  await expect(page.locator(".attachment-chip")).toHaveCount(1, { timeout: 10000 })
  await expect(page.locator(".direct-composer .err, .direct-composer [role=alert]")).toHaveCount(0)

  // An image-only successor draft is still hydrating from saved refs when the handoff lands;
  // it must win over the predecessor's draft instead of being merged with it.
  await page.goto(sessionURL("ses_c"))
  await pasteImage("successor.png", 48)
  await expect(page.locator(".attachment-chip")).toHaveCount(1)
  await page.waitForTimeout(300)
  await page.goto(sessionURL("ses_b"))
  await expect(page.getByRole("textbox", { name: "Message" })).toHaveValue("unsent work")
  await page.getByRole("textbox", { name: "Message" }).fill("second handoff text")
  await handOff("Finish work", "Second handoff")
  await expect(page).toHaveURL(/\/session\/ses_c\?/)
  await expect(page.locator(".attachment-chip")).toHaveCount(1)
  await expect(page.locator(".attachment-chip")).toHaveAttribute("title", /successor\.png/)
  await expect(page.getByRole("textbox", { name: "Message" })).toHaveValue("")
  await page.goto(sessionURL("ses_c"))
  await expect(page.locator(".attachment-chip")).toHaveCount(1, { timeout: 10000 })
  await expect(page.locator(".attachment-chip")).toHaveAttribute("title", /successor\.png/)
  await expect(page.getByRole("textbox", { name: "Message" })).toHaveValue("")
  expect(writes).toHaveLength(2)
  expect(preview.fixture.calls.filter((call) => call.method === "POST" && call.path.includes("prompt"))).toEqual([])
  console.log("PASS handoff: single operation, pin and draft continuity, separate transcripts and lineage, shared image survives predecessor edit, hydrating image-only successor draft wins")
} finally {
  await browser.close()
  await preview.close()
}
