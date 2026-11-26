// What a prompt was looking at: one quiet line per attached context part under the user bubble, linked to that exact
// revision. Frames: node test/context-line.browser.mjs --shots <dir>
import { createRequire } from "node:module"
import { mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { startPanelPreview } from "./composer-panel-preview.mjs"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const shots = process.argv.includes("--shots") ? process.argv[process.argv.indexOf("--shots") + 1] : `${tmpdir()}/context-line-frames`
mkdirSync(shots, { recursive: true })
const preview = await startPanelPreview()
const fixture = preview.fixture
fixture.status = "idle"
const directory = `${fixture.editspaces[0].root}/lanes/ux-impl/repos/org/repo`
const at = Date.parse("2026-11-05T06:40:00Z")
fixture.sessionIDs = ["ses_a"]
fixture.sessionTitles.set("ses_a", "Context lines")
fixture.sessionTimes.set("ses_a", { created: at, updated: at + 60_000 })
const base = { sessionID: "ses_a", agent: "build", model: { providerID: "fixture", modelID: "test" } }
const part = (id, messageID, text, metadata) => ({ id, messageID, sessionID: "ses_a", type: "text", text, synthetic: true, metadata })
const source = "es-app/mention"
fixture.messages = [
  // Sent from the reader's Message owner: "While looking at", linked to the exact revision.
  { info: { ...base, id: "msg_001", role: "user", time: { created: at } },
    parts: [
      { id: "prt_001", messageID: "msg_001", sessionID: "ses_a", type: "text", text: "Is the fixture column right?" },
      part("prt_002", "msg_001", "Context the person attached: surface fixture-report \"Fixture report\" …\nReference: {\"kind\":\"surface\"}", {
        source, key: "surface:mini:fixture-report", origin: "reader", kind: "surface", label: "Fixture report", revision: 3,
        href: "/?item=mini~surface%3Afixture-report&rev=3", asOf: "2026-11-05T06:39:00.000Z" }),
    ] },
  { info: { id: "msg_002", sessionID: "ses_a", role: "assistant", parentID: "msg_001", agent: "build", mode: "build", providerID: "fixture", modelID: "test",
    path: { cwd: directory, root: directory }, cost: 0, finish: "stop", tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: at + 100, completed: at + 200 } },
    parts: [{ id: "prt_003", messageID: "msg_002", sessionID: "ses_a", type: "text", text: "Checked." }] },
  // Explicit @ chips: "About", with a revision only where the item has one; three parts fold the extra one.
  { info: { ...base, id: "msg_003", role: "user", time: { created: at + 5000 } },
    parts: [
      { id: "prt_004", messageID: "msg_003", sessionID: "ses_a", type: "text", text: "Compare these." },
      part("prt_005", "msg_003", "Context the person attached: decision d1 …", {
        source, key: "decision:mini:d1", origin: "chip", kind: "decision", label: "Keep the middle column?", revision: 7,
        href: "/?item=mini~attention%3Afixture%3Ad1&rev=7", asOf: "2026-11-05T06:39:30.000Z" }),
      part("prt_006", "msg_003", "Context the person attached: agent for lane fixture …", {
        source, key: "agent:mini:es/fixture", origin: "chip", kind: "agent", label: "fixture lane", href: "/session/ses_a?directory=%2Ftmp", asOf: "unknown" }),
      part("prt_007", "msg_003", "Context the person attached: session ses_b …", {
        source, key: "session:mini:ses_b", origin: "chip", kind: "session", label: "Earlier thread", href: "/session/ses_b?directory=%2Ftmp", asOf: "2026-11-05T06:39:40.000Z" }),
    ] },
]
const browser = await chromium.launch({ channel: "chrome", headless: true })
const errors = []
try {
  for (const rtl of [false, true]) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } })
    if (rtl) await context.addInitScript(() => document.addEventListener("DOMContentLoaded", () => { document.documentElement.dir = "rtl" }))
    const page = await context.newPage()
    page.on("pageerror", error => errors.push(error.message))
    await page.goto(`${preview.origin}/session/ses_a?directory=${encodeURIComponent(directory)}`, { timeout: 120_000 })
    const readerWrap = page.locator('[data-user-prompt="msg_001"]')
    const chipWrap = page.locator('[data-user-prompt="msg_003"]')
    // One line, reading as what he was looking at, with the revision.
    const line = readerWrap.locator(".msg-context")
    await expect(line).toHaveCount(1)
    await expect(line).toHaveText(/While looking at\s*Fixture report\s*·\s*r3\s*↗/)
    await expect(line.locator("a")).toHaveAttribute("href", "/?item=mini~surface%3Afixture-report&rev=3")
    await expect(line.locator("a")).toHaveAttribute("title", "At 2026-11-05T06:39:00.000Z")
    await expect(line.locator("a")).toHaveAttribute("aria-label", /While looking at Fixture report, revision 3\. At .* Open in the reader/)
    // Quiet: no box, no chip border, the sub colour, 12px.
    const style = await line.locator("a").evaluate(element => {
      const own = getComputedStyle(element)
      const probe = document.body.appendChild(document.createElement("span"))
      probe.style.color = "var(--subtext0)"
      const sub = getComputedStyle(probe).color
      probe.remove()
      return { size: own.fontSize, color: own.color, sub, border: own.borderTopWidth, background: own.backgroundColor }
    })
    if (style.size !== "12px" || style.color !== style.sub || style.border !== "0px" || style.background !== "rgba(0, 0, 0, 0)") throw Error(`context line is not quiet ${JSON.stringify(style)}`)
    // @ chips: "About", the revision only where the item has one, and at most two lines then "+1 more".
    const chips = chipWrap.locator(".msg-context")
    await expect(chips).toHaveCount(3)
    await expect(chips.nth(0)).toHaveText(/About\s*Keep the middle column\?\s*·\s*r7\s*↗/)
    await expect(chips.nth(1)).toHaveText(/About\s*fixture lane\s*↗/)
    await expect(chips.nth(1).locator("a")).toHaveAttribute("title", "Capture time not recorded")
    await expect(chips.nth(2)).toHaveText("+1 more")
    await expect(chips.nth(2)).not.toHaveAttribute("href", /.+/)
    // The tick shares the last context row: no separate tick row, and the mark sits beside that line.
    for (const wrap of [readerWrap, chipWrap]) {
      await expect(wrap.locator(".msg-tick-row")).toHaveCount(0)
      const row = await wrap.locator(".msg-context-row").last().evaluate(element => {
        const line = element.querySelector(".msg-context")
        const tick = element.querySelector(".msg-tick")
        if (!line || !tick) return { missing: true }
        const a = line.getBoundingClientRect()
        const b = tick.getBoundingClientRect()
        return { lineTop: a.top, tickTop: b.top, rtl: getComputedStyle(document.documentElement).direction === "rtl",
          lineEnd: getComputedStyle(document.documentElement).direction === "rtl" ? a.left : a.right,
          tickEnd: getComputedStyle(document.documentElement).direction === "rtl" ? b.right : b.left }
      })
      if (row.missing) throw Error("tick is not on the last context row")
      // Same line box (baselines within a few px) and the inline-end edge on the outside.
      if (Math.abs(row.lineTop - row.tickTop) > 6) throw Error(`tick not on the context line ${JSON.stringify(row)}`)
      if (row.rtl ? row.lineEnd < row.tickEnd : row.lineEnd > row.tickEnd) throw Error(`tick not at the inline-end of the line ${JSON.stringify(row)}`)
    }
    // Nothing spills past the pane in either direction.
    const overflow = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, width: window.innerWidth }))
    if (overflow.scroll > overflow.width) throw Error(`context line overflow ${JSON.stringify(overflow)}`)
    // The bubble's own text is unchanged: the context parts stay hidden as parts.
    await expect(readerWrap).toContainText("Is the fixture column right?")
    await expect(readerWrap).not.toContainText("Context the person attached")
    if (!rtl) {
      await page.setViewportSize({ width: 1280, height: 1000 })
      await readerWrap.screenshot({ path: `${shots}/1-reader-origin.png` })
      await chipWrap.screenshot({ path: `${shots}/2-chip-lines.png` })
      await page.setViewportSize({ width: 390, height: 844 })
      await chipWrap.scrollIntoViewIfNeeded()
      await chipWrap.screenshot({ path: `${shots}/3-phone.png` })
      const fit = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, width: window.innerWidth }))
      if (fit.scroll > fit.width) throw Error(`phone overflow ${JSON.stringify(fit)}`)
    } else {
      await readerWrap.screenshot({ path: `${shots}/4-rtl.png` })
    }
    await context.close()
  }
  if (errors.length) throw Error(errors.join("\n"))
  console.log(`PASS context lines: "While looking at” with r3 and the exact-revision reader link, @ chips read “About” (revision only where the item has one), at most two lines then “+1 more”, 12px/sub-colour/no box, asOf in the hover and name, aligned with the tick in LTR and RTL, no overflow at 390px, the agent's text unchanged. Frames: ${shots}`)
} finally {
  await browser.close()
  await preview.close()
}
