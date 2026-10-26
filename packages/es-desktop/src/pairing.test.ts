import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import WebSocket from "ws"
import { serve } from "./server"
import { createPairingCode, issueCookie, remoteListenHost } from "./pairing"

const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})
const code = "ABCD2-EFGH3-JKLM4-NPQR5"
const setup = async (publicOrigin?: string) => {
  const root = await mkdtemp(path.join(tmpdir(), "es-pairing-test-"))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  await Bun.write(path.join(root, "index.html"), "<title>Fixture renderer</title>")
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) =>
      Response.json({
        method: request.method,
        path: new URL(request.url).pathname,
        cookieForwarded: request.headers.has("cookie"),
      }),
  })
  cleanup.push(async () => upstream.stop(true))
  const server = await serve({
    root,
    opencode: upstream.url.origin,
    dashboard: upstream.url.origin,
    host: "127.0.0.1",
    pairing: { code },
    publicOrigin,
  })
  cleanup.push(server.close)
  const pair = (value: string, headers: Record<string, string> = {}) =>
    fetch(`${server.origin}/__es/pair`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
      body: new URLSearchParams({ code: value }),
    })
  return { server, pair }
}
const cookieOf = (response: Response) => response.headers.get("set-cookie")?.split(";")[0] ?? ""

test("remote listeners accept only loopback and tailnet addresses", () => {
  expect(remoteListenHost("127.0.0.1")).toBe("127.0.0.1")
  expect(remoteListenHost("[::1]")).toBe("::1")
  expect(remoteListenHost("100.101.102.103")).toBe("100.101.102.103")
  expect(remoteListenHost("fd7a:115c:a1e0::1")).toBe("fd7a:115c:a1e0::1")
  for (const value of ["0.0.0.0", "::", "192.168.1.20", "10.0.0.5", "100.128.0.1", "example.com", "localhost"])
    expect(remoteListenHost(value)).toBeUndefined()
})

test("refuses wildcard binds and remote binds without pairing", async () => {
  await expect(serve({ root: tmpdir(), host: "0.0.0.0", pairing: { code } })).rejects.toThrow("loopback or a tailnet")
  await expect(serve({ root: tmpdir(), host: "100.100.100.100" })).rejects.toThrow("require pairing")
})

test("generated pairing codes are grouped and unambiguous", () => {
  const value = createPairingCode()
  expect(value).toMatch(/^[2-9A-HJ-NP-Z]{5}(-[2-9A-HJ-NP-Z]{5}){3}$/)
  expect(createPairingCode()).not.toBe(value)
})

test("unpaired clients get a health probe, a pairing page, and API 401s only", async () => {
  const { server } = await setup()
  const health = await fetch(`${server.origin}/__es/health`)
  expect(await health.json()).toEqual({ service: "editspace", pairing: true })
  const page = await fetch(`${server.origin}/session/ses_a`, { headers: { accept: "text/html" } })
  expect(page.status).toBe(401)
  expect(page.headers.get("content-security-policy")).toContain("form-action 'self'")
  expect(await page.text()).toContain('action="/__es/pair"')
  const api = await fetch(`${server.origin}/oc/session`)
  expect(api.status).toBe(401)
  expect(await api.json()).toEqual({ error: "Pairing required" })
  expect((await fetch(`${server.origin}/__es/events`)).status).toBe(401)
  // The native capability header is not a credential in pairing mode.
  expect((await fetch(`${server.origin}/oc/session`, { headers: { "x-editspace-key": server.key } })).status).toBe(401)
})

test("a wrong code sets no cookie; the right code in any case pairs and redirects home", async () => {
  const { pair } = await setup()
  const wrong = await pair("AAAAA-AAAAA-AAAAA-AAAAA")
  expect(wrong.status).toBe(401)
  expect(wrong.headers.get("set-cookie")).toBeNull()
  expect(await wrong.text()).toContain("does not match")
  const right = await pair(" abcd2efgh3 jklm4-npqr5 ")
  expect(right.status).toBe(303)
  expect(right.headers.get("location")).toBe("/")
  expect(right.headers.get("set-cookie")).toMatch(/^es_remote=[\w-]+\.[\w-]+; HttpOnly; SameSite=Strict; Path=\/; Max-Age=2592000$/)
})

test("paired cookie authorizes reads; writes also need the page origin; cookies stay local", async () => {
  const { server, pair } = await setup()
  const cookie = cookieOf(await pair(code))
  const read = await fetch(`${server.origin}/oc/session`, { headers: { cookie } })
  expect(await read.json()).toEqual({ method: "GET", path: "/session", cookieForwarded: false })
  const shell = await fetch(`${server.origin}/`, { headers: { cookie, accept: "text/html" } })
  expect(await shell.text()).toContain("Fixture renderer")
  const originless = await fetch(`${server.origin}/oc/session/ses_a/prompt_async`, { method: "POST", headers: { cookie }, body: "{}" })
  expect(originless.status).toBe(401)
  const write = await fetch(`${server.origin}/oc/session/ses_a/prompt_async`, {
    method: "POST",
    headers: { cookie, origin: server.origin },
    body: "{}",
  })
  expect(await write.json()).toEqual({ method: "POST", path: "/session/ses_a/prompt_async", cookieForwarded: false })
  for (const site of ["cross-site", "same-site"]) {
    const foreign = await fetch(`${server.origin}/oc/session`, { headers: { cookie, "sec-fetch-site": site } })
    expect(foreign.status).toBe(401)
  }
})

