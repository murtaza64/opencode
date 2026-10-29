import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { serve } from "./server"
import { apiAllowed, appRouteURL, externalURL, hostApiAllowed, hostWriteAllowed, internalURL, serviceOrigins, serviceURL, startupMode, startupPlan, surfaceFrameURL } from "./policy"
import { readFile } from "node:fs/promises"

const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})
const setup = async () => {
  const root = await mkdtemp(path.join(tmpdir(), "es-desktop-test-"))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  await Bun.write(path.join(root, "index.html"), "<title>Fixture renderer</title>")
  await Bun.write(path.join(root, "app.js"), "export const fixture = true")
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url)
      // Consume every request body: an unread body makes the server drop the keep-alive
      // connection, and the proxy's next pooled request then fails as "socket closed".
      const text = await request.text()
      if (url.pathname === "/api/attention/session") return Response.json({
        originBound: request.headers.get("origin") === url.origin,
        operatorCookieOnly: request.headers.get("cookie") === "es_attention_operator=synthetic",
        csrf: request.headers.get("x-attention-csrf"),
        keyForwarded: request.headers.has("x-editspace-key"),
        authForwarded: request.headers.has("authorization"),
      }, { headers: { "set-cookie": "es_attention_operator=synthetic; HttpOnly; SameSite=Strict; Path=/" } })
      if (url.pathname.startsWith("/api/frontdesk/") || /^\/api\/attention\/[0-9a-f-]{36}\//.test(url.pathname)) return Response.json({
        method: request.method,
        path: url.pathname,
        originBound: request.headers.get("origin") === url.origin,
        operatorCookieOnly: request.headers.get("cookie") === "es_attention_operator=synthetic",
        keyForwarded: request.headers.has("x-editspace-key"),
      })
      if (url.pathname === "/api/handoffs/self" || /^\/api\/handoffs\/self\/[\w-]+$/.test(url.pathname)) return Response.json({
        method: request.method,
        path: url.pathname,
        query: url.search,
        body: text,
        originBound: request.headers.get("origin") === url.origin,
        operatorCookieOnly: request.headers.get("cookie") === "es_attention_operator=synthetic",
        csrf: request.headers.get("x-attention-csrf"),
        keyForwarded: request.headers.has("x-editspace-key"),
        authForwarded: request.headers.has("authorization"),
      })
      if (url.pathname.startsWith("/api/secret-intake/sih_SLOW")) return Response.json({ error: "uncertain" }, { status: 502 })
      if (url.pathname.startsWith("/api/secret-intake/")) return Response.json({
        method: request.method,
        path: url.pathname,
        query: url.search,
        body: text,
        originBound: request.headers.get("origin") === url.origin,
        operatorCookieOnly: request.headers.get("cookie") === "es_attention_operator=synthetic",
        csrf: request.headers.get("x-attention-csrf"),
        keyForwarded: request.headers.has("x-editspace-key"),
        authForwarded: request.headers.has("authorization"),
      })
      if (url.searchParams.has("redirect")) return Response.redirect("http://127.0.0.1:4096", 302)
      if (url.pathname === "/event")
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("data: ready\n\n"))
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        )
      return Response.json(
        {
          method: request.method,
          path: url.pathname,
          directory: url.searchParams.get("directory"),
          body: text,
          credentialForwarded:
            request.headers.has("cookie") ||
            request.headers.has("x-editspace-key") ||
            request.headers.has("authorization"),
        },
        { status: url.searchParams.has("conflict") ? 409 : 200 },
      )
    },
  })
  cleanup.push(async () => {
    await upstream.stop(true)
  })
  const server = await serve({ root, opencode: upstream.url.origin, dashboard: upstream.url.origin })
  cleanup.push(server.close)
  const get = (pathname: string, init?: RequestInit) =>
    fetch(`${server.origin}${pathname}`, {
      ...init,
      headers: { "x-editspace-key": server.key, ...init?.headers },
    })
  return { root, server, upstream, get }
}

test("requires explicit loopback service origins", () => {
  expect(serviceURL(undefined)).toBeUndefined()
  expect(serviceURL("http://127.0.0.1:12345")).toBe("http://127.0.0.1:12345")
  for (const value of [
    "https://example.com",
    "http://localhost:4096",
    "http://127.0.0.1:4096/path",
    "http://user:pass@127.0.0.1:4096",
    "file:///tmp/test",
  ])
    expect(() => serviceURL(value)).toThrow()
})

test("Spotlight launch reads configured service origins without shell environment", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "es-desktop-origins-"))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  await Bun.write(path.join(directory, "service-origins.json"), JSON.stringify({
    opencode: "http://127.0.0.1:4096",
    dashboard: "http://127.0.0.1:7777",
  }))
  expect(await serviceOrigins(directory, {})).toEqual({
    opencode: "http://127.0.0.1:4096",
    dashboard: "http://127.0.0.1:7777",
  })
  expect(await serviceOrigins(directory, { OPENCODE_URL: "http://127.0.0.1:52961" })).toEqual({
    opencode: "http://127.0.0.1:52961",
    dashboard: "http://127.0.0.1:7777",
  })
})

test("rejects non-loopback origins from the saved configuration", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "es-desktop-origins-"))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  await Bun.write(path.join(directory, "service-origins.json"), JSON.stringify({ opencode: "https://example.com" }))
  await expect(serviceOrigins(directory, {})).rejects.toThrow("Service targets must be explicit")
})

test("external links only accept credential-free HTTP(S)", () => {
  expect(externalURL("https://example.com/path?q=1")).toBe("https://example.com/path?q=1")
  for (const value of [
    "ink://open",
    "file:///tmp/test",
    "javascript:alert(1)",
    "data:text/html,test",
    "https://user:pass@example.com",
    "https://example.com\n",
  ])
    expect(externalURL(value)).toBeUndefined()
  expect(internalURL("http://127.0.0.1:12345/session/ses_a", "http://127.0.0.1:12345")).toBe(true)
  expect(internalURL("http://127.0.0.1:12345/oc/session", "http://127.0.0.1:12345")).toBe(false)
  expect(internalURL("http://127.0.0.1:54321/", "http://127.0.0.1:12345")).toBe(false)
})

