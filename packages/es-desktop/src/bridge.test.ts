import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import WebSocket from "ws"
import { createBridge, encryptedCookie, type BridgeStore } from "./bridge"
import { serve } from "./server"
import { remoteHosts } from "../../es-app/remote-host"

const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

// Synthetic credentials for the fake gateway only.
const ACCESS = { clientId: "fixture-id.access", clientSecret: "fixture-secret-value" }
const CODE = "ABCD2-EFGH3-JKLM4-NPQR5"
const PAIRED = "fixture-pairing-cookie-0123456789"

// A host gateway behind a Cloudflare Access gate: no valid service token -> redirect to the Access login;
// pairing with the code sets es_remote; everything else needs that cookie.
const gateway = () => {
  const seen: { method: string; path: string; id: string | null; secret: string | null; cookie: string | null; origin: string | null }[] = []
  // `cookie`: the pairing the gateway currently honours; changing it models a gateway rotation or expiry.
  const state = { accept: true, cookie: PAIRED, coreUnauthorized: false }
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url)
      const body = await request.text()
      seen.push({ method: request.method, path: url.pathname, id: request.headers.get("cf-access-client-id"), secret: request.headers.get("cf-access-client-secret"), cookie: request.headers.get("cookie"), origin: request.headers.get("origin") })
      if (!state.accept || request.headers.get("cf-access-client-id") !== ACCESS.clientId || request.headers.get("cf-access-client-secret") !== ACCESS.clientSecret)
        return new Response(null, { status: 302, headers: { location: "https://team.cloudflareaccess.com/cdn-cgi/access/login/agents" } })
      if (url.pathname === "/__es/pair") {
        if (new URLSearchParams(body).get("code") !== CODE) return new Response("That code does not match", { status: 401 })
        return new Response(null, { status: 303, headers: { location: "/", "set-cookie": `es_remote=${PAIRED}; HttpOnly; SameSite=Strict; Path=/; Secure` } })
      }
      if (request.headers.get("cookie")?.includes(`es_remote=${state.cookie}`) !== true) return Response.json({ error: "Pairing required" }, { status: 401 })
      // A Core-level 401 behind a valid pairing (e.g. Core server auth).
      if (state.coreUnauthorized) return Response.json({ name: "UnauthorizedError" }, { status: 401 })
      if (url.pathname === "/oc/global/event")
        return new Response(new ReadableStream({ start: (controller) => { controller.enqueue(new TextEncoder().encode('data: {"type":"session.updated","host":"personal"}\n\n')); controller.close() } }), { headers: { "content-type": "text/event-stream" } })
      return Response.json({ path: url.pathname, method: request.method })
    },
  })
  cleanup.push(async () => void (await server.stop(true)))
  return { origin: server.url.origin, seen, state }
}

const memory = (access: typeof ACCESS | undefined): BridgeStore & { saved: string[] } => {
  const saved: string[] = []
  return { saved, access: async () => access, cookie: async () => saved.at(-1), saveCookie: async (value) => void saved.push(value), forgetCookie: async () => void saved.splice(0) }
}

const listener = async (origin: string, store: BridgeStore) => {
  const root = await mkdtemp(path.join(tmpdir(), "es-bridge-"))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  await writeFile(path.join(root, "index.html"), "<title>Local app</title>")
  const bridge = createBridge({ origin, store })
  await bridge.ready
  const server = await serve({ root, remote: { id: "personal", origin, bridge }, hostInfo: () => ({ id: "personal", label: "Personal", remote: true, hosts: [] }) })
  cleanup.push(() => Promise.race([server.close(), Bun.sleep(500)]))
  const get = (pathname: string, init: RequestInit = {}) =>
    fetch(`${server.origin}${pathname}`, { redirect: "manual", ...init, headers: { "x-editspace-key": server.key, ...init.headers } })
  return { server, get, bridge }
}

