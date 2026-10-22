import { createRequire } from "node:module"
import { startActivityPreview } from "./composer-activity-preview.mjs"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const preview = await startActivityPreview()
const fixture = preview.fixture
const browser = await chromium.launch({ channel: "chrome", headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
await page.context().route("**/*", route => new URL(route.request().url()).origin === preview.origin ? route.continue() : route.abort())
const errors = []
page.on("pageerror", error => errors.push(error.message))
const receipts = page.locator(".input-receipts")
const sidebar = page.locator(".session-info:not(.sidebar-mini)")
const todos = sidebar.getByRole("region", { name: "Todos", exact: true })
const writes = () => fixture.calls.filter(call => !["GET", "HEAD", "OPTIONS"].includes(call.method))
try {
  await page.goto(`${preview.url}/agents`)
  await expect(receipts.locator("li[data-request-id]")).toHaveCount(2)
  await expect(receipts.locator("summary")).toContainText("1 queued, 1 steer")
  await expect(receipts.locator('[data-request-id="human-queue"] img')).toHaveAttribute("src", fixture.receipts[0].images[0].url)
  await expect(receipts).toContainText("Human draft mentions editspace-mail")
  await expect(receipts).not.toContainText("Peer")
  await expect(page.getByRole("button", { name: /Cancel .*Peer/ })).toHaveCount(0)
  const peer = page.locator('.transcript [data-mail-id="peer-mail"]')
  await expect(peer.locator("summary")).toContainText("Inbound")
  await expect(peer.locator("summary")).toContainText("reviewer")
  await peer.locator("summary").click()
  await expect(peer).toContainText("Peer queued notice")
  await expect(peer).toContainText("queue · pending")
  expect(writes()).toEqual([])

  // The current checklist has one sidebar owner, independent of composer expansion.
  await expect(todos).toBeVisible()
  await expect(page.locator(".todo-panel")).toHaveCount(1)
  await expect(page.locator(".session-main .todo-panel, .float-editor .todo-panel")).toHaveCount(0)
  await expect(todos.locator("li")).toHaveCount(2)
  const head = todos.getByRole("button")
  await head.focus()
  await head.press("Enter")
  await expect(head).toHaveAttribute("aria-expanded", "false")
  await expect(todos.locator(".todo-list")).toHaveCount(0)
  fixture.emit("todo.updated", { sessionID: "ses_a", todos: [
    { content: "Review src/session.ts — مراجعة", status: "completed", priority: "high" },
    { content: "Updated while collapsed", status: "in_progress", priority: "medium" },
  ] })
  await expect(head).toContainText("1/2")
  await expect(head).toContainText("Updated while collapsed")
  await head.press("Space")
  await expect(todos.locator('li[data-status="in_progress"]')).toHaveText("[•]Updated while collapsed")
  await page.getByRole("button", { name: "Expand editor", exact: true }).click()
  await expect(page.locator(".float-editor .input-receipts li[data-request-id]")).toHaveCount(2)
  await expect(page.locator(".float-editor .input-receipts")).not.toContainText("Peer")
  await expect(page.locator(".todo-panel")).toHaveCount(1)
  await expect(page.locator(".float-editor .todo-panel")).toHaveCount(0)
  await page.locator(".float-head button").click()

  for (const [lang, dir] of [["en", "ltr"], ["en", "rtl"], ["ar", "rtl"]]) {
    await page.evaluate(({ lang, dir }) => { document.documentElement.lang = lang; document.documentElement.dir = dir }, { lang, dir })
    await sidebar.evaluate(element => { element.scrollTop = 0 })
    await expect(todos).toBeVisible()
    const geometry = await page.evaluate(() => {
      const side = document.querySelector(".session-info:not(.sidebar-mini)")
      const main = document.querySelector(".session-main")
      const panel = document.querySelector(".todo-panel")
      const disclosure = panel.querySelector(".activity-disclosure").getBoundingClientRect()
      const label = panel.querySelector(".activity-kind").getBoundingClientRect()
      return { side: side.getBoundingClientRect().toJSON(), main: main.getBoundingClientRect().toJSON(),
        border: getComputedStyle(side).borderInlineStartWidth, align: getComputedStyle(panel.querySelector("button")).textAlign,
        disclosure: disclosure.x, label: label.x }
    })
    expect(geometry.border).toBe("1px")
    expect(geometry.align).toBe("start")
    if (dir === "ltr") {
      expect(geometry.side.left).toBeGreaterThanOrEqual(geometry.main.right)
      expect(geometry.disclosure).toBeGreaterThan(geometry.label)
    } else {
      expect(geometry.side.right).toBeLessThanOrEqual(geometry.main.left)
      expect(geometry.disclosure).toBeLessThan(geometry.label)
    }
    fixture.emit("todo.updated", { sessionID: "ses_a", todos: [
      { content: `Live ${lang} ${dir} — تحديث`, status: "in_progress", priority: "high" },
    ] })
    await expect(todos.locator("li")).toHaveCount(1)
    await expect(todos.locator("li")).toHaveText(`[•]Live ${lang} ${dir} — تحديث`)
    await page.keyboard.press("Control+l")
    await expect(page.locator(".todo-panel")).toHaveCount(0)
    await page.keyboard.press("Control+l")
    await expect(page.locator(".todo-panel")).toHaveCount(1)
    await expect(todos.locator("li")).toHaveText(`[•]Live ${lang} ${dir} — تحديث`)
  }

  // Scroll the sidebar itself, including on mobile, without a second checklist scroller.
  const long = Array.from({ length: 24 }, (_, index) => ({ content: `Todo ${index} — مهمة /src/session.ts`, status: "pending", priority: "medium" }))
  fixture.emit("todo.updated", { sessionID: "ses_a", todos: long })
  await expect(todos.locator("li")).toHaveCount(24)
  for (const dir of ["ltr", "rtl"]) {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.evaluate(dir => { document.documentElement.dir = dir }, dir)
    await head.scrollIntoViewIfNeeded()
    await expect(head).toBeInViewport()
    await todos.locator("li").last().scrollIntoViewIfNeeded()
    await expect(todos.locator("li").last()).toBeInViewport()
    const scroll = await sidebar.evaluate(element => ({ top: element.scrollTop, height: element.clientHeight, total: element.scrollHeight,
      nested: getComputedStyle(element.querySelector(".todo-list")).overflowY,
      width: document.documentElement.clientWidth, totalWidth: document.documentElement.scrollWidth }))
    expect(scroll.top).toBeGreaterThan(0)
    expect(scroll.total).toBeGreaterThan(scroll.height)
    expect(scroll.nested).toBe("visible")
    expect(scroll.totalWidth).toBeLessThanOrEqual(scroll.width)
    await head.scrollIntoViewIfNeeded()
    await head.click()
    await expect(head).toHaveAttribute("aria-expanded", "false")
    await head.click()
    await expect(head).toHaveAttribute("aria-expanded", "true")
  }

  await page.setViewportSize({ width: 1440, height: 1000 })
  const editor = page.getByRole("textbox", { name: "Message", exact: true })
  await editor.fill("Keep this draft")
  await receipts.getByRole("button", { name: /Cancel steer input: Human steering/ }).click()
  await expect(receipts.locator("summary")).toContainText("1 queued, 0 steer")
  await expect(editor).toHaveValue("Keep this draft")
  await expect(receipts.locator('[data-request-id="human-queue"] img')).toHaveCount(1)
  await receipts.getByRole("button", { name: /Cancel queue input: Human draft/ }).click()
  await expect(receipts).toHaveCount(0)
  expect(fixture.receipts.filter(receipt => receipt.source?.type === "editspace-mail").map(receipt => receipt.state)).toEqual(["pending", "pending"])
  await expect(peer).toBeVisible()
  expect(writes().map(call => `${call.method} ${call.path}`)).toEqual([
    "DELETE /session/ses_a/input/human-steer", "DELETE /session/ses_a/input/human-queue",
  ])
  expect(errors).toEqual([])
  expect(fixture.unexpected).toEqual([])
  console.log("PASS composer activity: human text/image queue + explicit human steer only, peer mail stays labeled and pending, human-only cancellation, one live sidebar todo panel, collapse/keyboard, English LTR/RTL + Arabic RTL, mobile sidebar scroll/no overflow, fixture writes only")
} finally {
  await browser.close()
  await preview.close()
}