test("agent-shared app links open in this window; other destinations stay external", () => {
  const origin = "http://127.0.0.1:60302"
  const session = "/session/ses_e9bdef7e4ffeo9XgAIryoyMX2Z?directory=%2FUsers%2Fme%2Fproj"
  expect(appRouteURL(`http://127.0.0.1:3181${session}`, origin)).toBe(`${origin}${session}`)
  expect(appRouteURL(`http://localhost:3100${session}#end`, origin)).toBe(`${origin}${session}#end`)
  expect(appRouteURL(`${origin}/desk`, origin)).toBe(`${origin}/desk`)
  expect(appRouteURL(`http://127.0.0.1:3181${session}&message=msg_a&to=msg_b`, origin)).toBe(`${origin}${session}&message=msg_a&to=msg_b`)
  expect(apiAllowed("GET", "/oc/session/ses_a/message/msg_a")).toBe(true)
  for (const value of [
    "https://github.com/owner/repo/pull/1",
    "http://127.0.0.1:64297/map",
    "http://127.0.0.1:7777/session/ses_a",
    "http://example.com:3181/session/ses_a",
    "http://u:p@127.0.0.1:3181/session/ses_a",
    "http://127.0.0.1:3181/oc/session",
    "http://127.0.0.1:3181/es/api/state",
  ])
    expect(appRouteURL(value, origin)).toBeUndefined()
})

test("API surface excludes direct shell, PTY, file, and config access", () => {
  expect(apiAllowed("POST", "/oc/session")).toBe(true)
  expect(apiAllowed("PUT", "/oc/session")).toBe(false)
  expect(apiAllowed("POST", "/oc/session/ses_a/input")).toBe(true)
  expect(apiAllowed("POST", "/es/api/handoffs/self")).toBe(true)
  expect(apiAllowed("GET", "/es/api/handoffs/self/req_1")).toBe(true)
  expect(apiAllowed("DELETE", "/es/api/handoffs/self/req_1")).toBe(true)
  expect(apiAllowed("POST", "/es/api/handoffs/self/req_1")).toBe(false)
  expect(apiAllowed("DELETE", "/es/api/handoffs/self")).toBe(false)
  expect(hostApiAllowed("GET", "/es/api/handoffs/self/req_1")).toBe(true)
  expect(hostWriteAllowed("POST", "/es/api/handoffs/self")).toBe(false)
  expect(hostWriteAllowed("DELETE", "/es/api/handoffs/self/req_1")).toBe(false)
  expect(apiAllowed("DELETE", "/oc/session/ses_a/aside/request-1")).toBe(true)
  for (const pathname of ["/oc/pty", "/oc/session/ses_a/shell", "/oc/config", "/oc/file/content", "/es/api/run"])
    expect(apiAllowed("POST", pathname)).toBe(false)
  // read-only session insight and PR detail lookups (dotfiles#139) are GET only
  expect(apiAllowed("GET", "/es/api/session-insights")).toBe(true)
  expect(apiAllowed("GET", "/es/api/lane-provenance")).toBe(true)
  expect(apiAllowed("POST", "/es/api/lane-provenance")).toBe(false)
  expect(apiAllowed("GET", "/es/api/pr-detail")).toBe(true)
  expect(apiAllowed("GET", "/es/api/current-work")).toBe(true)
  expect(apiAllowed("POST", "/es/api/current-work")).toBe(false)
  expect(apiAllowed("POST", "/es/api/session-insights")).toBe(false)
  expect(apiAllowed("POST", "/es/api/pr-detail")).toBe(false)
  // session todos are read-only
  expect(apiAllowed("GET", "/oc/session/ses_a/todo")).toBe(true)
  expect(apiAllowed("POST", "/oc/session/ses_a/todo")).toBe(false)
  expect(apiAllowed("GET", "/oc/session/ses_a/todo/x")).toBe(false)
  // Front desk reads its background-check children; listing only, never creating through this path
  expect(apiAllowed("GET", "/oc/session/ses_a/children")).toBe(true)
  expect(apiAllowed("POST", "/oc/session/ses_a/children")).toBe(false)
  expect(apiAllowed("GET", "/oc/session/ses_a/children/x")).toBe(false)
  // Front desk memory: read and whole-document CAS write only
  expect(apiAllowed("GET", "/es/api/frontdesk/memory")).toBe(true)
  expect(apiAllowed("PUT", "/es/api/frontdesk/memory")).toBe(true)
  expect(apiAllowed("POST", "/es/api/frontdesk/memory")).toBe(false)
  expect(apiAllowed("DELETE", "/es/api/frontdesk/memory")).toBe(false)
  expect(apiAllowed("GET", "/es/api/frontdesk/memory/x")).toBe(false)
  // Front desk ignored failures: read, and idempotent ignore/unignore posts
  expect(apiAllowed("GET", "/es/api/frontdesk/ignored-failures")).toBe(true)
  expect(apiAllowed("POST", "/es/api/frontdesk/ignored-failures")).toBe(true)
  expect(apiAllowed("PUT", "/es/api/frontdesk/ignored-failures")).toBe(false)
  expect(apiAllowed("DELETE", "/es/api/frontdesk/ignored-failures")).toBe(false)
  expect(apiAllowed("GET", "/es/api/frontdesk/ignored-failures/x")).toBe(false)
  // steer delivery and interrupted-step recovery
  expect(apiAllowed("POST", "/oc/session/ses_a/input/req_1/deliver")).toBe(true)
  expect(apiAllowed("POST", "/oc/session/ses_a/recover")).toBe(true)
  expect(apiAllowed("GET", "/oc/session/ses_a/input/req_1/deliver")).toBe(false)
  expect(apiAllowed("POST", "/oc/session/ses_a/input/req_1/deliver/x")).toBe(false)
  expect(apiAllowed("POST", "/oc/session/ses_a/input/../deliver")).toBe(false)
  // failed-turn recovery: read the durable list, retry one exact failure
  expect(apiAllowed("GET", "/oc/experimental/session/failed")).toBe(true)
  // Today's estimated spend (title-bar total): the daily rollup only, read-only.
  expect(apiAllowed("GET", "/oc/experimental/usage/daily")).toBe(true)
  expect(apiAllowed("POST", "/oc/experimental/usage/daily")).toBe(false)
  expect(apiAllowed("GET", "/oc/experimental/usage")).toBe(false)
  expect(apiAllowed("GET", "/oc/experimental/usage/daily/raw")).toBe(false)
  expect(apiAllowed("POST", "/oc/session/ses_a/retry")).toBe(true)
  expect(apiAllowed("GET", "/oc/session/ses_a/retry")).toBe(false)
  expect(apiAllowed("POST", "/oc/experimental/session/failed")).toBe(false)
  // A completed tool part's attachment: one exact read-only route, by index.
  expect(apiAllowed("GET", "/oc/session/ses_a/message/msg_b/part/prt_c/attachment/0")).toBe(true)
  expect(apiAllowed("GET", "/oc/session/ses_a/message/msg_b/part/prt_c/attachment/12")).toBe(true)
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) expect(apiAllowed(method, "/oc/session/ses_a/message/msg_b/part/prt_c/attachment/0")).toBe(false)
  for (const pathname of [
    "/oc/session/ses_a/message/msg_b/part/prt_c/attachment",
    "/oc/session/ses_a/message/msg_b/part/prt_c/attachment/x",
    "/oc/session/ses_a/message/msg_b/part/prt_c/attachment/0/raw",
    "/oc/session/ses_a/message/msg_b/part/../attachment/0",
    "/oc/session/ses_a/message/msg_b/part/prt_c",
    "/oc/session/ses_a/message/msg_b/part",
  ]) expect(apiAllowed("GET", pathname)).toBe(false)
})

