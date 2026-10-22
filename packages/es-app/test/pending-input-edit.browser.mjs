import { createRequire } from "node:module"
import { startPanelPreview } from "./composer-panel-preview.mjs"
import { imageCapability } from "./composer-fixture.mjs"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const preview = await startPanelPreview()
const fixture = preview.fixture
fixture.updateInput = true
fixture.images = imageCapability
fixture.sessionModels.set("ses_a", { id: "test", providerID: "fixture", variant: "default" })
const image = { type: "file", mime: "image/png", filename: "pending.png", url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==" }
fixture.receipts = [
  { requestID: "human-queue", sessionID: "ses_a", delivery: "queue", text: "Original queue", agent: "build", admittedSeq: 1, timeCreated: 1, state: "pending", images: [image] },
  { requestID: "human-steer", sessionID: "ses_a", delivery: "steer", text: "Original steer", agent: "build", admittedSeq: 2, timeCreated: 2, state: "pending" },
  { requestID: "peer", sessionID: "ses_a", delivery: "queue", text: "Peer mail", agent: "build", admittedSeq: 3, timeCreated: 3, state: "pending", source: { type: "editspace-mail", id: "mail-1" } },
  { requestID: "promoted", sessionID: "ses_a", delivery: "queue", text: "Promotable", agent: "build", admittedSeq: 4, timeCreated: 4, state: "pending" },
  { requestID: "concurrent", sessionID: "ses_a", delivery: "queue", text: "Before concurrent change", agent: "build", admittedSeq: 5, timeCreated: 5, state: "pending" },
  { requestID: "lost-ack", sessionID: "ses_a", delivery: "queue", text: "Before lost ack", agent: "build", admittedSeq: 6, timeCreated: 6, state: "pending" },
]
const browser = await chromium.launch({ channel: "chrome", headless: true })
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
await page.route("**/*", (route) => new URL(route.request().url()).origin === preview.origin ? route.continue() : route.abort())
const row = (id) => page.locator(`.input-receipts li[data-request-id="${id}"]`)
const edit = (id) => page.locator(`[data-edit-request-id="${id}"]`)
const patches = (id) => fixture.calls.filter((call) => call.method === "PATCH" && call.path === `/session/ses_a/input/${id}`)
const posts = () => fixture.calls.filter((call) => call.method === "POST" && call.path === "/session/ses_a/input")
const open = async (id) => row(id).getByRole("button", { name: /^Edit / }).click()
const save = async (id) => edit(id).getByRole("button", { name: "Save pending input" }).click()
// The ordinary draft stays mounted (hidden) while an edit occupies the composer.
const editor = page.locator(".prompt-box textarea[aria-label='Message']")
const primary = page.locator(".prompt-box .direct-send .direct-primary")
try {
  await page.goto(preview.url)
  await expect(row("human-queue")).toBeVisible()
  await expect(row("peer").getByRole("button", { name: /^Edit / })).toHaveCount(0)
  await editor.fill("Main unsent text")
  await page.getByRole("button", { name: "Change model", exact: true }).click()
  await page.getByRole("combobox", { name: "Session model" }).selectOption("fixture\u0000next")
  await expect(page.locator(".prompt-box .direct-model-name")).toHaveText("next")
  await expect(page.getByRole("button", { name: "Steer", exact: true })).toHaveAttribute("data-keyboard-target", "true")
  await editor.evaluate((el) => {
    el.setSelectionRange(2, 7)
    const transfer = new DataTransfer()
    transfer.items.add(new File([Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0))], "draft.png", { type: "image/png" }))
    el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true }))
  })
  await expect(page.locator(".prompt-box .direct-draft .attachment-chip")).toHaveCount(1)
  const unchanged = async () => {
    await expect(editor).toHaveValue("Main unsent text")
    await expect(page.locator(".prompt-box .direct-draft .attachment-chip")).toHaveCount(1)
    await expect(page.locator(".prompt-box .direct-model-name")).toHaveText("next")
    await expect(primary).toHaveAttribute("aria-label", "Steer")
    expect(await editor.evaluate((el) => [el.selectionStart, el.selectionEnd])).toEqual([2, 7])
  }

  await open("human-queue")
  // The edit takes over the composer: the draft and send controls are hidden, the edit text is focused.
  await expect(page.locator(".prompt-box").getByRole("textbox", { name: "Message", exact: true })).toHaveCount(0)
  await expect(page.locator(".prompt-box").getByRole("button", { name: "Steer", exact: true })).toHaveCount(0)
  await expect(page.locator(".prompt-box").getByRole("button", { name: "More send options", exact: true })).toHaveCount(0)
  await expect(edit("human-queue").getByRole("textbox", { name: "Pending input text" })).toBeFocused()
  await expect(edit("human-queue").getByRole("textbox", { name: "Pending input text" })).toHaveValue("Original queue")
  await expect(row("human-steer").getByRole("button", { name: /^Edit / })).toBeDisabled()
  await edit("human-queue").getByRole("textbox", { name: "Pending input text" }).fill("Changed to steer")
  await edit("human-queue").getByRole("combobox", { name: "Pending input delivery" }).selectOption("steer")
  fixture.holdInputUpdate = true
  await save("human-queue")
  await expect.poll(() => fixture.inputUpdateReplies.length).toBe(1)
  await expect(edit("human-queue").getByRole("button", { name: "Save pending input" })).toBeDisabled()
  await unchanged()
  fixture.holdInputUpdate = false
  fixture.inputUpdateReplies.shift()()
  await expect(row("human-queue").locator(".receipt-text")).toHaveText("Changed to steer")
  await expect(edit("human-queue")).toHaveCount(0)
  expect(patches("human-queue").map((call) => call.body)).toMatchObject([{ expectedRevision: 0, text: "Changed to steer", delivery: "steer" }])
  expect(fixture.receipts[0]).toMatchObject({ revision: 1, delivery: "steer", images: [image], agent: "build" })
  await unchanged()

  await open("human-steer")
  await edit("human-steer").getByRole("textbox", { name: "Pending input text" }).fill("Changed to queue")
  await edit("human-steer").getByRole("combobox", { name: "Pending input delivery" }).selectOption("queue")
  // Cmd/Ctrl+Enter saves the edit; it never sends a new message.
  await edit("human-steer").getByRole("textbox", { name: "Pending input text" }).press("Control+Enter")
  await expect(row("human-steer").locator(".receipt-kind")).toHaveText("queue")
  expect(patches("human-steer")[0].body).toMatchObject({ expectedRevision: 0, text: "Changed to queue", delivery: "queue" })
  await unchanged()

  await open("human-queue")
  await edit("human-queue").getByRole("textbox", { name: "Pending input text" }).fill("Draft after cancel")
  // Escape cancels; the ordinary draft comes back unchanged.
  await edit("human-queue").getByRole("textbox", { name: "Pending input text" }).press("Escape")
  await expect(edit("human-queue")).toHaveCount(0)
  await expect(page.locator(".prompt-box").getByRole("textbox", { name: "Message", exact: true })).toHaveValue("Main unsent text")
  await open("human-queue")
  await expect(edit("human-queue").getByRole("textbox", { name: "Pending input text" })).toHaveValue("Draft after cancel")
  await edit("human-queue").getByRole("button", { name: "Cancel edit" }).click()
  expect(patches("human-queue")).toHaveLength(1)

  await open("promoted")
  await edit("promoted").getByRole("textbox", { name: "Pending input text" }).fill("Keep this after promotion")
  fixture.promoteOnUpdate = true
  await save("promoted")
  await expect(edit("promoted").getByRole("alert")).toContainText("kept")
  await expect(edit("promoted").getByRole("textbox", { name: "Pending input text" })).toHaveValue("Keep this after promotion")
  await expect(edit("promoted")).toContainText("promoted")
  await expect(edit("promoted").getByRole("button", { name: "Keep edit against current revision" })).toHaveCount(0)
  await unchanged()
  // One edit at a time: close the conflicted edit before editing another input.
  await edit("promoted").getByRole("button", { name: "Cancel edit" }).click()

  await open("concurrent")
  await edit("concurrent").getByRole("textbox", { name: "Pending input text" }).fill("My concurrent draft")
  Object.assign(fixture.receipts.find((item) => item.requestID === "concurrent"), { text: "External revision", revision: 1 })
  await save("concurrent")
  await expect(edit("concurrent")).toContainText("External revision")
  await expect(edit("concurrent").getByRole("textbox", { name: "Pending input text" })).toHaveValue("My concurrent draft")
  await edit("concurrent").getByRole("button", { name: "Keep edit against current revision" }).click()
  await save("concurrent")
  await expect(row("concurrent").locator(".receipt-text")).toHaveText("My concurrent draft")
  expect(patches("concurrent").map((call) => call.body.expectedRevision)).toEqual([0, 1])

  await open("lost-ack")
  await edit("lost-ack").getByRole("textbox", { name: "Pending input text" }).fill("Update with lost ACK")
  fixture.loseInputUpdateAck = true
  await save("lost-ack")
  await expect(edit("lost-ack")).toContainText(/Update not confirmed \(.+\)\. Retry sends the same update\./)
  await expect(edit("lost-ack").getByRole("button", { name: "Retry same update" })).toBeVisible()
  // An unknown update survives reload in the composer, locked, next to the untouched draft.
  await page.reload()
  await expect(edit("lost-ack").getByRole("button", { name: "Retry same update" })).toBeVisible()
  await expect(edit("lost-ack").getByRole("textbox", { name: "Pending input text" })).toBeDisabled()
  await expect(edit("lost-ack").getByRole("textbox", { name: "Pending input text" })).toHaveValue("Update with lost ACK")
  await expect(editor).toHaveValue("Main unsent text")
  expect(patches("lost-ack")).toHaveLength(1)
  await edit("lost-ack").getByRole("button", { name: "Retry same update" }).click()
  await expect(edit("lost-ack")).toHaveCount(0)
  expect(patches("lost-ack")).toHaveLength(2)
  expect(patches("lost-ack")[1].body).toEqual(patches("lost-ack")[0].body)
  expect(fixture.receipts.find((item) => item.requestID === "lost-ack").revision).toBe(1)
  expect(posts()).toHaveLength(0)
  await unchanged()

  await page.setViewportSize({ width: 390, height: 780 })
  await page.evaluate(() => { document.documentElement.dir = "rtl" })
  await open("human-steer")
  await expect(edit("human-steer").getByRole("button", { name: "Save pending input" })).toBeVisible()
  await expect(edit("human-steer").getByRole("combobox", { name: "Pending input delivery" })).toBeVisible()
  await expect(edit("human-steer").getByRole("button", { name: "Cancel edit" })).toBeVisible()
  const width = await page.evaluate(() => ({ client: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth }))
  expect(width.scroll).toBeLessThanOrEqual(width.client)
  expect(fixture.unexpected).toEqual([])
  console.log("PASS pending input edit: capability, human-only, draft isolation, conversions, cancel, promotion, CAS rebase, lost ACK, mobile RTL")
} finally {
  await browser.close()
  await preview.close()
}
