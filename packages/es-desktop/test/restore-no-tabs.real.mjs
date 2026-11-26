// A relaunch without host tabs (a single-window install such as the Mac Mini's) reopens the captured session route
// (DD #618). Two launches on one disposable profile, mock keychain, composer fixture, no remote hosts:
// 1. no restore record -> the window opens on the listener's start page, as before;
// 2. a restore record naming a session route on that listener -> the window shows that route after launch.
// Run from packages/es-desktop (after `bun run build`): node test/restore-no-tabs.real.mjs [<packaged executable>]
import { _electron } from "@playwright/test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { createFixture, directory } from "../../es-app/test/composer-fixture.mjs"

const root = fileURLToPath(new URL("..", import.meta.url))
const executable = process.argv[2] ?? process.env.ES_DESKTOP_EXECUTABLE
const profile = await mkdtemp(path.join(tmpdir(), "es-restore-no-tabs-profile-"))
const fixture = await createFixture()
const restore = path.join(profile, "restore.json")
const results = []
let electron
const launch = (record) => _electron.launch({
  ...(executable ? { executablePath: executable, args: ["--use-mock-keychain"] } : { args: [root, "--use-mock-keychain"] }),
  env: { ...process.env, ELECTRON_RUN_AS_NODE: "", OPENCODE_URL: fixture.url, ES_DASHBOARD_URL: fixture.url, OPENCODE_SERVER_PASSWORD: "",
    ES_DESKTOP_USER_DATA: profile, ES_DESKTOP_START: "hidden", ES_REMOTE_HOSTS: "[]", ...(record ? { ES_DESKTOP_RESTORE: restore } : {}) },
})
const shown = async () => {
  for (let wait = 50; wait < 30_000; wait *= 2) {
    const page = electron.windows().find((item) => /^http:\/\/127\.0\.0\.1:\d+\//.test(item.url()))
    if (page) {
      await page.waitForLoadState("load")
      // Let any later load (the bug: the start page loaded over the restored route) land before reading.
      await new Promise((resolve) => setTimeout(resolve, 1500))
      return new URL(page.url())
    }
    await new Promise((resolve) => setTimeout(resolve, wait))
  }
  throw new Error("no window")
}
try {
  electron = await launch(false)
  const first = await shown()
  if (first.pathname !== "/") throw new Error(`no record: opened ${first.pathname}`)
  results.push("PASS no restore record: opens on the start page")
  await electron.close(); electron = undefined
  const route = `/session/ses_a?directory=${encodeURIComponent(directory)}`
  await writeFile(restore, JSON.stringify({ version: 1, selected: "local", views: [{ id: "local", url: `${first.origin}${route}` }] }))
  electron = await launch(true)
  const second = await shown()
  if (second.origin !== first.origin || `${second.pathname}${second.search}` !== route) throw new Error(`record: opened ${second.pathname}${second.search}`)
  results.push("PASS restore record: the relaunch shows the captured session route, not the start page")
} catch (error) {
  process.exitCode = 1
  results.push(`FAIL ${String(error).split("\n")[0]}`)
} finally {
  console.log(results.join("\n"))
  await electron?.close()
  await fixture.close?.()
  await rm(profile, { recursive: true, force: true })
}
