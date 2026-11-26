// Background request rate: Front Desk and an open session left idle and focused for one simulated hour.
// The page clock runs an hour of timers in seconds; every fixture call is counted by route. The window gets one
// focus event a minute (a user switching back to the app now and then).
// Run from packages/es-app: node test/poll-rate.mjs [--minutes 60] [--projects 8] [--dirs 10]
import { createRequire } from "node:module"
import { startPanelPreview } from "./composer-panel-preview.mjs"
import { directory } from "./composer-fixture.mjs"

const arg = (name, fallback) => { const index = process.argv.indexOf(`--${name}`); return index === -1 ? fallback : process.argv[index + 1] }
const MINUTES = Number(arg("minutes", 60)), PROJECTS = Number(arg("projects", 8)), DIRS = Number(arg("dirs", 10))
const { chromium } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const preview = await startPanelPreview()
const fixture = preview.fixture
fixture.status = "idle"
fixture.editspaces = [{ name: "fixture", root: `${directory}/.editspace` }, ...Array.from({ length: PROJECTS - 1 }, (_, index) => ({ name: `p${index}`, root: `/projects/p${index}` }))]
const now = Date.now()
fixture.workspaceSessions = Array.from({ length: DIRS * 3 }, (_, index) => ({ projectID: "fixture", version: "1", agent: "build", id: `ses_w${index}`,
  title: `Worker ${index}`, directory: index % DIRS ? `/projects/d${index % DIRS}` : directory, time: { created: now - index * 60_000, updated: now - index * 1000 } }))
const browser = await chromium.launch({ channel: "chrome", headless: true })
const routes = (from) => fixture.calls.slice(from).reduce((map, call) => {
  const key = call.path.replace(/ses_[A-Za-z0-9_]+/g, ":id")
  return map.set(key, (map.get(key) ?? 0) + 1)
}, new Map())
try {
  for (const [name, url] of [["desk", `${preview.origin}/`], ["session", `${preview.origin}/session/ses_a?directory=${encodeURIComponent(directory)}`]]) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
    await page.clock.install()
    await page.goto(url, { timeout: 300_000 })
    await page.clock.runFor(10_000)
    await page.waitForTimeout(1500)
    const from = fixture.calls.length
    for (let minute = 0; minute < MINUTES; minute++) {
      await page.clock.runFor(60_000)
      await page.evaluate(() => window.dispatchEvent(new Event("focus")))
      await page.waitForTimeout(40)
    }
    await page.waitForTimeout(1000)
    const counts = [...routes(from)].sort((a, b) => b[1] - a[1])
    const scale = 60 / MINUTES
    console.log(JSON.stringify({ page: name, minutes: MINUTES, projects: PROJECTS, dirs: DIRS, per_hour_total: Math.round(counts.reduce((sum, [, count]) => sum + count, 0) * scale),
      per_hour: Object.fromEntries(counts.slice(0, 12).map(([key, count]) => [key, Math.round(count * scale)])) }))
    await page.close()
  }
} finally {
  await browser.close()
  await preview.close()
}