test("cookies signed with another code and foreign Host headers are rejected", async () => {
  const { server } = await setup()
  const forged = `es_remote=${issueCookie("ZZZZZ-ZZZZZ-ZZZZZ-ZZZZZ")}`
  expect((await fetch(`${server.origin}/oc/session`, { headers: { cookie: forged } })).status).toBe(401)
  const valid = `es_remote=${issueCookie(code)}`
  expect((await fetch(`${server.origin}/oc/session`, { headers: { cookie: valid } })).status).toBe(200)
  const rebound = await fetch(`${server.origin}/oc/session`, { headers: { cookie: valid, host: "attacker.example:80" } })
  expect(rebound.status).toBe(403)
})

test("repeated wrong codes are throttled before the right code is checked", async () => {
  const { pair } = await setup()
  for (let attempt = 0; attempt < 10; attempt++) expect((await pair("WRONG")).status).toBe(401)
  const throttled = await pair(code)
  expect(throttled.status).toBe(429)
  expect(throttled.headers.get("set-cookie")).toBeNull()
})

test("pairing rejects cross-site form posts", async () => {
  const { pair } = await setup()
  expect((await pair(code, { origin: "http://attacker.example" })).status).toBe(403)
  expect((await pair(code, { "sec-fetch-site": "cross-site" })).status).toBe(403)
  expect((await pair(code, { origin: "null" })).status).toBe(303)
})

test("event socket upgrades need the paired cookie and the page origin", async () => {
  const { server } = await setup()
  const open = (headers: Record<string, string>) =>
    new Promise<boolean>((resolve) => {
      const socket = new WebSocket(`${server.origin.replace("http", "ws")}/oc/global/event`, "opencode-events-v1", { headers })
      socket.on("open", () => {
        socket.close()
        resolve(true)
      })
      socket.on("error", () => resolve(false))
    })
  const cookie = `es_remote=${issueCookie(code)}`
  expect(await open({ cookie, origin: server.origin })).toBe(true)
  expect(await open({ origin: server.origin })).toBe(false)
  expect(await open({ cookie, origin: "http://attacker.example" })).toBe(false)
  expect(await open({ cookie })).toBe(false)
})

const proxied = "https://agent-host.tailnet.ts.net:8443"

test("behind an HTTPS identity proxy, the configured public origin pairs and writes with a Secure cookie", async () => {
  const { server, pair } = await setup(proxied)
  const paired = await pair(code, { origin: proxied })
  expect(paired.status).toBe(303)
  expect(paired.headers.get("set-cookie")).toMatch(/; Secure$/)
  const cookie = cookieOf(paired)
  const write = await fetch(`${server.origin}/oc/session/ses_a/prompt_async`, { method: "POST", headers: { cookie, origin: proxied }, body: "{}" })
  expect(await write.json()).toEqual({ method: "POST", path: "/session/ses_a/prompt_async", cookieForwarded: false })
  const forwardedHost = await fetch(`${server.origin}/oc/session`, { headers: { cookie, host: new URL(proxied).host } })
  expect(forwardedHost.status).toBe(200)
  expect((await fetch(`${server.origin}/oc/session/ses_a/prompt_async`, { method: "POST", headers: { cookie, origin: "https://other.tailnet.ts.net" }, body: "{}" })).status).toBe(401)
  expect((await pair(code, { origin: "https://other.tailnet.ts.net" })).status).toBe(403)
  expect((await fetch(`${server.origin}/oc/session`, { headers: { cookie, host: "other.tailnet.ts.net" } })).status).toBe(403)
})

test("without a public origin, pairing cookies stay non-Secure for the USB loopback path", async () => {
  const { pair } = await setup()
  expect((await pair(code, { origin: proxied })).status).toBe(403)
  expect((await pair(code)).headers.get("set-cookie")).not.toContain("Secure")
})

test("public origins must be explicit https origins and require pairing", async () => {
  for (const value of ["http://agent-host.tailnet.ts.net", "https://agent-host.tailnet.ts.net/path", "https://user:pw@agent-host.tailnet.ts.net"])
    await expect(serve({ root: tmpdir(), host: "127.0.0.1", pairing: { code }, publicOrigin: value })).rejects.toThrow("explicit https")
  await expect(serve({ root: tmpdir(), publicOrigin: proxied })).rejects.toThrow("requires pairing")
})
