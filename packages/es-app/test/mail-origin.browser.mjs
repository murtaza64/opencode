import { createRequire } from "node:module"
import { startPanelPreview } from "./composer-panel-preview.mjs"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const preview = await startPanelPreview()
const fixture = preview.fixture
fixture.status = "idle"
const directory = `${fixture.editspaces[0].root}/lanes/squadron-v2/repos/org/repo`
const at = Date.parse("2026-10-20T12:00:00Z")
const unknown = "an-unregistered-legacy-sender-with-an-extremely-long-name-that-must-truncate-cleanly"
fixture.sessionIDs = ["ses_a", "ses_relay"]
fixture.sessionTitles.set("ses_a", "Tether").set("ses_relay", "Relay")
fixture.sessionTimes.set("ses_a", { created: at, updated: at + 60_000 })
fixture.laneOwners = [{ lane: "squadron-v2", owner: "ses_a" }, { lane: "orchestrator", owner: "ses_relay" }]
const squadron = { workspace_id: "5654abc", workspace_name: "squadron-bridge-test", persona: "murtaza/tether", mode: "task",
  ui_url: "https://infra-squadron-stage-1.duolingo.com/workspace/?workspace=5654abc",
  items: [{ kind: "message.created", message_id: "m1", persona: "smoke-peer", actor_kind: "agent", mention: true }] }
const delivery = (message_id, recipient, sessionID) => ({ message_id, recipient, session: sessionID, mode: "actionable", state: "handled", request_id: null, error: null })
const mail = (id, offset, from, to, direction, extra = {}) => ({ id, ts: new Date(at + offset).toISOString(), created_ms: at + offset, from, to, direction,
  kind: "task", text: `Body of ${id}`, deliveries: [], ...extra })
const records = [
  mail("internal-cross", 1000, "workbench-upgrade/batch-orchestrator", "squadron-v2", "received", { deliveries: [delivery("internal-cross", "squadron-v2", "ses_a")] }),
  mail("external-in", 2000, "integration:squadron", "squadron-v2", "received", { squadron, deliveries: [delivery("external-in", "squadron-v2", "ses_a")] }),
  mail("unknown-in", 3000, unknown, "squadron-v2", "received"),
  mail("tether-out", 4000, "squadron-v2", "orchestrator", "sent", { sender_session: "ses_a", deliveries: [delivery("tether-out", "orchestrator", "ses_relay")] }),
  mail("bridged-input", 5000, "integration:squadron", "squadron-v2", "received", { squadron, deliveries: [delivery("bridged-input", "squadron-v2", "ses_a")] }),
]
fixture.mail = (es, recipient) => ({ editspace: es, lane: recipient === "squadron-v2" ? recipient : "", messages: records })
const base = { sessionID: "ses_a", agent: "build", model: { providerID: "fixture", modelID: "test" } }
fixture.messages = [
  { info: { ...base, id: "msg_001", role: "user", time: { created: at + 500 } },
    parts: [{ id: "prt_001", messageID: "msg_001", sessionID: "ses_a", type: "text", text: "Human prompt" }] },
  { info: { ...base, id: "msg_002", role: "user", time: { created: at + 6000 },
    source: { type: "editspace-mail", id: "bridged-input", sender: "integration:squadron", recipient: "squadron-v2", kind: "task" } },
    parts: [{ id: "prt_002", messageID: "msg_002", sessionID: "ses_a", type: "text", text: "Squadron pointer digest" }] },
  { info: { id: "msg_003", sessionID: "ses_a", role: "assistant", parentID: "msg_002", agent: "build", mode: "build", providerID: "fixture", modelID: "test",
    path: { cwd: directory, root: directory }, cost: 0, finish: "stop", tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: at + 6100, completed: at + 6200 } },
    parts: [{ id: "prt_003", messageID: "msg_003", sessionID: "ses_a", type: "text", text: "Done." }] },
  { info: { ...base, id: "msg_004", role: "user", time: { created: at + 9000 },
    source: { type: "editspace-mail", id: "es-resume-1", sender: "orchestrator", senderSession: "ses_relay", recipient: "squadron-v2", kind: "resume" } },
    parts: [{ id: "prt_004", messageID: "msg_004", sessionID: "ses_a", type: "text", text: "Relay resumed you" }] },
]
const browser = await chromium.launch({ headless: true,
  ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : { channel: "chrome" }) })
