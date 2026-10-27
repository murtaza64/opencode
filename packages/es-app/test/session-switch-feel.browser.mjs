// Session switch continuity (ux-feel #759 slice). Every daemon/dashboard read is delayed to mimic a
// slow host. Measures, per switch: click -> correct header, click -> transcript content, layout
// shift (CLS) during the switch, long tasks; and that session A's content never shows under B.
// Run from packages/es-app: node test/session-switch-feel.browser.mjs [--delay 1500] [--assert]
import { createRequire } from "node:module"
import { startPanelPreview } from "./composer-panel-preview.mjs"
import { directory, session } from "./composer-fixture.mjs"

const arg = (name, fallback) => { const index = process.argv.indexOf(`--${name}`); return index === -1 ? fallback : process.argv[index + 1] }
const DELAY = Number(arg("delay", 1500)), ASSERT = process.argv.includes("--assert")
const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const preview = await startPanelPreview()
const fixture = preview.fixture
fixture.status = "idle"
const text = (id, role, words) => ({ info: role === "user"
  ? { id, sessionID: "ses_a", role, agent: "build", model: { providerID: "fixture", modelID: "test" }, time: { created: 1 } }
  : { id, sessionID: "ses_a", role, parentID: "msg_u", agent: "build", mode: "build", providerID: "fixture", modelID: "test", path: { cwd: directory, root: directory }, cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: 2, completed: 3 }, finish: "stop" },
parts: [{ id: `prt_${id}`, messageID: id, sessionID: "ses_a", type: "text", text: words }] })
fixture.messages = Array.from({ length: 40 }, (_, index) => text(`msg_${String(index).padStart(4, "0")}`, index % 2 ? "assistant" : "user", `ALPHA-${index} `.repeat(30)))
fixture.messagesB = Array.from({ length: 40 }, (_, index) => ({ ...text(`msg_b${String(index).padStart(4, "0")}`, index % 2 ? "assistant" : "user", `BRAVO-${index} `.repeat(30)),
}))
for (const message of fixture.messagesB) { message.info.sessionID = "ses_b"; message.parts[0].sessionID = "ses_b" }
fixture.sessionTitles.set("ses_a", "Alpha session")
fixture.sessionTitles.set("ses_b", "Bravo session")

