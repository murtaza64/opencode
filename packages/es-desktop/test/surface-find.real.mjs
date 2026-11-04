// Cmd+F in the Surface reader (DD #672/#676): the Mac app searches only the shown Surface frame, through an isolated
// world in that frame, and the app receives only counts. One disposable launch (temp profile, mock keychain, hidden
// start) against the private composer fixture and a local surface server: a static Surface with a hidden match and a
// nested frame, an interactive (script-rendered) Surface, no matches, next/previous, Esc focus return, Cmd+F typed
// inside the frame, the Surface's DOM unchanged, and every /__es/find reply limited to numbers and a reason.
// Run from packages/es-desktop (after `bun run build`): node test/surface-find.real.mjs [<packaged executable>]
import { _electron, expect } from "@playwright/test"
import { mkdtemp, rm } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { createFixture } from "../../es-app/test/composer-fixture.mjs"

const root = fileURLToPath(new URL("..", import.meta.url))
const executable = process.argv[2] ?? process.env.ES_DESKTOP_EXECUTABLE
const profile = await mkdtemp(path.join(tmpdir(), "es-surface-find-profile-"))
const pages = {
  "/report/": `<!doctype html><title>Report</title><h1>Migration report</h1><p>alpha beta alpha</p>
    <p style="display:none">alpha hidden</p><iframe title="nested" srcdoc="<p>alpha nested</p>"></iframe><p id="tail">end</p>`,
  "/app/": `<!doctype html><title>App</title><main id="root"></main>
    <script>document.getElementById("root").innerHTML = "<p>gamma one</p><p>gamma two</p>"</script>`,
}
const surfaceServer = await new Promise((resolve) => {
  const server = createServer((req, res) => {
    const body = pages[new URL(req.url ?? "/", "http://x").pathname]
    res.writeHead(body ? 200 : 404, { "content-type": "text/html" })
    res.end(body ?? "not found")
  })
  server.listen(0, "127.0.0.1", () => resolve({ server, origin: `http://127.0.0.1:${server.address().port}` }))
})
const fixture = await createFixture()
const now = Date.now()
const surface = (id, title, upstream) => ({ id, title, summary: null, kind: "url", owner: "fixture", lane: null, editspace: "fixture",
  updated_at: now, revision: 1, health: { state: "ok" }, upstream })
