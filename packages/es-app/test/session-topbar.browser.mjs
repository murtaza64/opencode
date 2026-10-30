// STYLE-12: the session top bar for another host's session. The title leads; the host glyph and label sit on one line
// (also when the bar is outside .session-page, as in the native title bar); at narrow widths the title truncates before
// the host label, the state never wraps. Shots before/after: desktop, narrow, 390, RTL. Run from packages/es-app.
import { createRequire } from "node:module"
import { startPanelPreview } from "./composer-panel-preview.mjs"
import { createFixture, directory } from "./composer-fixture.mjs"
import { request as httpRequest } from "node:http"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const mini = await createFixture()
const hostRoutes = {
  name: "test:hosts",
  configureServer: (server) => { server.middlewares.use((req, res, next) => {
    const match = /^\/hosts\/mini\/oc(\/.*)$/.exec(req.url ?? "")
    if (!match) return next()
    const upstream = httpRequest(`${mini.url}${match[1]}`, { method: req.method, headers: { ...req.headers, host: new URL(mini.url).host } }, (response) => { res.writeHead(response.statusCode ?? 502, response.headers); response.pipe(res) })
    upstream.on("error", () => { if (!res.headersSent) res.writeHead(502); res.end() })
    req.pipe(upstream)
  }) },
}
const preview = await startPanelPreview([hostRoutes])
mini.sessionTitles.set("ses_a", "Rotate the staging certificates before the Friday freeze and confirm the rollout")
const browser = await chromium.launch({ headless: true,
  ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : { channel: "chrome" }) })
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
page.setDefaultTimeout(60_000)
const errors = []
page.on("pageerror", (error) => errors.push(error.message))
await page.route("**/__es/host", (route) => route.fulfill({ json: { id: "local", label: "Local", remote: false, hosts: [], work: [
  { id: "local", label: "Local", origin: preview.fixture.url }, { id: "mini", label: "Mac Mini", origin: "https://mini.example.ts.net" }] } }))
await page.route("**/__es/events", (route) => route.fulfill({ json: { protocol: null } }))
const shotDir = process.env.SHOTS ?? "/tmp"
const label = process.env.LABEL ?? "after"
// The native title bar portals the bar outside .session-page; reproduce that placement with a moved copy.
const nativeCopy = () => page.evaluate(() => {
  document.querySelector(".native-copy")?.remove()
  const bar = document.querySelector(".session-page .topbar")
  const wrap = document.createElement("div")
  wrap.className = "native-header native-copy"
  wrap.style.cssText = "position:fixed;inset-block-start:0;inset-inline:0;z-index:99;display:flex;padding:6px 12px;background:var(--mantle)"
  const copy = bar.cloneNode(true)
  // As in native-header.css: the bar may shrink to the title bar's width.
  copy.style.cssText = "flex:1 1 auto;min-inline-size:0"
  wrap.append(copy)
  document.body.append(wrap)
})
const measure = (scope) => page.evaluate((scope) => {
  const bar = document.querySelector(`${scope} .topbar`)
  const r = (sel) => { const el = bar.querySelector(sel); const b = el?.getBoundingClientRect(); return b && { top: b.top, bottom: b.bottom, left: b.left, right: b.right, width: b.width, height: b.height } }
  const title = bar.querySelector(".session-title")
  return { glyph: r(".session-host .host-glyph"), label: r(".session-host bdi"), title: r(".session-title"), state: r(".session-state"), bar: (() => { const b = bar.getBoundingClientRect(); return { right: Math.min(b.right, innerWidth), left: Math.max(b.left, 0) } })(),
    titleClipped: title ? title.scrollWidth > title.clientWidth + 1 || [...title.querySelectorAll("*")].some((el) => el.scrollWidth > el.clientWidth + 1) : false }
}, scope)
const sameLine = (m) => m.glyph && m.label && Math.abs((m.glyph.top + m.glyph.bottom) / 2 - (m.label.top + m.label.bottom) / 2) <= 3
try {
  await page.goto(`${preview.origin}/session/ses_a?directory=${encodeURIComponent(directory)}&host=mini`, { waitUntil: "domcontentloaded", timeout: 300_000 })
  await expect(page.locator(".session-page .session-host")).toContainText("Mac Mini", { timeout: 120_000 })
  for (const [name, width] of [["desktop", 1280], ["narrow", 760], ["390", 390]]) {
    await page.setViewportSize({ width, height: 900 })
    await nativeCopy()
    await page.locator(".native-copy").screenshot({ path: `${shotDir}/session-topbar-${label}-${name}.png` })
    for (const scope of [".session-page", ".native-copy"]) {
      const m = await measure(scope)
      if (!sameLine(m)) throw new Error(`${label} ${name} ${scope}: host glyph and label not on one line ${JSON.stringify(m)}`)
      if (!m.state || m.state.height === 0 || m.state.height > 20) throw new Error(`${label} ${name} ${scope}: state hidden or wrapped ${JSON.stringify(m.state)}`)
      if (m.state.right > m.bar.right + 1 || m.label.right > m.bar.right + 1) throw new Error(`${label} ${name} ${scope}: host or state cut off ${JSON.stringify(m)}`)
    }
  }
  await page.evaluate(() => { document.documentElement.dir = "rtl" })
  await nativeCopy()
  const rtl = await measure(".native-copy")
  if (!sameLine(rtl)) throw new Error(`${label} rtl: host glyph and label not on one line ${JSON.stringify(rtl)}`)
  await page.locator(".native-copy").screenshot({ path: `${shotDir}/session-topbar-${label}-390-rtl.png` })
  expect(errors).toEqual([])
  console.log("session-topbar: PASS")
} finally {
  await browser.close()
  await preview.close()
  await mini.close()
}
