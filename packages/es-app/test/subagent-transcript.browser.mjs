import { createRequire } from "node:module"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { startPanelPreview } from "./composer-panel-preview.mjs"
import { directory, session } from "./composer-fixture.mjs"

const { chromium, _electron, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const preview = await startPanelPreview()
const fixture = preview.fixture
const childID = "ses_child"
const childDirectory = "/child worktree/مرحبا &?#"
const child = {
  session: { ...session(childID), parentID: "ses_a", title: "Child transcript مرحبا", directory: childDirectory },
  messages: [{
    info: { ...fixture.messages[0].info, id: "msg_child", sessionID: childID },
    parts: [{ id: "part_child", messageID: "msg_child", sessionID: childID, type: "text", text: "ONLY THE CORRECT CHILD" }],
  }],
  replies: [], closed: 0, hold: "metadata", failure: 0,
}
fixture.children.set(childID, child)
const task = (id, metadata, status = "completed") => ({
  id, messageID: "msg_2", sessionID: "ses_a", type: "tool", tool: "task", callID: id,
  state: { status, input: { description: id, subagent_type: "explore" }, metadata,
    output: "Untrusted output ses_fake", title: id, time: { start: 2, end: 3 },
    ...(status === "error" ? { error: "Error: child failed" } : {}) },
})
fixture.messages[1].parts = [
  task("inspect-child", { sessionId: childID }),
  task("failed-child", { sessionId: childID }, "error"),
  task("untrusted-child", {}),
  { ...fixture.messages[1].parts[0], text: "Parent only\n\n" + "Parent history\n\n".repeat(80) },
]
const profile = process.env.ES_DESKTOP_EXECUTABLE ? await mkdtemp(path.join(tmpdir(), "subagent-modal-")) : undefined
const app = profile ? await _electron.launch({
  executablePath: process.env.ES_DESKTOP_EXECUTABLE,
  env: { ...process.env, ELECTRON_RUN_AS_NODE: "", ES_DESKTOP_USER_DATA: profile, ES_DESKTOP_RENDERER: "",
    OPENCODE_URL: fixture.url, ES_DASHBOARD_URL: fixture.url, OPENCODE_SERVER_PASSWORD: "" },
}) : undefined
const browser = app ? undefined : await chromium.launch({ channel: "chrome", headless: true })
const context = app ? app.context() : await browser.newContext({ viewport: { width: 1440, height: 1000 } })
const page = app ? await app.firstWindow() : await context.newPage()
if (app) {
  await page.waitForURL("http://127.0.0.1:*/")
  preview.origin = new URL(page.url()).origin
  preview.url = `${preview.origin}/session/ses_a?directory=${encodeURIComponent(directory)}`
}
await context.route("**/*", route => new URL(route.request().url()).origin === preview.origin ? route.continue() : route.abort())
const errors = []
page.on("pageerror", error => errors.push(error.message))
const dialog = page.getByRole("dialog")
const trigger = page.getByRole("button", { name: "Agent Explore · inspect-child" })
const requests = () => fixture.calls.filter(call => call.path.startsWith(`/session/${childID}`))
const childStreams = () => [...fixture.eventStreams.values()].filter(stream => stream.directory === childDirectory)
const saved = () => page.evaluate(() => Object.fromEntries(Object.entries(localStorage).filter(([key]) => key.startsWith("es-app:composer:"))))
const scroll = () => page.locator(".session-page .transcript").evaluate(el => el.scrollTop)
try {
  await page.goto(preview.url, { waitUntil: "domcontentloaded" })
  const editor = page.getByRole("textbox", { name: "Message", exact: true })
  await editor.fill("Parent draft stays exactly here")
  await expect(page.getByRole("button", { name: "Steer", exact: true })).toBeEnabled()
  await editor.press("Meta+m")
  await page.getByLabel("Queue agent", { exact: true }).selectOption("plan")
  await page.getByLabel("Model override", { exact: true }).selectOption("fixture\u0000test")
  await editor.evaluate(el => el.setSelectionRange(2, 8))
  await trigger.scrollIntoViewIfNeeded()
  await trigger.focus()
  const before = await saved()
  const parentScroll = await scroll()
  expect(requests()).toHaveLength(0)
  await page.locator('[data-timeline-part-id="untrusted-child"] [role="button"]').click()
  await expect(dialog).toHaveCount(0)
  expect(requests()).toHaveLength(0)
  await trigger.focus()
  await trigger.press("Enter")
  await expect(dialog).toContainText("Loading subagent…")
  await expect.poll(() => child.replies.length).toBe(1)
  child.hold = ""
  child.replies.shift()()
  await expect(dialog).toContainText("ONLY THE CORRECT CHILD")
  await expect(dialog).toContainText(childDirectory)
  await expect(dialog).toContainText("Read-only inspection")
  await expect(dialog.getByRole("heading")).toHaveText(child.session.title)
  await expect.poll(() => childStreams().length).toBe(1)
  fixture.emit("session.status", { sessionID: childID, status: { type: "busy" } })
  await expect(dialog.getByRole("status")).toHaveText("busy")
  expect(requests().filter(call => call.path.endsWith("/message")).every(call => call.directory === childDirectory)).toBe(true)
  await expect(dialog.locator("textarea, .fork-here, .banner-actions, .direct-composer")).toHaveCount(0)
  await dialog.getByLabel("Subagent transcript", { exact: true }).focus()
  await page.keyboard.press("i")
  await page.keyboard.press("Control+l")
  await page.keyboard.press("Meta+m")
  await page.keyboard.press("Tab")
  expect(page.url()).toBe(preview.url)
  expect(await saved()).toEqual(before)
  expect(await scroll()).toBe(parentScroll)
  await page.keyboard.press("Escape")
  await expect(dialog).toHaveCount(0)
  await expect(trigger).toBeFocused()
  await expect.poll(() => childStreams().length).toBe(0)
  expect(await scroll()).toBe(parentScroll)
  expect(await saved()).toEqual(before)

  // Failure and retry use the resolved child's directory, with visible empty state.
  child.failure = 503
  await trigger.press("Space")
  await expect(dialog.getByRole("alert")).toContainText("Unable to load the subagent session")
  child.failure = 0
  child.messages = []
  await dialog.getByRole("button", { name: "Retry", exact: true }).click()
  await expect(dialog).toContainText("No messages yet.")
  await dialog.getByRole("button", { name: "Close", exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await expect(trigger).toBeFocused()

  // Error Task entries remain inspectable via keyboard, in both directions.
  for (const direction of ["ltr", "rtl"]) {
    await page.setViewportSize({ width: direction === "rtl" ? 390 : 1440, height: 1000 })
    await page.evaluate(dir => { document.documentElement.dir = dir }, direction)
    const failed = page.getByRole("button", { name: "Explore · failed-child", exact: true })
    await failed.focus()
    await failed.press("Enter")
    await expect(dialog).toContainText("No messages yet.")
    const width = await dialog.evaluate(el => ({ scroll: el.scrollWidth, client: el.clientWidth }))
    expect(width.scroll).toBeLessThanOrEqual(width.client)
    await page.keyboard.press("Escape")
    await expect(dialog).toHaveCount(0)
    await expect(failed).toBeFocused()
  }
  await page.setViewportSize({ width: 1440, height: 1000 })

  // An invalid metadata response must never start a child stream or transcript read.
  child.session = { ...child.session, id: "ses_wrong" }
  const priorReads = requests().length
  await trigger.click()
  await expect(dialog.getByRole("alert")).toContainText("invalid identity or directory")
  expect(requests().length).toBe(priorReads + 1)
  expect(childStreams()).toHaveLength(0)
  await page.keyboard.press("Escape")
  await expect(dialog).toHaveCount(0)
  child.session.id = childID

  // Closing aborts metadata and full-history fetches as well as event observers.
  for (const hold of ["metadata", "messages"]) {
    child.hold = hold
    const closed = child.closed
    await trigger.click()
    await expect.poll(() => child.replies.length).toBeGreaterThan(0)
    await expect(dialog).toContainText(hold === "metadata" ? "Loading subagent…" : "Loading transcript…")
    await page.keyboard.press("Escape")
    await expect(dialog).toHaveCount(0)
    await expect.poll(() => child.closed).toBeGreaterThan(closed)
    await expect.poll(() => childStreams().length).toBe(0)
    child.replies.splice(0).forEach(reply => reply())
  }
  expect(await saved()).toEqual(before)
  expect(fixture.calls.filter(call => !["GET", "HEAD", "OPTIONS"].includes(call.method))).toEqual([])
  expect(fixture.unexpected).toEqual([])
  expect(errors).toEqual([])
  console.log("PASS subagent modal: trusted identity, directory, on-demand reads, loading/error/retry/empty, keyboard/focus, LTR/RTL, draft/settings/scroll, cancellation, stream cleanup, zero mutations")
} finally {
  await app?.close()
  await browser?.close()
  await preview.close()
  if (profile) await rm(profile, { recursive: true, force: true })
}
