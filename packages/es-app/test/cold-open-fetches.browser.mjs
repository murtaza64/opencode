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
const page = await context.newPage()
page.on("request", (request) => {
  const url = new URL(request.url())
  if (!/^\/(oc|es)\//.test(url.pathname)) return
  const key = `${request.method()} ${url.pathname.replace(/ses_[\w-]+/g, ":id").replace(/^\/es\/api\/attention\/[0-9a-f-]{36}$/, "/es/api/attention/:id")}`
  counts[key] = (counts[key] ?? 0) + 1
})
try {
  await page.goto(`${preview.url}/session/ses_a?directory=${encodeURIComponent(directory)}`, { timeout: 300_000 })
  await page.waitForTimeout(8000)
  const total = Object.values(counts).reduce((sum, value) => sum + value, 0)
  console.log(JSON.stringify({ total, counts: Object.fromEntries(Object.entries(counts).sort((a, b) => b[1] - a[1])) }))
  if (ASSERT) {
    expect(counts["GET /oc/experimental/session"] ?? 0, "session index read once on cold open").toBeLessThanOrEqual(1)
    console.log("PASS cold open fetches")
  }
} finally {
  await browser.close()
  await preview.close()
}
