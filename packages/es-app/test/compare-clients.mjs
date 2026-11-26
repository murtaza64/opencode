import assert from "node:assert/strict"
import { createRequire } from "node:module"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { createServer } from "node:http"

// The fixture daemon uses a predictable tool and reply. Each client gets a fresh session.
async function compareClients({ base, home, binary }) {
  const desktopBinary = process.env.HARNESS_DESKTOP_BINARY
  const playwright = process.env.HARNESS_PLAYWRIGHT
  assert(desktopBinary && playwright, "Set HARNESS_DESKTOP_BINARY and HARNESS_PLAYWRIGHT (an app package.json)")
  const { _electron, expect } = createRequire(playwright)("@playwright/test")
  const profile = path.join(home, "desktop")
  await mkdir(profile)
  const dashboard = createServer((request, response) => {
    if (request.url?.split("?")[0] !== "/api/editspaces") { response.writeHead(404).end(); return }
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ editspaces: [], default: null }))
  })
  await new Promise((resolve, reject) => dashboard.once("error", reject).listen(0, "127.0.0.1", resolve))
  const app = await _electron.launch({ timeout: 12000, executablePath: desktopBinary, args: ["--use-mock-keychain"], env: {
    PATH: process.env.PATH, HOME: profile, ELECTRON_RUN_AS_NODE: "", ES_DESKTOP_USER_DATA: profile, ES_DESKTOP_START: "hidden",
    OPENCODE_URL: base, ES_DASHBOARD_URL: `http://127.0.0.1:${dashboard.address().port}`,
  } }).catch(error => { dashboard.close(); throw error })
  try {
    const page = await app.firstWindow()
    await page.waitForURL("http://127.0.0.1:*/", { timeout: 12000 })
    const origin = new URL(page.url()).origin
    assert.notEqual(new URL(origin).port, "60302")
    await page.route("**/*", route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort())
    const prompt = "Run the fixture exactly once, then report the result."
    const rows = []
    for (const client of ["desktop", "attached-tui", "attached-tui", "desktop"]) {
      const response = await fetch(`${base}/session?directory=${encodeURIComponent(home)}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "Client latency fixture" }), signal: AbortSignal.timeout(5000) })
      assert(response.ok)
      const session = await response.json()
      if (client === "desktop") {
        await page.goto(`${origin}/session/${session.id}?directory=${encodeURIComponent(home)}`, { waitUntil: "domcontentloaded", timeout: 12000 })
        const editor = page.getByRole("textbox", { name: "Message", exact: true })
        await editor.fill(prompt, { timeout: 12000 })
        await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled()
        await page.evaluate(() => {
          let entered = 0
          window.addEventListener("keydown", event => { if (event.key === "Enter") entered = performance.now() }, { capture: true })
          const watch = () => {
            if (entered && document.querySelector(".transcript")?.textContent.includes("READY")) {
              window.fixtureReplyMs = Math.round(performance.now() - entered)
              return
            }
            requestAnimationFrame(watch)
          }
          watch()
        })
        await editor.press("Control+Enter")
        await page.waitForFunction(() => window.fixtureReplyMs, undefined, { timeout: 25000 })
        rows.push({ client, firstReplyMs: await page.evaluate(() => window.fixtureReplyMs) })
      } else {
        const expectScript = path.join(import.meta.dirname, "compare-clients.exp")
        const { stdout } = await promisify(execFile)("/usr/bin/expect", [expectScript, binary, base, home, session.id, prompt], {
          timeout: 45000, env: { PATH: process.env.PATH, HOME: home, TERM: "xterm-256color", XDG_CONFIG_HOME: path.join(home, "config"), XDG_DATA_HOME: path.join(home, "data"), OPENCODE_CONFIG_CONTENT: "{}" },
        })
        const match = stdout.match(/^FIXTURE_TUI_REPLY_MS=(\d+)$/m)
        assert(match, "TUI did not report first output")
        rows.push({ client, firstReplyMs: Number(match[1]) })
      }
      const steps = await fetch(`${base}/session/${session.id}/message?directory=${encodeURIComponent(home)}`, { signal: AbortSignal.timeout(5000) }).then(response => response.json())
      assert.equal(steps.filter(step => step.info.role === "user").length, 1)
      assert.equal(steps.flatMap(step => step.parts).filter(part => part.type === "tool" && part.tool === "bash").length, 1)
      console.log(JSON.stringify(rows.at(-1)))
    }
  } finally { await app.close(); dashboard.closeAllConnections(); dashboard.close() }
}

const [base, home, binary] = process.argv.slice(2)
assert(new URL(base).hostname === "127.0.0.1" && new URL(base).port !== "4096")
await compareClients({ base, home, binary })
