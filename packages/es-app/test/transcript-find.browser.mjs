import { createRequire } from "node:module"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { startFindPreview } from "./transcript-find-preview.mjs"
import { directory } from "./composer-fixture.mjs"
import { closeFindBrowser } from "./find-browser.mjs"

const { chromium, _electron, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const preview = await startFindPreview()
const fixture = preview.fixture
const profile = process.env.ES_DESKTOP_EXECUTABLE ? await mkdtemp(path.join(tmpdir(), "transcript-find-")) : undefined
const app = profile ? await _electron.launch({ args: ["--use-mock-keychain"], executablePath: process.env.ES_DESKTOP_EXECUTABLE,
  env: { ...process.env, ELECTRON_RUN_AS_NODE: "", ES_DESKTOP_USER_DATA: profile, ES_DESKTOP_RENDERER: "",
    OPENCODE_URL: fixture.url, ES_DASHBOARD_URL: fixture.url, OPENCODE_SERVER_PASSWORD: "" },
}) : undefined
const server = app ? undefined : await chromium.launchServer({ channel: "chrome", headless: true })
const browser = server ? await chromium.connect(server.wsEndpoint()) : undefined
const page = app ? await app.firstWindow() : await browser.newPage()
page.setDefaultTimeout(10_000)
if (app) {
  await page.waitForURL("http://127.0.0.1:*/")
  preview.origin = new URL(page.url()).origin
  preview.url = `${preview.origin}/session/ses_a?directory=${encodeURIComponent(directory)}`
}
const errors = []
page.on("pageerror", (error) => errors.push(error.message))
const find = () => page.getByRole("search", { name: "Find in transcript" })
const input = () => find().getByRole("searchbox", { name: "Find in transcript" })
const matches = () => find().locator(".find-result")
const editor = () => page.locator(".prompt-box textarea")
const reads = () => fixture.calls.filter((call) => call.path === "/session/ses_a/message").length
const unexpectedWrites = () => fixture.calls.filter((call) => !["GET", "HEAD", "OPTIONS"].includes(call.method) &&
  !(call.method === "POST" && call.path === "/api/attention/session" && JSON.stringify(call.body) === "{}"))
const open = async () => { await page.keyboard.press("Control+f"); await expect(input()).toBeFocused() }
const lookup = async (text, count) => {
  await input().fill(text)
  await expect(find().getByRole("status")).not.toContainText("Searching…")
  await expect(matches()).toHaveCount(count)
}
let failure = ""
await page.route("**/oc/session/ses_a/message?**", async (route) => {
  const url = new URL(route.request().url())
  if (!failure || !url.searchParams.has("before")) return route.continue()
  if (failure === "offline") return route.fulfill({ status: 503, body: "synthetic offline" })
  const response = await route.fetch()
  const headers = response.headers()
  if (failure === "repeat") headers["x-next-cursor"] = url.searchParams.get("before")
  return route.fulfill({ response, headers })
})
try {
  await page.goto(preview.url, { waitUntil: "domcontentloaded", timeout: 30_000 })
  await expect(editor()).toBeVisible({ timeout: 30_000 })
  await expect(page.locator("[data-find-message]")).toHaveCount(80)
  await editor().fill("Keep my draft שלום")
  await editor().press("Meta+m")
  await expect(page.locator(".prompt-box").getByRole("button", { name: "Queue", exact: true })).toHaveAttribute("data-keyboard-target", "true")
  await editor().evaluate((element) => { element.focus(); element.setSelectionRange(2, 7, "backward") })
  const originalDraft = await editor().evaluate((element) => ({ value: element.value, start: element.selectionStart, end: element.selectionEnd, direction: element.selectionDirection }))
  const originalReads = reads()
  await open()
  await lookup("needle", 2)
  await expect(find()).toContainText("Partial selected transcript")
  await input().press("Enter")
  await expect(find().getByRole("status")).toContainText("1 of 2")
  await expect(page.getByRole("region", { name: "Selected transcript match" })).toContainText("needle")
  await input().press("Shift+Enter")
  await expect(find().getByRole("status")).toContainText("2 of 2")
  await input().press("Enter")
  await expect(find().getByRole("status")).toContainText("1 of 2")
  await input().press("Control+Enter")
  await input().press("Meta+Enter")
  await lookup("[a.*]", 2)
  await lookup("unindexed-reasoning", 0)
  await lookup("unindexed-input", 0)
  await lookup("unindexed-system", 0)
  await lookup("unindexed-mail-payload", 0)
  await lookup("unindexed-mail-wrapper", 1)
  expect(reads()).toBe(originalReads)
  await input().fill("needle")
  await find().getByRole("button", { name: "Search earlier history" }).click()
  await expect(find()).toContainText("Full selected transcript")
  await expect(matches()).toHaveCount(3)
  await expect(page.locator("[data-find-message]")).toHaveCount(80)
  await matches().first().click()
  const selected = page.getByRole("region", { name: "Selected transcript match" })
  await expect(selected).toContainText("msg_00000")
  await expect(selected.locator("mark")).toHaveText("Needle")
  await expect(selected).toBeInViewport()
  await lookup("STRASSE", 2)
  await lookup("שלום", 3)
  await page.evaluate(() => { document.documentElement.dir = "rtl" })
  await input().press("Enter")
  await expect(page.getByRole("region", { name: "Selected transcript match" })).toBeInViewport()
  expect(await input().getAttribute("dir")).toBe("auto")
  await page.evaluate(() => { document.documentElement.lang = "ar" })
  await input().press("Shift+Enter")
  await lookup("", 0)
  await expect(page.getByRole("region", { name: "Selected transcript match" })).toHaveCount(0)
  await input().press("Escape")
  expect(await editor().evaluate((element) => ({ value: element.value, start: element.selectionStart, end: element.selectionEnd, direction: element.selectionDirection }))).toEqual(originalDraft)
  await expect(page.locator(".prompt-box").getByRole("button", { name: "Queue", exact: true })).toHaveAttribute("data-keyboard-target", "true")
  await page.evaluate(() => { document.documentElement.dir = "ltr"; document.documentElement.lang = "en" })
  console.log("Find: paged/literal/RTL/draft checks passed")

  // Opening and closing without choosing a result keeps the reader position.
  await page.locator(".transcript").evaluate((element) => { element.scrollTop = 1000 })
  const before = await page.locator(".transcript").evaluate((element) => element.scrollTop)
  await open()
  await lookup("needle", 2)
  await input().press("Escape")
  await expect.poll(() => page.locator(".transcript").evaluate((element) => element.scrollTop)).toBe(before)

  // Find never blur-saves the title. Closing restores exact caret and draft.
  await page.getByRole("button", { name: "Rename session", exact: true }).click()
  const title = page.getByRole("textbox", { name: "Session title", exact: true })
  await title.fill("Uncommitted title draft")
  await title.evaluate((element) => element.setSelectionRange(3, 9, "backward"))
  await page.keyboard.press("Meta+f")
  await expect(input()).toBeFocused()
  await input().press("Escape")
  await expect(title).toBeFocused()
  await expect(title).toHaveValue("Uncommitted title draft")
  expect(await title.evaluate((element) => [element.selectionStart, element.selectionEnd, element.selectionDirection])).toEqual([3, 9, "backward"])
  await title.press("Escape")

  // Expanded composer stays mounted, including images and vim mode/selection.
  await page.getByRole("button", { name: "Expand editor", exact: true }).click()
  const expanded = page.locator(".prompt-box.prompt-expanded textarea[aria-label='Message']")
  await expanded.fill("Expanded draft with image")
  await expanded.evaluate((element) => {
    const data = new DataTransfer()
    const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII="
    data.items.add(new File([Uint8Array.from(atob(png), (character) => character.charCodeAt(0))], "kept.png", { type: "image/png" }))
    element.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }))
  })
  await expect(page.locator(".prompt-box").getByRole("button", { name: "Remove kept.png", exact: true })).toBeVisible()
  await expanded.evaluate((element) => element.setSelectionRange(4, 11))
  await expanded.press("Escape")
  const expandedSelection = await expanded.evaluate((element) => [element.selectionStart, element.selectionEnd])
  await open()
  await expect(input()).toBeVisible()
  await input().press("Escape")
  await expect(expanded).toBeFocused()
  await expect(expanded).toHaveValue("Expanded draft with image")
  await expect(expanded).toHaveClass(/vim-normal/)
  expect(await expanded.evaluate((element) => [element.selectionStart, element.selectionEnd])).toEqual(expandedSelection)
  await expect(page.locator(".prompt-box").getByRole("button", { name: "Remove kept.png", exact: true })).toBeVisible()
  await page.getByRole("button", { name: "Collapse editor", exact: true }).click()
  console.log("Find: title/expanded editor checks passed")

  // Live text updates replace the search snapshot, not append stale hits.
  await open()
  await lookup("streamneedle", 0)
  fixture.emit("message.part.updated", { part: { ...fixture.messages[244].parts[0], text: "streamneedle" } })
  await expect(matches()).toHaveCount(1)
  fixture.emit("message.part.delta", { sessionID: "ses_a", messageID: "msg_00244", partID: "part_244", field: "text", delta: " STREAMNEEDLE" })
  await expect(matches()).toHaveCount(2)
  fixture.emit("message.part.updated", { part: { ...fixture.messages[244].parts[0], text: "needle ".repeat(1200) } })
  await lookup("needle", 500)
  await expect(find()).toContainText("500+ (result cap)")
  fixture.emit("message.part.updated", { part: { ...fixture.messages[244].parts[0], text: "streamneedle STREAMNEEDLE" } })
  await lookup("streamneedle", 2)
  await lookup("needle", 3)
  await input().fill("stale no match")
  await input().fill("streamneedle")
  await expect(matches()).toHaveCount(2)
  await input().press("Escape")

  for (const mode of ["repeat", "offline"]) {
    failure = mode
    await open()
    await lookup("needle", 3)
    await find().getByRole("button", { name: "Search earlier history" }).click()
    await expect(find().getByRole("alert")).toBeVisible()
    await expect(find()).toContainText("Partial selected transcript")
    await expect(find()).not.toContainText("Full selected transcript")
    await input().press("Escape")
  }
  console.log("Find: streaming/error checks passed")
  failure = ""
  fixture.holdMessages.set("ses_a", true)
  await open()
  await input().fill("needle")
  await find().getByRole("button", { name: "Search earlier history" }).click()
  await expect(find()).toContainText("Reading history")
  await expect.poll(() => fixture.messageReplies.length).toBeGreaterThan(0)
  await find().getByRole("button", { name: "Cancel history search" }).click()
  await expect(find()).not.toContainText("Reading history")
  await expect.poll(() => fixture.abortedMessages.length).toBeGreaterThan(0)
  await find().getByRole("button", { name: "Search earlier history" }).click()
  await expect.poll(() => fixture.messageReplies.length).toBeGreaterThan(1)
  await input().fill("cancel by query change")
  await expect(find()).not.toContainText("Reading history")
  await expect.poll(() => fixture.abortedMessages.length).toBeGreaterThan(1)
  await input().press("Escape")
  fixture.holdMessages.delete("ses_a")
  fixture.messageReplies.splice(0).forEach((reply) => reply())

  // Home retains browser-default Find; navigating disposes the Session listener.
  expect(unexpectedWrites()).toEqual([])
  await page.goto(preview.origin, { waitUntil: "domcontentloaded", timeout: 30_000 })
  expect(await page.evaluate(() => {
    const event = new KeyboardEvent("keydown", { key: "f", ctrlKey: true, bubbles: true, cancelable: true })
    window.dispatchEvent(event)
    return event.defaultPrevented
  })).toBe(false)
  expect(unexpectedWrites()).toEqual([])
  expect(errors).toEqual([])
  console.log(`PASS transcript Find (${app ? "packaged Electron" : "browser"}): paged earlier hit, literal/case/Unicode/RTL, live updates, cursor/network errors, cancel, wrapped navigation, draft/title/expanded vim preservation, Home default, zero writes`)
} finally {
  fixture.holdMessages.clear()
  fixture.messageReplies.splice(0).forEach((reply) => reply())
  await page.unrouteAll({ behavior: "ignoreErrors" })
  await app?.close()
  // The private server owns this Chromium process tree; do not let worker or
  // routed-request shutdown stall teardown after the assertions have finished.
  if (server) await closeFindBrowser(server)
  await preview.close()
  if (profile) await rm(profile, { recursive: true, force: true })
}
