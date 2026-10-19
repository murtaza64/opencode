import { createRequire } from "node:module"
import { startPanelPreview } from "./composer-panel-preview.mjs"
import { directory, imageCapability } from "./composer-fixture.mjs"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const preview = await startPanelPreview()
const fixture = preview.fixture
fixture.status = "idle"
fixture.images = imageCapability
fixture.sessionIDs.push("ses_c", "ses_d")
const browser = await chromium.launch({ channel: "chrome", headless: true })
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
const page = await context.newPage()
const errors = []
page.on("pageerror", (error) => errors.push(error.message))
const href = (id) => `${preview.origin}/session/${id}?directory=${encodeURIComponent(directory)}`
const key = (id) => `es-app:composer:1:${JSON.stringify([id, directory])}`
const image = { id: "source-image", mime: "image/png", filename: "source.png", url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aF2kAAAAASUVORK5CYII=" }
await context.addInitScript(({ directory, image }) => {
  if (sessionStorage.getItem("handoff-seeded")) return
  sessionStorage.setItem("handoff-seeded", "true")
  localStorage.setItem("es-app-sidebar-pins", JSON.stringify([JSON.stringify([directory, "ses_a"])]))
  const draft = { text: "", images: [], model: null, selection: [0, 0], revision: 0 }
  const save = (id, text) => sessionStorage.setItem(`es-app:composer:1:${JSON.stringify([id, directory])}`, JSON.stringify({
    version: 1, directView: 1, visibleBuffer: "task", keyboardTarget: "queue", targetRevision: 3, mode: "send",
    task: { ...draft, text, images: [{ ...image, id }], selection: [2, 5] },
    aside: { ...draft, text: `${text} aside`, model: { providerID: "fixture", modelID: "next" } }, asideSeeded: true,
  }))
  save("ses_a", "Unsent source")
  save("ses_b", "Destination draft")
}, { directory, image })
const editor = () => page.locator('.prompt-box:not([inert])').getByRole("textbox", { name: "Message", exact: true })
const read = (id) => page.evaluate((key) => JSON.parse(sessionStorage.getItem(key)), key(id))
const pins = () => page.evaluate(() => JSON.parse(localStorage.getItem("es-app-sidebar-pins")))
const mutations = () => fixture.calls.filter((call) => !["GET", "HEAD", "OPTIONS"].includes(call.method))
try {
  await page.goto(href("ses_b"))
  await expect(editor()).toHaveValue("Destination draft")
  await expect.poll(async () => (await read("ses_b")).task.images[0]?.ref).toBeTruthy()
  // The predecessor is pinned but not viewed when explicit lineage arrives.
  await page.goto(href("ses_c"))
  await expect(editor()).toBeVisible()
  fixture.handoffs = [{ lane: "work", predecessor: "ses_a", successor: "ses_b" }]
  fixture.laneOwners = [{ lane: "work", owner: "ses_b" }]
  fixture.emitDashboard("state")
  await expect.poll(pins).toEqual([JSON.stringify([directory, "ses_b"])])
  await expect(page).toHaveURL(href("ses_c"))
  fixture.handoffs.push({ lane: "work", predecessor: "ses_b", successor: "ses_d" })
  fixture.laneOwners = [{ lane: "work", owner: "ses_d" }]
  fixture.emitDashboard("state")
  await expect.poll(pins).toEqual([JSON.stringify([directory, "ses_d"])])
  // Return to the first hop for recovery and the previous-session link.
  fixture.handoffs.pop()
  fixture.laneOwners = [{ lane: "work", owner: "ses_b" }]
  fixture.superseded.set("ses_a", { successor: "ses_b" })
  fixture.handoffs = []
  await page.goto(href("ses_a"))
  await expect(editor()).toHaveValue("Unsent source")
  await page.locator(".prompt-box").getByRole("button", { name: "Send", exact: true }).click()
  const recovery = page.locator(".transcript .handoff-recovery")
  await expect(recovery).toContainText("Message not sent")
  await expect(recovery).toContainText("Unsent source")
  await expect(page.locator(".direct-feedback.err")).toHaveCount(0)
  await expect(page.locator(".normal-submission")).toHaveCount(0)
  expect(mutations().filter((call) => call.path.endsWith("/prompt_async"))).toHaveLength(1)
  fixture.handoffs = [{ lane: "work", predecessor: "ses_a", successor: "ses_b" }]
  fixture.emitDashboard("state")
  const source = await read("ses_a")
  const destination = await read("ses_b")
  page.once("dialog", async (dialog) => { expect(dialog.message()).toContain("already has a draft"); await dialog.dismiss() })
  await recovery.getByRole("link").click()
  await expect(recovery).toContainText("Both sessions’ drafts were kept")
  expect(await read("ses_a")).toEqual(source)
  expect(await read("ses_b")).toEqual(destination)
  await expect(page).toHaveURL(href("ses_a"))
  // Failure to validate destination identity never opens confirmation or changes drafts.
  await page.route("**/oc/session/ses_b?*", (route) => route.fulfill({ status: 503, json: { error: "fixture unavailable" } }))
  await recovery.getByRole("link").click()
  await expect(recovery).toContainText("Could not open the successor")
  expect(await read("ses_b")).toEqual(destination)
  await page.unroute("**/oc/session/ses_b?*")
  // Actual transfer in forced RTL, with images and selection intact and no POST/PATCH.
  await page.evaluate(() => { document.documentElement.dir = "rtl" })
  const before = mutations().length
  page.once("dialog", async (dialog) => dialog.accept())
  await recovery.getByRole("link").click()
  await expect(page).toHaveURL(href("ses_b"))
  await expect(editor()).toHaveValue("Unsent source")
  await expect(page.locator(".transcript").getByLabel("Previous session")).toContainText("ses_a")
  await expect(page.locator(".transcript").getByLabel("Previous session").getByRole("link")).toHaveAttribute("href", `/session/ses_a?directory=${encodeURIComponent(directory)}`)
  await expect(page.locator(".prompt-box").getByRole("button", { name: "Remove source.png", exact: true })).toBeVisible()
  const copied = await read("ses_b")
  expect(copied.task.selection).toEqual([2, 5])
  expect(copied.aside.model).toEqual({ providerID: "fixture", modelID: "next" })
  expect(copied.task.images).toHaveLength(1)
  expect(copied.keyboardTarget).toBe("steer")
  expect(await read("ses_a")).toEqual(source)
  expect(mutations()).toHaveLength(before)
  // A completed self-spawn receipt also blocks writes when the runtime has no fence.
  fixture.handoffs = [{ lane: "work", predecessor: "ses_b", successor: "ses_d" }]
  fixture.laneOwners = [{ lane: "work", owner: "ses_d" }]
  await page.goto(href("ses_b"))
  await expect(page.locator(".handoff-recovery")).toBeVisible()
  const beforeUnfenced = mutations().length
  await page.locator(".prompt-box").getByRole("button", { name: "Send", exact: true }).click()
  await expect(page.locator(".transcript .handoff-recovery")).toContainText("Message not sent")
  expect(mutations()).toHaveLength(beforeUnfenced)
  expect(errors).toEqual([])
  console.log("handoff continuity: unviewed/multi-hop pins, transcript409, cancel/failure preservation, RTL draft/image/model/selection recovery without send: PASS")
} finally {
  await context.close()
  await browser.close()
  await preview.close()
}
