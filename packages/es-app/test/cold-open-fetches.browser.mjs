// Cold open fan-out: every request the page under test makes in its first 8 s, grouped by path.
// Gate: the session index is read once, and no path is requested more than its per-path cap.
// Prints counts so two builds can be compared. Run from packages/es-app: node test/cold-open-fetches.browser.mjs [--assert]
import { createRequire } from "node:module"
import { startAttentionPreview } from "./attention-preview.mjs"
import { directory } from "./composer-fixture.mjs"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const ASSERT = process.argv.includes("--assert")
const preview = await startAttentionPreview()
const fixture = preview.fixture
fixture.handoffs = [{ lane: "home-agents", predecessor: "ses_b", successor: "ses_a" }]
fixture.editspaces = [{ name: "fixture" }, ...Array.from({ length: 8 }, (_, index) => ({ name: `other-${index}` }))]
const browser = await chromium.launch({ channel: "chrome", headless: true })
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
await context.route("**/*", (route) => new URL(route.request().url()).origin === preview.origin ? route.continue() : route.abort())
const counts = {}
// Background reads: not needed by the open session. Their start times and overlap are tracked.
// (Other editspaces' lineage, the session index, the failure scan, the cost rollup. Per-directory status
// is excluded here: in this fixture every session shares the open session's directory.)
const BACKGROUND = /^GET \/(es\/api\/(state|handoffs)\?es=other-|oc\/experimental\/(session|session\/failed|usage\/daily)$)/
const timeline = []
let recordAt
let inFlight = 0, maxInFlight = 0
const page = await context.newPage()
page.on("request", (request) => {
  const url = new URL(request.url())
  if (!/^\/(oc|es)\//.test(url.pathname)) return
  const key = `${request.method()} ${url.pathname.replace(/ses_[\w-]+/g, ":id").replace(/^\/es\/api\/attention\/[0-9a-f-]{36}$/, "/es/api/attention/:id")}`
  counts[key] = (counts[key] ?? 0) + 1
  const full = `${key}${url.search}`
  if (BACKGROUND.test(full)) {
    timeline.push({ at: Date.now(), key })
    inFlight++
    maxInFlight = Math.max(maxInFlight, inFlight)
  }
  if (key === "GET /oc/session/:id") recordAt ??= Date.now()
})
const settle = (request) => {
  const url = new URL(request.url())
  if (BACKGROUND.test(`${request.method()} ${url.pathname}${url.search}`)) inFlight--
}
page.on("requestfinished", settle)
page.on("requestfailed", settle)
try {
  await page.goto(`${preview.url}/session/ses_a?directory=${encodeURIComponent(directory)}`, { timeout: 300_000 })
  await page.waitForTimeout(8000)
  const total = Object.values(counts).reduce((sum, value) => sum + value, 0)
  // Session record answered = target ready (Send enabled); background reads before that compete with it.
  const early = timeline.filter((item) => item.at < recordAt).length
  console.log(JSON.stringify({ total, background_before_target: early, background_max_in_flight: maxInFlight, counts: Object.fromEntries(Object.entries(counts).sort((a, b) => b[1] - a[1])) }))
  if (ASSERT) {
    expect(counts["GET /oc/experimental/session"] ?? 0, "session index read once on cold open").toBeLessThanOrEqual(1)
    expect(early, "no background read starts before the session record is requested").toBe(0)
    expect(maxInFlight, "at most 4 background reads in flight").toBeLessThanOrEqual(4)
    console.log("PASS cold open fetches")
  }
} finally {
  await browser.close()
  await preview.close()
}
