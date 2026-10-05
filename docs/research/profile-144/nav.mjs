// Browser-side navigation profile for dotfiles#144 against a live es-app
// origin. Read-only: every non-GET request is aborted; only counters leave the
// page (timings, byte counts, node counts, error banner presence). No message
// bodies are written anywhere.
//
// usage: ES_APP_URL=http://127.0.0.1:3181 SMALL=<id>@<dir> LARGE=<id>@<dir> \
//        node docs/research/profile-144/nav.mjs [--rounds 3] [--tabs 1] [--ua-electron]
import { createRequire } from "node:module"
// PLAYWRIGHT_DIR lets an uninstalled lane borrow the root repo's resolved package.
const { chromium } = createRequire(
  process.env.PLAYWRIGHT_DIR ? `${process.env.PLAYWRIGHT_DIR}/package.json` : new URL("../../../packages/app/package.json", import.meta.url),
)("@playwright/test")

const arg = (name, fallback) => {
  const i = process.argv.indexOf(name)
  return i === -1 ? fallback : process.argv[i + 1]
}
const app = new URL(process.env.ES_APP_URL ?? "http://127.0.0.1:3181")
if (app.hostname !== "127.0.0.1") throw new Error("loopback only")
const rounds = Number(arg("--rounds", 3))
const tabs = Number(arg("--tabs", 1))
const uaElectron = process.argv.includes("--ua-electron")
const parse = (value) => {
  const [id, dir] = value.split("@")
  return { id, dir }
}
const targets = { small: parse(process.env.SMALL), large: parse(process.env.LARGE) }
const sessionUrl = (t) => new URL(`/session/${t.id}?directory=${encodeURIComponent(t.dir)}`, app).href

const BANNERS = [
  "Could not load session relationships",
  "Session connection lost",
  "Activity connection lost",
  "Unable to load session",
  "Unable to connect to session",
  "Unable to refresh activity",
]

const browser = await chromium.launch({ channel: "chrome", headless: true })
const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
  ...(uaElectron ? { userAgent: "Mozilla/5.0 (Macintosh) Chrome/130.0.0.0 Electron/33.0.0 Safari/537.36" } : {}),
})
const blocked = []
await context.route("**/*", (route) => {
  const req = route.request()
  const url = new URL(req.url())
  if (url.origin !== app.origin || req.method() !== "GET") {
    blocked.push(`${req.method()} ${url.pathname}`)
    return route.abort()
  }
  return route.continue()
})

const instrument = async (page) =>
  page.evaluate(() => {
    window.__p?.observer?.disconnect()
    performance.setResourceTimingBufferSize(10000)
    window.__p = { longTasks: [], start: performance.now() }
    window.__p.observer = new PerformanceObserver((list) => window.__p.longTasks.push(...list.getEntries().map((e) => Math.round(e.duration))))
    window.__p.observer.observe({ type: "longtask" })
  })

