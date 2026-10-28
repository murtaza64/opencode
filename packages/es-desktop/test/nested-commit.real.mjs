// A host selection run inside the host strip's own navigation commit ("blur" while Chromium swaps the
// strip's frames) must not crash. Starting the strip's next navigation there SIGSEGVs in
// NavigationRequest creation; a nested inspector evaluate once did exactly that. A blur listener runs
// the selection at that point deterministically. Disposable profile, private fixture; the Mini and
// Personal origins are only read. --control defers the selection to a later task.
// Usage: node test/nested-commit.real.mjs [binary] [--control]   (after `bun run build`)
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { _electron } from "@playwright/test"
import { createFixture } from "../../es-app/test/composer-fixture.mjs"

const binary = process.argv.slice(2).find((arg) => !arg.startsWith("--"))
const control = process.argv.includes("--control")
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const note = (entry) => console.error(new Date().toISOString(), JSON.stringify(entry))
const fixture = await createFixture()
const profile = await mkdtemp(path.join(tmpdir(), "es-desktop-nested-commit-"))
const app = await _electron.launch({
  timeout: 30000,
  ...(binary ? { executablePath: binary, args: [] } : { args: [fileURLToPath(new URL("..", import.meta.url))] }),
  env: {
    ...process.env,
    ELECTRON_RUN_AS_NODE: "",
    OPENCODE_URL: fixture.url,
    ES_DASHBOARD_URL: fixture.url,
    OPENCODE_SERVER_PASSWORD: "",
    ES_DESKTOP_USER_DATA: profile,
    ES_REMOTE_HOSTS: JSON.stringify([
      { id: "mini", label: "Mac Mini", origin: "https://murtaza-mac-mini.tailc81fd.ts.net" },
      { id: "personal", label: "Personal", origin: "https://agents.murtaza.earth", mode: "page" },
    ]),
  },
})
const exit = { value: undefined }
const crash = { signal: undefined }
app.process().on("exit", (code, signal) => { exit.value = { code, signal }; note({ exit: exit.value }) })
try {
  await sleep(4000)
  // Every WebContents: on blur, select a host synchronously (as a nested inspector evaluate did).
  const armed = await app.evaluate(({ Menu, webContents }, control) => {
    const hosts = Menu.getApplicationMenu().items.find((item) => item.label === "Hosts").submenu.items
    const flip = { next: "Work" }
    globalThis.__blurs = 0
    const select = () => {
      globalThis.__blurs++
      const label = flip.next
      flip.next = label === "Work" ? "Mac Mini" : "Work"
      const item = hosts.find((entry) => entry.label === label)
      if (control) setTimeout(() => item.click(), 0)
      else item.click()
    }
    const all = webContents.getAllWebContents()
    all.forEach((contents) => contents.on("blur", select))
    return all.map((contents) => contents.getURL().slice(0, 30))
  }, control)
  note({ control, armed })
  for (let round = 0; round < 6 && !exit.value; round++) {
    // A host click repaints the strip (a data: navigation); the strip then holds focus, so when that
    // navigation commits and swaps frames, the strip's own "blur" runs the next selection nested in
    // its commit, and that selection repaints (loadURL) the same strip mid-commit.
    await app.evaluate(({ Menu, webContents }, round) => {
      const strip = webContents.getAllWebContents().find((contents) => contents.getURL().startsWith("data:text/html;charset"))
      Menu.getApplicationMenu().items.find((item) => item.label === "Hosts").submenu.items.find((entry) => entry.label === (round % 2 ? "Work" : "Mac Mini")).click()
      strip.focus()
    }, round).catch((error) => note({ round, evaluateError: String(error).slice(0, 200) }))
    await sleep(2500)
    note({ round, alive: !exit.value, blurs: exit.value ? "n/a" : await app.evaluate(() => globalThis.__blurs).catch(() => "n/a") })
  }
} finally {
  crash.signal = exit.value?.signal ?? undefined
  note({ verdict: exit.value ? (exit.value.signal ?? `exit ${exit.value.code}`) : "alive" })
  if (!exit.value) await Promise.race([app.close(), sleep(10000)]).catch(() => {})
  if (!exit.value) app.process().kill("SIGKILL")
  for (let i = 0; i < 50 && !exit.value; i++) await sleep(100)
  await fixture.close?.()
  await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
}
if (crash.signal) {
  console.error(`FAIL: the app exited with ${crash.signal} during a nested host selection`)
  process.exit(1)
}
