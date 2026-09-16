import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { serve } from "./server"
import { apiAllowed, externalURL, internalURL, serviceURL } from "./policy"

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
          body: await request.text(),
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

test("API surface excludes direct shell, PTY, file, and config access", () => {
  expect(apiAllowed("POST", "/oc/session/ses_a/input")).toBe(true)
  expect(apiAllowed("DELETE", "/oc/session/ses_a/aside/request-1")).toBe(true)
  for (const pathname of ["/oc/pty", "/oc/session/ses_a/shell", "/oc/config", "/oc/file/content", "/es/api/run"])
    expect(apiAllowed("POST", pathname)).toBe(false)
})

test("rejects unauthenticated, cross-origin, and foreign Host requests", async () => {
  const { server, get } = await setup()
  expect((await fetch(server.origin)).status).toBe(403)
  expect((await get("/oc/session", { headers: { origin: "https://example.com" } })).status).toBe(403)
  expect((await get("/oc/session", { headers: { host: "evil.test" } })).status).toBe(403)
  expect((await get("/oc/session", { headers: { "sec-fetch-site": "cross-site" } })).status).toBe(403)
  expect((await get("/oc/pty", { method: "POST" })).status).toBe(403)
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

test("shows an offline document and API failure when attached services stop", async () => {
  const { get, upstream } = await setup()
  await upstream.stop(true)
  const page = await get("/")
  expect(page.status).toBe(503)
  expect(await page.text()).toContain("Services unavailable")
  expect((await get("/oc/session")).status).toBe(502)
})

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
