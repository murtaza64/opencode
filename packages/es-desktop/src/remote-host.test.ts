import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import WebSocket from "ws"
import { serve } from "./server"
import { pageNavigation, serviceHosts } from "./policy"
import type { HostInfo } from "../../es-app/remote-host"

const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

// A fake execution host shaped like the Mini's gate: Core at the root, dashboard under /es.
// Both hosts use the same session ID and directory, as a laptop and Mini running the same setup do.
const fakeHost = (name: string, options: { delay?: number; status?: number } = {}) => {
  const seen: { path: string; cookie: string | null; authorization: string | null; origin: string | null }[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url)
      await request.text()
      seen.push({ path: url.pathname, cookie: request.headers.get("cookie"), authorization: request.headers.get("authorization"), origin: request.headers.get("origin") })
      if (options.status) return new Response("deny unlisted-login", { status: options.status })
      if (options.delay) await Bun.sleep(options.delay)
      if (url.pathname === "/global/event" || url.pathname === "/es/api/notification-events")
        return new Response(
          new ReadableStream({
            start: (controller) => {
              controller.enqueue(new TextEncoder().encode(`data: {"type":"session.updated","host":"${name}"}\n\n`))
              controller.close()
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        )
      if (url.pathname.endsWith("/api/attention/session"))
        return Response.json({ host: name }, { headers: { "set-cookie": `es_attention_operator=${name}-operator; HttpOnly; SameSite=Strict; Path=/` } })
      return Response.json({ host: name, path: url.pathname, directory: url.searchParams.get("directory") })
    },
  })
  cleanup.push(async () => void (await server.stop(true)))
  return { origin: server.url.origin, seen, stop: () => server.stop(true) }
}

const renderer = async () => {
  const root = await mkdtemp(path.join(tmpdir(), "es-desktop-remote-"))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  await Bun.write(path.join(root, "index.html"), "<title>Fixture renderer</title>")
  return root
}

// The local listener and a Mini listener, as main.ts starts them.
const twoHosts = async (mini: ReturnType<typeof fakeHost>, local = fakeHost("local")) => {
  const root = await renderer()
  const hosts: HostInfo["hosts"] = []
  const info = (id: string): HostInfo => ({ id, label: id === "local" ? "Local" : "Mac Mini", remote: id !== "local", hosts })
  const localServer = await serve({ root, opencode: local.origin, dashboard: local.origin, opencodeAuth: "Basic bG9jYWw6c2VjcmV0", hostInfo: () => info("local") })
  // Under Bun's node:http, server.close() never settles once a websocket was upgraded; bound it.
  const closing = (close: () => Promise<void>) => () => Promise.race([close(), Bun.sleep(500)])
  cleanup.push(closing(localServer.close))
  const miniServer = await serve({ root, remote: { id: "mini", origin: mini.origin }, hostInfo: () => info("mini") })
  cleanup.push(closing(miniServer.close))
  hosts.push({ id: "local", label: "Local", origin: localServer.origin }, { id: "mini", label: "Mac Mini", origin: miniServer.origin })
  const client = (server: { origin: string; key: string }) => (pathname: string, init?: RequestInit) =>
    fetch(`${server.origin}${pathname}`, { ...init, headers: { "x-editspace-key": server.key, ...init?.headers } })
  return { local, localServer, miniServer, localGet: client(localServer), miniGet: client(miniServer) }
}

test("each host's listener reaches only that host's Core and dashboard for the same session ID and path", async () => {
  const mini = fakeHost("mini")
  const { localGet, miniGet } = await twoHosts(mini)
  const session = "/oc/session/ses_same?directory=%2FUsers%2Fmurtaza%2Fdotfiles"
  expect(await (await miniGet(session)).json()).toEqual({ host: "mini", path: "/session/ses_same", directory: "/Users/murtaza/dotfiles" })
  expect(await (await localGet(session)).json()).toEqual({ host: "local", path: "/session/ses_same", directory: "/Users/murtaza/dotfiles" })
  expect(await (await miniGet("/es/api/editspaces")).json()).toMatchObject({ host: "mini", path: "/es/api/editspaces" })
  expect(await (await localGet("/es/api/editspaces")).json()).toMatchObject({ host: "local", path: "/api/editspaces" })
})

test("a delayed local response stays on the local listener while the Mini answers its own", async () => {
  const mini = fakeHost("mini")
  const { localGet, miniGet } = await twoHosts(mini, fakeHost("local", { delay: 300 }))
  const slowLocal = localGet("/oc/session/ses_same?directory=%2Frepo").then((response) => response.json())
  expect(await (await miniGet("/oc/session/ses_same?directory=%2Frepo")).json()).toMatchObject({ host: "mini" })
  expect(await slowLocal).toMatchObject({ host: "local" })
})

