import { createRequire } from "node:module"
import { mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { startPanelPreview } from "./composer-panel-preview.mjs"

// Wake markers (CHAT-PARTS §4): a thin agent-side row above the input that woke the session, from the
// transcript's reply evidence and the dashboard's frozen passive-review record. The mail it covers keeps its own state.
const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const shots = process.env.SCREENSHOT_DIR ?? join(tmpdir(), "es-app-wake-marker")
mkdirSync(shots, { recursive: true })
const preview = await startPanelPreview()
const fixture = preview.fixture
fixture.status = "idle"
const directory = `${fixture.editspaces[0].root}/lanes/squadron-v2/repos/org/repo`
const at = Date.parse("2026-10-20T12:00:00Z")
fixture.sessionIDs = ["ses_a"]
fixture.sessionTitles.set("ses_a", "Tether")
fixture.sessionTimes.set("ses_a", { created: at, updated: at + 60_000 })
fixture.laneOwners = [{ lane: "squadron-v2", owner: "ses_a" }]
const passive = (id, offset) => ({ id, ts: new Date(at + offset).toISOString(), created_ms: at + offset, from: "orchestrator", to: "squadron-v2",
  direction: "received", kind: "notice", text: `Body of ${id}`, sender_session: "ses_relay",
  deliveries: [{ message_id: id, recipient: "squadron-v2", session: "ses_a", mode: "passive", state: "recorded", wake: "none",
    request_id: null, error: null, presented_at: null, handled_at: null }] })
fixture.mail = (es) => ({ editspace: es, lane: "squadron-v2", messages: [passive("p1", 3000), passive("p2", 4000)] })
fixture.wakeEvents = (session) => session === "ses_a"
  ? [{ id: "review-1", session: "ses_a", host: "mini", cause: "passive-review", recipient: "squadron-v2", at: at + 10_000, admission: "admitted", outcome: "unknown", covers: ["p1", "p2"] }]
  : []
const base = { sessionID: "ses_a", agent: "build", model: { providerID: "fixture", modelID: "test" } }
const reply = (id, parentID, created, completed) => ({ id, sessionID: "ses_a", role: "assistant", parentID, agent: "build", mode: "build",
  providerID: "fixture", modelID: "test", path: { cwd: directory, root: directory }, cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created, completed } })
const text = (messageID, value) => [{ id: `prt_${messageID}`, messageID, sessionID: "ses_a", type: "text", text: value }]
const source = (id, kind) => ({ type: "editspace-mail", id, sender: "es", recipient: "squadron-v2", kind })
fixture.messages = [
  { info: { ...base, id: "msg_001", role: "user", time: { created: at + 500 } }, parts: text("msg_001", "Human prompt") },
  { info: reply("msg_002", "msg_001", at + 600, at + 900), parts: text("msg_002", "Done.") },
  { info: { ...base, id: "msg_003", role: "user", time: { created: at + 10_000 }, source: source("review-1", "passive-review") },
    parts: text("msg_003", "2 unread passive mail for squadron-v2.") },
  { info: reply("msg_004", "msg_003", at + 10_100, at + 10_200), parts: text("msg_004", "Reviewed.") },
  { info: { ...base, id: "msg_005", role: "user", time: { created: at + 20_000 }, source: source("resume-1", "resume") },
    parts: text("msg_005", "Resume your lane.") },
]
const browser = await chromium.launch({ headless: true,
  ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : { channel: "chrome" }) })
const errors = []
try {
  for (const dir of ["ltr", "rtl"]) {
    const context = await browser.newContext({ viewport: { width: 900, height: 700 } })
    if (dir === "rtl") await context.addInitScript(() => document.addEventListener("DOMContentLoaded", () => { document.documentElement.dir = "rtl" }))
    const page = await context.newPage()
    page.on("pageerror", (error) => errors.push(error.message))
    await page.goto(`${preview.origin}/session/ses_a?directory=${encodeURIComponent(directory)}`)
    const markers = page.locator(".transcript .wake-marker")
    // One marker per waking input, in transcript order; the human prompt gets none.
    await expect(markers).toHaveCount(2)
    await expect(markers.nth(0)).toHaveAttribute("data-state", "woke")
    await expect(markers.nth(0)).toContainText("Woke for passive review · 2 mail")
    await expect(markers.nth(0)).toHaveAttribute("title", /started a turn$/)
    await expect(markers.nth(1)).toHaveAttribute("data-state", "unconfirmed")
    await expect(markers.nth(1)).toHaveText("Resume · wake not confirmed")
    await expect(page.locator('[data-find-message="msg_001"] .wake-marker')).toHaveCount(0)
    // The marker sits directly above the input it describes.
    await expect(page.locator('[data-find-message="msg_003"] .wake-marker + .msg-wrap')).toHaveCount(1)
    // Covered passive mail keeps its own "did not wake" evidence.
    const chip = page.locator('.transcript [data-mail-id="p1"] .mail-activity-summary')
    await expect(chip).toHaveAttribute("aria-label", /Recorded, did not wake$/)
    // "show mail" brings the first covered mail into view.
    await page.locator(".transcript").evaluate((element) => { element.scrollTop = element.scrollHeight })
    await markers.nth(0).getByRole("button", { name: "Show the 2 mail this review covered" }).click()
    await expect(page.locator('.transcript [data-mail-id="p1"]')).toBeInViewport()
    await page.screenshot({ path: join(shots, `wake-marker-${dir}.png`) })
    await context.close()
  }
  expect(errors).toEqual([])
  expect(fixture.calls.filter((call) => !["GET", "HEAD", "OPTIONS"].includes(call.method))).toEqual([])
  expect(fixture.calls.some((call) => call.path === "/api/wake-events")).toBe(true)
  console.log(`PASS wake markers: woke with frozen mail count, unconfirmed resume, human prompt unmarked, marker above its input, covered mail unchanged, show-mail scroll, no writes, LTR/RTL; screenshots ${shots}`)
} finally {
  await browser.close()
  await preview.close()
}
