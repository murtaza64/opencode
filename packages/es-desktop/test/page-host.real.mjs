// Page host tab against a private HTTPS fixture shaped like Cloudflare Access + the pairing gateway:
// the app site redirects to a sign-in site, which navigates back; the app's own session cookie is
// SameSite=Strict, so the first arrival from the sign-in site does not carry it. The tab must end
// on the real page (or a visible sign-in/pairing page), never a blank or spinning view.
import { _electron, expect } from "@playwright/test"
import { execFileSync } from "node:child_process"
import { createServer } from "node:https"
import { mkdtemp, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { createFixture } from "../../es-app/test/composer-fixture.mjs"

const root = fileURLToPath(new URL("..", import.meta.url))
const dir = await mkdtemp(path.join(tmpdir(), "es-page-host-"))
execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=localhost",
  "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1", "-keyout", path.join(dir, "key.pem"), "-out", path.join(dir, "cert.pem")], { stdio: "ignore" })
const tls = { key: await readFile(path.join(dir, "key.pem")), cert: await readFile(path.join(dir, "cert.pem")) }
const listen = (handler) => new Promise((resolve) => { const server = createServer(tls, handler); server.listen(0, "127.0.0.1", () => resolve(server)) })
const seen = []
const cookies = (req) => Object.fromEntries((req.headers.cookie ?? "").split(";").map((item) => item.trim().split("=")).filter((pair) => pair[0]))
const html = (res, status, body, headers = {}) => { res.writeHead(status, { "content-type": "text/html", ...headers }); res.end(`<!doctype html><title>${body}</title><h1>${body}</h1>`) }
const signIn = await listen((req, res) => {
  // Sign-in site (a different site from the app): returns to the app from the page, as Access does after a PIN.
  res.writeHead(200, { "content-type": "text/html" })
  res.end(`<!doctype html><title>Sign in</title><script>setTimeout(() => location.href = ${JSON.stringify(`https://127.0.0.1:${appPort()}/authorized`)}, 300)</script>`)
})
const app = await listen((req, res) => {
  const url = new URL(req.url, "https://127.0.0.1")
  const jar = cookies(req)
  seen.push({ path: url.pathname, access: !!jar.access, paired: !!jar.paired })
  if (url.pathname === "/authorized") return html(res, 302, "redirect", { "set-cookie": "access=1; Secure; HttpOnly; SameSite=Lax; Path=/", location: "/" })
  if (!jar.access) return html(res, 302, "redirect", { location: `https://localhost:${signIn.address().port}/login` })
  if (!jar.paired) return html(res, 401, "Pairing required")
  return html(res, 200, "Personal app ready")
})
function appPort() { return app.address().port }
const origin = `https://127.0.0.1:${appPort()}`
const fixture = await createFixture()
const profile = await mkdtemp(path.join(tmpdir(), "es-page-host-profile-"))
const electron = await _electron.launch({
  ...(process.env.ES_DESKTOP_EXECUTABLE ? { executablePath: process.env.ES_DESKTOP_EXECUTABLE, args: ["--ignore-certificate-errors"] } : { args: [root, "--ignore-certificate-errors"] }),
  env: { ...process.env, ELECTRON_RUN_AS_NODE: "", OPENCODE_URL: fixture.url, ES_DASHBOARD_URL: fixture.url, OPENCODE_SERVER_PASSWORD: "", ES_DESKTOP_USER_DATA: profile, ES_DESKTOP_START: "hidden",
    ES_REMOTE_HOSTS: JSON.stringify([{ id: "personal", label: "Personal", origin, mode: "page" }]) },
})
const result = {}
try {
  // Already paired in this tab's partition (as after a first pairing), so only the sign-in round trip is new.
  await electron.evaluate(({ session }, url) => session.fromPartition("persist:editspace-host-personal").cookies.set({ url, name: "paired", value: "1", secure: true, httpOnly: true, sameSite: "strict" }), origin)
  const find = async (match) => { for (let i = 0; i < 80; i++) { const page = electron.windows().find((item) => match(item.url())); if (page) return page; await new Promise((r) => setTimeout(r, 250)) } }
  const bar = await find((url) => url.startsWith("data:"))
  await new Promise((r) => setTimeout(r, 2500))
  await bar.getByRole("link", { name: "Personal" }).click()
  const page = await find((url) => url.startsWith(origin) || url.includes("localhost"))
  await new Promise((r) => setTimeout(r, 4000))
  result.url = page.url()
  result.title = await page.title()
  result.requests = seen
  // The host stops answering: the tab says the page is unavailable instead of going blank.
  app.closeAllConnections?.()
  await new Promise((r) => app.close(r))
  await page.reload().catch(() => {})
  await new Promise((r) => setTimeout(r, 2000))
  const failed = await find((url) => url.startsWith("data:text/html") && url.includes("Page%20unavailable"))
  result.downTitle = failed ? await failed.title() : null
  console.log(JSON.stringify(result, null, 2))
  expect(result.title).toBe("Personal app ready")
  expect(result.downTitle).toBe("Page unavailable")
} finally {
  await electron.close()
  await fixture.close()
  app.close?.()
  signIn.close()
}