test("a tool attachment is proxied keyed, without browser credentials, keeping Core's type and cache headers", async () => {
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) => new Response("PNGBYTES", {
      headers: {
        "content-type": "image/png",
        "cache-control": new URL(request.url).pathname.endsWith("/1") ? "public, max-age=31536000" : "private, max-age=3600",
        "x-content-type-options": "nosniff",
        "content-security-policy": "sandbox",
        "x-path": new URL(request.url).pathname,
        "x-credential": String(request.headers.has("cookie") || request.headers.has("x-editspace-key")),
      },
    }),
  })
  cleanup.push(async () => upstream.stop(true))
  const root = await mkdtemp(path.join(tmpdir(), "es-desktop-attachment-"))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  await Bun.write(path.join(root, "index.html"), "<title>Fixture</title>")
  const server = await serve({ root, opencode: upstream.url.origin, dashboard: upstream.url.origin })
  cleanup.push(server.close)
  const route = "/oc/session/ses_a/message/msg_b/part/prt_c/attachment/0"
  expect((await fetch(`${server.origin}${route}`)).status).toBe(403)
  const response = await fetch(`${server.origin}${route}`, { headers: { "x-editspace-key": server.key, cookie: "es_attention_operator=x" } })
  expect(response.status).toBe(200)
  expect(await response.text()).toBe("PNGBYTES")
  expect(response.headers.get("x-path")).toBe("/session/ses_a/message/msg_b/part/prt_c/attachment/0")
  expect(response.headers.get("x-credential")).toBe("false")
  expect(response.headers.get("content-type")).toBe("image/png")
  expect(response.headers.get("cache-control")).toBe("private, max-age=3600")
  expect(response.headers.get("x-content-type-options")).toBe("nosniff")
  // Opened directly it can never run as the app: an empty sandbox replaces whatever Core sent.
  expect(response.headers.get("content-security-policy")).toBe("sandbox; default-src 'none'")
  expect((await fetch(`${server.origin}${route}`, { method: "POST", headers: { "x-editspace-key": server.key } })).status).toBe(403)
  // Only private caching passes through; anything else is no-store.
  const shared = await fetch(`${server.origin}${route.replace(/0$/, "1")}`, { headers: { "x-editspace-key": server.key } })
  expect(shared.headers.get("cache-control")).toBe("no-store")
  // Every other route keeps the app's own CSP and no-store.
  const other = await fetch(`${server.origin}/oc/session/ses_a/message/msg_b`, { headers: { "x-editspace-key": server.key } })
  expect(other.headers.get("cache-control")).toBe("no-store")
  expect(other.headers.get("content-security-policy")).toContain("script-src 'self'")
})

test("rejects unauthenticated, cross-origin, and foreign Host requests", async () => {
  const { server, get } = await setup()
  expect((await fetch(server.origin)).status).toBe(403)
  expect((await get("/oc/session", { headers: { origin: "https://example.com" } })).status).toBe(403)
  expect((await get("/oc/session", { headers: { host: "evil.test" } })).status).toBe(403)
  expect((await get("/oc/session", { headers: { "sec-fetch-site": "cross-site" } })).status).toBe(403)
  expect((await get("/oc/pty", { method: "POST" })).status).toBe(403)
})

test("pending input PATCH is exact-route keyed and origin-bound without forwarding credentials", async () => {
  const { server, get } = await setup()
  const pathname = "/oc/session/ses_a/input/request-1"
  const body = JSON.stringify({ commandID: "edit-1", expectedRevision: 0, text: "edited", delivery: "steer" })
  expect(apiAllowed("PATCH", pathname)).toBe(true)
  expect(apiAllowed("PATCH", "/oc/session/ses_a/input")).toBe(false)
  expect(apiAllowed("PATCH", "/oc/session/ses_a/input/request-1/handle")).toBe(false)
  expect(apiAllowed("PATCH", "/oc/session/ses_a/message/msg_a")).toBe(false)
  expect(apiAllowed("PUT", pathname)).toBe(false)
  expect((await fetch(`${server.origin}${pathname}`, { method: "PATCH", body, headers: { origin: server.origin } })).status).toBe(403)
  expect((await get(pathname, { method: "PATCH", body, headers: { origin: "https://evil.test" } })).status).toBe(403)
  expect((await get(pathname, { method: "PATCH", body, headers: { "sec-fetch-site": "cross-site" } })).status).toBe(403)
  const response = await get(`${pathname}?directory=%2Ffixture&conflict=1`, {
    method: "PATCH", body, headers: { origin: server.origin, "content-type": "application/json" },
  })
  expect(response.status).toBe(409)
  expect(await response.json()).toEqual({ method: "PATCH", path: "/session/ses_a/input/request-1", directory: "/fixture", body, credentialForwarded: false })
})

