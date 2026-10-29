import { createRequire } from "node:module"
import { startPanelPreview } from "./composer-panel-preview.mjs"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const preview = await startPanelPreview()
const assistant = preview.fixture.messages[1]
const initial = [
  { content: "Read the transcript renderer", status: "completed", priority: "high" },
  { content: "Render the todo checklist", status: "in_progress", priority: "high" },
  { content: "Profile idle CPU", status: "pending", priority: "medium" },
  { content: "Drop the old poller", status: "cancelled", priority: "low" },
]
assistant.parts.push({
  id: "part_todo",
  messageID: assistant.info.id,
  sessionID: "ses_a",
  type: "tool",
  tool: "todowrite",
  callID: "call-todo",
  state: { status: "completed", input: { todos: initial }, metadata: { todos: initial }, output: "", title: "3 todos", time: { start: 2, end: 3 } },
})
preview.fixture.todos = new Map([["ses_a", initial]])

const browser = await chromium.launch({ channel: "chrome", headless: true })
const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } })
const page = await context.newPage()
await context.route("**/*", (route) => new URL(route.request().url()).origin === preview.origin ? route.continue() : route.abort())
const errors = []
page.on("pageerror", (error) => errors.push(error.message))

try {
  await page.goto(preview.url, { waitUntil: "commit" })
  const inline = page.locator('.transcript .todo-activity[data-tool="todowrite"]')
  await expect(inline).toHaveCount(1, { timeout: 30_000 })
  await expect(inline.locator("summary")).toContainText("1/4")
  await expect(inline.locator("summary")).toContainText("Render the todo checklist")
  await expect(inline.locator(".todo-list")).toHaveCount(0)
  // Icon-first line (dotfiles#262): the checklist icon is the row's Filament anchor; progress reads in words.
  await expect(inline.locator(".tool-run-icon")).toHaveAttribute("data-filament-icon", "part_todo")
  await expect(inline.locator(".tool-run-icon")).toHaveAttribute("data-status", "unfinished")
  await expect(inline.locator(".todo-current")).toHaveText("in progress: Render the todo checklist")
  await expect(inline.locator("summary")).toHaveAccessibleName("Todos 1 of 4 done, in progress: Render the todo checklist")
  // No box at rest.
  expect(await inline.evaluate((el) => [getComputedStyle(el).borderTopWidth, getComputedStyle(el).backgroundColor])).toEqual(["0px", "rgba(0, 0, 0, 0)"])
  if (process.env.SCREENSHOT_DIR) await inline.screenshot({ path: `${process.env.SCREENSHOT_DIR}/todo-row.png` })
  // Keyboard: Enter opens the checklist; Escape closes it and returns focus to the row.
  await inline.locator("summary").focus()
  await page.keyboard.press("Enter")
  await expect(inline.locator(".todo-list li")).toHaveCount(4)
  if (process.env.SCREENSHOT_DIR) await inline.screenshot({ path: `${process.env.SCREENSHOT_DIR}/todo-row-open.png` })
  await page.keyboard.press("Escape")
  await expect(inline.locator(".todo-list")).toHaveCount(0)
  await expect(inline.locator("summary")).toBeFocused()
  await page.evaluate(() => { document.documentElement.dir = "rtl" })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  if (process.env.SCREENSHOT_DIR) await inline.screenshot({ path: `${process.env.SCREENSHOT_DIR}/todo-row-rtl.png` })
  await page.evaluate(() => { document.documentElement.dir = "ltr" })
  await inline.locator("summary").click()
  await expect(inline.locator(".todo-list li")).toHaveCount(4)

  const panel = page.getByRole("region", { name: "Todos" })
  await expect(panel).toBeVisible()
  await expect(panel.locator(".todo-count")).toHaveText("1/4")
  await expect(panel.locator('li[data-status="in_progress"]')).toContainText("Render the todo checklist")
  await expect(panel.locator('li[data-status="in_progress"] .todo-glyph')).toHaveText("[•]")
  await expect(panel.locator('li[data-status="completed"] .todo-glyph')).toHaveText("[✓]")
  await expect(panel.locator('li[data-status="cancelled"] .todo-glyph')).toHaveText("[-]")

  await panel.getByRole("button", { expanded: true }).click()
  await expect(panel.locator(".todo-list")).toHaveCount(0)
  await expect(panel.locator(".todo-panel-active")).toHaveText("Render the todo checklist")
  await panel.getByRole("button", { expanded: false }).click()

  // Live: todo.updated replaces the list without refetching.
  const requests = []
  page.on("request", (request) => { if (request.url().includes("/todo")) requests.push(request.url()) })
  preview.fixture.emit("todo.updated", {
    sessionID: "ses_a",
    todos: initial.map((todo) => todo.status === "in_progress" ? { ...todo, status: "completed" } : todo.status === "pending" ? { ...todo, status: "in_progress" } : todo),
  })
  await expect(panel.locator(".todo-count")).toHaveText("2/4")
  await expect(panel.locator('li[data-status="in_progress"]')).toContainText("Profile idle CPU")
  // Other sessions' updates are ignored.
  preview.fixture.emit("todo.updated", { sessionID: "ses_b", todos: [] })
  preview.fixture.emit("todo.updated", { sessionID: "ses_a", todos: initial.map((todo) => ({ ...todo, status: "completed" })) })
  await expect(panel).toHaveCount(0)
  expect(requests).toEqual([])

  expect(errors).toEqual([])
  expect(preview.fixture.unexpected).toEqual([])
  console.log("PASS todos: inline icon-first row (anchor, words, no box, Enter/Escape focus, RTL), sticky panel glyphs/counts, collapse, live todo.updated, closes when done")
} finally {
  await browser.close()
  await preview.close()
}
