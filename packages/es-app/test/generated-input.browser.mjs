import { createRequire } from "node:module"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { startPanelPreview } from "./composer-panel-preview.mjs"
import { directory, session } from "./composer-fixture.mjs"

const { chromium, _electron, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const preview = await startPanelPreview()
const fixture = preview.fixture
const notice = "[Agent notice fixture; not a user request]\nResume the existing PR updates after the maintenance hold. Preserve completed effects.\n\n<img src=x onerror=alert(1)> stays literal.\n" + "Full retained notice text. ".repeat(30)
const user = (id, parts) => ({ info: { ...fixture.messages[0].info, id }, parts: parts.map((part, index) => ({ id: `${id}_${index}`, sessionID: "ses_a", messageID: id, ...part })) })
const assistant = fixture.messages[1]
fixture.messages = [
  user("msg_001", [{ type: "text", text: "Human question" }]),
  user("msg_002", [{ type: "text", text: notice, synthetic: true }]),
  user("msg_003", [{ type: "text", text: "[Agent notice fake] This is still human input." }]),
  user("msg_004", [{ type: "text", text: "Read the requested file" }, { type: "text", text: "EXPANSION_HIDDEN", synthetic: true }]),
  user("msg_005", [{ type: "file", mime: "image/png", filename: "fixture.png", url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jWZ0AAAAASUVORK5CYII=" }, { type: "text", text: "IMAGE_EXPANSION_HIDDEN", synthetic: true }]),
  { info: { ...assistant.info, id: "msg_006" }, parts: [{ type: "tool", id: "part_task", messageID: "msg_006", sessionID: "ses_a", tool: "task", callID: "task",
    state: { status: "completed", input: { subagent_type: "explore", description: "Inspect generated child" }, metadata: { sessionId: "ses_child" }, output: "Done", title: "Inspect", time: { start: 1, end: 2 } } }] },
]
fixture.children.set("ses_child", { session: { ...session("ses_child"), parentID: "ses_a", title: "Child generated input" }, messages: [{
  info: { ...fixture.messages[0].info, id: "msg_child", sessionID: "ses_child" },
  parts: [{ id: "part_child", messageID: "msg_child", sessionID: "ses_child", type: "text", synthetic: true, text: "Resume child fixture — generated input" }],
}] })
const profile = process.env.ES_DESKTOP_EXECUTABLE ? await mkdtemp(path.join(tmpdir(), "generated-input-")) : undefined
const app = profile ? await _electron.launch({ executablePath: process.env.ES_DESKTOP_EXECUTABLE,
  env: { ...process.env, ELECTRON_RUN_AS_NODE: "", ES_DESKTOP_USER_DATA: profile, ES_DESKTOP_RENDERER: "", OPENCODE_URL: fixture.url, ES_DASHBOARD_URL: fixture.url, OPENCODE_SERVER_PASSWORD: "" },
}) : undefined
const browser = app ? undefined : await chromium.launch({ channel: "chrome", headless: true })
const page = app ? await app.firstWindow() : await browser.newPage({ viewport: { width: 1440, height: 1000 } })
if (app) {
  await page.waitForURL("http://127.0.0.1:*/")
  preview.origin = new URL(page.url()).origin
  preview.url = `${preview.origin}/session/ses_a?directory=${encodeURIComponent(directory)}`
}
await page.context().route("**/*", route => new URL(route.request().url()).origin === preview.origin ? route.continue() : route.abort())
const errors = []
page.on("pageerror", error => errors.push(error.message))
try {
  await page.goto(preview.url)
  // Observe the clipboard boundary without replacing the user's system clipboard.
  await page.evaluate(() => {
    const output = document.createElement("output")
    output.id = "copy-capture"
    output.hidden = true
    document.body.append(output)
    document.addEventListener("copy", event => {
      event.preventDefault()
      output.textContent = document.activeElement instanceof HTMLTextAreaElement ? document.activeElement.value : document.getSelection().toString()
    })
  })
  const editor = page.getByRole("textbox", { name: "Message", exact: true })
  await editor.fill("Parent draft remains unchanged")
  await editor.evaluate(el => el.setSelectionRange(2, 7))
  await editor.press("Escape")
  const generated = page.locator('[data-generated-message-id="msg_002"]')
  await expect(page.locator(".generated-input")).toHaveCount(1)
  await expect(generated.locator("summary")).toContainText("Generated input")
  await expect(generated.getByRole("region")).toHaveCount(0)
  await expect(page.locator('[data-component="user-message"]')).toHaveCount(4)
  await expect(page.locator('[data-component="user-message"]')).toContainText(["Human question", "[Agent notice fake] This is still human input.", "Read the requested file"])
  await expect(page.locator('[data-slot="user-message-attachment"][data-type="image"]')).toHaveCount(1)
  await expect(page.locator(".transcript")).not.toContainText("EXPANSION_HIDDEN")
  expect(await generated.evaluate(el => {
    const previous = document.querySelector('[data-timeline-part-id="msg_001_0"]')
    const next = document.querySelector('[data-timeline-part-id="msg_003_0"]')
    return !!(previous.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) && !!(el.compareDocumentPosition(next) & Node.DOCUMENT_POSITION_FOLLOWING)
  })).toBe(true)
  await generated.locator("summary").focus()
  await generated.locator("summary").press("Enter")
  await expect(generated.getByRole("region", { name: "Generated input text" })).toHaveText(notice)
  await expect(generated.locator("img,script,iframe")).toHaveCount(0)
  const scroll = await page.locator(".session-page .transcript").evaluate(el => el.scrollTop)
  await generated.getByRole("button", { name: "Copy generated input" }).click()
  await expect(page.locator("#copy-capture")).toHaveText(notice)
  expect(await page.locator("#copy-capture").textContent()).toBe(notice)
  await expect(generated.getByRole("button", { name: "Copy generated input" })).toBeFocused()
  expect(await page.locator(".session-page .transcript").evaluate(el => el.scrollTop)).toBe(scroll)
  await expect(editor).toHaveValue("Parent draft remains unchanged")
  await page.keyboard.press("Tab")
  expect(page.url()).toBe(preview.url)
  await generated.locator("summary").click()
  await expect(generated.getByRole("region")).toHaveCount(0)

  const trigger = page.getByRole("button", { name: "Agent Explore · Inspect generated child" })
  await trigger.click()
  const dialog = page.getByRole("dialog")
  await expect(dialog.locator(".generated-input")).toHaveCount(1)
  await dialog.locator(".generated-input summary").press("Enter")
  await expect(dialog.getByRole("region", { name: "Generated input text" })).toHaveText("Resume child fixture — generated input")
  await dialog.getByRole("button", { name: "Copy generated input" }).click()
  await expect(page.locator("#copy-capture")).toHaveText("Resume child fixture — generated input")
  await page.keyboard.press("Tab")
  expect(await page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]'))).toBe(true)
  await page.keyboard.press("Escape")
  await expect(dialog).toHaveCount(0)
  await expect(trigger).toBeFocused()
  await expect(editor).toHaveValue("Parent draft remains unchanged")
  expect(errors).toEqual([])
  expect(fixture.calls.filter(call => !["GET", "HEAD", "OPTIONS"].includes(call.method))).toEqual([])
  console.log(`PASS ${app ? "packaged native" : "browser"} generated input: synthetic-only visibility/order, fake-prefix human, mixed/context+image suppression, literal safe body, full copy, keyboard/modal/focus/draft/scroll, zero mutations`)
} finally {
  await app?.close()
  await browser?.close()
  await preview.close()
  if (profile) await rm(profile, { recursive: true, force: true })
}
