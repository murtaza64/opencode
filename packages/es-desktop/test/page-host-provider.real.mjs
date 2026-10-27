// Page host sign-in through Access's "Cloudflare" identity provider, against private HTTPS fixtures
// at the real host names (resolved to loopback): app -> team login (state cookie) -> provider button
// to dash.cloudflare.com -> oauth-callbacks.cloudflareaccess.com -> team callback (checks the state
// cookie) -> app. Every hop must stay in the Personal tab's partition; nothing may open externally.
// shell.openExternal is replaced in the test app, so no real browser is touched.
import { _electron, expect } from "@playwright/test"
import { execFileSync } from "node:child_process"
import { createServer } from "node:https"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { createFixture } from "../../es-app/test/composer-fixture.mjs"

const root = fileURLToPath(new URL("..", import.meta.url))
const dir = await mkdtemp(path.join(tmpdir(), "es-page-provider-"))
const names = { app: "agents.example.test", team: "team-fixture.cloudflareaccess.com", dash: "dash.cloudflare.com", callbacks: "oauth-callbacks.cloudflareaccess.com" }
execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=fixture",
  "-addext", `subjectAltName=${Object.values(names).map((name) => `DNS:${name}`).join(",")}`, "-keyout", path.join(dir, "key.pem"), "-out", path.join(dir, "cert.pem")], { stdio: "ignore" })
const tls = { key: await readFile(path.join(dir, "key.pem")), cert: await readFile(path.join(dir, "cert.pem")) }
const hops = []
const jar = (req) => Object.fromEntries((req.headers.cookie ?? "").split(";").map((item) => item.trim().split("=")).filter((pair) => pair[0]))
const page = (res, title, body = "", headers = {}) => { res.writeHead(200, { "content-type": "text/html", ...headers }); res.end(`<!doctype html><title>${title}</title><h1>${title}</h1>${body}`) }
const redirect = (res, location, headers = {}) => { res.writeHead(302, { location, ...headers }); res.end() }
// One HTTPS server answers every fixture name, routed by Host.
const server = createServer(tls, (req, res) => {
  const host = (req.headers.host ?? "").split(":")[0]
  const url = new URL(req.url, `https://${host}`)
  const cookies = jar(req)
  hops.push(`${host}${url.pathname}`)
  if (host === names.app) {
    if (url.pathname === "/cdn-cgi/access/authorized") return redirect(res, "/", { "set-cookie": "CF_Authorization=1; Secure; HttpOnly; SameSite=Lax; Path=/" })
    if (!cookies.CF_Authorization) return redirect(res, `https://${names.team}/cdn-cgi/access/login/${names.app}`)
    return page(res, "Personal app ready")
  }
  if (host === names.team) {
    if (url.pathname.startsWith("/cdn-cgi/access/login/")) {
      const state = "s" + Math.random().toString(36).slice(2)
      const authorize = `https://${names.dash}/oauth2/auth?response_type=code&state=${state}&redirect_uri=${encodeURIComponent(`https://${names.callbacks}/cdn-cgi/access/outbound-oauth-callback`)}`
      return page(res, "Access login", `<a id="provider" href="${authorize}">Cloudflare</a>`, { "set-cookie": `CF_state=${state}; Secure; HttpOnly; SameSite=Lax; Path=/` })
    }
    if (url.pathname === "/cdn-cgi/access/callback") {
      // The state must match the cookie set in the session that started sign-in.
      if (!cookies.CF_state || cookies.CF_state !== url.searchParams.get("state")) return page(res, "invalid state")
      return redirect(res, `https://${names.app}/cdn-cgi/access/authorized`)
    }
  }
  if (host === names.dash && url.pathname === "/oauth2/auth") {
    const back = `${url.searchParams.get("redirect_uri")}?code=c&state=${url.searchParams.get("state")}`
    return page(res, "Cloudflare sign in", `<a id="approve" href="${back}">Allow</a>`)
  }
  if (host === names.callbacks) return redirect(res, `https://${names.team}/cdn-cgi/access/callback?state=${url.searchParams.get("state")}`)
  res.writeHead(404).end()
})
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
const port = server.address().port
const rules = Object.values(names).map((name) => `MAP ${name}:443 127.0.0.1:${port}`).join(", ")
const fixture = await createFixture()
const profile = await mkdtemp(path.join(tmpdir(), "es-page-provider-profile-"))
const args = ["--ignore-certificate-errors", `--host-resolver-rules=${rules}`]
const electron = await _electron.launch({
  ...(process.env.ES_DESKTOP_EXECUTABLE ? { executablePath: process.env.ES_DESKTOP_EXECUTABLE, args } : { args: [root, ...args] }),
  env: { ...process.env, ELECTRON_RUN_AS_NODE: "", OPENCODE_URL: fixture.url, ES_DASHBOARD_URL: fixture.url, OPENCODE_SERVER_PASSWORD: "", ES_DESKTOP_USER_DATA: profile, ES_DESKTOP_START: "hidden",
    ES_REMOTE_HOSTS: JSON.stringify([{ id: "personal", label: "Personal", origin: `https://${names.app}`, mode: "page" }]) },
})
try {
  await electron.evaluate(({ shell }) => {
    globalThis.externalOpens = []
    shell.openExternal = async (url) => void globalThis.externalOpens.push(new URL(url).host)
  })
  const find = async (match) => { for (let i = 0; i < 80; i++) { const win = electron.windows().find((item) => match(item.url())); if (win) return win; await new Promise((r) => setTimeout(r, 250)) } }
  const bar = await find((url) => url.startsWith("data:"))
  await new Promise((r) => setTimeout(r, 2500))
  await bar.getByRole("link", { name: "Personal" }).click()
  const tab = await find((url) => url.includes(names.team))
  await tab.locator("#provider").click({ noWaitAfter: true })
  await tab.waitForURL((url) => url.host === names.dash, { timeout: 5000 }).catch(() => {})
  if (new URL(tab.url()).host === names.dash) await tab.locator("#approve").click()
  await tab.waitForURL((url) => url.host === names.app, { timeout: 5000 }).catch(() => {})
  await new Promise((r) => setTimeout(r, 1000))
  const result = { title: await tab.title(), host: new URL(tab.url()).host, external: await electron.evaluate(() => globalThis.externalOpens), hops }
  console.log(JSON.stringify(result, null, 2))
  expect(result.external).toEqual([])
  expect(result.title).toBe("Personal app ready")
  console.log("PASS page host provider sign-in: Access -> dash.cloudflare.com -> oauth-callbacks -> Access -> app in one partition; no external open")
} finally {
  await electron.close()
  await fixture.close()
  server.close()
  await rm(profile, { recursive: true, force: true })
  await rm(dir, { recursive: true, force: true })
}
