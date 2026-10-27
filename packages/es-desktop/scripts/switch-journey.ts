// Isolated session-switch journey against the INSTALLED renderer bundle and the live
// Core/dashboard behind GET-only gates. Headless private Chromium: no user focus,
// no writes (any non-GET is refused before reaching Core or the dashboard).
// Usage: bun scripts/switch-journey.ts <rendererRoot> <session ids...>
//   rendererRoot: the installed bundle, e.g. extract app.asar and pass app/dist/renderer.
//   PLAYWRIGHT_CHROMIUM: optional browser executable. Journal + ring land in ES_JOURNEY_OUT (default ./journey).
import { chromium } from "@playwright/test"
import { serve } from "../src/server"

const [root, ...targets] = process.argv.slice(2)
const out = process.env.ES_JOURNEY_OUT ?? `${process.cwd()}/journey`

const refused: string[] = []
const gate = (upstream: string) =>
  Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    idleTimeout: 0,
    fetch: (request) => {
      const url = new URL(request.url)
      if (!["GET", "HEAD"].includes(request.method)) {
        refused.push(`${request.method} ${url.pathname}`)
        return new Response("read-only harness", { status: 403 })
      }
      // Bound history reads: an unbounded page would stall the shared live Core.
      if (/\/session\/[^/]+\/message$/.test(url.pathname) && !url.searchParams.get("limit")) {
        refused.push(`unbounded ${url.pathname}`)
        return new Response("unbounded read refused", { status: 403 })
      }
      const headers = new Headers(request.headers)
      headers.delete("host")
      headers.delete("accept-encoding")
      return fetch(`${upstream}${url.pathname}${url.search}`, { headers, redirect: "manual", decompress: false } as RequestInit).then((response) => {
        const out = new Headers(response.headers)
        out.delete("content-encoding")
        out.delete("content-length")
        return new Response(response.body, { status: response.status, headers: out })
      })
    },
  })
const core = gate("http://127.0.0.1:4096")
const dash = gate("http://127.0.0.1:7777")
const perfDir = `${out}/journal`
const server = await serve({ root, opencode: `http://127.0.0.1:${core.port}`, dashboard: `http://127.0.0.1:${dash.port}`, perfDir })

const meta = async (id: string) => (await fetch(`http://127.0.0.1:4096/session/${id}`)).json() as Promise<{ directory: string; title: string }>
const sessions = await Promise.all(targets.map(async (id) => ({ id, ...(await meta(id)) })))

const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM })
const context = await browser.newContext({ extraHTTPHeaders: { "x-editspace-key": server.key } })
const page = await context.newPage()
const results: Record<string, unknown>[] = []
try {
  await page.goto(server.origin, { waitUntil: "domcontentloaded" })
  await page.waitForTimeout(4000)
  for (const round of [1, 2]) {
    for (const session of sessions) {
      const href = `/session/${session.id}?directory=${encodeURIComponent(session.directory)}`
      const start = Date.now()
      // In-app navigation, as a sidebar click does (no page reload).
      await page.evaluate((target) => {
        history.pushState(null, "", target)
        dispatchEvent(new PopStateEvent("popstate"))
      }, href)
      const ready = await page
        .waitForFunction(() => {
          const box = document.querySelector("textarea, [contenteditable=true]") as HTMLTextAreaElement | null
          return !!box && !box.closest("[aria-disabled=true]") && !(box as HTMLTextAreaElement).disabled
        }, undefined, { timeout: 60_000 })
        .then(() => Date.now() - start, () => -1)
      await page.waitForTimeout(1500)
      const open = await page.evaluate((id) => {
        const rows = ((window as unknown as { __esPerf?: () => Record<string, unknown>[] }).__esPerf?.() ?? [])
        return rows.filter((row) => row.kind === "session.open" && row.sessionID === id).at(-1)
      }, session.id)
      const status = await page.locator(".session-work-status").first().textContent().catch(() => null)
      results.push({ round, title: session.title.slice(0, 40), editorReadyMs: ready, open, status })
    }
  }
} finally {
  const all = await page.evaluate(() => (window as unknown as { __esPerf?: () => unknown[] }).__esPerf?.() ?? []).catch(() => [])
  await Bun.write(`${out}/ring.json`, JSON.stringify(all, null, 1))
  await browser.close()
  await server.close()
  core.stop(true)
  dash.stop(true)
}
console.log(JSON.stringify({ results, refused: [...new Set(refused)] }, null, 1))