test("attention exposes only operator bootstrap, reads and record commands", () => {
  const id = "00000000-0000-4000-8000-000000000001"
  expect(apiAllowed("GET", "/es/api/attention")).toBe(true)
  expect(apiAllowed("GET", "/es/api/attention/session")).toBe(true)
  expect(apiAllowed("GET", `/es/api/attention/${id}`)).toBe(true)
  expect(apiAllowed("POST", "/es/api/attention/session")).toBe(true)
  expect(apiAllowed("POST", `/es/api/attention/${id}/commands`)).toBe(true)
  expect(apiAllowed("POST", "/es/api/attention/publish")).toBe(false)
  expect(apiAllowed("POST", "/es/api/attention/session/commands")).toBe(false)
  expect(apiAllowed("GET", `/es/api/attention/${id}/commands`)).toBe(false)
  expect(apiAllowed("DELETE", `/es/api/attention/${id}`)).toBe(false)
  expect(apiAllowed("PUT", "/es/api/attention/session")).toBe(false)
  expect(apiAllowed("GET", "/es/api/wingman")).toBe(true)
  expect(apiAllowed("GET", "/es/api/wingman/transcript")).toBe(true)
  expect(apiAllowed("POST", "/es/api/wingman")).toBe(false)
  expect(apiAllowed("POST", "/es/api/wingman/transcript")).toBe(false)
})

test("binds attention to the validated native origin and forwards only its operator cookie", async () => {
  const { server, get } = await setup()
  const response = await get("/es/api/attention/session", {
    method: "POST", body: "{}", headers: { origin: server.origin, cookie: "unrelated=private; es_attention_operator=synthetic", authorization: "not-forwarded", "x-attention-csrf": "1", "content-type": "application/json" },
  })
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ originBound: true, operatorCookieOnly: true, csrf: "1", keyForwarded: false, authForwarded: false })
  expect(response.headers.get("set-cookie")).toContain("es_attention_operator=")
  expect((await get("/es/api/attention/session", { method: "POST", body: "{}" })).status).toBe(403)
  expect((await get("/es/api/attention/session", { method: "POST", body: "{}", headers: { origin: "https://evil.test" } })).status).toBe(403)
  expect((await fetch(`${server.origin}/es/api/attention/session`, { method: "POST", body: "{}", headers: { origin: server.origin } })).status).toBe(403)
})

test("a secure decision field's one POST reaches the dashboard bound to its origin with only the operator cookie", async () => {
  const { server, get } = await setup()
  const path = "/es/api/secret-intake/sih_AAAAAAAAAAAAAAAAAAAAAA?es=alpha&record=r&revision=2&choice=provide"
  const body = JSON.stringify({ values: { issuer: "user:CANARY-ISSUER", secret: "CANARY-SECRET" } })
  const response = await get(path, {
    method: "POST", body, headers: { origin: server.origin, cookie: "unrelated=private; es_attention_operator=synthetic", authorization: "not-forwarded", "x-attention-csrf": "1", "content-type": "application/json" },
  })
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ method: "POST", path: "/api/secret-intake/sih_AAAAAAAAAAAAAAAAAAAAAA", query: "?es=alpha&record=r&revision=2&choice=provide", body,
    originBound: true, operatorCookieOnly: true, csrf: "1", keyForwarded: false, authForwarded: false })
  expect((await get(path, { method: "POST", body, headers: { "content-type": "application/json" } })).status).toBe(403)
  expect((await get(path, { method: "POST", body, headers: { origin: "https://evil.test", "content-type": "application/json" } })).status).toBe(403)
  expect((await get(path)).status).toBe(403)
})

test("a secure field's handle never reaches the performance journal", async () => {
  const { root, upstream } = await setup()
  const perfDir = await mkdtemp(path.join(tmpdir(), "es-desktop-perf-"))
  cleanup.push(() => rm(perfDir, { recursive: true, force: true }))
  const server = await serve({ root, opencode: upstream.url.origin, dashboard: upstream.url.origin, perfDir })
  cleanup.push(server.close)
  const handle = "sih_SLOWAAAAAAAAAAAAAAAAAA"
  const response = await fetch(`${server.origin}/es/api/secret-intake/${handle}?es=alpha`, {
    method: "POST", body: "{}", headers: { "x-editspace-key": server.key, origin: server.origin, cookie: "es_attention_operator=synthetic", "content-type": "application/json", "x-attention-csrf": "1" },
  })
  expect(response.status).toBe(502)
  await response.text()
  let journal = ""
  for (let attempt = 0; attempt < 40 && !journal; attempt++) {
    await Bun.sleep(25)
    journal = (await Promise.all([...new Bun.Glob("*.jsonl").scanSync(perfDir)].map(file => readFile(path.join(perfDir, file), "utf8")))).join("")
  }
  expect(journal).toContain('"route":"es/api/secret-intake/:handle"')
  expect(journal).not.toContain(handle)
})

test("a remote host's listener never forwards a secure decision field", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "es-desktop-test-"))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  await Bun.write(path.join(root, "index.html"), "<title>Fixture renderer</title>")
  const server = await serve({ root, remote: { id: "mini", origin: "https://mini.example.ts.net" } })
  cleanup.push(server.close)
  const response = await fetch(`${server.origin}/es/api/secret-intake/sih_AAAAAAAAAAAAAAAAAAAAAA?es=alpha`, {
    method: "POST", body: "{}", headers: { "x-editspace-key": server.key, origin: server.origin, "content-type": "application/json", "x-attention-csrf": "1" },
  })
  expect(response.status).toBe(403)
  expect(await response.text()).toContain("answered on the computer that asked")
})

