// An unknown steer (with an image) set aside while a newer draft is in the editor stays visible as a
// set-aside bubble, with its image and Check/Retry, before and after reload; the newer draft is kept.
// When storage is full the set-aside is refused and says so visibly; the input stays as it was.
// Run from packages/es-app: node test/set-aside-visibility.browser.mjs
import { createRequire } from "node:module"
import { startPanelPreview } from "./composer-panel-preview.mjs"
import { directory } from "./composer-fixture.mjs"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const preview = await startPanelPreview()
const fixture = preview.fixture
const browser = await chromium.launch({ channel: "chrome", headless: true })
const page = await browser.newPage()
const errors = []
page.on("pageerror", (error) => errors.push(error.message))
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6SAAAAABJRU5ErkJggg=="
const id = "req_selected_unknown_original"
const key = `es-app:composer:1:${JSON.stringify(["ses_a", directory])}`
const editor = page.getByRole("textbox", { name: "Message", exact: true })
const recovery = page.locator(`.input-recovery[data-recovery-id="${id}"]`)
// Headless Chrome keeps composer drafts in sessionStorage; the desktop app uses localStorage.
const saved = () => page.evaluate((key) => JSON.parse(sessionStorage.getItem(key) ?? localStorage.getItem(key) ?? "null"), key)
const posts = () => fixture.calls.filter((call) => call.method === "POST" && call.path === "/session/ses_a/input")
try {
  await page.goto(preview.url, { waitUntil: "domcontentloaded", timeout: 120_000 })
  await editor.fill("Original unknown payload with image")
  await editor.evaluate((element, data) => {
    const transfer = new DataTransfer()
    transfer.items.add(new File([Uint8Array.from(atob(data), (char) => char.charCodeAt(0))], "fixture.png", { type: "image/png" }))
    element.dispatchEvent(new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true }))
  }, png)
  await expect(page.getByRole("button", { name: "Remove fixture.png" })).toBeVisible()
  await expect.poll(async () => !!(await saved())?.task?.images?.[0]?.ref).toBe(true)
  // A restored unknown steer whose editor already holds a newer draft (as left by a lost acknowledgment).
  await page.evaluate(({ key, id }) => {
    const store = sessionStorage.getItem(key) ? sessionStorage : localStorage
    const value = JSON.parse(store.getItem(key))
    const original = { ...value.task, model: { providerID: "fixture", modelID: "test" } }
    value.admission = { payload: { requestID: id, delivery: "steer", text: original.text, images: original.images, agent: "build" },
      revision: original.revision, draft: original, status: "unknown" }
    value.task = { ...value.task, text: "Newer unsent draft with caret", selection: [7, 7], revision: value.task.revision + 1 }
    store.setItem(key, JSON.stringify(value))
  }, { key, id })
  await page.reload({ waitUntil: "domcontentloaded" })
  await expect(page.locator(".input-admission")).toContainText("Not confirmed · steer")
  await expect(editor).toHaveValue("Newer unsent draft with caret")

  // 1. Storage full: set-aside is refused visibly; nothing is dismissed or resent.
  await page.evaluate(() => {
    window.__setItem = Storage.prototype.setItem
    Storage.prototype.setItem = () => { throw new DOMException("Quota exceeded", "QuotaExceededError") }
  })
  await page.getByRole("button", { name: "Set aside unknown input", exact: true }).click()
  await expect(page.getByRole("alert").filter({ hasText: "Cannot save this unknown input" })).toBeVisible()
  await expect(page.locator(".input-admission")).toHaveCount(1)
  await expect(page.locator(".input-admission .outgoing-cue")).toHaveAttribute("title", /Cannot save this unknown input/)
  await expect(editor).toHaveValue("Newer unsent draft with caret")
  await page.evaluate(() => { Storage.prototype.setItem = window.__setItem })
  expect((await saved()).admission.payload.requestID).toBe(id)
  console.info("PASS storage full: set-aside refused with a visible alert; unknown input, image and newer draft kept")

  // 2. Set aside with a newer draft: the bubble shows with its image and actions, and survives reload.
  await page.getByRole("button", { name: "Set aside unknown input", exact: true }).click()
  await expect(page.locator(".input-admission")).toHaveCount(0)
  await expect(page.getByRole("alert").filter({ hasText: "Cannot save" })).toHaveCount(0)
  await expect(recovery).toContainText("Original unknown payload with image")
  await expect(recovery.locator("img")).toHaveCount(1)
  await expect(recovery.getByRole("button", { name: "Check set-aside input", exact: true })).toBeVisible()
  await expect(editor).toHaveValue("Newer unsent draft with caret")
  expect((await saved()).recoveries.map((entry) => entry.admission.payload.requestID)).toEqual([id])
  await page.reload({ waitUntil: "domcontentloaded" })
  await expect(recovery).toContainText("Original unknown payload with image")
  await expect(recovery.locator("img")).toHaveCount(1)
  await expect(recovery.getByRole("button", { name: "Check and retry same set-aside input", exact: true })).toBeVisible()
  await expect(editor).toHaveValue("Newer unsent draft with caret")
  expect(posts()).toHaveLength(0)
  console.info("PASS set aside with a newer draft: bubble with image and Check/Retry before and after reload; draft kept; nothing sent")
  // 3. The set-aside input was delivered after all (promoted while this page was away): once Core reports it
  // promoted and the transcript shows it, the "Set aside · promoted" card goes; the newer draft stays.
  const original = (await saved()).recoveries[0].admission.payload
  const info = { id: "msg_setaside_promoted", sessionID: "ses_a", role: "user", agent: "build", model: { providerID: "fixture", modelID: "test" }, time: { created: Date.now() } }
  fixture.messages.push({ info, parts: [{ id: "prt_setaside_promoted", sessionID: "ses_a", messageID: info.id, type: "text", text: original.text }] })
  fixture.receipts.push({ requestID: id, sessionID: "ses_a", delivery: "steer", text: original.text, images: original.images.map((image) => ({ type: "file", mime: image.mime, url: `data:image/png;base64,${png}`, filename: image.filename })),
    agent: "build", admittedSeq: 1, timeCreated: Date.now(), state: "promoted", messageID: info.id, timePromoted: Date.now() })
  await page.reload({ waitUntil: "domcontentloaded" })
  await expect(page.locator('[data-component="user-message"]').filter({ hasText: original.text })).toHaveCount(1)
  await expect(recovery).toHaveCount(0)
  await expect(page.locator(".outgoing-item")).toHaveCount(0)
  await expect(editor).toHaveValue("Newer unsent draft with caret")
  await expect.poll(async () => (await saved()).recoveries.length).toBe(0)
  expect(posts()).toHaveLength(0)
  expect(fixture.calls.filter((call) => call.method !== "GET" && call.path.startsWith("/session/ses_a/input"))).toEqual([])
  console.info("PASS set-aside input promoted elsewhere: card removed once Core reports it promoted (GET only), message shown once, newer draft kept, nothing sent")

  expect(errors).toEqual([])
} finally {
  await browser.close()
  await preview.close()
}
