import { createRequire } from "node:module"
import { startPanelPreview } from "./composer-panel-preview.mjs"
import { directory } from "./composer-fixture.mjs"

// Composer safety behaviours that only the retired four-mode tests (composer.browser.mjs, composer-panel.browser.mjs)
// covered, on today's composer (Steer primary, Queue and Aside in More send options; DD #443):
// - Aside cancellation: Escape never aborts the session; an unconfirmed cancel says so; a cancel with no active Aside
//   says none remains.
// - A queued input promoted while its cancel was in flight: the cancel is reported as not applied.
// - A question's answer field keeps focus across status changes; its Ctrl+Enter and Cmd+M send nothing.
// - Session actions keep the draft: Stop (one abort while pending), Archive, a failed Delete; Fork posts {} and opens
//   the fork; an accepted Delete goes home.
const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const preview = await startPanelPreview()
const fixture = preview.fixture
const browser = await chromium.launch({ headless: true,
  ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : { channel: "chrome" }) })
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
await context.route("**/*", (route) => new URL(route.request().url()).origin === preview.origin ? route.continue() : route.abort())
const page = await context.newPage()
const errors = []
page.on("pageerror", (error) => errors.push(error.message))
const active = () => page.locator(".prompt-box")
const editor = () => active().getByRole("textbox", { name: "Message", exact: true })
const button = (name) => active().getByRole("button", { name, exact: true })
const more = () => active().getByRole("button", { name: "More send options", exact: true })
const secondary = async (name) => {
  if ((await more().getAttribute("aria-expanded")) !== "true") await more().click()
  return button(name)
}
const mutations = () => fixture.calls.filter((call) => call.method !== "GET")
const aborts = () => mutations().filter((call) => call.path.endsWith("/abort"))
try {
  await page.goto(preview.url, { waitUntil: "domcontentloaded", timeout: 180_000 })
  await expect(editor()).toBeVisible()
  fixture.setStatus("busy")
  await expect(more()).toHaveCount(1)

  // Aside cancellation.
  await editor().fill("aside question")
  fixture.holdAside = true
  await (await secondary("Ask aside")).click()
  const cancelAside = page.getByRole("button", { name: "Cancel aside", exact: true })
  await expect(cancelAside).toBeVisible()
  await editor().focus()
  await page.keyboard.press("Escape")
  await page.keyboard.press("Escape")
  await page.keyboard.press("Escape")
  expect(aborts()).toHaveLength(0)
  fixture.failCancel = true
  await cancelAside.click()
  await expect(page.locator(".aside-result")).toContainText("cancellation not confirmed")
  fixture.failCancel = false
  await cancelAside.click()
  await expect(page.locator(".aside-result")).toContainText("cancelled")
  fixture.holdAside = false
  fixture.asideReplies.shift()()
  await page.getByRole("button", { name: "Close aside", exact: true }).click()
  fixture.holdAside = true
  await (await secondary("Ask aside")).click()
  fixture.noActiveAside = true
  await page.getByRole("button", { name: "Cancel aside", exact: true }).click()
  await expect(page.locator(".aside-result")).toContainText("No active Aside remains")
  await page.getByRole("button", { name: "Close aside", exact: true }).click()
  fixture.noActiveAside = false
  fixture.holdAside = false
  fixture.asideReplies.shift()()
  expect(aborts()).toHaveLength(0)

  // A queued input promoted while its cancel was in flight.
  await editor().fill("queued then promoted")
  await (await secondary("Queue for when idle")).click()
  const cancelQueue = page.getByRole("button", { name: /^Cancel queue input: / })
  await expect(cancelQueue).toBeVisible()
  fixture.promoteOnCancel = true
  await cancelQueue.click()
  await expect(page.getByRole("button", { name: /^Cancel queue input: / })).toHaveCount(0)
  await expect(page.locator("body")).toContainText("cancellation was not applied")
  fixture.promoteOnCancel = false

  // A question's answer field: focus kept across status changes; composer shortcuts there send nothing.
  fixture.questions = [{ id: "question-1", sessionID: "ses_a", questions: [{ header: "Decision", question: "Which step should continue?",
    options: [{ label: "Continue", description: "Continue later" }], custom: true }] }]
  await page.reload({ waitUntil: "domcontentloaded" })
  const answer = page.getByRole("textbox", { name: "Decision note", exact: true })
  await answer.fill("Human answer in progress")
  const before = mutations().length
  fixture.setStatus("idle")
  await expect(answer).toBeFocused()
  fixture.setStatus("busy")
  await expect(answer).toBeFocused()
  // The question card's own Ctrl+Enter may submit the answer; the composer must not send or open its menu from here.
  await answer.press("Control+Enter")
  await answer.press("Meta+m")
  await expect(more()).toHaveAttribute("aria-expanded", "false")
  await expect(answer).toBeFocused()
  expect(mutations().slice(before).filter((call) => !/question/.test(call.path))).toEqual([])
  fixture.questions = []
  await page.reload({ waitUntil: "domcontentloaded" })

  // Session actions keep the draft.
  await editor().fill("Draft survives session actions")
  fixture.holdAction = true
  const stop = active().getByRole("button", { name: "Stop session", exact: true })
  await stop.click()
  await expect(stop).toBeDisabled()
  expect(aborts()).toHaveLength(1)
  fixture.holdAction = false
  fixture.actionReplies.shift()()
  await expect(editor()).toHaveValue("Draft survives session actions")
  fixture.setStatus("idle")
  await button("Archive").click()
  await expect(active().getByText("Archived", { exact: true })).toBeVisible()
  expect(mutations().find((call) => call.method === "PATCH").body.time.archived).toBeGreaterThan(0)
  await expect(editor()).toHaveValue("Draft survives session actions")
  fixture.failAction = "delete"
  page.once("dialog", (dialog) => dialog.accept())
  await button("Delete").click()
  await expect(page.locator(".session-alerts")).toContainText("delete failed")
  await expect(editor()).toHaveValue("Draft survives session actions")
  fixture.failAction = ""
  await button("Fork").click()
  await expect(page).toHaveURL(/\/session\/ses_b\?/)
  expect(mutations().find((call) => call.path.endsWith("/fork")).body).toEqual({})
  await page.goto(preview.url)
  await expect(editor()).toHaveValue("Draft survives session actions")
  page.once("dialog", (dialog) => dialog.accept())
  await button("Delete").click()
  await expect(page).toHaveURL(`${preview.origin}/`)
  expect(fixture.deleted.has("ses_a")).toBe(true)
  expect(mutations().every((call) => !call.directory || call.directory === directory)).toBe(true)
  expect(fixture.unexpected).toEqual([])
  expect(errors).toEqual([])
  console.log("PASS composer safety: Aside cancel (Escape never aborts, unconfirmed, none active), queued cancel overtaken by promotion, question field keeps focus and sends nothing, Stop/Archive/failed Delete keep the draft, Fork {}, Delete goes home")
} finally {
  await browser.close()
  await preview.close()
}
