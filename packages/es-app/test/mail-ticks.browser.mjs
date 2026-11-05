import { createRequire } from "node:module"
import { mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { startPanelPreview } from "./composer-panel-preview.mjs"

// Mail ticks, unread and Wake now (DD #414, Loupe ux-feel/artifacts/mail-ticks.md). Outgoing chips carry one tick
// (✓ sending, ✓✓ grey inbox, ✓✓ accent presented, ! failed) with its words only in hover/aria; incoming mail this
// session's agent was not shown is unread with one line from the dashboard's real wake state; one bar above the
// composer offers Wake now, which posts once per click and never while a wake is in flight.
const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const shots = process.env.SCREENSHOT_DIR ?? join(tmpdir(), "es-app-mail-ticks")
mkdirSync(shots, { recursive: true })
const preview = await startPanelPreview()
const fixture = preview.fixture
fixture.status = "idle"
const directory = `${fixture.editspaces[0].root}/lanes/squadron-v2/repos/org/repo`
const at = Date.now() - 10 * 60_000
fixture.sessionIDs = ["ses_a", "ses_relay", "ses_ux2"]
fixture.sessionTitles.set("ses_a", "Tether").set("ses_relay", "Relay").set("ses_ux2", "UX Impl")
fixture.sessionTimes.set("ses_a", { created: at - 60_000, updated: at + 60_000 })
fixture.laneOwners = [{ lane: "squadron-v2", owner: "ses_a" }, { lane: "orchestrator", owner: "ses_relay" }, { lane: "ux-impl", owner: "ses_ux2" }]
const delivery = (message_id, recipient, session, extra) => ({ message_id, recipient, session, mode: "actionable", state: "admitted",
  request_id: null, error: null, presented_at: null, handled_at: null, ...extra })
const mail = (id, offset, from, to, direction, extra) => ({ id, ts: new Date(at + offset).toISOString(), created_ms: at + offset, from, to, direction,
  kind: "notice", text: `Body of ${id}`, ...extra })
const out = (id, offset, deliveries) => mail(id, offset, "squadron-v2", deliveries[0]?.recipient ?? "orchestrator", "sent", { sender_session: "ses_a", deliveries })
const unreadFrom = (id, offset) => mail(id, offset, "orchestrator", "squadron-v2", "received",
  { sender_session: "ses_relay", deliveries: [delivery(id, "squadron-v2", "ses_a", { mode: "passive", state: "recorded", tick: "recorded" })] })
const records = [
  out("o-sending", 1000, []),
  out("o-queued", 2000, [delivery("o-queued", "orchestrator", "ses_relay", { state: "queued", tick: "queued" })]),
  out("o-inbox", 3000, [delivery("o-inbox", "orchestrator", "ses_relay", { tick: "admitted", wake: "joined" })]),
  out("o-read", 4000, [delivery("o-read", "orchestrator", "ses_relay", { state: "handled", tick: "presented", presented_ms: at + 4500, handled_at: new Date(at + 4800).toISOString() })]),
  out("o-failed", 5000, [delivery("o-failed", "orchestrator", "ses_relay", { state: "failed", tick: "failed", error: "lane refused" })]),
  // Two recipients: one presented, one only in its inbox -> the lower state.
  out("o-two", 6000, [delivery("o-two", "orchestrator", "ses_relay", { tick: "presented", presented_ms: at + 6500 }), delivery("o-two", "ux-impl", "ses_ux2", { tick: "admitted" })]),
  // A recipient on another host (federated address, no local session) and a successor session's receipt.
  out("o-remote", 7000, [delivery("o-remote", "mini:opencode/ux-feel", null, { tick: "admitted" })]),
  out("o-successor", 8000, [delivery("o-successor", "ux-impl", "ses_ux2", { tick: "presented", presented_ms: at + 8500 })]),
  unreadFrom("i-unread-1", 9000),
  unreadFrom("i-unread-2", 9500),
  // Read (presented) incoming mail is not unread.
  mail("i-read", 9700, "orchestrator", "squadron-v2", "received",
    { sender_session: "ses_relay", deliveries: [delivery("i-read", "squadron-v2", "ses_a", { mode: "passive", state: "presented", tick: "presented", presented_ms: at + 9800 })] }),
]
fixture.mail = (es, recipient) => ({ editspace: es, lane: recipient === "squadron-v2" ? recipient : "", messages: records })
const base = { sessionID: "ses_a", agent: "build", model: { providerID: "fixture", modelID: "test" } }
fixture.messages = [{ info: { ...base, id: "msg_001", role: "user", time: { created: at } },
  parts: [{ id: "prt_001", messageID: "msg_001", sessionID: "ses_a", type: "text", text: "Human prompt" }] }]

// The dashboard's wake state for this session, switched per scenario; Wake now answers as configured.
const state = (value, next, extra) => ({ schema: "es.mail.wake/v1", lane: "squadron-v2", session: "ses_a", state: value, next,
  pending: { queued: 0, admitted: 0, unread_passive: 2 }, checked_at: Date.now(), wake_now: value !== "blocked", ...extra })
let wake = state("scheduled", { reason: "passive-review", at_ms: Date.now() + 12 * 60_000 + 20_000, count: 2 })
let post = () => ({ body: { lane: "squadron-v2", session: "ses_a", offered: 0, busy: false, review: { action: "admitted" }, state: wake } })
let release
fixture.mailWake = (method) => method === "GET" ? { body: wake } : post()

const browser = await chromium.launch({ headless: true,
  ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : { channel: "chrome" }) })
