// Request-rate guard for the remote web client (agents.murtaza.earth storm, orchestrator #801):
// the real es-app web bundle served through the real pairing gateway, fixture Core/dashboard.
// Counts backend requests per path while the page is idle, under dashboard/Core events, across
// event-stream drops, hidden/visible and backend errors. Fails if any path exceeds its budget.
// Run from packages/es-android after `bun run build:web`: bun scripts/request-rate.ts [--seconds 30]
import { existsSync } from "node:fs"
import path from "node:path"
import { createRequire } from "node:module"
import { parseArgs } from "node:util"
import { createPairingCode } from "../../es-desktop/src/pairing"
import { startGateway } from "../src/gateway"
// @ts-expect-error untyped fixture module shared with es-app browser tests
import { createFixture, directory, session } from "../../es-app/test/composer-fixture.mjs"

const args = parseArgs({ options: { seconds: { type: "string", default: "30" }, assert: { type: "boolean", default: false } } })
const SECONDS = Number(args.values.seconds)
const root = path.resolve(import.meta.dir, "../dist/renderer")
if (!existsSync(path.join(root, "index.html"))) throw new Error("Run `bun run build:web` first")
const { chromium } = createRequire(path.resolve(import.meta.dir, "../../app/package.json"))("@playwright/test")

const fixture = await createFixture()
fixture.status = "busy"
fixture.mail = (_: string, lane: string) => ({ editspace: "fixture", lane, messages: [] })
fixture.workspaceSessions = Array.from({ length: 30 }, (_, index) => ({ ...session(`ses_w${index}`), title: `Worker ${index}`, directory,
  time: { created: Date.now() - index * 60_000, updated: Date.now() - index * 1000 } }))
const code = createPairingCode()
const gateway = await startGateway({ host: "127.0.0.1", port: 0, code, root, opencode: fixture.url, dashboard: fixture.url })
const browser = await chromium.launch({ channel: "chrome", headless: true })
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
const page = await context.newPage()

const count = () => {
  const counts = new Map<string, number>()
  for (const call of fixture.calls as { method: string; path: string }[])
    counts.set(`${call.method} ${call.path.replace(/ses_\w+/g, ":id")}`, (counts.get(`${call.method} ${call.path.replace(/ses_\w+/g, ":id")}`) ?? 0) + 1)
  return counts
}
const phase = async (name: string, act: () => Promise<void> | void, seconds = SECONDS) => {
  fixture.calls.length = 0
  const started = Date.now()
  await act()
  while (Date.now() - started < seconds * 1000) await page.waitForTimeout(250)
  const elapsed = (Date.now() - started) / 1000
  const rates = Object.fromEntries([...count()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([key, value]) => [key, Math.round((value / elapsed) * 60)]))
  console.log(JSON.stringify({ phase: name, seconds: Math.round(elapsed), per_minute: rates }))
  return count()
}
// Budgets in requests per minute. Dashboard events say only "changed"; the client coalesces them to
// at most one snapshot refetch per resource per second however fast events arrive (es-app
// coalesced.ts), so each budget is that cap plus slack, independent of the event rate.
const budget = { "GET /api/mail": 70, "GET /api/state": 70, "GET /api/handoffs": 70 }
const failures: string[] = []
const check = (name: string, counts: Map<string, number>, seconds: number) => {
  for (const [key, limit] of Object.entries(budget)) {
    const rate = ((counts.get(key) ?? 0) / seconds) * 60
    if (rate > limit) failures.push(`${name}: ${key} ${Math.round(rate)}/min > ${limit}/min`)
  }
}
let ticker: ReturnType<typeof setInterval> | undefined
try {
  await page.goto(`${gateway.origin}/`, { timeout: 300_000 })
  await page.fill("input[name=code]", code)
  await Promise.all([page.waitForNavigation({ timeout: 120_000 }), page.locator("form").evaluate((form) => (form as HTMLFormElement).submit())])
  await page.goto(`${gateway.origin}/session/ses_a?directory=${encodeURIComponent(directory)}`, { timeout: 300_000 })
  await page.waitForTimeout(5000)
  console.log(JSON.stringify({ loaded: page.url(), title: await page.title(), sidebar: await page.locator(".nav-item").count(), calls: fixture.calls.length }))
  check("idle", await phase("idle", () => {}), SECONDS)
  check("mail+refresh events", await phase("mail+refresh events", () => {
    // Dashboard events at a busy-editspace rate: mail every 2 s, refresh every 1 s.
    let tick = 0
    ticker = setInterval(() => fixture.emitDashboard(++tick % 2 ? "refresh" : "mail"), 1000)
  }), SECONDS)
  clearInterval(ticker)
  // The live storm: on Linux the dashboard turned its own reads of mail files into "mail" events.
  // Reproduce that feedback here: every GET /api/mail answer emits another "mail" event.
  let feedback = false
  const push = fixture.calls.push.bind(fixture.calls)
  fixture.calls.push = (...calls: { method: string; path: string }[]) => {
    if (feedback && calls.some((call) => call.method === "GET" && call.path === "/api/mail"))
      setTimeout(() => { for (let index = 0; index < 5; index++) fixture.emitDashboard("mail") }, 5)
    return push(...calls)
  }
  check("read->event feedback", await phase("read->event feedback", () => { feedback = true; fixture.emitDashboard("mail") }), SECONDS)
  feedback = false
  await page.waitForTimeout(3000)
  check("stream drops", await phase("stream drops", () => {
    ticker = setInterval(() => { for (const [response] of fixture.eventStreams) response.end() }, 3000)
  }), SECONDS)
  clearInterval(ticker)
  check("backend 502", await phase("backend 502", async () => {
    await page.route("**/es/api/**", (route) => route.request().url().includes("/events") ? route.continue() : route.fulfill({ status: 502, body: "{}" }))
  }), SECONDS)
  await page.unroute("**/es/api/**")
  check("hidden", await phase("hidden", async () => {
    await page.evaluate(() => { Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true }); document.dispatchEvent(new Event("visibilitychange")) })
  }), SECONDS)
  console.log(JSON.stringify({ failures }))
  if (args.values.assert && failures.length) process.exitCode = 1
} finally {
  clearInterval(ticker)
  await browser.close()
  await gateway.close()
  await fixture.close()
}
