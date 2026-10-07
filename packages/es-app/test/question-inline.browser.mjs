import { createRequire } from "node:module"
import { startPanelPreview } from "./composer-panel-preview.mjs"
import { directory, session } from "./composer-fixture.mjs"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const preview = await startPanelPreview()
const childDirectory = `${directory}/child`
const assistant = preview.fixture.messages[1]
const questions = [
  {
    header: "Architecture",
    question: "Choose the **smallest durable seam**.\n\nKeep the transcript renderer reusable.",
    options: [
      { label: "Renderer slot (Recommended)", description: "Add a narrow **question-only** slot." },
      { label: "Fork renderer", description: "Copy the whole message renderer." },
    ],
  },
  {
    header: "Coverage",
    question: "Which behavior needs explicit browser coverage?",
    options: [
      { label: "Keyboard", description: "Exercise recommendation fallback." },
      { label: "Subagents", description: "Exercise unmatched child requests." },
    ],
    multiple: true,
  },
  {
    header: "Ship mode",
    question: "How should this land?",
    options: [
      { label: "Park for review (Recommended)", description: "Leave a live walkthrough." },
      { label: "Land now", description: "Skip human review." },
    ],
  },
]
const tool = (id, callID, input, status, metadata = {}) => ({
  id,
  messageID: assistant.info.id,
  sessionID: "ses_a",
  type: "tool",
  tool: "question",
  callID,
  state: status === "completed"
    ? { status, input, metadata, output: "answered", title: id, time: { start: 2, end: 3 } }
    : { status, input, raw: "", title: id },
})
assistant.parts.push(
  tool("question-complete", "call-complete", { questions: [questions[0]] }, "completed", { answers: [["Renderer slot (Recommended)"]] }),
  tool("question-pending", "call-parent", { questions }, "pending"),
)
const parentRequest = {
  id: "question-parent",
  sessionID: "ses_a",
  questions,
  tool: { messageID: assistant.info.id, callID: "call-parent" },
}
const childRequest = {
  id: "question-child",
  sessionID: "ses_child",
  questions: [{
    header: "Child decision",
    question: "Should the subagent continue with the **focused check**?",
    options: [{ label: "Continue (Recommended)", description: "Finish the child investigation." }],
  }],
  tool: { messageID: "child-message", callID: "call-child" },
}
preview.fixture.workspaceSessions.push({ ...session("ses_child"), title: "Focused reviewer", directory: childDirectory, parentID: "ses_a" })
preview.fixture.questionsByDirectory = new Map([[directory, [parentRequest]], [childDirectory, [childRequest]]])

const browser = await chromium.launch({ channel: "chrome", headless: true })
const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } })
const page = await context.newPage()
await context.route("**/*", route => new URL(route.request().url()).origin === preview.origin ? route.continue() : route.abort())
const errors = []
page.on("pageerror", error => errors.push(error.message))

try {
  await page.goto(preview.url, { waitUntil: "commit" })
  const parent = page.locator('[data-question-request="question-parent"]')
  const child = page.locator('[data-question-request="question-child"]')
  await expect(parent).toBeVisible()
  await expect(page.locator('[data-timeline-part-id="question-pending"][data-question-request="question-parent"]')).toBeVisible()
  await expect(parent.locator("strong").filter({ hasText: "smallest durable seam" })).toBeVisible()
  await expect(parent.getByText("question-only", { exact: false })).toBeVisible()
  await expect(page.locator("[data-question-summary]")).toContainText("Renderer slot (Recommended)")
  await expect(child).toContainText("from subagent: Focused reviewer")

  await parent.getByRole("button", { name: /Fork renderer/ }).click()
  await parent.getByRole("textbox", { name: "Architecture note" }).fill("Keep the extension local to es-app.")
  await parent.getByRole("button", { name: /Keyboard/ }).click()
  await parent.getByRole("button", { name: /Subagents/ }).click()
  await parent.getByRole("textbox", { name: "Coverage note" }).fill("Include both directions.")
  await parent.getByRole("button", { name: "Answer round" }).focus()
  await page.keyboard.press("Enter")
  await expect(parent).toHaveCount(0)
  expect(preview.fixture.questionReplies).toEqual([{
    id: "question-parent",
    answers: [
      ["Fork renderer", "Keep the extension local to es-app."],
      ["Keyboard", "Subagents", "Include both directions."],
      ["Park for review (Recommended)"],
    ],
  }])

  await child.getByRole("button", { name: "Dismiss" }).click()
  await expect(child).toHaveCount(0)
  expect(preview.fixture.questionRejects).toEqual(["question-child"])

  await page.setViewportSize({ width: 390, height: 900 })
  await page.evaluate(() => { document.documentElement.dir = "rtl" })
  expect(await page.locator(".session-page .transcript").evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
  expect(errors).toEqual([])
  console.log("PASS inline questions: transcript placement, markdown, multi-answer notes, recommended Enter, subagent dismiss, RTL containment")
} finally {
  await browser.close()
  await preview.close()
}
