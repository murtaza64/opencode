// Historical four-mode UI coverage. Chosen direct-action UI runs composer-direct.browser.mjs.
import { createRequire } from "node:module"
import { mkdir } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { startPanelPreview } from "./composer-panel-preview.mjs"
import { directory } from "./composer-fixture.mjs"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const preview = await startPanelPreview()
const fixture = preview.fixture
const browser = await chromium.launch({ headless: true, channel: "chrome" })
const artifacts = fileURLToPath(new URL("../artifacts/composer-panel/", import.meta.url))
await mkdir(artifacts, { recursive: true })
const errors = []
const external = []
const active = (page) => page.locator(".float-editor").or(page.locator(".prompt-box:not([inert])"))
const editor = (page) => active(page).locator("textarea")
const footer = (page) => active(page).locator(".composer-controls")
const actions = (page) => footer(page).getByRole("group", { name: "Session actions", exact: true })
const mutations = () => fixture.calls.filter((call) => call.method !== "GET")
const posts = () => mutations().filter((call) => call.path.endsWith("/input"))
const open = async (options) => {
  const context = await browser.newContext(options)
  await context.route("**/*", (route) => {
    const url = new URL(route.request().url())
    if (url.origin === preview.origin || ["data:", "blob:"].includes(url.protocol)) return route.continue()
    external.push(url.origin)
    return route.abort()
  })
  const page = await context.newPage()
  page.on("pageerror", (error) => errors.push(error.message))
  await page.goto(preview.url, { waitUntil: "domcontentloaded" })
  await expect(footer(page).getByLabel("Queue agent", { exact: true })).toBeEnabled()
  return page
}
const reachable = async (locator) => {
  await locator.scrollIntoViewIfNeeded()
  expect(
    await locator.evaluate((el) => {
      const rect = el.getBoundingClientRect()
      const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)
      return rect.top >= 0 && rect.bottom <= innerHeight && (hit === el || el.contains(hit))
    }),
  ).toBe(true)
}
const checkPanel = async (page, maxHeight) => {
  await expect(page.locator(".topbar button")).toHaveCount(0)
  await expect(footer(page).getByText("Alt+M", { exact: true })).toBeVisible()
  await expect(footer(page).locator(".composer-send kbd")).toContainText("⌘/Ctrl↵")
  for (const name of ["Fork", "Archive", "Delete", "Stop session", "Nudge"]) {
    await reachable(actions(page).getByRole("button", { name, exact: true }))
  }
  const input = await editor(page).boundingBox()
  const panel = await footer(page).boundingBox()
  expect(panel.y).toBeGreaterThanOrEqual(input.y + input.height - 1)
  expect(panel.height).toBeLessThanOrEqual(maxHeight)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
}
try {
  console.log("panel: desktop editor and selection")
  const page = await open({ viewport: { width: 1440, height: 1000 } })
  await expect(editor(page)).toBeFocused()
  await page.keyboard.type("start typing")
  await expect(editor(page)).toHaveValue("start typing")
  await editor(page).press("Escape")
  await editor(page).press("0")
  await editor(page).press("l")
  expect(await editor(page).evaluate((el) => el.selectionStart)).toBe(1)
  await editor(page).press("i")
  await page.keyboard.type("X")
  await expect(editor(page)).toHaveValue("sXtart typing")
  await editor(page).fill("Keep this draft and its selection.")
  await checkPanel(page, 84)
  await page.screenshot({ path: `${artifacts}/desktop.png`, fullPage: true })
  await active(page).screenshot({ path: `${artifacts}/panel.png` })
  await editor(page).evaluate((el) => el.setSelectionRange(5, 15))
  page.once("dialog", (dialog) => dialog.dismiss())
  await actions(page).getByRole("button", { name: "Delete", exact: true }).click()
  expect(mutations()).toEqual([])
  expect(await editor(page).evaluate((el) => [el.selectionStart, el.selectionEnd])).toEqual([5, 15])
  await expect(editor(page)).toHaveValue("Keep this draft and its selection.")
  await footer(page).getByRole("radio", { name: "Aside", exact: true }).click()
  await editor(page).fill("Separate question")
  await footer(page).getByRole("radio", { name: "Queue", exact: true }).click()
  await expect(editor(page)).toHaveValue("Keep this draft and its selection.")
  await expect.poll(() => editor(page).evaluate((el) => [el.selectionStart, el.selectionEnd])).toEqual([5, 15])
  await footer(page).getByRole("radio", { name: "Queue", exact: true }).focus()
  await page.keyboard.press("ArrowLeft")
  await expect(footer(page).getByRole("radio", { name: "Aside", exact: true })).toBeFocused()
  await page.keyboard.press("ArrowRight")
  await expect(footer(page).getByRole("radio", { name: "Queue", exact: true })).toBeFocused()
  await expect.poll(() => editor(page).evaluate((el) => [el.selectionStart, el.selectionEnd])).toEqual([5, 15])

  await editor(page).press("Control+e")
  await checkPanel(page, 104)
  await expect(page.locator(".relative-lines")).toBeVisible()
  await expect(editor(page)).toBeFocused()
  await editor(page).fill("Expanded typing")
  await page.keyboard.type(" works")
  await expect(editor(page)).toHaveValue("Expanded typing works")
  await editor(page).press("Escape")
  await editor(page).press("0")
  await editor(page).press("l")
  expect(await editor(page).evaluate((el) => el.selectionStart)).toBe(1)
  await page.screenshot({ path: `${artifacts}/floating-desktop.png`, fullPage: true })
  await editor(page).press("Alt+m")
  await expect(footer(page).getByRole("radio", { name: "Steer", exact: true })).toHaveAttribute("aria-checked", "true")
  await expect(editor(page)).toBeFocused()
  await expect(editor(page)).toHaveClass(/vim-normal/)
  page.once("dialog", (dialog) => dialog.dismiss())
  await actions(page).getByRole("button", { name: "Delete", exact: true }).click()
  expect(mutations()).toEqual([])
  await page.getByRole("button", { name: /collapse/ }).click()
  await expect(editor(page)).toHaveClass(/vim-normal/)

  const mobile = await open({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
  console.log("panel: mobile and RTL")
  await editor(mobile).fill("Touch-sized controls; no overflow.")
  await checkPanel(mobile, 164)
  expect(
    await footer(mobile)
      .getByRole("radio", { name: "Aside", exact: true })
      .evaluate((el) => el.getBoundingClientRect().height),
  ).toBeGreaterThanOrEqual(44)
  await mobile.screenshot({ path: `${artifacts}/mobile.png`, fullPage: true })
  await footer(mobile).getByRole("button", { name: "Expand editor", exact: true }).tap()
  await checkPanel(mobile, 180)
  await mobile.screenshot({ path: `${artifacts}/floating-mobile.png`, fullPage: true })
  await mobile.getByRole("button", { name: /collapse/ }).tap()
  await mobile.keyboard.press("Control+h")
  await mobile.keyboard.press("Control+l")
  await mobile.evaluate(() => {
    document.documentElement.dir = "rtl"
  })
  await editor(mobile).fill("\u0645\u0631\u062d\u0628\u0627 README.md 123")
  await checkPanel(mobile, 164)
  await footer(mobile).getByRole("radio", { name: "Queue", exact: true }).focus()
  await mobile.keyboard.press("ArrowRight")
  await expect(footer(mobile).getByRole("radio", { name: "Aside", exact: true })).toBeFocused()
  await mobile.screenshot({ path: `${artifacts}/mobile-rtl.png`, fullPage: true })
  await mobile.context().close()

  fixture.permissions = [
    { id: "permission-1", sessionID: "ses_a", permission: "bash", patterns: ["fixture command"], metadata: {} },
  ]
  console.log("panel: gates and shortcuts")
  fixture.questions = [
    {
      id: "question-1",
      sessionID: "ses_a",
      questions: [
        {
          header: "Decision",
          question: "Which step should continue?",
          options: [{ label: "Continue", description: "Continue later" }],
          custom: true,
        },
      ],
    },
  ]
  await page.reload()
  const answer = page.locator(".banner.question input")
  await answer.fill("Human answer in progress")
  fixture.setStatus("idle")
  await expect(answer).toBeFocused()
  fixture.setStatus("busy")
  await expect(answer).toBeFocused()
  await answer.press("Control+Enter")
  await answer.press("Alt+m")
  await expect(answer).toBeFocused()
  expect(mutations()).toEqual([])
  await expect(footer(page).getByRole("radio", { name: "Steer", exact: true })).toHaveAttribute("aria-checked", "true")
  await actions(page).getByRole("button", { name: "Fork", exact: true }).focus()
  await page.keyboard.press("Escape")
  await page.keyboard.press("Escape")
  expect(mutations()).toEqual([])

  await footer(page).getByRole("radio", { name: "Queue", exact: true }).click()
  await editor(page).fill("Control shortcut")
  await expect(footer(page).locator(".composer-send kbd")).not.toContainText("Enter ·")
  await editor(page).press("Control+Enter")
  await expect.poll(() => posts().length).toBe(1)
  await expect(editor(page)).toHaveValue("")
  await editor(page).fill("Command shortcut")
  await editor(page).press("Meta+Enter")
  await expect.poll(() => posts().length).toBe(2)
  await expect(editor(page)).toHaveValue("")
  await editor(page).fill("Normal Enter shortcut")
  await editor(page).press("Escape")
  await expect(footer(page).locator(".composer-send kbd")).toContainText("Enter ·")
  await editor(page).press("Enter")
  await expect.poll(() => posts().length).toBe(3)
  expect(posts().map((call) => call.body.text)).toEqual([
    "Control shortcut",
    "Command shortcut",
    "Normal Enter shortcut",
  ])
  await expect(editor(page)).toHaveValue("")
  await expect(page.locator(".input-receipts summary")).toHaveText("Task inputs (3 queued, 0 steer)")
  await footer(page).getByRole("radio", { name: "Steer", exact: true }).click()
  await editor(page).fill("One steer")
  await editor(page).press("Control+Enter")
  await expect(page.locator(".input-receipts summary")).toHaveText("Task inputs (3 queued, 1 steer)")
  for (const receipt of fixture.receipts.filter((item) => item.delivery === "queue"))
    Object.assign(receipt, { state: "promoted", messageID: `msg_${receipt.requestID}`, timePromoted: Date.now() })
  fixture.emit("session.input.updated", { sessionID: "ses_a" })
  await expect(page.locator(".input-receipts summary")).toHaveText("Task inputs (0 queued, 1 steer)")
  await page.reload({ waitUntil: "domcontentloaded" })
  await expect(page.locator(".input-receipts summary")).toHaveText("Task inputs (0 queued, 1 steer)")
  await page
    .locator(".input-receipts")
    .getByRole("button", { name: /Cancel steer input/ })
    .click()
  await expect(page.locator(".input-receipts")).toHaveCount(0)

  await editor(page).fill("Normal click send")
  fixture.setStatus("idle")
  console.log("panel: retained mode and normal sending")
  await expect(footer(page).getByRole("radio", { name: "Steer", exact: true })).toHaveAttribute("aria-checked", "true")
  await expect(footer(page).getByRole("button", { name: "Steer task", exact: true })).toBeVisible()
  await expect(footer(page).getByRole("button", { name: "Use normal Send", exact: true })).toHaveText(
    "Switch to normal Send",
  )
  await active(page).screenshot({ path: `${artifacts}/idle-retained-steer.png` })
  await footer(page).getByRole("button", { name: "Use normal Send", exact: true }).click()
  await expect(footer(page).locator(".composer-normal-mode")).toHaveText("Normal Send")
  await expect(editor(page)).toHaveValue("Normal click send")
  fixture.holdNormal = true
  const normalPosts = () => mutations().filter((call) => call.path.endsWith("/prompt_async"))
  await footer(page).getByRole("button", { name: "Send", exact: true }).click()
  await expect(page.getByRole("region", { name: "Normal Send status" })).toContainText("Sending…")
  await expect(actions(page).getByRole("button", { name: "Nudge", exact: true })).toBeDisabled()
  await expect(page.getByRole("region", { name: "Normal Send status" })).toContainText("Normal click send")
  await expect(page.locator(".transcript")).not.toContainText("Normal click send")
  await editor(page).press("Control+Enter")
  expect(normalPosts()).toHaveLength(1)
  await editor(page).fill("Newer normal draft")
  fixture.setStatus("busy")
  fixture.holdNormal = false
  fixture.normalReplies.shift()()
  await expect(page.getByRole("region", { name: "Normal Send status" })).toContainText("Accepted by server")
  await expect(editor(page)).toHaveValue("Newer normal draft")
  await expect(footer(page).locator(".composer-normal-mode")).toHaveText("Normal Send")
  await expect(footer(page).getByRole("button", { name: "Send", exact: true })).toBeDisabled()
  await expect(footer(page)).toContainText("Normal Send is unavailable")
  await active(page).screenshot({ path: `${artifacts}/explicit-normal-busy.png` })
  await page.reload({ waitUntil: "domcontentloaded" })
  await expect(footer(page).locator(".composer-normal-mode")).toHaveText("Normal Send")
  await expect(footer(page).getByRole("button", { name: "Send", exact: true })).toBeDisabled()
  fixture.setStatus("idle")
  await expect(footer(page).getByRole("button", { name: "Send", exact: true })).toBeEnabled()
  await editor(page).press("Control+e")
  await expect(footer(page).locator(".composer-normal-mode")).toHaveText("Normal Send")
  await editor(page).press("Control+Enter")
  await expect.poll(() => normalPosts().length).toBe(2)
  await expect(page.getByRole("region", { name: "Normal Send status" })).toContainText("Accepted by server")
  await expect(page.locator(".float-editor")).toHaveCount(0)
  await editor(page).fill("Unknown normal outcome")
  fixture.loseNormal = true
  await footer(page).getByRole("button", { name: "Send", exact: true }).click()
  await expect(page.getByRole("region", { name: "Normal Send status" })).toContainText("Outcome unknown")
  await page.reload({ waitUntil: "domcontentloaded" })
  await expect(page.getByRole("region", { name: "Normal Send status" })).toContainText("Outcome unknown")
  await expect(page.locator(".input-receipts")).toHaveCount(0)
  expect(normalPosts()).toHaveLength(3)
  await page.getByRole("button", { name: "Dismiss send status", exact: true }).click()
  fixture.setStatus("busy")
  await editor(page).fill("Draft survives session actions")

  fixture.holdAction = true
  console.log("panel: session actions")
  await actions(page).getByRole("button", { name: "Stop session", exact: true }).click()
  await expect(actions(page).getByRole("button", { name: "Stop session", exact: true })).toBeDisabled()
  await expect(actions(page).getByRole("button", { name: "Nudge", exact: true })).toBeDisabled()
  expect(mutations().filter((call) => call.path.endsWith("/abort"))).toHaveLength(1)
  fixture.holdAction = false
  fixture.actionReplies.shift()()
  await expect(actions(page).getByRole("button", { name: "↓ Bottom", exact: true })).toBeVisible()
  await expect(editor(page)).toHaveValue("Draft survives session actions")

  console.log("panel: bottom-slot Nudge barrier and draft preservation")
  await footer(page).getByLabel("Model override", { exact: true }).selectOption("fixture\u0000test")
  await editor(page).evaluate((el) => {
    const data = new DataTransfer()
    data.items.add(new File([new Uint8Array([1, 2, 3])], "nudge-draft.png", { type: "image/png" }))
    el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true }))
  })
  await expect(active(page).getByRole("button", { name: "Remove nudge-draft.png", exact: true })).toBeVisible()
  await footer(page).getByRole("button", { name: "Choose message delivery", exact: true }).click()
  await footer(page).getByRole("radio", { name: "Aside", exact: true }).click()
  await editor(page).fill("Aside survives Nudge")
  await editor(page).press("Control+e")
  fixture.holdAction = true
  fixture.holdNormal = true
  const beforeNudge = mutations().length
  await actions(page).getByRole("button", { name: "Nudge", exact: true }).click()
  await expect(actions(page).getByRole("button", { name: "Stopping…", exact: true })).toBeDisabled()
  await expect(footer(page).getByRole("button", { name: "Ask aside", exact: true })).toBeDisabled()
  await editor(page).press("Control+Enter")
  expect(mutations().slice(beforeNudge).map((call) => call.path)).toEqual(["/session/ses_a/abort"])
  fixture.setStatus("busy")
  await expect(actions(page).getByRole("button", { name: "Stop session", exact: true })).toBeDisabled()
  await expect(actions(page).getByRole("button", { name: "Fork", exact: true })).toBeDisabled()
  await expect(actions(page).getByRole("button", { name: "Archive", exact: true })).toBeDisabled()
  await expect(actions(page).getByRole("button", { name: "Delete", exact: true })).toBeDisabled()
  fixture.holdAction = false
  fixture.actionReplies.shift()()
  await expect(actions(page).getByRole("button", { name: "Sending resume…", exact: true })).toBeDisabled()
  await editor(page).press("Control+Enter")
  expect(mutations().slice(beforeNudge).map((call) => call.path)).toEqual([
    "/session/ses_a/abort",
    "/session/ses_a/prompt_async",
  ])
  expect(normalPosts().at(-1).body.model).toEqual({ providerID: "fixture", modelID: "test" })
  expect(normalPosts().at(-1).body.parts).toEqual([
    { type: "text", text: "Resume where you left off. Reorient briefly and continue the outstanding work." },
  ])
  fixture.holdNormal = false
  fixture.normalReplies.shift()()
  await expect(actions(page).getByRole("button", { name: "Nudge", exact: true })).toBeEnabled()
  await expect(editor(page)).toHaveValue("Aside survives Nudge")
  await footer(page).getByRole("radio", { name: "Queue", exact: true }).click()
  await expect(editor(page)).toHaveValue("Draft survives session actions")
  await expect(active(page).getByRole("button", { name: "Remove nudge-draft.png", exact: true })).toBeVisible()
  await expect(footer(page).getByLabel("Model override", { exact: true })).toHaveValue("fixture\u0000test")
  await page.getByRole("button", { name: /collapse/ }).click()
  fixture.failAction = "abort"
  const beforeFailure = mutations().length
  await actions(page).getByRole("button", { name: "Nudge", exact: true }).click()
  await expect(page.locator(".session-alerts")).toContainText("Could not interrupt session")
  expect(mutations().slice(beforeFailure).map((call) => call.path)).toEqual(["/session/ses_a/abort"])
  fixture.failAction = ""

  await actions(page).getByRole("button", { name: "Archive", exact: true }).click()
  await expect(actions(page).getByText("Archived", { exact: true })).toBeVisible()
  expect(mutations().find((call) => call.method === "PATCH").body.time.archived).toBeGreaterThan(0)
  await expect(editor(page)).toHaveValue("Draft survives session actions")

  fixture.failAction = "delete"
  page.once("dialog", (dialog) => dialog.accept())
  await actions(page).getByRole("button", { name: "Delete", exact: true }).click()
  await expect(page.locator(".session-alerts")).toContainText("delete failed")
  await expect(editor(page)).toHaveValue("Draft survives session actions")
  fixture.failAction = ""
  await actions(page).getByRole("button", { name: "Fork", exact: true }).click()
  await expect(page).toHaveURL(/\/session\/ses_b\?/)
  expect(mutations().find((call) => call.path.endsWith("/fork")).body).toEqual({})
  await page.goto(preview.url)
  await expect(editor(page)).toHaveValue("Draft survives session actions")
  page.once("dialog", (dialog) => dialog.accept())
  await actions(page).getByRole("button", { name: "Delete", exact: true }).click()
  await expect(page).toHaveURL(`${preview.origin}/`)
  expect(fixture.deleted.has("ses_a")).toBe(true)
  expect(mutations().every((call) => call.directory === directory)).toBe(true)
  expect(mutations().some((call) => /permission|question/.test(call.path))).toBe(false)
  expect(fixture.unexpected).toEqual([])
  expect(errors).toEqual([])
  expect(external).toEqual([])
  console.log(
    "PASS panel: visible shortcuts, footer grouping, touch/RTL, inline/floating, gates/selection, native delete confirmation, fork/archive/stop semantics, Nudge barrier/guards/draft preservation",
  )
} catch (error) {
  console.error(error)
  throw error
} finally {
  await preview.close()
  await browser.close()
}