fixture.surfaces = [surface("fixture-report", "Report", `${surfaceServer.origin}/report/`), surface("fixture-app", "App", `${surfaceServer.origin}/app/`)]
const results = []
const replies = []
let electron
const step = (label) => console.error(`[${new Date().toISOString().slice(11, 19)}] ${label}`)
// A hung step must not hold the launch: report what passed and stop the app.
const watchdog = setTimeout(() => {
  console.log([...results, "FAIL watchdog: a step hung past 100 s"].join("\n"))
  electron?.process().kill("SIGKILL")
  process.exit(1)
}, 100_000)
try {
  electron = await _electron.launch({
    ...(executable ? { executablePath: executable, args: ["--use-mock-keychain"] } : { args: [root, "--use-mock-keychain"] }),
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "", OPENCODE_URL: fixture.url, ES_DASHBOARD_URL: fixture.url, OPENCODE_SERVER_PASSWORD: "",
      ES_DESKTOP_USER_DATA: profile, ES_DESKTOP_START: "hidden" },
  })
  step("launched")
  const page = await electron.firstWindow()
  await page.waitForLoadState("domcontentloaded")
  const origin = new URL(page.url()).origin
  page.on("response", async (response) => {
    if (new URL(response.url()).pathname === "/__es/find" && response.request().method() === "POST") replies.push(await response.json().catch(() => "unparsed"))
  })
  const frameOf = async () => {
    for (let wait = 50; wait < 20_000; wait *= 2) {
      const frame = page.frames().find((item) => item.url().includes("/__cap/surface/"))
      if (frame && (await frame.evaluate(() => document.readyState).catch(() => "")) === "complete") return frame
      await new Promise((resolve) => setTimeout(resolve, wait))
    }
    throw new Error("Surface frame not found")
  }
  const bar = page.locator(".surface-find")
  const input = page.getByRole("searchbox", { name: "Find in Surface" })
  const count = bar.locator(".surface-find-count")

  step("first window")
  await page.goto(`${origin}/?surface=fixture-report`)
  step("report page")
  const frame = await frameOf()
  const before = await frame.evaluate(() => document.documentElement.outerHTML)
  // Surfaces are served with CSP frame-src 'none', so a nested frame normally never loads; count it only if it did.
  const nested = await frame.evaluate(() => !!document.querySelector("iframe")?.contentDocument?.body?.textContent?.includes("alpha")).catch(() => false)
  const total = nested ? 3 : 2
  // The reader top bar keeps Open in new tab inside the More menu; any host control works as the focus target.
  const opener = page.getByRole("button", { name: "More" })
  await opener.focus()
  step("frame ready")
  await page.keyboard.press("Meta+f")
  await expect(input).toBeFocused()
  await input.fill("alpha")
  await expect(count).toHaveText(`1 of ${total}`)
  results.push(`PASS static Surface: ${total} visible matches, the hidden one skipped; nested frame ${nested ? "loaded and searched" : "blocked by the Surface CSP (frame-src 'none'), so not counted"}`)
  await input.press("Enter")
  await expect(count).toHaveText(`2 of ${total}`)
  await input.press("Shift+Enter")
  await expect(count).toHaveText(`1 of ${total}`)
  await input.press("Shift+Enter")
  await expect(count).toHaveText(`${total} of ${total}`)
  await bar.getByRole("button", { name: "Next match" }).click()
  await expect(count).toHaveText(`1 of ${total}`)
  results.push("PASS Enter / Shift+Enter / buttons move next and previous")
  if (!(await frame.evaluate(() => CSS.highlights.has("editspace-find")))) throw new Error("no highlight registered in the Surface frame")
  await input.fill("zzz")
  await expect(count).toHaveText("No matches")
  results.push("PASS no matches")
  await input.press("Escape")
  await expect(bar).toHaveCount(0)
  await expect(opener).toBeFocused()
  await expect(page.locator(".desk-surface")).toHaveCount(1)
  await expect.poll(() => frame.evaluate(() => CSS.highlights.size)).toBe(0)
  if ((await frame.evaluate(() => document.documentElement.outerHTML)) !== before) throw new Error("the Surface DOM changed")
  results.push("PASS Esc closes, clears highlights, keeps the reader open and returns focus; the Surface DOM is unchanged")

  step("esc done")
  await frame.locator("#tail").click()
  // A typed chord (sendInputEvent goes through the native input path, as a key press does; CDP key events do not
  // reach before-input-event).
  const focused = await electron.evaluate(({ webContents }) => {
    const view = webContents.getAllWebContents().find((item) => item.focusedFrame && item.focusedFrame !== item.mainFrame)
    const url = view?.focusedFrame?.url ?? ""
    view?.sendInputEvent({ type: "keyDown", keyCode: "F", modifiers: ["meta"] })
    view?.sendInputEvent({ type: "keyUp", keyCode: "F", modifiers: ["meta"] })
    return url
  })
  if (!focused.includes("/__cap/surface/")) throw new Error(`focus is not in the Surface frame: ${focused}`)
  await expect(input).toBeFocused()
  await input.fill("beta")
  await expect(count).toHaveText("1 of 1")
  await input.press("Escape")
  await expect.poll(() => page.evaluate(() => document.activeElement?.tagName)).toBe("IFRAME")
  results.push("PASS Cmd+F typed inside the Surface frame opens the reader's find; Esc returns focus to the frame")

  step("in-frame done")
  await page.goto(`${origin}/?surface=fixture-app`)
  await frameOf()
  await page.keyboard.press("Meta+f")
  await input.fill("gamma")
  await expect(count).toHaveText("1 of 2")
  await input.press("Escape")
  results.push("PASS interactive Surface: script-rendered text is found")

  const allowed = new Set(["state", "current", "total", "reason"])
  for (const reply of replies) {
    if (typeof reply !== "object" || !reply || Object.keys(reply).some((key) => !allowed.has(key))) throw new Error(`find reply carried more than counts: ${JSON.stringify(reply)}`)
    if (/alpha|gamma|beta|nested|Migration/.test(JSON.stringify(reply))) throw new Error(`find reply carried Surface text: ${JSON.stringify(reply)}`)
  }
  results.push(`PASS ${replies.length} find replies carried only state/current/total`)
} catch (error) {
  process.exitCode = 1
  results.push(`FAIL ${String(error).split("\n").slice(0, 6).join(" | ")}`, `find replies: ${JSON.stringify(replies)}`)
} finally {
  clearTimeout(watchdog)
  console.log(results.join("\n"))
  await electron?.close()
  await fixture.close?.()
  surfaceServer.server.close()
  await rm(profile, { recursive: true, force: true })
}
