import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"
import { createServer } from "vite"
import { createFixture, directory } from "./composer-fixture.mjs"
import { createLargeHistory, withoutSummaryPatches } from "./large-history-fixture.mjs"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const fixture = await createFixture()
fixture.status = "idle"
fixture.permissions = []
const history = createLargeHistory()
process.env.OPENCODE_URL = process.env.ES_DASHBOARD_URL = fixture.url
const vite = await createServer({
  root: fileURLToPath(new URL("..", import.meta.url)),
  server: { host: "127.0.0.1", port: 0 },
})
await vite.listen()
const origin = `http://127.0.0.1:${vite.httpServer.address().port}`
const browser = await chromium.launch({ channel: "chrome", headless: true })
try {
  // Full wire simulates an older backend; both modes use the current client's metadata projection.
  for (const mode of process.env.HISTORY_MODE ? [process.env.HISTORY_MODE] : ["full", "wire-small"]) {
    fixture.messages = mode === "wire-small" ? withoutSummaryPatches(history) : history
    const context = await browser.newContext({
      userAgent: "Mozilla/5.0 Electron/40.0",
      viewport: { width: 1440, height: 1000 },
    })
    try {
      await context.addInitScript(() => {
        const original = window.fetch
        window.measurements = { reads: [], pending: 0 }
        window.fetch = async (...args) => {
          const url = new URL(args[0] instanceof Request ? args[0].url : String(args[0]), location.href)
          if (!url.pathname.endsWith("/ses_a/message")) return original(...args)
          const start = performance.now()
          window.measurements.pending++
          const response = await original(...args)
          const headers = performance.now()
          response.json = async () => {
            const raw = await response.text()
            const body = performance.now()
            const messages = JSON.parse(raw)
            const json = performance.now()
            window.measurements.reads.push({
              headersMs: Math.round(headers - start),
              bodyMs: Math.round(body - headers),
              jsonMs: Math.round(json - body),
              jsonEnd: json,
            })
            window.measurements.pending--
            return messages
          }
          return response
        }
      })
      const page = await context.newPage()
      await page.goto(`${origin}/session/ses_b?directory=${encodeURIComponent(directory)}`)
      await expect(page.locator(".topbar")).toContainText("Other session")
      const profiler = process.env.PROFILE ? await context.newCDPSession(page) : undefined
      if (profiler) {
        await profiler.send("Profiler.enable")
        await profiler.send("Profiler.start")
      }
      await page.evaluate(() => {
        window.measurements.start = performance.now()
        const observer = new MutationObserver(() => {
          if (
            !document
              .querySelector('[data-timeline-part-id="prt_msg_000359_text"]')
              ?.textContent.includes("LATEST_LARGE_HISTORY_SENTINEL")
          )
            return
          observer.disconnect()
          requestAnimationFrame(() =>
            requestAnimationFrame(() => {
              window.measurements.frame = performance.now()
            }),
          )
        })
        observer.observe(document.body, { childList: true, subtree: true, characterData: true })
        document.querySelector('.sidebar a[href*="/session/ses_a"]').click()
      })
      await page.waitForFunction(
        () => window.measurements.frame && window.measurements.pending === 0 && window.measurements.reads.length >= 2,
        undefined,
        { timeout: 30000 },
      )
      await expect(page.locator('[data-timeline-part-id="prt_msg_000359_text"]')).toBeInViewport()
      const metrics = await page.evaluate(() => ({
        firstFrameMs: Math.round(window.measurements.frame - window.measurements.start),
        firstJsonToFrameMs: Math.round(window.measurements.frame - window.measurements.reads[0].jsonEnd),
        reads: window.measurements.reads.map(({ jsonEnd, ...value }) => value),
        userMessages: document.querySelectorAll('[data-component="user-message"]').length,
        toolParts: document.querySelectorAll('[data-component="tool-part-wrapper"]').length,
        nodes: document.querySelectorAll("*").length,
        heapBytes: performance.memory?.usedJSHeapSize,
      }))
      expect(Number.isFinite(metrics.firstFrameMs)).toBe(true)
      expect(metrics.reads.length).toBeGreaterThanOrEqual(2)
      console.log(
        JSON.stringify({
          mode,
          messages: history.length,
          responseBytes: Buffer.byteLength(JSON.stringify(fixture.messages)),
          ...metrics,
        }),
      )
      if (profiler) {
        const { profile } = await profiler.send("Profiler.stop")
        const nodes = new Map(profile.nodes.map((node) => [node.id, node.callFrame]))
        const totals = new Map()
        profile.samples.forEach((id, index) => {
          const frame = nodes.get(id)
          const key = `${frame.functionName} ${frame.url.replace(origin, "")}:${frame.lineNumber}`
          totals.set(key, (totals.get(key) ?? 0) + profile.timeDeltas[index] / 1000)
        })
        console.log(JSON.stringify({ profile: [...totals].sort((a, b) => b[1] - a[1]).slice(0, 15) }))
        await profiler.detach()
      }
    } finally {
      await context.close()
    }
  }
} finally {
  await browser.close()
  await vite.close()
  await fixture.close()
}