test("bridged hosts are configured with a Keychain item name, are Personal by default and never Work peers", () => {
  expect(remoteHosts([{ id: "personal", origin: "https://agents.murtaza.earth", mode: "bridged", access: { keychain: "cloudflare-access-laptop-desktop" } }])).toEqual([
    { id: "personal", label: "personal", origin: "https://agents.murtaza.earth", mode: "bridged", profile: "personal", access: { keychain: "cloudflare-access-laptop-desktop" } },
  ])
  expect(() => remoteHosts([{ id: "personal", origin: "https://agents.murtaza.earth", mode: "bridged" }])).toThrow("access.keychain")
  expect(() => remoteHosts([{ id: "personal", origin: "https://agents.murtaza.earth", mode: "bridged", access: { keychain: "a b" } }])).toThrow("access.keychain")
})

test("without a service token nothing goes upstream: the API says sign-in needed and the page says so", async () => {
  const host = gateway()
  const { get } = await listener(host.origin, memory(undefined))
  expect(await (await get("/oc/session/status")).json()).toEqual({ error: "Sign-in needed" })
  const page = await get("/", { headers: { "sec-fetch-dest": "document" } })
  expect(page.status).toBe(401)
  expect(await page.text()).toContain("Sign-in needed")
  expect(host.seen).toEqual([])
})

test("pairing sends the code only to the gateway, keeps the cookie in the main process, then requests carry both credentials", async () => {
  const host = gateway()
  const store = memory(ACCESS)
  const { server, get } = await listener(host.origin, store)
  expect(await (await get("/oc/session/status")).json()).toEqual({ error: "Pairing required" })
  expect(await (await get("/", { headers: { "sec-fetch-dest": "document" } })).text()).toContain('action="/__es/bridge/pair"')
  const pair = (code: string, origin = server.origin) => get("/__es/bridge/pair", { method: "POST", headers: { origin, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ code }).toString() })
  expect((await pair(CODE, "https://evil.test")).status).toBe(403)
  const wrong = await pair("WRONG")
  expect(wrong.status).toBe(401)
  expect(await wrong.text()).toContain("does not match")
  const right = await pair(CODE)
  expect(right.status).toBe(303)
  expect(right.headers.get("set-cookie")).toBeNull()
  expect(store.saved).toEqual([PAIRED])
  const read = await get("/oc/session/status")
  expect(await read.json()).toEqual({ path: "/oc/session/status", method: "GET" })
  expect(host.seen.at(-1)).toEqual({ method: "GET", path: "/oc/session/status", id: ACCESS.clientId, secret: ACCESS.clientSecret, cookie: `es_remote=${PAIRED}`, origin: host.origin })
  // Nothing about the credentials comes back to the page.
  const returned: string[] = []
  read.headers.forEach((value, name) => returned.push(`${name}:${value}`))
  expect(returned.some((item) => /cf-access|es_remote/i.test(item))).toBe(false)
  // Writes reach the gateway as its own public origin with the operator cookie joined to the pairing cookie.
  const write = await get("/es/api/attention/session", { method: "POST", headers: { origin: server.origin, cookie: "es_attention_operator__personal=op", "x-attention-csrf": "1", "content-type": "application/json" }, body: "{}" })
  expect(write.status).toBe(200)
  expect(host.seen.at(-1)).toMatchObject({ method: "POST", path: "/es/api/attention/session", origin: host.origin, cookie: `es_remote=${PAIRED}; es_attention_operator=op` })
})

test("a token the gate no longer accepts is 'sign-in needed', never a followed redirect", async () => {
  const host = gateway()
  const store = memory(ACCESS)
  store.saved.push(PAIRED)
  const { get } = await listener(host.origin, store)
  host.state.accept = false
  const response = await get("/oc/session/status")
  expect(response.status).toBe(401)
  expect(await response.json()).toEqual({ error: "Sign-in needed" })
  expect(host.seen.filter((item) => item.path.includes("cloudflareaccess"))).toEqual([])
})

