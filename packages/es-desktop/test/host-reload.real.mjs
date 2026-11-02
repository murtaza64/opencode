// View > Reload and Force Reload under host tabs (DD #583): the window is a BaseWindow, so the menu reloads the shown
// host's view. One launch on a disposable profile, mock keychain, a local self-signed https page host so host tabs
// exist; the Work view runs against the composer fixture. Asserts: Reload and Force Reload each reload the shown Work
// view (a page marker is gone, the document loads again), its stored draft survives, the hidden page host is not
// reloaded. Run from packages/es-desktop (after `bun run build`): node test/host-reload.real.mjs [<packaged executable>]
import { _electron } from "@playwright/test"
import { execFileSync } from "node:child_process"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { createServer } from "node:https"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { createFixture } from "../../es-app/test/composer-fixture.mjs"

const root = fileURLToPath(new URL("..", import.meta.url))
const executable = process.argv[2] ?? process.env.ES_DESKTOP_EXECUTABLE
const profile = await mkdtemp(path.join(tmpdir(), "es-host-reload-profile-"))
const certs = await mkdtemp(path.join(tmpdir(), "es-host-reload-cert-"))
execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-subj", "/CN=127.0.0.1", "-days", "1",
  "-keyout", path.join(certs, "key.pem"), "-out", path.join(certs, "cert.pem")], { stdio: "ignore" })
const pageLoads = []
const personal = await new Promise(async (resolve) => {
  const server = createServer({ key: await readFile(path.join(certs, "key.pem")), cert: await readFile(path.join(certs, "cert.pem")) }, (req, res) => {
    if (req.url === "/") pageLoads.push(Date.now())
    res.writeHead(200, { "content-type": "text/html" })
    res.end("<!doctype html><title>Personal fixture</title><p>ok</p>")
  })
  server.listen(0, "127.0.0.1", () => resolve({ server, origin: `https://127.0.0.1:${server.address().port}` }))
})
const fixture = await createFixture()
const results = []
let electron
try {
  electron = await _electron.launch({
    ...(executable ? { executablePath: executable, args: ["--ignore-certificate-errors", "--use-mock-keychain"] } : { args: [root, "--ignore-certificate-errors", "--use-mock-keychain"] }),
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "", OPENCODE_URL: fixture.url, ES_DASHBOARD_URL: fixture.url, OPENCODE_SERVER_PASSWORD: "",
      ES_DESKTOP_USER_DATA: profile, ES_DESKTOP_START: "hidden",
      ES_REMOTE_HOSTS: JSON.stringify([{ id: "personal", label: "Personal", origin: personal.origin, mode: "page" }]) },
  })
  const work = await (async () => {
    for (let wait = 50; wait < 30_000; wait *= 2) {
      const found = electron.windows().find((item) => /^http:\/\/127\.0\.0\.1:\d+\//.test(item.url()))
      if (found) return found
      await new Promise((resolve) => setTimeout(resolve, wait))
    }
    throw new Error("no Work view")
  })()
  await work.waitForLoadState("load")
  const menu = (label) => electron.evaluate(({ Menu }, label) => {
    const item = Menu.getApplicationMenu().items.flatMap((top) => top.submenu?.items ?? []).find((entry) => entry.label === label)
    if (!item) return { missing: true }
    item.click()
    return { accelerator: item.accelerator }
  }, label)
  const pageBefore = pageLoads.length
  for (const [label, accelerator] of [["Reload", "CommandOrControl+R"], ["Force Reload", "Shift+CommandOrControl+R"]]) {
    await work.evaluate(() => { window.__esReloadMark = 1; localStorage.setItem("es-app:host-reload-check", "draft kept") })
    const item = await menu(label)
    if (item.missing || item.accelerator !== accelerator) throw new Error(`${label} menu item: ${JSON.stringify(item)}`)
    await work.waitForFunction(() => window.__esReloadMark === undefined, undefined, { timeout: 15_000 })
    await work.waitForLoadState("load")
    const draft = await work.evaluate(() => localStorage.getItem("es-app:host-reload-check"))
    if (draft !== "draft kept") throw new Error(`${label}: draft ${JSON.stringify(draft)}`)
    results.push(`PASS ${label} (${accelerator}) reloads the shown Work view; its stored draft is kept`)
  }
  if (pageLoads.length !== pageBefore) throw new Error(`hidden page host reloaded ${pageLoads.length - pageBefore} times`)
  results.push("PASS the hidden page host was not reloaded")
} catch (error) {
  process.exitCode = 1
  results.push(`FAIL ${String(error).split("\n")[0]}`)
} finally {
  console.log(results.join("\n"))
  await electron?.close()
  await fixture.close?.()
  personal.server.close()
  await rm(profile, { recursive: true, force: true })
  await rm(certs, { recursive: true, force: true })
}