test("Front desk ignored failures and memory reach the dashboard with only the operator cookie", async () => {
  const { server, get } = await setup()
  const cookie = "unrelated=private; es_attention_operator=synthetic"
  const read = await get("/es/api/frontdesk/ignored-failures", { headers: { cookie } })
  expect(read.status).toBe(200)
  expect(await read.json()).toEqual({ method: "GET", path: "/api/frontdesk/ignored-failures", originBound: true, operatorCookieOnly: true, keyForwarded: false })
  const write = await get("/es/api/frontdesk/ignored-failures", {
    method: "POST", body: "{}", headers: { origin: server.origin, cookie, "x-attention-csrf": "1", "content-type": "application/json" },
  })
  expect(await write.json()).toMatchObject({ method: "POST", originBound: true, operatorCookieOnly: true })
  const memory = await get("/es/api/frontdesk/memory", { method: "PUT", body: "{}", headers: { origin: server.origin, cookie, "content-type": "application/json" } })
  expect(await memory.json()).toMatchObject({ method: "PUT", operatorCookieOnly: true })
  expect((await get("/es/api/frontdesk/ignored-failures", { method: "POST", body: "{}" })).status).toBe(403)
  expect((await get("/es/api/frontdesk/ignored-failures", { method: "POST", body: "{}", headers: { origin: "https://evil.test" } })).status).toBe(403)
})

test("pin writes reach this host's dashboard as operator writes, the lane ref still encoded once", async () => {
  const { server, get } = await setup()
  const cookie = "unrelated=private; es_attention_operator=synthetic"
  const headers = { origin: server.origin, cookie, "x-attention-csrf": "1", "content-type": "application/json" }
  const lane = await get("/es/api/pins/lane:opencode%2Forchestrator", { method: "PUT", body: '{"at":1,"op":"op-12345678"}', headers })
  expect(await lane.json()).toMatchObject({ method: "PUT", path: "/api/pins/lane:opencode%2Forchestrator", body: '{"at":1,"op":"op-12345678"}' })
  const order = await get("/es/api/pins/session:ses_a/order", { method: "PATCH", body: "{}", headers })
  expect(await order.json()).toMatchObject({ method: "PATCH", path: "/api/pins/session:ses_a/order" })
  const unpin = await get("/es/api/pins/session:ses_a", { method: "DELETE", body: "{}", headers })
  expect(await unpin.json()).toMatchObject({ method: "DELETE", path: "/api/pins/session:ses_a" })
  // Without the native origin a pin write never leaves the listener.
  expect((await get("/es/api/pins/session:ses_a", { method: "PUT", body: "{}" })).status).toBe(403)
  expect((await get("/es/api/pins/session:ses_a", { method: "PUT", body: "{}", headers: { origin: "https://evil.test" } })).status).toBe(403)
})

test("self-handoff POST and DELETE reach only this host's dashboard with operator cookie and bound origin", async () => {
  const { server, get } = await setup()
  const headers = { origin: server.origin, cookie: "unrelated=private; es_attention_operator=synthetic", authorization: "not-forwarded", "x-attention-csrf": "1", "content-type": "application/json" }
  const post = await get("/es/api/handoffs/self?es=proj", { method: "POST", body: '{"lane":"work"}', headers })
  expect(post.status).toBe(200)
  expect(await post.json()).toEqual({ method: "POST", path: "/api/handoffs/self", query: "?es=proj", body: '{"lane":"work"}', originBound: true, operatorCookieOnly: true, csrf: "1", keyForwarded: false, authForwarded: false })
  const remove = await get("/es/api/handoffs/self/click-1?es=proj", { method: "DELETE", body: "{}", headers })
  expect(remove.status).toBe(200)
  expect(await remove.json()).toEqual({ method: "DELETE", path: "/api/handoffs/self/click-1", query: "?es=proj", body: "{}", originBound: true, operatorCookieOnly: true, csrf: "1", keyForwarded: false, authForwarded: false })
  for (const [method, pathname] of [["POST", "/es/api/handoffs/self"], ["DELETE", "/es/api/handoffs/self/click-1"]]) {
    expect((await get(pathname, { method, body: "{}", headers: { ...headers, origin: "https://evil.test" } })).status).toBe(403)
    expect((await get(pathname, { method, body: "{}", headers: { cookie: headers.cookie, "content-type": "application/json" } })).status).toBe(403)
  }
})

test("only exact pin routes are exposed", () => {
  expect(apiAllowed("GET", "/es/api/pins")).toBe(true)
  expect(apiAllowed("GET", "/es/api/pins/events")).toBe(true)
  for (const method of ["PUT", "DELETE"]) {
    expect(apiAllowed(method, "/es/api/pins/session:ses_a")).toBe(true)
    expect(apiAllowed(method, "/es/api/pins/lane:opencode%2Forchestrator")).toBe(true)
  }
  expect(apiAllowed("PATCH", "/es/api/pins/lane:opencode%2forchestrator/order")).toBe(true)
  for (const [method, pathname] of [
    ["POST", "/es/api/pins"], ["PUT", "/es/api/pins"], ["GET", "/es/api/pins/session:ses_a"], ["PUT", "/es/api/pins/lane:opencode/orchestrator"],
    ["PUT", "/es/api/pins/lane:a%252Fb"], ["PUT", "/es/api/pins/other:x"], ["PATCH", "/es/api/pins/session:ses_a"], ["PUT", "/es/api/pins/session:ses_a/order"],
  ]) expect(apiAllowed(method, pathname)).toBe(false)
})

test("marking a requested deliverable seen reaches the dashboard with only the operator cookie", async () => {
  const { server, get } = await setup()
  const cookie = "unrelated=private; es_attention_operator=synthetic"
  const seen = await get("/es/api/frontdesk/deliverables/seen", {
    method: "POST", body: "{}", headers: { origin: server.origin, cookie, "x-attention-csrf": "1", "content-type": "application/json" },
  })
  expect(await seen.json()).toMatchObject({ method: "POST", path: "/api/frontdesk/deliverables/seen", originBound: true, operatorCookieOnly: true })
  expect((await get("/es/api/frontdesk/deliverables/seen", { method: "POST", body: "{}" })).status).toBe(403)
  expect(apiAllowed("GET", "/es/api/frontdesk/deliverables/seen")).toBe(false)
})

