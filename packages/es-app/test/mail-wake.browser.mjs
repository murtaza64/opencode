import { createRequire } from "node:module"
import { mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { startPanelPreview } from "./composer-panel-preview.mjs"

// Mail chips carry a wordless wake cue from typed evidence (CHAT-PARTS §4): only `caused` draws attention.
const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const shots = process.env.SCREENSHOT_DIR ?? join(tmpdir(), "es-app-mail-wake")
mkdirSync(shots, { recursive: true })
const preview = await startPanelPreview()
const fixture = preview.fixture
fixture.status = "idle"
const directory = `${fixture.editspaces[0].root}/lanes/squadron-v2/repos/org/repo`
const at = Date.parse("2026-10-20T12:00:00Z")
fixture.sessionIDs = ["ses_a", "ses_relay"]
fixture.sessionTitles.set("ses_a", "Tether").set("ses_relay", "Relay")
fixture.sessionTimes.set("ses_a", { created: at, updated: at + 60_000 })
fixture.laneOwners = [{ lane: "squadron-v2", owner: "ses_a" }, { lane: "orchestrator", owner: "ses_relay" }]
const delivery = (message_id, recipient, sessionID, extra) => ({ message_id, recipient, session: sessionID, mode: "actionable", state: "handled",
  request_id: null, error: null, presented_at: null, handled_at: null, ...extra })
const mail = (id, offset, from, to, direction, extra) => ({ id, ts: new Date(at + offset).toISOString(), created_ms: at + offset, from, to, direction,
  kind: "notice", text: `Body of ${id}`, ...extra })
const incoming = (id, offset, extra) => mail(id, offset, "orchestrator", "squadron-v2", "received",
  { sender_session: "ses_relay", deliveries: [delivery(id, "squadron-v2", "ses_a", extra)] })
const records = [
  incoming("caused", 1000, { wake: "caused", wake_observations: [{ outcome: "scheduled", observedAt: at + 1000 }] }),
  incoming("joined", 2000, { wake: "joined" }),
  incoming("none", 3000, { mode: "passive", state: "recorded", wake: "none" }),
  incoming("unknown", 4000, { wake: "unknown" }),
  // An older dashboard reports no typed evidence: no cue, even with a scheduling observation.
  incoming("legacy", 5000, { wake_observations: [{ outcome: "scheduled", observedAt: at + 5000 }] }),
  mail("out-caused", 6000, "squadron-v2", "orchestrator", "sent",
    { sender_session: "ses_a", deliveries: [delivery("out-caused", "orchestrator", "ses_relay", { wake: "caused" })] }),
]
fixture.mail = (es, recipient) => ({ editspace: es, lane: recipient === "squadron-v2" ? recipient : "", messages: records })
const base = { sessionID: "ses_a", agent: "build", model: { providerID: "fixture", modelID: "test" } }
fixture.messages = [
  { info: { ...base, id: "msg_001", role: "user", time: { created: at + 500 } },
    parts: [{ id: "prt_001", messageID: "msg_001", sessionID: "ses_a", type: "text", text: "Human prompt" }] },
]
const browser = await chromium.launch({ headless: true,
  ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : { channel: "chrome" }) })
const errors = []
const chip = (page, id) => page.locator(`.transcript [data-mail-id="${id}"] .mail-activity-summary`)
try {
  for (const dir of ["ltr", "rtl"]) {
    const context = await browser.newContext({ viewport: { width: 900, height: 900 } })
    if (dir === "rtl") await context.addInitScript(() => document.addEventListener("DOMContentLoaded", () => { document.documentElement.dir = "rtl" }))
    const page = await context.newPage()
    page.on("pageerror", (error) => errors.push(error.message))
    await page.goto(`${preview.origin}/session/ses_a?directory=${encodeURIComponent(directory)}`)
    await expect(chip(page, "out-caused")).toBeVisible()

    // Glyphs: filled bolt for caused, hollow dot for unknown, nothing otherwise.
    await expect(chip(page, "caused").locator('.mail-activity-wake[data-wake="caused"]')).toHaveCount(1)
    await expect(chip(page, "out-caused").locator('.mail-activity-wake[data-wake="caused"]')).toHaveCount(1)
    await expect(chip(page, "unknown").locator('.mail-activity-wake[data-wake="unknown"]')).toHaveCount(1)
    for (const id of ["joined", "none", "legacy"]) await expect(chip(page, id).locator(".mail-activity-wake")).toHaveCount(0)

    // Words live only in the tooltip and accessible label, never in the collapsed text.
    const labels = { caused: "Woke this agent", joined: "Arrived while this agent was working", none: "Recorded, did not wake",
      unknown: "Wake not confirmed", "out-caused": "Woke Relay" }
    for (const [id, label] of Object.entries(labels)) {
      await expect(chip(page, id)).toHaveAttribute("title", new RegExp(`· ${label}$`))
      await expect(chip(page, id)).toHaveAttribute("aria-label", new RegExp(`, ${label}$`))
      await expect(chip(page, id)).not.toContainText(label)
    }
    await expect(chip(page, "legacy")).not.toHaveAttribute("aria-label", /wake|Woke/i)
    for (const id of [...Object.keys(labels), "legacy"]) await expect(chip(page, id)).not.toContainText(/passive|wake|scheduled/i)

    // Only caused draws attention: heavier party; none and unknown are muted; all chips keep one height.
    const weight = (id) => chip(page, id).locator(".mail-activity-party").evaluate((element) => getComputedStyle(element).fontWeight)
    expect(await weight("caused")).toBe("600")
    expect(await weight("joined")).not.toBe("600")
    const color = (id) => chip(page, id).locator(".mail-activity-purpose").evaluate((element) => getComputedStyle(element).color)
    expect(await color("none")).not.toBe(await color("joined"))
    expect(await color("unknown")).toBe(await color("none"))
    const heights = await Promise.all(["caused", "joined", "none", "unknown", "legacy"].map(async (id) => Math.round((await chip(page, id).boundingBox()).height)))
    expect(new Set(heights).size).toBe(1)

    // The glyph sits before the party in reading order.
    const glyph = await chip(page, "caused").locator(".mail-activity-wake").boundingBox()
    const party = await chip(page, "caused").locator(".mail-activity-party").boundingBox()
    if (dir === "ltr" ? glyph.x > party.x : glyph.x < party.x) throw new Error(`wake glyph not before the party (${dir})`)

    // The expansion states the typed evidence per recipient.
    await chip(page, "none").click()
    await expect(page.locator('.transcript [data-mail-id="none"] .mail-activity-details')).toContainText("Wake: none · Recorded, did not wake")
    await chip(page, "legacy").click()
    await expect(page.locator('.transcript [data-mail-id="legacy"] .mail-activity-details')).not.toContainText("Wake:")
    await page.screenshot({ path: join(shots, `mail-wake-${dir}.png`) })
    await context.close()
  }
  expect(errors).toEqual([])
  expect(fixture.calls.filter((call) => !["GET", "HEAD", "OPTIONS"].includes(call.method))).toEqual([])
  console.log(`PASS mail wake: caused/joined/none/unknown/legacy cues, tooltip + aria words only, emphasis, equal heights, expansion evidence, LTR/RTL; screenshots ${shots}`)
} finally {
  await browser.close()
  await preview.close()
}
