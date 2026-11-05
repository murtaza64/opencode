// A navigation during the first load (a notification click or an opened route at launch, DD #822) must not fail
// startup: the newer route wins, no "could not start" box, the app stays up. One disposable launch (temp profile, mock
// keychain, hidden start) against the private composer fixture; no remote hosts, so the window is the Work view.
// Run from packages/es-desktop (after `bun run build`): node test/startup-abort.real.mjs [<packaged executable>]
import { _electron } from "@playwright/test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { createFixture } from "../../es-app/test/composer-fixture.mjs"

const root = fileURLToPath(new URL("..", import.meta.url))
const executable = process.argv[2] ?? process.env.ES_DESKTOP_EXECUTABLE
const profile = await mkdtemp(path.join(tmpdir(), "es-startup-abort-profile-"))
const fixture = await createFixture()
const results = []
let electron
const watchdog = setTimeout(() => { console.log([...results, "FAIL watchdog"].join("\n")); electron?.process().kill("SIGKILL"); process.exit(1) }, 60_000)
try {
  electron = await _electron.launch({
    ...(executable ? { executablePath: executable, args: ["--use-mock-keychain"] } : { args: [root, "--use-mock-keychain"] }),
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "", OPENCODE_URL: fixture.url, ES_DASHBOARD_URL: fixture.url, OPENCODE_SERVER_PASSWORD: "",
      ES_DESKTOP_USER_DATA: profile, ES_DESKTOP_START: "hidden" },
  })
  const exited = new Promise((resolve) => electron.process().once("exit", (code) => resolve(code)))
  const logs = []
  electron.process().stderr?.on("data", (chunk) => logs.push(String(chunk)))
  electron.process().stdout?.on("data", (chunk) => logs.push(String(chunk)))
  globalThis.__logs = logs
  // Record any startup error box instead of blocking, and replace the first load with another route the moment it starts.
  await electron.evaluate(({ app, dialog, BrowserWindow }) => {
    globalThis.__boxes = []
    dialog.showErrorBox = (title) => { globalThis.__boxes.push(title) }
    const hook = (contents) => contents.once("did-start-navigation", (details) => {
      if (!details.isMainFrame) return
      const next = new URL("/new", details.url)
      // A real notification click or opened route reaches the window as its own task. A loadURL called synchronously
      // inside this event re-enters the first loadURL, and the packaged app's Chromium rejects it with ERR_FAILED
      // before any navigation starts; that is not the startup abort this test covers. One microtask takes it out of
      // the first load's stack while the first request is still in flight.
      queueMicrotask(() => { void contents.loadURL(next.href).catch(() => undefined) })
    })
    // The app window is the Work view (no remote hosts); hidden webContents are not part of this launch's route.
    const window = BrowserWindow.getAllWindows()[0]
    if (window) hook(window.webContents)
    else app.on("web-contents-created", (_event, contents) => hook(contents))
  })
  const outcome = await Promise.race([exited.then((code) => ({ exited: code })), new Promise((resolve) => setTimeout(() => resolve({ alive: true }), 8000))])
  if (!("alive" in outcome)) throw new Error(`the app exited (${outcome.exited}) after a navigation during its first load`)
  const boxes = await electron.evaluate(() => globalThis.__boxes)
  if (boxes.length) throw new Error(`startup error box shown: ${boxes.join(", ")}`)
  const url = await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.webContents.getURL() ?? "")
  if (new URL(url).pathname !== "/new") throw new Error(`window ended on ${url}`)
  results.push("PASS a navigation during the first load: the newer route wins, no error box, the app stays up")
} catch (error) {
  process.exitCode = 1
  results.push(`FAIL ${String(error).split("\n").slice(0, 4).join(" | ")}`)
  results.push(`app log: ${(globalThis.__logs ?? []).join("").split("\n").filter((line) => /startup|abort|ERR_|Error/i.test(line)).slice(0, 8).join(" | ")}`)
} finally {
  clearTimeout(watchdog)
  console.log(results.join("\n"))
  await electron?.close().catch(() => undefined)
  await fixture.close?.()
  await rm(profile, { recursive: true, force: true })
}