test("serves the built SPA and assets with restrictive CSP", async () => {
  const { get } = await setup()
  const page = await get("/session/ses_a")
  expect(await page.text()).toContain("Fixture renderer")
  expect(page.headers.get("content-security-policy")).toContain("frame-ancestors 'none'")
  expect(page.headers.get("content-security-policy")).toContain("'wasm-unsafe-eval'")
  expect((await get("/app.js")).headers.get("content-type")).toBe("text/javascript")
  expect((await get("/assets/missing.js")).status).toBe(404)
  expect((await get("/assets/missing")).status).toBe(404)
  expect((await get("/", { method: "POST" })).status).toBe(405)
})

test("serves the renderer entry from memory after the package path becomes unavailable", async () => {
  const { root, get } = await setup()
  await rm(path.join(root, "index.html"))
  const response = await get("/session/ses_a")
  expect(response.status).toBe(200)
  expect(await response.text()).toContain("Fixture renderer")
})

test("rejects escaping symlinks and encoded path traversal", async () => {
  const { root, get } = await setup()
  const decoy = await mkdtemp(path.join(tmpdir(), "es-desktop-decoy-"))
  cleanup.push(() => rm(decoy, { recursive: true, force: true }))
  await Bun.write(path.join(decoy, "private.txt"), "decoy")
  await symlink(path.join(decoy, "private.txt"), path.join(root, "escape.txt"))
  expect((await get("/escape.txt")).status).toBe(403)
  expect((await get("/%2e%2e%2fprivate.txt")).status).toBe(400)
  expect((await get("/%00")).status).toBe(400)
  expect((await get("/%ZZ")).status).toBe(400)
})

test("proxies body, method, encoded directory, and error status without browser credentials", async () => {
  const { get } = await setup()
  const response = await get("/oc/session/ses_a/input?directory=%2Ffixture%20with%20spaces%2Fa%26b%3F%23&conflict", {
    method: "POST",
    body: '{"text":"fixture only"}',
    headers: { cookie: "fixture=value", authorization: "fixture" },
  })
  expect(response.status).toBe(409)
  expect(await response.json()).toEqual({
    method: "POST",
    path: "/session/ses_a/input",
    directory: "/fixture with spaces/a&b?#",
    body: '{"text":"fixture only"}',
    credentialForwarded: false,
  })
  expect((await (await get("/es/api/state")).json()).path).toBe("/api/state")
})

test("proxies only the mail, subscription, and handoff methods used by Editspace", async () => {
  const { get } = await setup()
  for (const endpoint of ["mail", "subscriptions", "handoffs"]) {
    const response = await get(`/es/api/${endpoint}?es=fixture`)
    expect(await response.json()).toMatchObject({ method: "GET", path: `/api/${endpoint}` })
  }
  const handoff = await get("/es/api/handoffs?es=fixture", {
    method: "POST", body: '{"lane":"example"}', headers: { "content-type": "application/json" },
  })
  expect(await handoff.json()).toMatchObject({ method: "POST", path: "/api/handoffs", body: '{"lane":"example"}' })
  for (const method of ["PUT", "DELETE"]) {
    const response = await get("/es/api/subscriptions?es=fixture", { method })
    expect(await response.json()).toMatchObject({ method, path: "/api/subscriptions" })
  }
  expect((await get("/es/api/mail", { method: "POST" })).status).toBe(403)
  expect((await get("/es/api/handoffs", { method: "DELETE" })).status).toBe(403)
})

test("proxies wake events read-only", async () => {
  const { get } = await setup()
  const response = await get("/es/api/wake-events?es=fixture&session=ses_a")
  expect(await response.json()).toMatchObject({ method: "GET", path: "/api/wake-events" })
  for (const method of ["POST", "PUT", "DELETE"]) expect((await get("/es/api/wake-events?es=fixture", { method })).status).toBe(403)
  expect((await get("/es/api/wake-events/x")).status).toBe(403)
})

test("proxies read-only agent choices in the caller directory", async () => {
  const { get } = await setup()
  const response = await get("/oc/agent?directory=%2Ffixture%20with%20spaces")
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({
    method: "GET",
    path: "/agent",
    directory: "/fixture with spaces",
  })
  expect((await get("/oc/agent", { method: "POST" })).status).toBe(403)
})

test("blocks upstream redirects without contacting the destination", async () => {
  const { get } = await setup()
  const response = await get("/oc/session?redirect")
  expect(response.status).toBe(502)
  expect(await response.json()).toEqual({ error: "Upstream redirect blocked" })
})

test("streams events before upstream completion and cancels on client disconnect", async () => {
  const { get } = await setup()
  const controller = new AbortController()
  const response = await get("/oc/event", { signal: controller.signal })
  expect(response.headers.get("content-type")).toBe("text/event-stream")
  const reader = response.body!.getReader()
  expect(new TextDecoder().decode((await reader.read()).value)).toBe("data: ready\n\n")
  controller.abort()
  await reader.cancel().catch(() => {})
})

test("exposes only a keyed protocol capability and no unauthenticated access", async () => {
  const { server, get } = await setup()
  expect(await (await get("/__es/events")).json()).toEqual({ protocol: "opencode-events-v1" })
  expect((await fetch(`${server.origin}/__es/events`)).status).toBe(403)
  expect((await get("/__es/events", { headers: { origin: "https://evil.test" } })).status).toBe(403)
  expect((await get("/__es/events?unexpected=1")).status).toBe(403)
})

test("shows an offline document and API failure when attached services stop", async () => {
  const { get, upstream } = await setup()
  await upstream.stop(true)
  const page = await get("/")
  expect(page.status).toBe(503)
  const text = await page.text()
  expect(text).toContain("Services unavailable")
  // The page reloads itself, so a brief outage at launch does not strand the window.
  expect(text).toContain('<meta http-equiv="refresh" content="5">')
  expect((await get("/oc/session")).status).toBe(502)
})

