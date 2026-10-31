// Personal (page-mode) sign-in across a graceful app restart (PERS-AUTH-01): a private profile and a self-signed local
// https page host. The page sets a persistent cookie at load, a session cookie (no expiry) and a persistent cookie 300 ms
// before the quit; the app partition gets a session cookie too. After relaunch on the same profile: the page host
// receives all three Personal cookies (the session one kept as persistent, flags intact), and the app partition's
// session cookie has ended as usual. Fixtures only; mock keychain.
// Run from packages/es-desktop: node test/page-cookies.real.mjs [<packaged Editspace executable>]
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
const profile = await mkdtemp(path.join(tmpdir(), "es-page-cookies-profile-"))
const certs = await mkdtemp(path.join(tmpdir(), "es-page-cookies-cert-"))
execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-subj", "/CN=127.0.0.1", "-days", "1",
  "-keyout", path.join(certs, "key.pem"), "-out", path.join(certs, "cert.pem")], { stdio: "ignore" })
const seen = []
const personal = await new Promise(async (resolve) => {
  const server = createServer({ key: await readFile(path.join(certs, "key.pem")), cert: await readFile(path.join(certs, "cert.pem")) }, (req, res) => {
    seen.push({ url: req.url, cookie: req.headers.cookie ?? "" })
    const cookies = req.url === "/late" ? ["late=1; Max-Age=86400; Secure; Path=/"]
      : req.url === "/" && !(req.headers.cookie ?? "").includes("persistent=") ? ["persistent=1; Max-Age=86400; Secure; Path=/", "session=1; Secure; Path=/"] : []
    res.writeHead(200, { "content-type": "text/html", "set-cookie": cookies })
    res.end("<!doctype html><title>Personal fixture</title><p>ok</p>")
  })
  server.listen(0, "127.0.0.1", () => resolve({ server, origin: `https://127.0.0.1:${server.address().port}` }))
})
const fixture = await createFixture()
const restore = path.join(profile, "restore.json")
await writeFile(restore, JSON.stringify({ version: 1, selected: "personal", views: [{ id: "personal", created: true }] }))
const launch = () => _electron.launch({
  ...(executable ? { executablePath: executable, args: ["--ignore-certificate-errors", "--use-mock-keychain"] } : { args: [root, "--ignore-certificate-errors", "--use-mock-keychain"] }),
  env: { ...process.env, ELECTRON_RUN_AS_NODE: "", OPENCODE_URL: fixture.url, ES_DASHBOARD_URL: fixture.url, OPENCODE_SERVER_PASSWORD: "",
    ES_DESKTOP_USER_DATA: profile, ES_DESKTOP_START: "hidden", ES_DESKTOP_RESTORE: restore,
    ES_REMOTE_HOSTS: JSON.stringify([{ id: "personal", label: "Personal", origin: personal.origin, mode: "page" }]) },
})
const view = async (electron) => {
  for (let wait = 50; wait < 30000; wait *= 2) {
    const page = electron.windows().find((item) => item.url().startsWith(personal.origin))
    if (page) return page
    await new Promise((resolve) => setTimeout(resolve, wait))
  }
  throw new Error("no Personal view")
}
const result = {}
let electron
try {
  electron = await launch()
  let page = await view(electron)
  await page.waitForLoadState("load")
  await page.evaluate(() => fetch("/late", { credentials: "include" }).catch(() => undefined))
  await electron.evaluate(({ session }) => session.fromPartition("persist:editspace").cookies.set({ url: "http://127.0.0.1/", name: "appsession", value: "1" }))
  await new Promise((resolve) => setTimeout(resolve, 300))
  const quitStarted = Date.now()
  await electron.close(); electron = undefined
  result.quitMs = Date.now() - quitStarted
  const before = seen.length
  electron = await launch()
  page = await view(electron)
  await page.waitForLoadState("load")
  const relaunch = seen.slice(before).find((item) => item.url === "/")
  const has = (name) => (relaunch?.cookie ?? "").split(/;\s*/).some((part) => part.startsWith(`${name}=`))
  const kept = await electron.evaluate(async ({ session }, origin) => (await session.fromPartition("persist:editspace-host-personal").cookies.get({ name: "session" }))
    .map((cookie) => ({ session: cookie.session, secure: cookie.secure, path: cookie.path, hostOnly: cookie.hostOnly, days: Math.round(((cookie.expirationDate ?? 0) * 1000 - Date.now()) / 86_400_000) })), personal.origin)
  const app = await electron.evaluate(async ({ session }) => (await session.fromPartition("persist:editspace").cookies.get({ name: "appsession" })).length)
  Object.assign(result, { persistent: has("persistent"), session: has("session"), lateBeforeQuit: has("late"), kept, appSessionCookieAfter: app,
    relaunchCookieNames: (relaunch?.cookie ?? "").split(/;\s*/).map((part) => part.split("=")[0]).filter(Boolean) })
  console.log(JSON.stringify(result))
  const expected = { persistent: true, session: true, lateBeforeQuit: true, appSessionCookieAfter: 0 }
  for (const [key, value] of Object.entries(expected)) if (result[key] !== value) throw new Error(`${key}: expected ${value}, got ${result[key]}`)
  if (JSON.stringify(kept) !== JSON.stringify([{ session: false, secure: true, path: "/", hostOnly: true, days: 7 }])) throw new Error(`kept cookie: ${JSON.stringify(kept)}`)
  if (result.quitMs > 10_000) throw new Error(`quit took ${result.quitMs} ms`)
  console.log("PASS page cookies: Personal persistent, late and session cookies survive a restart (session kept 7 days, secure, host-only, path /); app partition session cookie ends")
} finally {
  await electron?.close()
  await fixture.close?.()
  personal.server.close()
  await rm(profile, { recursive: true, force: true })
  await rm(certs, { recursive: true, force: true })
}