const collect = async (page, start, banners) =>
  page.evaluate(
    ({ start, banners }) => {
      const res = performance.getEntriesByType("resource").filter((e) => e.startTime >= start)
      const api = res.filter((e) => /\/(oc|es)\//.test(e.name))
      const bucket = (re) => api.filter((e) => re.test(e.name))
      const sum = (list, f) => Math.round(list.reduce((a, e) => a + f(e), 0))
      const describe = (list) => ({
        n: list.length,
        bytes: sum(list, (e) => e.transferSize || e.encodedBodySize || 0),
        ms_max: Math.round(Math.max(0, ...list.map((e) => e.responseEnd - e.startTime))),
        queue_ms_max: Math.round(Math.max(0, ...list.map((e) => (e.requestStart || e.fetchStart) - e.startTime))),
      })
      const text = document.body.innerText
      const mem = performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null
      return {
        api_total: describe(api),
        messages: describe(bucket(/\/message\?/)),
        session_list: describe(bucket(/experimental\/session/)),
        status: describe(bucket(/session\/status/)),
        perm_q: describe(bucket(/\/(permission|question)\?/)),
        es_state: describe(bucket(/\/es\/api\/state/)),
        long_tasks: window.__p.longTasks.filter((d) => d >= 50),
        long_task_ms: window.__p.longTasks.reduce((a, b) => a + b, 0),
        heap_mb: mem,
        dom_nodes: document.querySelectorAll("*").length,
        user_nodes: document.querySelectorAll('[data-component="user-message"]').length,
        banners: banners.filter((b) => text.includes(b)),
      }
    },
    { start, banners },
  )

const waitForTranscript = async (page) => {
  const t0 = Date.now()
  await page.waitForFunction(() => document.querySelectorAll('[data-component="user-message"]').length > 0, null, { timeout: 60000 }).catch(() => {})
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
  return Date.now() - t0
}

const results = []
const pages = []
for (let i = 0; i < tabs; i++) pages.push(await context.newPage())
const page = pages[0]
const errors = []
page.on("pageerror", (e) => errors.push(e.message))
page.on("requestfailed", (r) => { if (r.url().startsWith(app.origin)) errors.push(`requestfailed ${new URL(r.url()).pathname} ${r.failure()?.errorText}`) })
page.on("response", (r) => { if (r.url().startsWith(app.origin) && r.status() >= 400) errors.push(`HTTP ${r.status()} ${new URL(r.url()).pathname}`) })

// cold load of the app shell on the small session (background tabs sit on the large session)
for (const extra of pages.slice(1)) await extra.goto(sessionUrl(targets.large), { waitUntil: "domcontentloaded" })
const coldStart = Date.now()
await page.goto(sessionUrl(targets.small), { waitUntil: "domcontentloaded" })
await instrument(page)
const coldPaint = await waitForTranscript(page)
await page.waitForTimeout(1500)
results.push({ phase: "cold-load", target: "small", paint_ms: coldPaint, wall_ms: Date.now() - coldStart, ...(await collect(page, 0, BANNERS)) })

const order = ["large", "small", "large", "small"]
for (let round = 0; round < rounds; round++) {
  for (const name of order) {
    const t = targets[name]
    const start = await page.evaluate(() => performance.now())
    await instrument(page)
    const wall0 = Date.now()
    await page.evaluate((href) => {
      const a = document.createElement("a")
      a.href = href
      document.body.appendChild(a)
      a.click()
      a.remove()
    }, sessionUrl(t))
    const paint = await waitForTranscript(page)
    await page.waitForTimeout(1200)
    results.push({ phase: `nav-r${round}`, target: name, paint_ms: paint, wall_ms: Date.now() - wall0, ...(await collect(page, start, BANNERS)) })
  }
}
// idle soak: do banners appear without navigation?
const soakStart = await page.evaluate(() => performance.now())
await instrument(page)
await page.waitForTimeout(Number(arg("--soak-ms", 20000)))
results.push({ phase: "idle-soak", target: "small", ...(await collect(page, soakStart, BANNERS)) })

const fmt = (d) => `${d.n}x/${(d.bytes / 1024).toFixed(0)}KB/max${d.ms_max}ms/q${d.queue_ms_max}`
for (const r of results)
  console.log(
    `${r.phase.padEnd(10)} ${r.target.padEnd(5)} paint=${String(r.paint_ms ?? "-").padStart(5)}ms api=${fmt(r.api_total)} msgs=${fmt(r.messages)} list=${fmt(r.session_list)} status=${fmt(r.status)} permq=${fmt(r.perm_q)} longtasks=${r.long_tasks.length}/${r.long_task_ms}ms max=${Math.max(0, ...r.long_tasks)} heap=${r.heap_mb}MB dom=${r.dom_nodes} banners=${JSON.stringify(r.banners)}`,
  )
const red = results.some((r) => r.banners.length) || errors.length > 0
console.log(JSON.stringify({ summary: true, red, errors: errors.slice(0, 20), blocked_mutations: blocked.slice(0, 10), tabs, ua_electron: uaElectron }))
await browser.close()
process.exit(red ? 1 : 0)