const errors = []
const posts = () => fixture.calls.filter((call) => call.path === "/api/mail/wake" && call.method === "POST")
try {
  for (const dir of ["ltr", "rtl"]) {
    const context = await browser.newContext({ viewport: { width: 1000, height: 1000 } })
    if (dir === "rtl") await context.addInitScript(() => document.addEventListener("DOMContentLoaded", () => { document.documentElement.dir = "rtl" }))
    const page = await context.newPage()
    page.on("pageerror", (error) => errors.push(error.message))
    const chip = (id) => page.locator(`.transcript [data-mail-id="${id}"] > .mail-activity-summary`)
    const tick = (id) => chip(id).locator(".msg-tick")
    await page.goto(`${preview.origin}/session/ses_a?directory=${encodeURIComponent(directory)}`)
    await expect(chip("o-two")).toBeVisible({ timeout: 60_000 })

    // Outgoing: one tick slot, its words in hover + aria only, never inline.
    const ticks = {
      "o-sending": ["sent", "Sending"],
      "o-queued": ["sent", "Sending · queued until Relay is free"],
      "o-inbox": ["delivered", "In Relay's inbox · Relay was working"],
      "o-failed": ["failed", "Not delivered to Relay: lane refused"],
      "o-two": ["delivered", "Relay: Read by Relay · "],
      "o-remote": ["delivered", "In mini:opencode/ux-feel's inbox"],
      "o-successor": ["read", "Read by UX Impl · "],
      "o-read": ["read", "Read by Relay · "],
    }
    for (const [id, [value, label]] of Object.entries(ticks)) {
      await expect(tick(id)).toHaveCount(1)
      await expect(tick(id)).toHaveAttribute("data-tick", value)
      await expect(tick(id)).toHaveAttribute("aria-label", new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`))
      await expect(chip(id)).not.toContainText(/admitted|presented|queued|handled|inbox|Sending/)
      await expect(chip(id).locator(".mail-activity-wake")).toHaveCount(0)
    }
    await expect(tick("o-two")).toHaveAttribute("aria-label", /; UX Impl: In UX Impl's inbox$/)
    // Grey for the inbox, accent for presented, red for failed: three distinct colours.
    const color = (id) => tick(id).evaluate((element) => getComputedStyle(element).color)
    expect(new Set([await color("o-inbox"), await color("o-read"), await color("o-failed")]).size).toBe(3)
    expect(await color("o-sending")).toBe(await color("o-inbox"))
    // The tick is the chip's last glyph, at its inline end.
    const end = async (id) => { const t = await tick(id).boundingBox(); const c = await chip(id).boundingBox()
      return dir === "ltr" ? c.x + c.width - (t.x + t.width) : t.x - c.x }
    expect(await end("o-inbox")).toBeLessThan(16)
    // Handled stays in the expansion, never the chip.
    await chip("o-read").click()
    await expect(page.locator('.transcript [data-mail-id="o-read"] .mail-activity-details')).toContainText("Handled:")

    // Incoming unread: dot, bolder sender, one wake line from the scheduler; presented mail is not unread.
    const unread = chip("i-unread-1")
    await expect(unread).toHaveAttribute("data-unread", "true")
    await expect(unread.locator(".mail-unread-dot")).toHaveCount(1)
    await expect(unread.locator(".mail-unread-wake")).toHaveText("Agent wakes in 12 min")
    await expect(unread).toHaveAttribute("aria-label", /^Unread mail from Relay: .*, Agent wakes in 12 min$/)
    expect(await unread.locator(".mail-activity-party").evaluate((element) => getComputedStyle(element).fontWeight)).toBe("600")
    await expect(chip("i-read")).not.toHaveAttribute("data-unread", "true")
    await expect(chip("i-read").locator(".mail-unread-dot")).toHaveCount(0)

    // One bar for the session, above the composer.
    const bar = page.locator(".mail-wake-bar")
    await expect(bar).toHaveCount(1)
    await expect(bar).toContainText("2 unread")
    await expect(bar.getByRole("button", { name: "Wake now" })).toBeVisible()
    await expect(page.locator(".mail-activity .mail-wake-now")).toHaveCount(0)
    const barBox = await bar.boundingBox()
    const composer = await page.locator(".prompt-box").boundingBox()
    expect(barBox.y + barBox.height).toBeLessThanOrEqual(composer.y + 1)
    await page.screenshot({ path: join(shots, `scheduled-${dir}.png`) })

    if (dir === "ltr") {
      // Repeated clicks while a wake is in flight (agent busy) post once; the dashboard coalesces anything else.
      const before = posts().length
      let resolve
      const gate = new Promise((r) => { resolve = r })
      post = () => ({ body: { lane: "squadron-v2", session: "ses_a", offered: 0, busy: true, review: { action: "admitted" }, state: wake } })
      await page.route("**/es/api/mail/wake**", async (route) => {
        if (route.request().method() === "POST") await gate
        await route.continue()
      })
      const button = bar.locator(".mail-wake-now")
      await button.click()
      await expect(button).toBeDisabled()
      await expect(button).toHaveText("Waking…")
      await button.click({ force: true })
      await button.press("Enter")
      resolve()
      await expect(button).toHaveText("Waking… agent is working, reads it at its next safe point")
      await page.waitForTimeout(500)
      expect(posts().length - before).toBe(1)
      await page.screenshot({ path: join(shots, "waking-busy.png") })
      // The agent is shown the mail: unread clears, the bar goes.
      for (const id of ["i-unread-1", "i-unread-2"]) Object.assign(records.find((item) => item.id === id).deliveries[0], { state: "presented", tick: "presented", presented_ms: Date.now() })
      fixture.emitDashboard("mail")
      await expect(bar).toHaveCount(0, { timeout: 20_000 })
      await expect(chip("i-unread-1")).not.toHaveAttribute("data-unread", "true")
      await page.unroute("**/es/api/mail/wake**")
      for (const id of ["i-unread-1", "i-unread-2"]) Object.assign(records.find((item) => item.id === id).deliveries[0], { state: "recorded", tick: "recorded", presented_ms: null })

      // A refused wake (no operator connection) says so and offers Retry; nothing is marked read.
      wake = state("none", null)
      post = () => ({ status: 403, body: { error: "operator required" } })
      fixture.emitDashboard("mail")
      await expect(bar.locator(".mail-wake-now")).toHaveText("Wake now", { timeout: 20_000 })
      await expect(chip("i-unread-1").locator(".mail-unread-wake")).toHaveText("No wake scheduled · read on the agent's next turn")
      await bar.locator(".mail-wake-now").click()
      await expect(bar.locator(".mail-wake-error")).toHaveText("Couldn't wake: operator connection unavailable")
      await expect(bar.locator(".mail-wake-now")).toHaveText("Retry")
      await expect(chip("i-unread-1")).toHaveAttribute("data-unread", "true")

      // Paused (passive review off): the line says so and the button delivers without claiming the schedule resumed.
      wake = state("paused", { reason: "passive-review-off", at_ms: null, count: 2 })
      fixture.emitDashboard("mail")
      await expect(chip("i-unread-1").locator(".mail-unread-wake")).toHaveText("Agent paused · no wake scheduled", { timeout: 20_000 })
      await expect(bar.locator(".mail-wake-now")).toHaveAttribute("title", /without resuming the schedule/)

      // Blocked (no owner): no button, the reason in words.
      wake = state("blocked", { reason: "no-owner-session", at_ms: null })
      fixture.emitDashboard("mail")
      await expect(bar.locator(".mail-wake-blocked")).toHaveText("Blocked: no agent owns this lane", { timeout: 20_000 })
      await expect(bar.locator(".mail-wake-now")).toHaveCount(0)
      await expect(chip("i-unread-1").locator(".mail-unread-wake")).toHaveText("Blocked: no agent owns this lane")

      // A dashboard without the wake route: never an invented time.
      fixture.mailWake = undefined
      fixture.emitDashboard("mail")
      await expect(chip("i-unread-1").locator(".mail-unread-wake")).toHaveText("Next wake not available", { timeout: 20_000 })
      await page.screenshot({ path: join(shots, "unavailable.png") })
      fixture.mailWake = (method) => method === "GET" ? { body: wake } : post()
      wake = state("scheduled", { reason: "passive-review", at_ms: Date.now() + 12 * 60_000 + 20_000, count: 2 })
    }
    await context.close()
  }
  // No timer reads: wake state is read on mail revisions only.
  const reads = fixture.calls.filter((call) => call.path === "/api/mail/wake" && call.method === "GET").length
  expect(reads).toBeGreaterThan(0)
  expect(errors).toEqual([])
  // Writes: only Wake now posts (the 403 retry scenario counts one).
  expect(fixture.calls.filter((call) => !["GET", "HEAD", "OPTIONS"].includes(call.method) && call.path !== "/api/mail/wake")).toEqual([])
  console.log(`PASS mail ticks: sending/queued ✓, inbox ✓✓ grey (wake in hover), presented ✓✓ accent, failed !, lowest of two recipients, cross-host + successor recipients; unread dot + scheduler line (scheduled/none/paused/blocked/unavailable); one Wake now bar above the composer; repeated clicks while busy post once; refused wake says so with Retry; LTR/RTL; screenshots ${shots}`)
} finally {
  await browser.close()
  await preview.close()
}
