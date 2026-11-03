// Local time zone (es-desktop-local-timezone-20261103). The same Mini-hosted transcript read under two viewer zones:
// agent prose keeps its UTC text, and each unambiguous UTC token gets a dotted underline whose hover/description is
// the viewer's local time ("10:24Z" -> 05:24 in New York); code is left alone; a mail input's time is the viewer's.
// Run from packages/es-app: node test/local-time.browser.mjs
import { createRequire } from "node:module"
import { startPanelPreview } from "./composer-panel-preview.mjs"
import { directory } from "./composer-fixture.mjs"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const preview = await startPanelPreview()
const fixture = preview.fixture
fixture.status = "idle"
const at = Date.UTC(2026, 10, 3, 15, 24, 42)
fixture.messages = [
  { info: { id: "msg_u", sessionID: "ses_a", role: "user", agent: "build", model: { providerID: "fixture", modelID: "test" }, time: { created: at - 60_000 } },
    parts: [{ id: "prt_u", messageID: "msg_u", sessionID: "ses_a", type: "text", text: "status?" }] },
  { info: { id: "msg_a", parentID: "msg_u", sessionID: "ses_a", role: "assistant", agent: "build", mode: "build", providerID: "fixture", modelID: "test",
    path: { cwd: directory, root: directory }, time: { created: at, completed: at + 1 }, cost: 0, tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } } },
    parts: [{ id: "prt_a", messageID: "msg_a", sessionID: "ses_a", type: "text", text: "Installed at 10:24Z (release 2026-11-03T15:24:42Z). Log line: `started 10:24Z`. Ambiguous 10:24 stays." }] },
]
const browser = await chromium.launch({ channel: "chrome", headless: true })
const errors = []
try {
  for (const [zone, clock] of [["America/New_York", /0?5:24/], ["UTC", /10:24/]]) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, timezoneId: zone })
    const page = await context.newPage()
    page.setDefaultTimeout(30_000)
    page.on("pageerror", (error) => errors.push(error.message))
    await page.goto(`${preview.origin}/session/ses_a?directory=${encodeURIComponent(directory)}`, { waitUntil: "domcontentloaded", timeout: 180_000 })
    const message = page.locator('[data-find-message="msg_a"]')
    await expect(message).toContainText("Installed at 10:24Z", { timeout: 120_000 })
    const times = message.locator("abbr.utc-time")
    await expect(times).toHaveCount(2)
    // The text is unchanged; the hover gives the viewer's time.
    await expect(times.nth(0)).toHaveText("10:24Z")
    expect(await times.nth(0).getAttribute("title")).toMatch(new RegExp(`^Your time: ${clock.source}.*\\(time of day; 10:24Z is UTC\\)$`))
    await expect(times.nth(1)).toHaveText("2026-11-03T15:24:42Z")
    expect(await times.nth(1).getAttribute("title")).toMatch(zone === "UTC" ? /exact: 2026-11-03T15:24:42Z/ : /exact: 2026-11-03T10:24:42-05:00/)
    // Code and ambiguous bare times are left alone.
    await expect(message.locator("code abbr.utc-time")).toHaveCount(0)
    expect(await message.locator("code").first().textContent()).toBe("started 10:24Z")
    await context.close()
  }
  expect(errors).toEqual([])
  console.log("PASS local time: UTC tokens in prose keep their text and show the viewer's time on hover (New York 05:24, UTC 10:24; ISO with the viewer's offset); code and bare times untouched")
} finally {
  await preview.close()
  await browser.close()
}