test("a slow but answering service still loads the app instead of the offline page", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "es-desktop-test-"))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  await Bun.write(path.join(root, "index.html"), "<title>Fixture renderer</title>")
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      if (new URL(request.url).pathname === "/experimental/capabilities") await Bun.sleep(2500)
      return Response.json({})
    },
  })
  cleanup.push(async () => {
    await upstream.stop(true)
  })
  const server = await serve({ root, opencode: upstream.url.origin, dashboard: upstream.url.origin })
  cleanup.push(server.close)
  const page = await fetch(`${server.origin}/`, { headers: { "x-editspace-key": server.key } })
  expect(page.status).toBe(200)
  expect(await page.text()).toContain("Fixture renderer")
}, 15_000)

test("shutdown releases the listener without stopping attached services", async () => {
  const { server, upstream } = await setup()
  cleanup.pop()
  await server.close()
  expect(
    await fetch(server.origin).then(
      () => false,
      () => true,
    ),
  ).toBe(true)
  expect((await fetch(upstream.url)).status).toBe(200)
})

test("does not replace a listener occupying the saved port", async () => {
  const { root, server, get } = await setup()
  await expect(serve({ root, port: Number(new URL(server.origin).port) })).rejects.toThrow()
  expect((await get("/app.js")).status).toBe(200)
})

test("unconfigured launches show setup guidance without a default backend", async () => {
  const { root } = await setup()
  const server = await serve({ root })
  cleanup.push(server.close)
  const response = await fetch(server.origin, { headers: { "x-editspace-key": server.key } })
  expect(response.status).toBe(503)
  expect(await response.text()).toContain("OPENCODE_URL")
})

test("ordinary launches keep showing; only explicit opt-in starts never activate", () => {
  for (const value of [undefined, "", "normal", "Background", "hidden "]) expect(startupMode(value)).toBe("normal")
  expect(startupPlan("normal")).toEqual({ activationPolicy: undefined, showOnLoad: true, revealOnReopen: true, backgroundThrottling: true })
  expect(startupPlan(startupMode("background"))).toEqual({ activationPolicy: "accessory", showOnLoad: false, revealOnReopen: true, backgroundThrottling: true })
  expect(startupPlan(startupMode("hidden"))).toEqual({ activationPolicy: "accessory", showOnLoad: false, revealOnReopen: false, backgroundThrottling: false })
})

test("main process applies the activation policy before launch and only shows windows on the allowed paths", async () => {
  const source = await readFile(path.join(import.meta.dirname, "main.ts"), "utf8")
  const policy = source.indexOf("app.setActivationPolicy(startup.activationPolicy)")
  expect(policy).toBeGreaterThan(-1)
  // Module scope, before whenReady and before any BrowserWindow exists.
  expect(policy).toBeLessThan(source.indexOf("await app.whenReady()"))
  expect(policy).toBeLessThan(source.indexOf("new BrowserWindow("))
  expect(source).not.toMatch(/app\.focus\(|dock\.(bounce|show)\(|requestUserAttention|showInactive|moveTop\(|setAlwaysOnTop/)
  // show()/focus() calls: reveal(), the unchanged ordinary second-instance handler, and the guarded load path.
  expect([...source.matchAll(/\.show\(\)/g)].length).toBe(3)
  expect([...source.matchAll(/\.focus\(\)/g)].length).toBe(2)
  expect(source).toContain("if (startup.showOnLoad) window.show()")
  expect(source).toMatch(/if \(startup\.activationPolicy\) \{\n\s+if \(startup\.revealOnReopen\) reveal\(\)\n\s+return\n\s+\}/)
  expect(source).toContain('show: false,')
  // The initial-launch activate is dropped, not queued for after load.
  expect(source).toMatch(/app\.on\("activate", \(\) => \{\n\s+if \(opened\.ready\) reveal\(\)\n\s+\}\)/)
  expect(source).not.toContain('app.on("activate", reveal)')
})

test("hosts Front Desk surfaces: keyed address, capability-only frame requests, no app credentials upstream", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "es-desktop-surface-"))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  await Bun.write(path.join(root, "index.html"), "<title>Fixture renderer</title>")
  const surface = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: request => Response.json({ path: new URL(request.url).pathname, key: request.headers.has("x-editspace-key") }) })
  cleanup.push(async () => { await surface.stop(true) })
  const dashboard = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json({ surfaces: [{ id: "board", upstream: `${surface.url.origin}/` }] }) })
  cleanup.push(async () => { await dashboard.stop(true) })
  const server = await serve({ root, dashboard: dashboard.url.origin })
  cleanup.push(server.close)

  expect((await fetch(`${server.origin}/__es/surface/board`)).status).toBe(403)
  const { src } = await fetch(`${server.origin}/__es/surface/board`, { headers: { "x-editspace-key": server.key } }).then(response => response.json())
  // The sandboxed frame is opaque-origin and cross-site to the app; Electron still injects the key.
  const framed = await fetch(`${server.origin}${src}api`, { headers: { origin: "null", "sec-fetch-site": "cross-site", "x-editspace-key": server.key } })
  expect(await framed.json()).toEqual({ path: "/api", key: false })
  expect(framed.headers.get("content-security-policy")).toStartWith("sandbox allow-scripts")
  expect((await fetch(`${server.origin}/__cap/surface/board/zzzzzz-${"0".repeat(32)}/`)).status).toBe(404)
  // The frame's prefix never reaches the app's own APIs.
  expect((await fetch(`${server.origin}/oc/session`, { headers: { origin: "null", "sec-fetch-site": "cross-site", "x-editspace-key": server.key } })).status).toBe(403)
  const page = await fetch(server.origin, { headers: { "x-editspace-key": server.key } })
  expect(page.headers.get("content-security-policy")).toContain("frame-src 'self'")
})

test("agents' surface snapshots are readable; other surface subpaths are not exposed", () => {
  expect(apiAllowed("GET", "/es/api/surfaces/relay-board/snapshot")).toBe(true)
  expect(apiAllowed("POST", "/es/api/surfaces/relay-board/snapshot")).toBe(false)
  expect(apiAllowed("GET", "/es/api/surfaces/relay-board/static/index.html")).toBe(false)
})