const errors = []
const row = (page, id) => page.locator(`.transcript [data-mail-id="${id}"]`)
try {
  for (const rtl of [false, true]) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } })
    if (rtl) await context.addInitScript(() => document.addEventListener("DOMContentLoaded", () => { document.documentElement.dir = "rtl" }))
    const page = await context.newPage()
    page.on("pageerror", (error) => errors.push(error.message))
    await page.goto(`${preview.origin}/session/ses_a?directory=${encodeURIComponent(directory)}`, { timeout: 120_000 })
    await expect(page.locator(".transcript .mail-activity")).toHaveCount(6)

    // Origin: classified only from structured fields.
    await expect(row(page, "internal-cross").locator("summary .mail-origin-full")).toHaveText("Electric Sheep")
    await expect(row(page, "tether-out").locator("summary .mail-origin-full")).toHaveText("Electric Sheep")
    await expect(row(page, "external-in").locator("summary .mail-origin-full")).toHaveText("Squadron")
    await expect(row(page, "unknown-in").locator(".mail-origin")).toHaveCount(0)
    // The external sender is the workspace author, not the local bridge.
    const sender = row(page, "external-in").locator("summary .mail-party").first()
    await expect(sender).toHaveText("smoke-peer")
    await expect(sender).toHaveAttribute("title", "smoke-peer · via integration:squadron")
    await expect(row(page, "tether-out").locator("summary .mail-party")).toHaveText(["Tether", "Relay"])
    // Transcript input and the turn-input note use the same cue.
    const input = page.locator('[data-mail-message-id="msg_002"]')
    await expect(input.locator("summary .mail-origin-full")).toHaveText("Squadron")
    await expect(input.locator("summary .mail-party").first()).toHaveText("smoke-peer")
    await expect(page.locator(".mail-cause .mail-origin-full")).toHaveText("Squadron")
    await expect(page.locator('[data-mail-message-id="msg_004"] .mail-tag')).toHaveText("Agent resume")

    for (const width of [1280, 760, 420]) {
      await page.setViewportSize({ width, height: 1000 })
      const geometry = await page.evaluate(() => [...document.querySelectorAll(".transcript .mail-activity:not([open]) > .mail-activity-summary")].map((summary) => {
        const box = summary.getBoundingClientRect()
        const glyph = summary.querySelector(".mail-activity-kind").getBoundingClientRect()
        const inner = [...summary.querySelectorAll(".mail-activity-line > *, .mail-route > *, .mail-activity-state")]
          .map((element) => element.getBoundingClientRect()).filter((rect) => rect.width > 0)
        const arrow = summary.querySelector(".mail-activity-arrow").getBoundingClientRect()
        const recipient = [...summary.querySelectorAll(".mail-route > .mail-party")].at(-1).getBoundingClientRect()
        const line = summary.querySelector(".mail-activity-line").getBoundingClientRect()
        return {
          height: Math.round(box.height), glyphStart: Math.round(document.dir === "rtl" ? box.right - glyph.right : glyph.left - box.left),
          glyphWidth: Math.round(glyph.width),
          overflow: inner.some((rect) => rect.left < box.left - 1 || rect.right > box.right + 1),
          arrowVisible: arrow.width > 0 && arrow.left >= line.left - 1 && arrow.right <= line.right + 1,
          recipientVisible: recipient.width >= 10 && recipient.left >= line.left - 1 && recipient.right <= line.right + 1,
          lineHeight: Math.round(line.height),
        }
      }))
      const label = `${width}px ${rtl ? "rtl" : "ltr"}`
      if (new Set(geometry.map((item) => item.height)).size !== 1) throw new Error(`${label}: unequal row heights ${JSON.stringify(geometry.map((g) => g.height))}`)
      if (new Set(geometry.map((item) => item.glyphStart)).size !== 1 || geometry.some((item) => item.glyphWidth !== 16))
        throw new Error(`${label}: misaligned glyph column ${JSON.stringify(geometry)}`)
      if (geometry.some((item) => item.overflow)) throw new Error(`${label}: content spills out of a row`)
      if (geometry.some((item) => !item.arrowVisible || !item.recipientVisible)) throw new Error(`${label}: arrow or recipient clipped ${JSON.stringify(geometry)}`)
      if (geometry.some((item) => item.lineHeight > 24)) throw new Error(`${label}: route line wrapped`)
      // The turn-input note keeps the same glyph column.
      const cause = await page.evaluate(() => {
        const note = document.querySelector(".mail-cause .mail-activity-kind").getBoundingClientRect()
        const transcript = document.querySelector(".transcript-inner").getBoundingClientRect()
        return Math.round(document.dir === "rtl" ? transcript.right - note.right : note.left - transcript.left)
      })
      const rowStart = await page.evaluate(() => {
        const glyph = document.querySelector(".transcript .mail-activity .mail-activity-kind").getBoundingClientRect()
        const transcript = document.querySelector(".transcript-inner").getBoundingClientRect()
        return Math.round(document.dir === "rtl" ? transcript.right - glyph.right : glyph.left - transcript.left)
      })
      if (Math.abs(cause - rowStart) > 1) throw new Error(`${label}: note glyph at ${cause}, rows at ${rowStart}`)
    }
    await page.setViewportSize({ width: 1280, height: 1000 })

    // Expanded: full names, origin and where a reply goes.
    await row(page, "external-in").locator("summary").click()
    const details = row(page, "external-in").locator(".mail-activity-details")
    await expect(details).toContainText("Origin: Squadron · workspace squadron-bridge-test · from smoke-peer")
    await expect(details).toContainText("Reply in the Squadron workspace (es squadron post 5654abc)")
    await expect(details.getByRole("link", { name: "Open workspace" })).toHaveAttribute("href", squadron.ui_url)
    await row(page, "unknown-in").locator("summary").click()
    await expect(row(page, "unknown-in").locator(".mail-activity-details")).toContainText(`From: ${unknown}`)
    await expect(row(page, "unknown-in").locator(".mail-activity-details")).toContainText("Origin: unknown")
    await row(page, "internal-cross").locator("summary").click()
    await expect(row(page, "internal-cross").locator(".mail-activity-details")).toContainText("Origin: Electric Sheep · reply here with es mail send --reply-to internal-cross")
    await context.close()
  }
  expect(errors).toEqual([])
  expect(fixture.calls.filter((call) => !["GET", "HEAD", "OPTIONS"].includes(call.method))).toEqual([])
  console.log("PASS mail origin + layout: internal cross-ES, external bridged (row/input/note), unknown unlabeled; equal heights, one glyph column, no spill/clip at 1280/760/420 LTR+RTL; details with reply destination")
} finally {
  await browser.close()
  await preview.close()
}
