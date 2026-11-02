// A view whose renderer is gone shows Try again instead of staying blank (DD #588, Personal incident desktop-delivery#671).
// One launch on a disposable profile, mock keychain, a local self-signed https page host that sets a cookie. The Personal
// tab is selected, its renderer is crashed, the failure page appears with Try again; Try again loads the page again
// and the page host receives the same cookie (partition untouched). Then the same for the Work view (a listener view).
// Run from packages/es-desktop (after `bun run build`): node test/renderer-loss.real.mjs [<packaged executable>]
import { _electron } from "@playwright/test"
import { execFileSync } from "node:child_process"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:https"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { createFixture } from "../../es-app/test/composer-fixture.mjs"

const root = fileURLToPath(new URL("..", import.meta.url))
const executable = process.argv[2] ?? process.env.ES_DESKTOP_EXECUTABLE
const profile = await mkdtemp(path.join(tmpdir(), "es-renderer-loss-profile-"))
const certs = await mkdtemp(path.join(tmpdir(), "es-renderer-loss-cert-"))
execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-subj", "/CN=127.0.0.1", "-days", "1",
  "-keyout", path.join(certs, "key.pem"), "-out", path.join(certs, "cert.pem")], { stdio: "ignore" })
const seen = []
const personal = await new Promise(async (resolve) => {
  const server = createServer({ key: await readFile(path.join(certs, "key.pem")), cert: await readFile(path.join(certs, "cert.pem")) }, (req, res) => {
    if (req.url === "/") seen.push(req.headers.cookie ?? "")
    res.writeHead(200, { "content-type": "text/html", ...(req.headers.cookie?.includes("signin=") ? {} : { "set-cookie": "signin=kept; Max-Age=86400; Secure; Path=/" }) })
    res.end("<!doctype html><title>Personal fixture</title><p id=ok>ok</p>")
  })
  server.listen(0, "127.0.0.1", () => resolve({ server, origin: `https://127.0.0.1:${server.address().port}` }))
})
const fixture = await createFixture()
const restore = path.join(profile, "restore.json")
await writeFile(restore, JSON.stringify({ version: 1, selected: "personal", views: [{ id: "local", created: true }, { id: "personal", created: true }] }))
const results = []
let electron
const find = async (match) => {
  for (let wait = 50; wait < 30_000; wait *= 2) {
    const found = electron.windows().find((item) => match(item.url()))
    if (found) return found
    await new Promise((resolve) => setTimeout(resolve, wait))
  }
  throw new Error("view not found")
}
// Crashes the renderer of the view whose URL matches, from the main process (this disposable instance only).
const crash = (prefix) => electron.evaluate(({ webContents }, prefix) => {
  const target = webContents.getAllWebContents().find((item) => item.getURL().startsWith(prefix))
  if (!target) return false
  target.forcefullyCrashRenderer()
  return true
}, prefix)
try {
  electron = await _electron.launch({
    ...(executable ? { executablePath: executable, args: ["--ignore-certificate-errors", "--use-mock-keychain"] } : { args: [root, "--ignore-certificate-errors", "--use-mock-keychain"] }),
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "", OPENCODE_URL: fixture.url, ES_DASHBOARD_URL: fixture.url, OPENCODE_SERVER_PASSWORD: "",
      ES_DESKTOP_USER_DATA: profile, ES_DESKTOP_START: "hidden", ES_DESKTOP_RESTORE: restore,
      ES_REMOTE_HOSTS: JSON.stringify([{ id: "personal", label: "Personal", origin: personal.origin, mode: "page" }]) },
  })
  const work = await find((url) => /^http:\/\/127\.0\.0\.1:\d+\//.test(url))
  await work.waitForSelector("#root *", { timeout: 60_000 })
  results.push("PASS smoke: the Work view renders the app")
  let page = await find((url) => url.startsWith(personal.origin))
  await page.waitForSelector("#ok")
  const before = seen.length
  if (!(await crash(personal.origin))) throw new Error("no Personal view to crash")
  // The failure page, not the tab strip (also a data: document).
  const failurePage = (url) => url.startsWith("data:text/html") && url.includes("Page%20unavailable")
  page = await find(failurePage)
  await page.waitForSelector("text=Try again")
  const text = await page.evaluate(() => document.body.innerText)
  if (!/did not load \(renderer /.test(text)) throw new Error(`failure page text: ${text}`)
  await page.click("text=Try again")
  page = await find((url) => url.startsWith(personal.origin))
  await page.waitForSelector("#ok")
  if (seen.length <= before || !seen.at(-1).includes("signin=kept")) throw new Error(`cookie after Try again: ${JSON.stringify(seen.slice(before))}`)
  results.push("PASS a crashed Personal page shows Try again; Try again reloads it with its cookie (partition untouched)")
  const listener = new URL(work.url()).origin
  if (!(await crash(listener))) throw new Error("no Work view to crash")
  const failed = await find((url) => failurePage(url) && !electron.windows().some((item) => item.url().startsWith(listener)))
  await failed.waitForSelector("text=Try again")
  await failed.click("text=Try again")
  const back = await find((url) => url.startsWith(listener))
  await back.waitForSelector("#root *", { timeout: 30_000 }).catch(async (error) => {
    throw new Error(`${error.message.split("\n")[0]} title=${await back.title().catch((e) => e.message)} body=${(await back.evaluate(() => document.body?.innerHTML.slice(0, 200)).catch((e) => e.message))}`)
  })
  results.push("PASS a crashed Work view shows Try again; Try again loads the app again")
} catch (error) {
  process.exitCode = 1
  results.push(`FAIL ${String(error).split("\n")[0]} views=${JSON.stringify(electron?.windows().map((item) => item.url().slice(0, 60)))}`)
} finally {
  console.log(results.join("\n"))
  await electron?.close()
  await fixture.close?.()
  personal.server.close()
  await rm(profile, { recursive: true, force: true })
  await rm(certs, { recursive: true, force: true })
}