test("only surface paths on the app origin may load in a subframe", () => {
  expect(surfaceFrameURL("http://127.0.0.1:60302/__cap/surface/board/abc/", "http://127.0.0.1:60302")).toBe(true)
  expect(surfaceFrameURL("http://127.0.0.1:60302/oc/session", "http://127.0.0.1:60302")).toBe(false)
  expect(surfaceFrameURL("http://127.0.0.1:64878/__cap/surface/board/abc/", "http://127.0.0.1:60302")).toBe(false)
})

const record = "0b0a8f8e-6a2b-4f39-9a41-5d0f6b1c2e3d"

test("re-checking an answer's delivery and regenerating a brief reach the dashboard as operator writes", async () => {
  const { server, get } = await setup()
  const cookie = "unrelated=private; es_attention_operator=synthetic"
  const headers = { origin: server.origin, cookie, "x-attention-csrf": "1", "content-type": "application/json" }
  for (const pathname of [`/es/api/attention/${record}/delivery?es=dotfiles`, `/es/api/frontdesk/briefs/${record}/regenerate?es=dotfiles`]) {
    const response = await get(pathname, { method: "POST", body: "{}", headers })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ method: "POST", path: pathname.slice(3).split("?")[0], originBound: true, operatorCookieOnly: true, keyForwarded: false })
    expect((await get(pathname, { method: "POST", body: "{}" })).status).toBe(403)
    expect((await get(pathname, { method: "POST", body: "{}", headers: { origin: "https://evil.test" } })).status).toBe(403)
  }
  expect(apiAllowed("POST", "/es/api/frontdesk/briefs/not-a-record/regenerate")).toBe(false)
  expect(apiAllowed("GET", `/es/api/frontdesk/briefs/${record}/regenerate`)).toBe(false)
  expect(apiAllowed("POST", `/es/api/attention/${record}/delivery/x`)).toBe(false)
})

test("the Front desk model and a request's conversation are read-only reads without browser credentials", async () => {
  const { get } = await setup()
  for (const pathname of ["/es/api/frontdesk/model", `/es/api/frontdesk/conversation?es=dotfiles&record=${record}`]) {
    const response = await get(pathname, { headers: { cookie: "unrelated=private" } })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ method: "GET", operatorCookieOnly: false, keyForwarded: false })
    expect(apiAllowed("POST", pathname.split("?")[0])).toBe(false)
  }
})

// Every route es-app calls must be exposed by the native listener, or the native app fails where web works.
test("every es-app API route is exposed by the native allowlist", async () => {
  const root = path.join(import.meta.dirname, "../../es-app/src")
  const files = [...new Bun.Glob("**/*.{ts,tsx}").scanSync(root)].filter((file) => !file.endsWith(".test.ts"))
  const sample = (template: string) => template.replace(/\$\{[^}]*\}/g, (match) => (/record|item\.record|id\b|ticket/i.test(match) ? record : "ses_a"))
  const routes = new Set<string>()
  for (const file of files) {
    const source = await Bun.file(path.join(root, file)).text()
    for (const match of source.matchAll(/[`"](\/(?:oc|es)\/[^`"?]*)/g)) routes.add(match[1])
    // The Core client (api.ts ocAt) builds routes on a host base: `/oc` here, `/hosts/<id>/oc` for another Work host.
    if (file === "api.ts") for (const match of source.matchAll(/`\$\{base\}(\/[^`?]*)/g)) routes.add(`/oc${match[1]}`)
    // The composer builds session routes from a relative path.
    for (const match of source.matchAll(/url\(`(\/[^`?]*)/g)) routes.add(`/oc/session/ses_a${match[1]}`)
  }
  const concrete = [...routes]
    // Bare prefixes and routes whose tail is a variable are checked where the tail is spelled out.
    .filter((route) => !/^\/(oc|es)\/$/.test(route) && !/\$\{(path|editspace|q\(|esQ)[^}]*\}$/.test(route) && !route.endsWith("${path}"))
    .map(sample)
    // A template cut off inside an expression (a query built in code) is not a whole route.
    .filter((route) => !route.includes("${"))
  expect(concrete.length).toBeGreaterThan(50)
  const missing = concrete.filter((route) => !["GET", "POST", "PUT", "PATCH", "DELETE"].some((method) => apiAllowed(method, route)))
  expect(missing).toEqual([])
})

test("a launch restore reopens only app routes on each view's own listener, all or nothing", async () => {
  const { restorePlan } = await import("./policy")
  const tabs = [{ id: "local", origin: "http://127.0.0.1:60302" }, { id: "mini", origin: "http://127.0.0.1:53935" }]
  const work = "http://127.0.0.1:60302/desk?item=attention%3Afixture%3A1"
  const mini = "http://127.0.0.1:53935/session/ses_a?directory=%2Frepo#prompt-msg_1"
  expect(restorePlan({ version: 1, selected: "mini", views: [{ id: "local", url: work }, { id: "mini", url: mini }] }, tabs))
    .toEqual({ selected: "mini", views: [{ id: "local", url: work }, { id: "mini", url: mini }] })
  for (const bad of [
    { version: 2, selected: "local", views: [{ id: "local", url: work }] },
    { version: 1, selected: "mini", views: [{ id: "local", url: work }] },
    { version: 1, selected: "local", views: [{ id: "local", url: mini }] },
    { version: 1, selected: "local", views: [{ id: "local", url: "http://127.0.0.1:60302/oc/session" }] },
    { version: 1, selected: "local", views: [{ id: "local", url: "https://example.com/desk" }] },
    { version: 1, selected: "local", views: [{ id: "local", url: work }, { id: "local", url: work }] },
    { version: 1, selected: "wing", views: [{ id: "wing", url: work }] },
    { version: 1, selected: "local", views: [{ id: "local", url: work }, { id: "mini", url: "http://127.0.0.1:53935/__cap/x" }] },
    "not json", null,
  ]) expect(restorePlan(bad, tabs)).toBeUndefined()
})
