// Front Desk surfaces behind an authenticating edge (Cloudflare Access in front of the app).
// The fixture edge sets a SameSite=Lax session cookie and answers any request without it with a
// 302 to its login page, the way Access does. Browsers send no cookies with an opaque-origin
// (sandboxed) frame's subresource requests, so a surface's CSS, JS and API calls hit that 302.
// Phase 1 reproduces that with no edge exception. Phase 2 deploys the chosen transport: an edge
// bypass for /__surface/ only, where the expiring per-surface capability is the whole credential.
// Run from packages/es-app: node test/surface-edge.browser.mjs
import { createRequire } from "node:module"
import { createServer } from "node:http"
// SURFACE_PROXY points at another build of surface-proxy.ts, to show this test fails without the fix.
const { surfaceProxy } = await import(process.env.SURFACE_PROXY ?? "../surface-proxy.ts")

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const SESSION = "fixture_access=signed-in"

const listen = (handler) => new Promise((resolve) => {
  const server = createServer(handler)
  server.listen(0, "127.0.0.1", () => resolve({ server, origin: `http://127.0.0.1:${server.address().port}` }))
})

// The agent's own surface: a stylesheet, a script and a call to its own data endpoint.
const surface = await listen((req, res) => {
  const files = {
    "/": ["text/html", `<!doctype html><link rel="stylesheet" href="style.css"><script src="app.js" defer></script><h1>Migration</h1><p id="data">loading</p>`],
    "/style.css": ["text/css", "body { color: rgb(1, 2, 3) }"],
    "/app.js": ["text/javascript", `fetch("api/data").then(r => r.json()).then(d => { document.getElementById("data").textContent = d.done + " migrated" }).catch(e => { document.getElementById("data").textContent = "failed: " + e })`],
    "/api/data": ["application/json", JSON.stringify({ done: 41 })],
  }
  const file = files[req.url ?? ""]
  res.writeHead(file ? 200 : 404, { "content-type": file?.[0] ?? "text/plain" })
  res.end(file?.[1] ?? "missing")
})

let bypass = []
const proxy = surfaceProxy({ dashboard: undefined, registry: async () => [{ id: "migration", upstream: `${surface.origin}/` }], capabilityTtl: 4000 })
const parent = `<!doctype html><title>Desk</title><iframe id="frame" sandbox="allow-scripts allow-forms"></iframe>
<script>fetch("/__es/surface/migration").then(r => r.json()).then(a => { document.getElementById("frame").src = a.src })</script>`

const edge = await listen((req, res) => {
  const url = new URL(req.url ?? "/", "http://edge")
  if (url.pathname === "/cdn-cgi/access/login") {
    res.writeHead(302, { location: "/", "set-cookie": `${SESSION}; HttpOnly; SameSite=Lax; Path=/` })
    return res.end()
  }
  const signedIn = (req.headers.cookie ?? "").split(/;\s*/).includes(SESSION)
  if (!signedIn && !bypass.some((prefix) => url.pathname.startsWith(prefix))) {
    res.writeHead(302, { location: "/cdn-cgi/access/login", "content-type": "text/html" })
    return res.end("<html>Sign in</html>")
  }
  if (url.pathname.startsWith("/__es/surface/")) return proxy.address(req, res)
  if (url.pathname.startsWith("/__surface/")) return void proxy.serve(req, res)
  res.writeHead(200, { "content-type": "text/html", "content-security-policy": "frame-src 'self'" })
  res.end(parent)
})

const browser = await chromium.launch({ channel: "chrome", headless: true })
const results = []
const check = async (name, run) => {
  try { await run(); results.push(`PASS ${name}`) } catch (error) { results.push(`FAIL ${name}: ${String(error).split("\n")[0]}`); process.exitCode = 1 }
}
const signedInFrame = async () => {
  const context = await browser.newContext()
  const page = await context.newPage()
  await page.goto(`${edge.origin}/cdn-cgi/access/login`)
  const frame = page.frameLocator("#frame")
  return { context, page, frame }
}
try {
  await check("phase 1 (no edge exception): the bug reproduces: frame document loads, its CSS/JS/data are sent to login", async () => {
    const { context, frame } = await signedInFrame()
    await expect(frame.locator("h1")).toHaveText("Migration", { timeout: 15_000 })
    await new Promise((resolve) => setTimeout(resolve, 1500))
    await expect(frame.locator("#data")).toHaveText("loading")
    expect(await frame.locator("body").evaluate((body) => getComputedStyle(body).color)).not.toBe("rgb(1, 2, 3)")
    await context.close()
  })

  bypass = ["/__surface/"]
  await check("phase 2: signed-in parent renders the surface with its styles and data", async () => {
    const { context, page, frame } = await signedInFrame()
    await expect(frame.locator("#data")).toHaveText("41 migrated", { timeout: 15_000 })
    expect(await frame.locator("body").evaluate((body) => getComputedStyle(body).color)).toBe("rgb(1, 2, 3)")
    const probe = await page.frames().find((item) => item.url().includes("/__surface/")).evaluate(async () => {
      const result = {}
      try { result.parent = String(window.parent.document.title) } catch { result.parent = "blocked" }
      try { result.storage = localStorage.length } catch { result.storage = "blocked" }
      return result
    })
    expect(probe).toEqual({ parent: "blocked", storage: "blocked" })
    await context.close()
  })

  await check("phase 2: anonymous requests still go to login everywhere except /__surface/", async () => {
    for (const path of ["/", "/__es/surface/migration", "/oc/session", "/es/api/surfaces"]) {
      const response = await fetch(`${edge.origin}${path}`, { redirect: "manual" })
      expect([path, response.status, response.headers.get("location")]).toEqual([path, 302, "/cdn-cgi/access/login"])
    }
  })

  await check("phase 2: wrong, foreign, edited and expired capabilities get a plain 404, never the login page", async () => {
    const minted = await fetch(`${edge.origin}/__es/surface/migration`, { headers: { cookie: SESSION } }).then((response) => response.json())
    const [expiry, signature] = minted.src.split("/")[3].split("-")
    const bad = [
      `/__surface/migration/${expiry}-${"0".repeat(32)}/`,
      `/__surface/other/${expiry}-${signature}/`,
      `/__surface/migration/${(parseInt(expiry, 36) + 3600).toString(36)}-${signature}/`,
      `/__surface/migration/${expiry}-${signature}/../../oc/session`,
    ]
    for (const path of bad) {
      const response = await fetch(`${edge.origin}${path}`, { redirect: "manual" })
      expect([path, response.status, response.headers.get("location")]).toEqual([path, 404, null])
    }
    expect((await fetch(`${edge.origin}${minted.src}`, { redirect: "manual" })).status).toBe(200)
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, minted.expires_at - Date.now()) + 200))
    const expired = await fetch(`${edge.origin}${minted.src}`, { redirect: "manual" })
    expect([expired.status, await expired.text()]).toEqual([404, "Not found"])
  })
} finally {
  await browser.close()
  edge.server.close()
  surface.server.close()
  console.log(results.join("\n"))
}
