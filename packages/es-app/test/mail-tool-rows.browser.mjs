// Receipt-derived mail tool rows (Laptop2627). A shell call that ran `es mail send` and printed the transport's
// receipt line says who it mailed; the delivery word is the loaded mail record's exact state ("handled" stays
// handled: acknowledgment, never "started"); a receipt whose record this host has not loaded says "reported sent ·
// delivery not read"; a failed send or a non-mail call printing the same text stays a plain shell row. No request
// beyond the transcript's existing mail read.
// Run from packages/es-app: node test/mail-tool-rows.browser.mjs   (SCREENSHOT_DIR=<dir>)
import { createRequire } from "node:module"
import { mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { startToolRunsPreview } from "./tool-runs-preview.mjs"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const shots = process.env.SCREENSHOT_DIR ?? join(tmpdir(), "es-app-mail-tool-rows")
mkdirSync(shots, { recursive: true })
const preview = await startToolRunsPreview(0, { iconCases: true })
const fixture = preview.fixture
const sent = (id, recipient, state, extra = {}) => ({ id, ts: "2001-01-01T00:00:00Z", created_ms: 978307200000, from: "transcript-scan", to: recipient,
  direction: "sent", kind: "task", text: "Please review the strip.", sender_session: "ses_a",
  deliveries: [{ message_id: id, recipient, session: "ses_r", mode: "actionable", state, request_id: null, error: null, presented_at: null, handled_at: null, ...extra }] })
const base = fixture.mail
fixture.mail = (es, recipient) => {
  const value = base(es, recipient)
  return recipient === "ses_a" ? { ...value, messages: [...value.messages, sent("ux-feel#7", "ux-feel", "handled"), sent("front-desk#9", "front-desk", "queued")] } : value
}
const receipt = (id, to, kind = "task") => `sent ${id} (${kind}) transcript-scan -> ${to}`
fixture.messages.push(
  preview.assistant("msg_3001", "msg_2006", [
    preview.text("q1", "Mailing ux-feel:"),
    preview.tool("m1_handled", "bash", { command: `es mail send --to ux-feel --kind task "Please review the strip." | head -1` }, receipt("ux-feel#7", "ux-feel"), { metadata: { exit: 0 } }),
    preview.text("q2", "Two mails at once:"),
    preview.tool("m2_two", "bash", { command: `es mail send --to ux-feel --kind task "a"; es mail send --to front-desk --kind task "b"` },
      `${receipt("ux-feel#7", "ux-feel")}\n${receipt("front-desk#9", "front-desk")}`, { metadata: { exit: 0 } }),
    preview.text("q3", "A mail this host has no record of:"),
    preview.tool("m3_unread", "bash", { command: `es mail send --to orchestrator --kind notice "x"` }, receipt("orchestrator#55", "orchestrator", "notice"), { metadata: { exit: 0 } }),
    preview.text("q4", "A failed send, and a file that merely contains the words:"),
    preview.tool("m4_failed", "bash", { command: `es mail send --to nobody "x"` }, "error: unknown lane nobody", { status: "error" }),
    preview.text("q5", "and"),
    preview.tool("m5_cat", "bash", { command: "cat notes.txt" }, receipt("ux-feel#7", "ux-feel"), { metadata: { exit: 0 } }),
  ]),
)
const browser = await chromium.launch({ channel: "chrome", headless: true })
const errors = []
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  page.setDefaultTimeout(20_000)
  await page.context().route("**/*", (route) => new URL(route.request().url()).origin === preview.origin ? route.continue() : route.abort())
  page.on("pageerror", (error) => errors.push(error.message))
  await page.goto(preview.url, { waitUntil: "domcontentloaded", timeout: 180_000 })
  const chip = (id) => page.locator(`.tool-chip[data-timeline-part-id="${id}"]`)
  const state = (id) => chip(id).locator(".tool-chip-state")
  await expect(chip("m1_handled")).toHaveCount(1, { timeout: 120_000 })
  const mailReads = () => fixture.calls.filter((call) => call.path === "/api/mail").length
  await expect.poll(mailReads).toBeGreaterThan(0)

  // Receipt + loaded record: who was mailed and the record's exact state; handled stays handled.
  await expect(state("m1_handled")).toHaveText("Mail sent to ux-feel · handled")
  await expect(chip("m1_handled").locator(".tool-run-icon")).toHaveAttribute("data-mail", "sent")
  await chip("m1_handled").locator(".tool-chip-summary").hover()
  await expect(chip("m1_handled").locator(".tool-call-description")).toHaveText("ux-feel#7 task to ux-feel: ux-feel handled (acknowledged by the recipient; not proof the work started)")
  await page.screenshot({ path: join(shots, "handled.png") })
  await page.mouse.move(0, 0)
  expect(await page.locator(".tool-chip-state").allTextContents()).not.toContainEqual(expect.stringMatching(/\b(started|completed)\b/))
  // Two receipts: both recipients, differing states named as such, each in the card.
  await expect(state("m2_two")).toHaveText("Mail sent to ux-feel, front-desk · mixed states")
  // A receipt without its record here: qualified, no state claimed.
  await expect(state("m3_unread")).toHaveText("Mail reported sent to orchestrator · delivery not read")
  // No receipt: the plain shell row.
  await expect(state("m4_failed")).toHaveText(/^failed · es mail send --to nobody/)
  await expect(chip("m4_failed").locator(".tool-run-icon")).not.toHaveAttribute("data-mail", "sent")
  await expect(state("m5_cat")).toHaveText("cat notes.txt")

  // Expanded: each mail with its delivery, and a way to its mail row.
  await chip("m2_two").locator(".tool-chip-summary").click()
  await expect(chip("m2_two").locator(".tool-chip-mail li")).toHaveText([/^ux-feel#7 task to ux-feel: ux-feel handled/, /^front-desk#9 task to front-desk: front-desk queued \(stored, not yet in the recipient's input\)/])
  await expect(chip("m2_two").locator(".tool-chip-mail-open")).toHaveCount(2)
  await chip("m3_unread").locator(".tool-chip-summary").click()
  await expect(chip("m3_unread").locator(".tool-chip-mail-open")).toHaveCount(0)
  await page.screenshot({ path: join(shots, "expanded.png") })

  // The rows added no request: mail is still only the transcript's own read.
  const reads = mailReads()
  await page.waitForTimeout(1500)
  expect(mailReads()).toBe(reads)
  expect(fixture.calls.filter((call) => !["GET", "HEAD", "OPTIONS"].includes(call.method) && call.path !== "/api/attention/session")).toEqual([])
  expect(errors).toEqual([])
  console.log(`PASS mail tool rows: receipt + record -> 'Mail sent to X · <exact state>' (handled stays handled, never started); two mails -> mixed states with per-mail card; receipt without record -> 'reported sent · delivery not read'; failed send and non-mail output stay shell rows; expanded rows list each mail with a Show mail link only when recorded; no extra request; screenshots ${shots}`)
} finally {
  await preview.close()
  await browser.close()
}
