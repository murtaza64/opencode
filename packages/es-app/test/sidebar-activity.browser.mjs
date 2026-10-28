// Sidebar activity indicators under a live status timeline plus a transcript stream / tool burst on
// the open session. Every 250 ms samples, for the other session's sidebar row: its dot class (state)
// and whether its halo is visibly moving (computed ::after opacity/transform changes between samples).
// Pass: state matches the injected status within 1 s; while busy and visible, the indicator moves.
// Run from packages/es-app: node test/sidebar-activity.browser.mjs [--assert]
import { createRequire } from "node:module"
import { startPanelPreview } from "./composer-panel-preview.mjs"
import { directory } from "./composer-fixture.mjs"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const ASSERT = process.argv.includes("--assert")
const preview = await startPanelPreview()
const fixture = preview.fixture
// The sidebar follows the global activity stream ({ directory, payload }); the session view follows /event.
const emit = (type, properties) => {
  fixture.emit(type, properties)
  for (const [response, entry] of fixture.eventStreams)
    if (entry.path === "/global/event") response.write(`data: ${JSON.stringify({ directory, payload: { type, properties } })}\n\n`)
}
const browser = await chromium.launch({ channel: "chrome", headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
try {
  await page.goto(`${preview.url}/session/ses_a?directory=${encodeURIComponent(directory)}`, { timeout: 300_000 })
  const row = page.locator(".sidebar a, .sidebar button").filter({ hasText: "Other session" }).first()
  await expect(row).toBeVisible({ timeout: 60_000 })
  const dot = row.locator(".dot").first()
  const sample = () => dot.evaluate((node) => {
    const after = getComputedStyle(node, "::after")
    return { state: [...node.classList].find((name) => name !== "dot"), look: `${after.opacity}|${after.transform}` }
  })
  // Timeline: ses_b busy 0-6 s, idle 6-9 s, busy 9-14 s; the open session streams text and tool parts throughout.
  const timeline = [[0, "busy"], [6000, "idle"], [9000, "busy"]]
  const expected = (t) => timeline.filter(([at]) => at <= t).at(-1)[1]
  const start = Date.now()
  let next = 0
  const samples = []
  let burst = 0
  while (Date.now() - start < 14_000) {
    const t = Date.now() - start
    while (next < timeline.length && timeline[next][0] <= t) {
      emit("session.status", { sessionID: "ses_b", status: { type: timeline[next][1] } })
      next++
    }
    // Transcript stream + tool burst on the open session.
    for (let i = 0; i < 5; i++) emit("message.part.updated", { part: { id: `prt_burst_${burst % 40}`, messageID: "msg_assistant", sessionID: "ses_a", type: "tool", callID: `c${burst}`, tool: "bash",
      state: { status: "running", input: { command: `step ${burst++}` }, time: { start: Date.now() } } } })
    samples.push({ t, now: expected(t), expected: expected(Math.max(0, t - 1000)), ...(await sample()) })
    await page.waitForTimeout(250)
  }
  // Staleness: a sample at least 1 s after a status change must show that status.
  // Stale = the dot shows neither the current status nor the one from 1 s ago.
  const shows = (item, status) => status === "busy" ? item.state === "busy" : item.state !== "busy"
  const stale = samples.filter((item) => item.t > 1000 && !shows(item, item.now) && !shows(item, item.expected))
  // Motion: during each busy span (after 1 s), the indicator's look must change at least once a second.
  const busySpans = [[1000, 6000], [10_000, 14_000]]
  const motion = busySpans.map(([from, to]) => new Set(samples.filter((item) => item.t >= from && item.t < to).map((item) => item.look)).size)
  if (process.env.DUMP) console.log(samples.map((item) => `${item.t}:${item.now[0]}${item.state?.[0]}`).join(" "))
  console.log(JSON.stringify({ samples: samples.length, stale: stale.length, distinct_looks_per_busy_span: motion, first_stale: stale[0] }))
  if (ASSERT) {
    expect(stale, "sidebar state follows status within 1 s").toEqual([])
    for (const count of motion) expect(count, "busy indicator moves while visible").toBeGreaterThan(1)
    console.log("PASS sidebar activity")
  }
} finally {
  await browser.close()
  await preview.close()
}