test("event streams reach the gateway with both credentials and its public origin", async () => {
  const host = gateway()
  const store = memory(ACCESS)
  store.saved.push(PAIRED)
  const { server } = await listener(host.origin, store)
  const message = await new Promise<string>((resolve, reject) => {
    const socket = new WebSocket(`${server.origin.replace("http", "ws")}/oc/global/event`, "opencode-events-v1", { headers: { origin: server.origin, "x-editspace-key": server.key } })
    socket.on("open", () => socket.send(JSON.stringify({ type: "subscribe", id: 1, url: "/oc/global/event" })))
    socket.on("message", (data) => {
      const packet = JSON.parse(data.toString())
      if (packet.type !== "message") return
      socket.on("close", () => resolve(packet.data))
      socket.close()
    })
    socket.on("error", reject)
  })
  expect(JSON.parse(message)).toEqual({ type: "session.updated", host: "personal" })
  expect(host.seen.find((item) => item.path === "/oc/global/event")).toMatchObject({ id: ACCESS.clientId, cookie: `es_remote=${PAIRED}`, origin: host.origin })
})

test("the pairing cookie is stored only encrypted, owner-only", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "es-bridge-cookie-"))
  cleanup.push(() => rm(dir, { recursive: true, force: true }))
  const file = path.join(dir, "personal.cookie")
  const crypto = { available: () => true, encrypt: (value: string) => Buffer.from(value).reverse(), decrypt: (value: Buffer) => Buffer.from(value).reverse().toString() }
  const store = encryptedCookie(file, crypto)
  await store.saveCookie(PAIRED)
  expect((await Bun.file(file).text()).includes(PAIRED)).toBe(false)
  expect(await store.cookie()).toBe(PAIRED)
  expect((await import("node:fs/promises").then((fs) => fs.stat(file))).mode & 0o777).toBe(0o600)
})

test("without OS encryption pairing is refused as 'unavailable' and nothing is written, plaintext or otherwise", async () => {
  const host = gateway()
  const dir = await mkdtemp(path.join(tmpdir(), "es-bridge-noenc-"))
  cleanup.push(() => rm(dir, { recursive: true, force: true }))
  const file = path.join(dir, "personal.cookie")
  const cookie = encryptedCookie(file, { available: () => false, encrypt: () => { throw new Error("unexpected") }, decrypt: () => { throw new Error("unexpected") } })
  const { server, get, bridge } = await listener(host.origin, { access: async () => ACCESS, ...cookie })
  const page = await get("/__es/bridge/pair", { method: "POST", headers: { origin: server.origin, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ code: CODE }).toString() })
  expect(page.status).toBe(503)
  expect(await page.text()).toContain("cannot store the pairing securely")
  expect(bridge.paired()).toBe(false)
  expect(await Bun.file(file).exists()).toBe(false)
  expect(await Bun.file(`${file}.tmp`).exists()).toBe(false)
})

test("an unreadable pairing cookie means 'pair again', and the service token is kept", async () => {
  const host = gateway()
  const { get, bridge } = await listener(host.origin, { access: async () => ACCESS, cookie: async () => { throw new Error("decrypt failed") }, saveCookie: async () => {}, forgetCookie: async () => {} })
  expect(bridge.configured()).toBe(true)
  expect(await (await get("/oc/session/status")).json()).toEqual({ error: "Pairing required" })
  expect(host.seen).toEqual([])
})