const browser = await chromium.launch({ channel: "chrome", headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
const errors = []
page.on("pageerror", (error) => errors.push(error.message))
let delay = 0
await page.route(/\/(oc|es\/api)\//, async (route) => {
  const path = new URL(route.request().url()).pathname
  if (path.endsWith("/event") || path.includes("/events")) return route.continue()
  if (delay) await new Promise((resolve) => setTimeout(resolve, delay))
  return route.continue().catch(() => {})
})
await page.addInitScript(() => {
  window.__feel = { shifts: [], long: [] }
  new PerformanceObserver((list) => { for (const entry of list.getEntries()) if (!entry.hadRecentInput) window.__feel.shifts.push({ t: entry.startTime, v: entry.value,
    sources: (entry.sources ?? []).map((source) => { const node = source.node; const el = node?.nodeType === 1 ? node : node?.parentElement
      return `${el ? `${el.tagName.toLowerCase()}.${String(el.className).split(" ").slice(0, 2).join(".")}` : "?"} ${Math.round(source.previousRect.y)}->${Math.round(source.currentRect.y)} h${Math.round(source.previousRect.height)}->${Math.round(source.currentRect.height)} x${Math.round(source.previousRect.x)}->${Math.round(source.currentRect.x)} w${Math.round(source.previousRect.width)}->${Math.round(source.currentRect.width)}` }) }) }).observe({ type: "layout-shift", buffered: true })
  new PerformanceObserver((list) => { for (const entry of list.getEntries()) window.__feel.long.push({ t: entry.startTime, d: entry.duration }) }).observe({ type: "longtask", buffered: true })
})

// Click a sidebar row and time header/content from the click, sampling every frame for wrong content.
const switchTo = async (id, word, title) => page.evaluate(async ({ id, word, title }) => {
  const other = word === "ALPHA" ? "BRAVO" : "ALPHA"
  const start = performance.now()
  const result = { header: -1, content: -1, wrong: 0 }
  const removed = []
  const mo = new MutationObserver((records) => { for (const r of records) for (const n of r.removedNodes) if (n.nodeType === 1 && (n.matches?.("[data-find-message]") || n.querySelector?.("[data-find-message]"))) removed.push(`${Math.round(performance.now() - start)}:${n.getAttribute?.("data-find-message") ?? n.className}`) })
  mo.observe(document.body, { childList: true, subtree: true })
  document.querySelector(`.nav-item[href*="${id}"]`).click()
  await new Promise((resolve) => {
    const tick = () => {
      const now = performance.now() - start
      const main = document.querySelector(".session-main")
      const header = main?.querySelector(".topbar")?.textContent ?? ""
      const body = main?.querySelector(".transcript")?.textContent ?? ""
      if (result.header < 0 && header.includes(title)) result.header = Math.round(now)
      if (result.content < 0 && body.includes(`${word}-39`)) result.content = Math.round(now)
      if (header.includes(title) && body.includes(`${other}-`)) result.wrong++
      if (window.__debugShifts) {
        const t = main?.querySelector(".transcript")
        const rows = [...(main?.querySelectorAll("[data-find-message]") ?? [])]
        const top = t?.getBoundingClientRect().top ?? 0
        const firstVisible = rows.find((row) => row.getBoundingClientRect().bottom > top)
        const kids = (sel) => [...(document.querySelector(sel)?.querySelectorAll(":scope > *, :scope > * > *") ?? [])].filter((el) => el.getBoundingClientRect().height > 0).map((el) => `${String(el.className).split(" ")[0]}=${Math.round(el.getBoundingClientRect().height)}`).join(",")
        ;(result.frames ??= []).push(`${Math.round(now)}:[${[...(main?.children ?? [])].map((el) => `${String(el.className).split(" ")[0]}=${Math.round(el.getBoundingClientRect().height)}`).join(",")}][${[...(document.querySelector(".session-main .transcript-inner")?.children ?? [])].slice(0, 3).map((el) => `${String(el.className).split(" ")[0] || el.tagName}=${Math.round(el.getBoundingClientRect().height)}`).join(",")}][${(() => { const row = main?.querySelectorAll("[data-find-message]")[1]; const walk = (el, d) => d > 4 ? "" : [...el.children].map((c) => `${(c.getAttribute("data-component") || c.getAttribute("data-slot") || String(c.className).split(" ")[0] || c.tagName).slice(0, 24)}=${Math.round(c.getBoundingClientRect().height)}${c.children.length && d < 4 ? `{${walk(c, d + 1)}}` : ""}`).join(","); return row ? walk(row, 0) : "" })()}][w${Math.round(main?.getBoundingClientRect().width ?? 0)} info${Math.round(document.querySelector(".session-info")?.getBoundingClientRect().width ?? -1)}]`)
        ;(result.frames ??= []).push(`${Math.round(now)}:${Math.round(t?.scrollTop ?? -1)}/${t?.scrollHeight}/${rows.length}/${firstVisible?.getAttribute("data-find-message")}`)
      }
      if ((result.header >= 0 && result.content >= 0 && now > 2500) || now > 15000) return resolve()
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })
  const shifts = window.__feel.shifts.filter((entry) => entry.t >= start)
  const long = window.__feel.long.filter((entry) => entry.t >= start)
  mo.disconnect()
  if (window.__debugShifts) result.removed = removed.slice(0, 12)
  if (window.__debugShifts) result.shifts = shifts.map((entry) => `${Math.round(entry.t - start)}ms ${entry.v.toFixed(3)} ${entry.sources.join(" | ")}`)
  return { ...result, cls: Math.round(shifts.reduce((sum, entry) => sum + entry.v, 0) * 1000) / 1000, long_tasks: long.length, worst_long_ms: Math.round(Math.max(0, ...long.map((entry) => entry.d))) }
}, { id, word, title })

try {
  await page.goto(preview.url, { timeout: 300_000 })
  await expect(page.locator(".transcript")).toContainText("ALPHA-39")
  await page.waitForTimeout(1500)
  if (process.env.DEBUG_SHIFTS) await page.evaluate(() => { window.__debugShifts = true })
  delay = DELAY
  const rows = []
  rows.push({ step: "A->B first", ...(await switchTo("ses_b", "BRAVO", "Bravo session")) })
  rows.push({ step: "B->A revisit", ...(await switchTo("ses_a", "ALPHA", "Alpha session")) })
  rows.push({ step: "A->B revisit", ...(await switchTo("ses_b", "BRAVO", "Bravo session")) })
  for (const row of rows) console.log(JSON.stringify({ delay: DELAY, ...row }))
  if (ASSERT) {
    for (const row of rows) expect(row.wrong, `${row.step}: other session's content under this header`).toBe(0)
    for (const row of rows.slice(1)) {
      expect(row.content, `${row.step}: cached transcript within a frame or two`).toBeLessThan(100)
      expect(row.header, `${row.step}: header`).toBeLessThan(100)
      expect(row.cls, `${row.step}: CLS`).toBeLessThan(0.01)
    }
    console.info("PASS session switch continuity: revisit content+header < 100 ms, CLS ~0, no foreign content")
  }
  expect(errors).toEqual([])
} finally {
  await browser.close()
  await preview.close()
}