test("the Mini never receives this machine's credentials, cookies or Core password", async () => {
  const mini = fakeHost("mini")
  const { miniGet } = await twoHosts(mini)
  await miniGet("/oc/session/ses_same/prompt_async?directory=%2Frepo", {
    method: "POST",
    body: "{}",
    headers: { "content-type": "application/json", cookie: "es_attention_operator=local-operator; other=private", authorization: "Basic bG9jYWw6c2VjcmV0" },
  })
  expect(mini.seen.at(-1)).toEqual({ path: "/session/ses_same/prompt_async", cookie: null, authorization: null, origin: null })
})

test("attention uses each host's own operator cookie and public origin", async () => {
  const mini = fakeHost("mini")
  const { local, localServer, miniServer, localGet, miniGet } = await twoHosts(mini)
  const cookie = "es_attention_operator=local-operator; es_attention_operator__mini=mini-operator"
  const miniResponse = await miniGet("/es/api/attention/session", { method: "POST", body: "{}", headers: { origin: miniServer.origin, cookie, "content-type": "application/json" } })
  expect(miniResponse.status).toBe(200)
  expect(mini.seen.at(-1)).toMatchObject({ cookie: "es_attention_operator=mini-operator", origin: mini.origin, authorization: null })
  expect(miniResponse.headers.get("set-cookie")).toStartWith("es_attention_operator__mini=mini-operator;")
  const localResponse = await localGet("/es/api/attention/session", { method: "POST", body: "{}", headers: { origin: localServer.origin, cookie, "content-type": "application/json" } })
  expect(local.seen.at(-1)).toMatchObject({ cookie: "es_attention_operator=local-operator" })
  expect(localResponse.headers.get("set-cookie")).toStartWith("es_attention_operator=local-operator;")
})

test("event streams subscribe on the page's own host and present the Mini its public origin", async () => {
  const mini = fakeHost("mini")
  const { miniServer } = await twoHosts(mini)
  const message = await new Promise<string>((resolve, reject) => {
    const socket = new WebSocket(`${miniServer.origin.replace("http", "ws")}/oc/global/event`, "opencode-events-v1", {
      headers: { origin: miniServer.origin, "x-editspace-key": miniServer.key },
    })
    socket.on("open", () => socket.send(JSON.stringify({ type: "subscribe", id: 1, url: "/oc/global/event" })))
    socket.on("message", (data) => {
      const packet = JSON.parse(data.toString())
      if (packet.type !== "message") return
      socket.on("close", () => resolve(packet.data))
      socket.close()
    })
    socket.on("error", reject)
  })
  expect(JSON.parse(message)).toEqual({ type: "session.updated", host: "mini" })
  expect(mini.seen.find((item) => item.path === "/global/event")).toMatchObject({ origin: mini.origin, authorization: null, cookie: null })
})

test("an unreachable Mini shows its own unavailable page while the local listener keeps working", async () => {
  const mini = fakeHost("mini")
  const { localGet, miniGet, localServer } = await twoHosts(mini)
  await mini.stop()
  const page = await miniGet("/", { headers: { "sec-fetch-dest": "document" } })
  expect(page.status).toBe(503)
  const text = await page.text()
  expect(text).toContain("Mac Mini unavailable")
  expect(text).toContain(`href="${localServer.origin}/"`)
  expect((await miniGet("/oc/session")).status).toBe(502)
  expect(await (await localGet("/oc/session")).json()).toMatchObject({ host: "local" })
})

test("a gate rejection reaches the app as that status, not as local data", async () => {
  const { miniGet } = await twoHosts(fakeHost("mini", { status: 403 }))
  const response = await miniGet("/oc/session")
  expect(response.status).toBe(403)
  expect(await response.text()).toBe("deny unlisted-login")
})

test("each listener reports its host and the switch targets; Front Desk surfaces stay local", async () => {
  const { localServer, miniServer, localGet, miniGet } = await twoHosts(fakeHost("mini"))
  const hosts = [{ id: "local", label: "Local", origin: localServer.origin }, { id: "mini", label: "Mac Mini", origin: miniServer.origin }]
  expect(await (await miniGet("/__es/host")).json()).toEqual({ id: "mini", label: "Mac Mini", remote: true, hosts })
  expect(await (await localGet("/__es/host")).json()).toEqual({ id: "local", label: "Local", remote: false, hosts })
  expect((await fetch(`${miniServer.origin}/__es/host`)).status).toBe(403)
  expect((await miniGet("/__es/surface/board")).status).toBe(503)
})

test("a listener without configured hosts reports the local host and no switch", async () => {
  const local = fakeHost("local")
  const server = await serve({ root: await renderer(), opencode: local.origin, dashboard: local.origin })
  cleanup.push(server.close)
  const response = await fetch(`${server.origin}/__es/host`, { headers: { "x-editspace-key": server.key } })
  expect(await response.json()).toEqual({ id: "local", label: "Local", remote: false, hosts: [] })
})