test("a page can never supply Access credentials: they are stripped on every listener", async () => {
  const host = gateway()
  const store = memory(ACCESS)
  store.saved.push(PAIRED)
  const { get } = await listener(host.origin, store)
  const injected = { "cf-access-client-id": "attacker-id", "cf-access-client-secret": "attacker-secret", "cf-access-token": "t", "cf-authorization": "a", "cf-access-jwt-assertion": "j" }
  await get("/oc/session/status", { headers: injected })
  expect(host.seen.at(-1)).toMatchObject({ id: ACCESS.clientId, secret: ACCESS.clientSecret })
  // A plain local listener forwards none of them either.
  const upstream: Record<string, string | null>[] = []
  const core = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => (upstream.push(Object.fromEntries(Object.keys(injected).map((name) => [name, request.headers.get(name)]))), Response.json({})) })
  cleanup.push(async () => void (await core.stop(true)))
  const root = await mkdtemp(path.join(tmpdir(), "es-bridge-local-"))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  await writeFile(path.join(root, "index.html"), "<title>x</title>")
  const local = await serve({ root, opencode: core.url.origin, dashboard: core.url.origin })
  cleanup.push(() => Promise.race([local.close(), Bun.sleep(500)]))
  await fetch(`${local.origin}/oc/session/status`, { headers: { "x-editspace-key": local.key, ...injected } })
  expect(upstream.at(-1)).toEqual({ "cf-access-client-id": null, "cf-access-client-secret": null, "cf-access-token": null, "cf-authorization": null, "cf-access-jwt-assertion": null })
})

test("a gateway pairing 401 (rotation or expiry) forgets the stale cookie and the page offers pairing again", async () => {
  const host = gateway()
  const store = memory(ACCESS)
  store.saved.push(PAIRED)
  const { get, bridge } = await listener(host.origin, store)
  host.state.cookie = "rotated-pairing-cookie-0123456789"
  const stale = await get("/oc/session/status")
  expect(stale.status).toBe(401)
  expect(await stale.json()).toEqual({ error: "Pairing required" })
  expect(bridge.paired()).toBe(false)
  expect(store.saved).toEqual([])
  const calls = host.seen.length
  expect(await (await get("/oc/session/status")).json()).toEqual({ error: "Pairing required" })
  const page = await get("/", { headers: { "sec-fetch-dest": "document" } })
  expect(page.status).toBe(401)
  expect(await page.text()).toContain("pairing code")
  expect(host.seen.length).toBe(calls)
})

test("a Core 401 behind a valid pairing passes through and keeps the pairing", async () => {
  const host = gateway()
  const store = memory(ACCESS)
  store.saved.push(PAIRED)
  const { get, bridge } = await listener(host.origin, store)
  host.state.coreUnauthorized = true
  const response = await get("/oc/session/status")
  expect(response.status).toBe(401)
  expect(await response.json()).toEqual({ name: "UnauthorizedError" })
  expect(bridge.paired()).toBe(true)
  expect(store.saved).toEqual([PAIRED])
})

test("Forget pairing deletes the stored cookie, only from this window", async () => {
  const host = gateway()
  const dir = await mkdtemp(path.join(tmpdir(), "es-bridge-forget-"))
  cleanup.push(() => rm(dir, { recursive: true, force: true }))
  const file = path.join(dir, "personal.cookie")
  const cookie = encryptedCookie(file, { available: () => true, encrypt: (value: string) => Buffer.from(value).reverse(), decrypt: (value: Buffer) => Buffer.from(value).reverse().toString() })
  await cookie.saveCookie(PAIRED)
  const { server, get, bridge } = await listener(host.origin, { access: async () => ACCESS, ...cookie })
  expect(bridge.paired()).toBe(true)
  const foreign = await get("/__es/bridge/forget", { method: "POST", headers: { origin: "https://evil.example" } })
  expect(foreign.status).toBe(403)
  expect(await Bun.file(file).exists()).toBe(true)
  const forgotten = await get("/__es/bridge/forget", { method: "POST", headers: { origin: server.origin } })
  expect(forgotten.status).toBe(303)
  expect(forgotten.headers.get("location")).toBe("/")
  expect(bridge.paired()).toBe(false)
  expect(await Bun.file(file).exists()).toBe(false)
  expect(host.seen.filter((item) => item.path.includes("forget"))).toEqual([])
})
