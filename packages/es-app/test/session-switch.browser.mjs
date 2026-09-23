import { createRequire } from "node:module"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { startPanelPreview } from "./composer-panel-preview.mjs"
import { session } from "./composer-fixture.mjs"

const { chromium, _electron, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const preview = await startPanelPreview()
const fixture = preview.fixture
fixture.sessionIDs.push("ses_c")
fixture.children.set("ses_child", { session: { ...session("ses_child"), parentID: "ses_a", title: "Child inspection" }, messages: [] })
fixture.messages[1].parts.push({ id: "part_task", messageID: "msg_2", sessionID: "ses_a", type: "tool", tool: "task", callID: "call_task",
  state: { status: "completed", input: { subagent_type: "explore", description: "Inspect child" }, metadata: { sessionId: "ses_child" }, title: "Inspect child", output: "Complete", time: { start: 1, end: 2 } } })
const profile = process.env.ES_DESKTOP_EXECUTABLE ? await mkdtemp(path.join(tmpdir(), "session-switch-")) : undefined
const app = profile ? await _electron.launch({ executablePath: process.env.ES_DESKTOP_EXECUTABLE,
  env: { ...process.env, ELECTRON_RUN_AS_NODE: "", ES_DESKTOP_USER_DATA: profile, ES_DESKTOP_RENDERER: "",
    OPENCODE_URL: fixture.url, ES_DASHBOARD_URL: fixture.url, OPENCODE_SERVER_PASSWORD: "" },
}) : undefined
const browser = app ? undefined : await chromium.launch({ channel: "chrome", headless: true })
const page = app ? await app.firstWindow() : await browser.newPage({ viewport: { width: 1440, height: 1000 } })
if (app) {
  await page.waitForURL("http://127.0.0.1:*/")
  preview.origin = new URL(page.url()).origin
  preview.url = `${preview.origin}/session/ses_a?directory=${encodeURIComponent(session("ses_a").directory)}`
}
await page.context().route("**/*", route => new URL(route.request().url()).origin === preview.origin ? route.continue() : route.abort())
const errors = []
page.on("pageerror", error => errors.push(error.message))
const editor = () => page.locator(".float-editor textarea, .prompt-box:not([inert]) textarea")
const selection = () => editor().evaluate(el => [el.selectionStart, el.selectionEnd])
const tab = async (back = false) => {
  if (!app) return page.keyboard.press(back ? "Shift+Tab" : "Tab")
  await app.evaluate(({ BrowserWindow }, back) => {
    const window = BrowserWindow.getAllWindows()[0]
    window.focus()
    window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Tab", modifiers: back ? ["shift"] : [] })
    window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Tab", modifiers: back ? ["shift"] : [] })
  }, back)
}
const at = async id => {
  await expect.poll(() => new URL(page.url()).pathname).toBe(`/session/${id}`)
  await expect(editor()).toBeFocused()
}
try {
  await page.goto(preview.url)
  await expect(page.locator('.nav-item[href*="ses_c"]')).toBeVisible()
  await editor().fill("alpha draft stays intact")
  await editor().evaluate(el => el.setSelectionRange(2, 7))
  await expect(editor()).toHaveClass(/vim-insert/)
  await tab()
  await at("ses_b")
  const expanded = "bravo expanded draft ".repeat(24)
  await editor().fill(expanded)
  await expect(page.locator(".float-editor textarea")).toBeFocused()
  await editor().evaluate(el => el.setSelectionRange(10, 20))
  await tab(true)
  await at("ses_a")
  await expect(editor()).toHaveValue("alpha draft stays intact")
  expect(await selection()).toEqual([2, 7])
  await editor().press("Escape")
  await expect(editor()).toHaveClass(/vim-normal/)
  const normalSelection = await selection()
  await tab()
  await at("ses_b")
  await expect(editor()).toHaveValue(expanded)
  expect(await selection()).toEqual([10, 20])
  await tab()
  await at("ses_c")
  await editor().fill("charlie draft")
  await editor().evaluate(el => el.setSelectionRange(1, 4))
  await tab()
  await at("ses_a")
  expect(await selection()).toEqual(normalSelection)
  await tab(true)
  await at("ses_c")
  await expect(editor()).toHaveValue("charlie draft")
  expect(await selection()).toEqual([1, 4])
  for (const event of [{ repeat: true }, { isComposing: true }, { ctrlKey: true }, { metaKey: true }, { altKey: true }]) {
    await editor().dispatchEvent("keydown", { key: "Tab", code: "Tab", ...event })
    await at("ses_c")
  }
  await expect(editor()).toHaveValue("charlie draft")
  await tab()
  await at("ses_a")
  await editor().press("Escape")
  await editor().evaluate(el => el.blur())
  await tab()
  await at("ses_b")
  await tab(true)
  await at("ses_a")

  // Tab remains focus navigation outside the composer, including the inspection dialog.
  await page.getByLabel("Model override", { exact: true }).focus()
  await tab()
  expect(new URL(page.url()).pathname).toBe("/session/ses_a")
  await expect(page.getByLabel("Model override", { exact: true })).not.toBeFocused()
  await page.getByRole("button", { name: "Explore Inspect child" }).click()
  const dialog = page.getByRole("dialog")
  await expect(dialog).toContainText("No messages yet.")
  await dialog.locator(".subagent-transcript").focus()
  await tab()
  expect(await page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]'))).toBe(true)
  await tab(true)
  expect(await page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]'))).toBe(true)
  expect(new URL(page.url()).pathname).toBe("/session/ses_a")
  await page.keyboard.press("Escape")
  await expect(dialog).toHaveCount(0)
  await expect(editor()).toHaveValue("alpha draft stays intact")
  expect(fixture.calls.filter(call => !["GET", "HEAD", "OPTIONS"].includes(call.method))).toEqual([])
  expect(fixture.unexpected).toEqual([])
  expect(errors).toEqual([])
  console.log(`PASS session Tab: Insert/Normal, forward/reverse/wrap order, inline/expanded drafts and selections, composition/repeat/modifiers, control focus and modal trap, zero mutations; input=${app ? "Electron webContents.sendInputEvent (synthetic)" : "Playwright browser keyboard"}`)
} finally {
  await app?.close()
  await browser?.close()
  await preview.close()
  if (profile) await rm(profile, { recursive: true, force: true })
}