test("remote hosts must be credential-free tailnet HTTPS origins with distinct ids", async () => {
  const directory = await renderer()
  expect(await serviceHosts(directory, {})).toEqual([])
  expect(await serviceHosts(directory, { ES_REMOTE_HOSTS: '[{"id":"mini","label":"Mac Mini","origin":"https://murtaza-mac-mini.tailc81fd.ts.net"}]' })).toEqual([
    { id: "mini", label: "Mac Mini", origin: "https://murtaza-mac-mini.tailc81fd.ts.net", mode: "proxy" },
  ])
  for (const origin of [
    "http://murtaza-mac-mini.tailc81fd.ts.net",
    "https://example.com",
    "https://user:pass@mini.tailc81fd.ts.net",
    "https://mini.tailc81fd.ts.net/es",
    "https://mini.tailc81fd.ts.net:8443",
    "https://127.0.0.1",
  ])
    await expect(serviceHosts(directory, { ES_REMOTE_HOSTS: JSON.stringify([{ id: "mini", origin }]) })).rejects.toThrow("Remote hosts must be")
  await expect(serviceHosts(directory, { ES_REMOTE_HOSTS: '[{"id":"local","origin":"https://a.b.ts.net"}]' })).rejects.toThrow("Invalid remote host id")
  await expect(serviceHosts(directory, { ES_REMOTE_HOSTS: '[{"id":"mini","origin":"https://a.b.ts.net"},{"id":"mini","origin":"https://c.b.ts.net"}]' })).rejects.toThrow("Duplicate")
  await Bun.write(path.join(directory, "service-origins.json"), JSON.stringify({ hosts: [{ id: "mini", label: "Mac Mini", origin: "https://murtaza-mac-mini.tailc81fd.ts.net" }] }))
  expect(await serviceHosts(directory, {})).toEqual([{ id: "mini", label: "Mac Mini", origin: "https://murtaza-mac-mini.tailc81fd.ts.net", mode: "proxy" }])
})

test("a page host is any credential-free https origin shown as its own page", async () => {
  const directory = await renderer()
  expect(await serviceHosts(directory, { ES_REMOTE_HOSTS: '[{"id":"personal","label":"Personal","origin":"https://agents.murtaza.earth","mode":"page"}]' })).toEqual([
    { id: "personal", label: "Personal", origin: "https://agents.murtaza.earth", mode: "page" },
  ])
  for (const origin of ["http://agents.murtaza.earth", "https://user:pass@agents.murtaza.earth", "https://agents.murtaza.earth/app"])
    await expect(serviceHosts(directory, { ES_REMOTE_HOSTS: JSON.stringify([{ id: "personal", origin, mode: "page" }]) })).rejects.toThrow("Page hosts must be")
})

test("a page host's tab stays on its origin and its sign-in steps; anything else opens externally", () => {
  const origin = "https://agents.murtaza.earth"
  expect(pageNavigation("https://agents.murtaza.earth/session/x", origin)).toBe(true)
  expect(pageNavigation("https://frosty-pond-8fd5.cloudflareaccess.com/cdn-cgi/access/login/agents.murtaza.earth", origin)).toBe(true)
  expect(pageNavigation("https://accounts.google.com/o/oauth2/auth", origin)).toBe(true)
  // Access's Cloudflare identity provider and its shared OAuth callback stay in the tab.
  expect(pageNavigation("https://dash.cloudflare.com/oauth2/auth?response_type=code", origin)).toBe(true)
  expect(pageNavigation("https://oauth-callbacks.cloudflareaccess.com/cdn-cgi/access/outbound-oauth-callback", origin)).toBe(true)
  expect(pageNavigation("http://dash.cloudflare.com/oauth2/auth", origin)).toBe(false)
  expect(pageNavigation("https://evil-dash.cloudflare.com/", origin)).toBe(false)
  expect(pageNavigation("https://dash.cloudflare.com.evil.example/", origin)).toBe(false)
  expect(pageNavigation("http://127.0.0.1:4096/", origin)).toBe(false)
  expect(pageNavigation("https://example.com/", origin)).toBe(false)
  expect(pageNavigation("http://evil.cloudflareaccess.com/", origin)).toBe(false)
})

test("a page host reloads once only when it lands on its own origin from another site", async () => {
  const { pageArrivedCrossSite } = await import("./policy")
  const origin = "https://agents.murtaza.earth"
  expect(pageArrivedCrossSite("https://frosty-pond-8fd5.cloudflareaccess.com/cdn-cgi/access/login/x", "https://agents.murtaza.earth/", origin)).toBe(true)
  expect(pageArrivedCrossSite("https://agents.murtaza.earth/cdn-cgi/access/authorized", "https://agents.murtaza.earth/", origin)).toBe(false)
  expect(pageArrivedCrossSite("https://other.murtaza.earth/", "https://agents.murtaza.earth/", origin)).toBe(false)
  expect(pageArrivedCrossSite(undefined, "https://agents.murtaza.earth/", origin)).toBe(false)
  expect(pageArrivedCrossSite("data:text/html,x", "https://agents.murtaza.earth/", origin)).toBe(false)
  expect(pageArrivedCrossSite("https://localhost:9/login", "https://frosty-pond-8fd5.cloudflareaccess.com/", origin)).toBe(false)
})
