import { createRequire } from "node:module"
import { startMailCausePreview } from "./mail-cause-preview.mjs"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const preview = await startMailCausePreview()
// Headless shell only: never opens a visible window or takes focus.
const browser = await chromium.launch({ headless: true, ...(process.env.HEADLESS_SHELL ? { executablePath: process.env.HEADLESS_SHELL } : {}) })
const errors = []
try {
  for (const dir of ["ltr", "rtl"]) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, timezoneId: "UTC", locale: "en-GB" })
    await page.context().route("**/*", route => new URL(route.request().url()).origin === preview.origin ? route.continue() : route.abort())
    page.on("pageerror", error => errors.push(error.message))
    await page.goto(preview.url)
    if (dir === "rtl") await page.evaluate(() => document.documentElement.setAttribute("dir", "rtl"))
    const cause = page.locator(".mail-cause")
    // One run, one cause line, placed after the human exchange and before the three mails it summarizes.
    await expect(cause).toHaveCount(1)
    await expect(cause).toContainText("3 mails, one turn")
    await expect(cause).toContainText("2 × task, task (handoff catch-up)")
    await expect(cause.locator(".mail-cause-what")).toContainText(/from .*ses_ea34207faffeel3lksWfWq3QvU.*, ux-feel, مراجعة ux-feel$/)
    await expect(cause).toContainText("sent 23:09–23:19 · received 23:29")
    await expect(cause).not.toContainText(/woke|wake|human prompt/i)
    const order = await page.locator("[data-find-message]").evaluateAll(rows => rows.map(row => row.getAttribute("data-find-message")))
    if (order.join(",") !== "msg_human,msg_reply,msg_m417,msg_m427,msg_m428,msg_turn") throw new Error(`transcript order ${order}`)
    // The cause sits after the last mail of the run, directly before the turn those mails caused.
    const placed = await page.evaluate(() => {
      const cause = document.querySelector(".mail-cause")
      const last = document.querySelector('[data-find-message="msg_m428"]')
      const turn = document.querySelector('[data-find-message="msg_turn"]')
      return !!last?.contains(cause) && last?.nextElementSibling === turn
    })
    if (!placed) throw new Error("cause line is not at the mail run's turn boundary")
    await expect(cause.locator('.mail-kind[data-kind="task"]')).toHaveCount(2)
    // Each envelope stays individually expandable with its own id, sender and body.
    await expect(page.locator(".mail-activity")).toHaveCount(3)
    await page.locator("#mail-orchestrator\\#428 summary").click()
    await expect(page.locator("#mail-orchestrator\\#428")).toContainText("Mail ID: orchestrator#428")
    await expect(page.locator("#mail-orchestrator\\#428")).toContainText("The new-session flow should open a draft immediately.")
    await expect(page.locator("#mail-orchestrator\\#428")).toContainText("Coalesced · already active")
    const overflow = await cause.evaluate(node => node.scrollWidth > node.clientWidth + 1)
    if (overflow) throw new Error(`${dir}: cause line overflows`)
    await page.screenshot({ path: `${process.env.SCREENSHOT_DIR ?? "/tmp"}/mail-cause-${dir}.png`, fullPage: false })
    await page.close()
  }
  if (errors.length) throw new Error(errors.join("\n"))
  console.log("mail cause browser proof passed (ltr, rtl)")
} finally {
  await browser.close()
  await preview.close()
}
