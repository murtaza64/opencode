import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
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

test("self-handoff writes through /hosts stay forbidden without contacting either upstream", async () => {
  const mini = fakeHost("mini")
  const { local, server, get } = await workListener(mini)
  const before = [local.seen.length, mini.seen.length]
  const headers = { origin: server.origin, cookie: "es_attention_operator=local; es_attention_operator__mini=mini", "content-type": "application/json", "x-attention-csrf": "1" }
  for (const [method, pathname] of [["POST", "/hosts/mini/es/api/handoffs/self"], ["DELETE", "/hosts/mini/es/api/handoffs/self/click-1"]]) {
    expect((await get(pathname, { method, body: "{}", headers })).status).toBe(403)
  }
  expect([local.seen.length, mini.seen.length]).toEqual(before)
})

test("a remote host's own listener binds self-handoff writes to its dashboard and operator cookie", async () => {
  const mini = fakeHost("mini")
  const { miniServer, miniGet } = await twoHosts(mini)
  const headers = { origin: miniServer.origin, cookie: "unrelated=private; es_attention_operator__mini=mini-operator", "content-type": "application/json", "x-attention-csrf": "1" }
  for (const [method, pathname] of [["POST", "/es/api/handoffs/self"], ["DELETE", "/es/api/handoffs/self/click-1"]]) {
    expect((await miniGet(pathname, { method, body: "{}", headers })).status).toBe(200)
    expect(mini.seen.at(-1)).toEqual({ path: pathname, cookie: "es_attention_operator=mini-operator", authorization: null, origin: mini.origin })
  }
  expect((await miniGet("/es/api/handoffs/self", { method: "POST", body: "{}", headers: { ...headers, origin: "https://evil.test" } })).status).toBe(403)
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

test("each listener reports its host and the switch targets", async () => {
  const { localServer, miniServer, localGet, miniGet } = await twoHosts(fakeHost("mini"))
  const hosts = [{ id: "local", label: "Local", origin: localServer.origin }, { id: "mini", label: "Mac Mini", origin: miniServer.origin }]
  expect(await (await miniGet("/__es/host")).json()).toEqual({ id: "mini", label: "Mac Mini", remote: true, hosts })
  expect(await (await localGet("/__es/host")).json()).toEqual({ id: "local", label: "Local", remote: false, hosts })
  expect((await fetch(`${miniServer.origin}/__es/host`)).status).toBe(403)
})

test("a remote host's listener opens that host's file surface through its dashboard, in this listener's sandbox", async () => {
  const seen: { path: string; cookie: string | null; authorization: string | null }[] = []
  const report = "<!doctype html><style>body{color:#e4eaef}</style><h1>API tests: where things stand</h1>"
  const gate = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) => {
      const url = new URL(request.url)
      seen.push({ path: url.pathname, cookie: request.headers.get("cookie"), authorization: request.headers.get("authorization") })
      if (url.pathname === "/es/api/surfaces") return Response.json({ surfaces: [
        { id: "api-tests", upstream: "/api/surfaces/api-tests/static/" },
        { id: "board", upstream: "http://127.0.0.1:9/" },
      ] })
      if (url.pathname === "/es/api/surfaces/api-tests/static/") return new Response(report, { headers: { "content-type": "text/html; charset=utf-8", "set-cookie": "leak=1" } })
      return new Response("not found", { status: 404 })
    },
  })
  cleanup.push(async () => void (await gate.stop(true)))
  const { miniServer, miniGet } = await twoHosts({ origin: gate.url.origin, seen: [], stop: () => gate.stop(true) } as ReturnType<typeof fakeHost>)
  // Minted by this listener only behind its own key, like the local host's surfaces.
  expect((await fetch(`${miniServer.origin}/__es/surface/api-tests`)).status).toBe(403)
  const minted = await miniGet("/__es/surface/api-tests", { headers: { cookie: "es_attention_operator=local-op" } })
  expect(minted.status).toBe(200)
  const { src } = await minted.json()
  expect(src).toMatch(/^\/__cap\/surface\/api-tests\/[0-9a-z]+-[0-9a-f]{32}\/$/)
  const frame = await fetch(`${miniServer.origin}${src}`)
  expect(frame.status).toBe(200)
  expect(await frame.text()).toBe(report)
  expect(frame.headers.get("content-security-policy")).toContain(`script-src ${miniServer.origin}${src} 'unsafe-inline'`)
  expect(frame.headers.get("content-security-policy")).toContain("sandbox allow-scripts")
  expect(frame.headers.get("set-cookie")).toBeNull()
  // Only that host's dashboard file route is read, with no credential of this machine.
  expect(seen.map((item) => item.path)).toEqual(["/es/api/surfaces", "/es/api/surfaces/api-tests/static/"])
  expect(seen.every((item) => !item.cookie && !item.authorization)).toBe(true)
  // A surface at a loopback address on that host is not reachable from here: an explicit refusal, never a local read.
  const { src: board } = await (await miniGet("/__es/surface/board")).json()
  const refused = await fetch(`${miniServer.origin}${board}`)
  expect([refused.status, await refused.text()]).toEqual([502, "This surface is served only on its own host"])
  expect(seen).toHaveLength(2)
  // Climbing out of the surface's file route is refused before any read.
  expect((await fetch(`${miniServer.origin}${src}..%2F..%2Fattention`)).status).toBeGreaterThanOrEqual(400)
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
    { id: "mini", label: "Mac Mini", origin: "https://murtaza-mac-mini.tailc81fd.ts.net", mode: "proxy", profile: "work" },
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
  expect(await serviceHosts(directory, {})).toEqual([{ id: "mini", label: "Mac Mini", origin: "https://murtaza-mac-mini.tailc81fd.ts.net", mode: "proxy", profile: "work" }])
})

test("a page host is any credential-free https origin shown as its own page", async () => {
  const directory = await renderer()
  expect(await serviceHosts(directory, { ES_REMOTE_HOSTS: '[{"id":"personal","label":"Personal","origin":"https://agents.murtaza.earth","mode":"page"}]' })).toEqual([
    { id: "personal", label: "Personal", origin: "https://agents.murtaza.earth", mode: "page", profile: "personal" },
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

// The Work view: the local listener reads other hosts at /hosts/<id>/..., list routes only.
const workListener = async (mini: ReturnType<typeof fakeHost>, local = fakeHost("local")) => {
  const server = await serve({ root: await renderer(), opencode: local.origin, dashboard: local.origin, opencodeAuth: "Basic bG9jYWw6c2VjcmV0", peers: [{ id: "mini", origin: mini.origin }] })
  cleanup.push(() => Promise.race([server.close(), Bun.sleep(500)]))
  const get = (pathname: string, init?: RequestInit) =>
    fetch(`${server.origin}${pathname}`, { ...init, headers: { "x-editspace-key": server.key, ...init?.headers } })
  return { server, get, local }
}

test("the local listener reads another host's session list with no credential and the same session IDs stay apart", async () => {
  const mini = fakeHost("mini")
  const { get } = await workListener(mini)
  const response = await get("/hosts/mini/oc/experimental/session?roots=true&limit=200", {
    headers: { cookie: "es_attention_operator=local-operator; es_attention_operator__mini=mini-operator", authorization: "Basic bG9jYWw6c2VjcmV0" },
  })
  expect(await response.json()).toMatchObject({ host: "mini", path: "/experimental/session" })
  expect(mini.seen.at(-1)).toEqual({ path: "/experimental/session", cookie: null, authorization: null, origin: null })
  expect(await (await get("/hosts/mini/es/api/editspaces")).json()).toMatchObject({ host: "mini", path: "/es/api/editspaces" })
  // Needs you reads the other host's decision list the same way: no operator cookie travels.
  const decisions = await get("/hosts/mini/es/api/attention?view=open&limit=200", { headers: { cookie: "es_attention_operator=local-operator; es_attention_operator__mini=mini-operator" } })
  expect(await decisions.json()).toMatchObject({ host: "mini", path: "/es/api/attention" })
  expect(mini.seen.at(-1)).toEqual({ path: "/es/api/attention", cookie: null, authorization: null, origin: null })
  // A Mini session opened read-only in the Local window: its record, messages, one message, todos, statuses.
  for (const pathname of ["/oc/session/ses_m", "/oc/session/ses_m/message", "/oc/session/ses_m/message/msg_1", "/oc/session/ses_m/todo", "/oc/session/status"]) {
    expect(await (await get(`/hosts/mini${pathname}?directory=%2Fr`)).json()).toMatchObject({ host: "mini", path: pathname.slice(3) })
    expect(mini.seen.at(-1)).toEqual({ path: pathname.slice(3), cookie: null, authorization: null, origin: null })
  }
  // Another host's handoff lineage and lane owners are read the same way, so a pin follows a handoff there.
  for (const pathname of ["/es/api/handoffs", "/es/api/state"]) {
    expect(await (await get(`/hosts/mini${pathname}?es=opencode`)).json()).toMatchObject({ host: "mini", path: pathname })
    expect(mini.seen.at(-1)).toEqual({ path: pathname, cookie: null, authorization: null, origin: null })
  }
  // Another host's pins are listed and followed with no credential (writes: the pin-write test below).
  expect(await (await get("/hosts/mini/es/api/pins?since=3")).json()).toMatchObject({ host: "mini", path: "/es/api/pins" })
  expect(mini.seen.at(-1)).toEqual({ path: "/es/api/pins", cookie: null, authorization: null, origin: null })
  // The Today total reads each host's daily usage rollup the same way.
  expect(await (await get("/hosts/mini/oc/experimental/usage/daily?days=1")).json()).toMatchObject({ host: "mini", path: "/experimental/usage/daily" })
  expect(mini.seen.at(-1)).toEqual({ path: "/experimental/usage/daily", cookie: null, authorization: null, origin: null })
  expect(await (await get("/oc/experimental/session")).json()).toMatchObject({ host: "local" })
})

test("host-qualified routes expose list reads only: writes, other routes and unknown hosts are refused", async () => {
  const mini = fakeHost("mini")
  const { get } = await workListener(mini)
  const before = mini.seen.length
  expect((await get("/hosts/mini/oc/session", { method: "POST", body: "{}" })).status).toBe(403)
  expect((await get("/hosts/mini/oc/experimental/session", { method: "POST", body: "{}" })).status).toBe(403)
  // Reads beyond the read-only session view, and every write, stay refused.
  for (const [method, pathname] of [
    ["POST", "/oc/session/ses_same/prompt_async"], ["POST", "/oc/session/ses_same/message"], ["PATCH", "/oc/session/ses_same"],
    ["DELETE", "/oc/session/ses_same"], ["POST", "/oc/session/ses_same/abort"], ["POST", "/oc/permission/per_1/reply"],
    ["GET", "/oc/session/ses_same/children/x"], ["GET", "/oc/session/ses_same/message/msg_1/part/prt_1/attachment/0"],
    ["GET", "/oc/session/ses_same/message/msg_1/x"],
  ]) expect((await get(`/hosts/mini${pathname}`, { method, ...(method === "GET" ? {} : { body: "{}" }) })).status).toBe(403)
  expect((await get("/hosts/mini/es/api/attention/session", { method: "POST", headers: { "content-type": "application/json", "x-attention-csrf": "1" }, body: "{}" })).status).toBe(403)
  expect((await get("/hosts/mini/es/api/attention", { method: "POST", body: "{}" })).status).toBe(403)
  expect((await get("/hosts/mini/oc/experimental/usage/daily", { method: "POST", body: "{}" })).status).toBe(403)
  for (const method of ["PUT", "DELETE"]) expect((await get("/hosts/mini/es/api/pins/session:ses_a", { method, body: "{}" })).status).toBe(403)
  expect((await get("/hosts/mini/es/api/handoffs", { method: "POST", body: "{}" })).status).toBe(403)
  expect((await get("/hosts/mini/es/api/pins/session:ses_a/order", { method: "PATCH", body: "{}" })).status).toBe(403)
  expect((await get("/hosts/mini/oc/experimental/usage")).status).toBe(403)
  expect((await get("/hosts/mini/oc/experimental/usage/daily/raw")).status).toBe(403)
  expect((await get("/hosts/mini/es/api/attention/00000000-0000-4000-8000-000000000000/commands", { method: "POST", body: "{}" })).status).toBe(403)
  expect((await get("/hosts/other/oc/experimental/session")).status).toBe(404)
  expect((await get("/hosts/local/oc/experimental/session")).status).toBe(404)
  expect((await get("/hosts/mini//oc/experimental/session")).status).toBe(404)
  expect(mini.seen.length).toBe(before)
})

test("this window sends input to, and stops, a run on another host: native origin only, that host's origin upstream, no credential", async () => {
  const mini = fakeHost("mini")
  const { server, get } = await workListener(mini)
  const body = JSON.stringify({ requestID: "11111111-2222-4333-8444-555555555555", delivery: "steer", text: "Use the staging bucket" })
  const sent = await get("/hosts/mini/oc/session/ses_m/input?directory=%2Fr", {
    method: "POST", body, headers: { origin: server.origin, "content-type": "application/json", cookie: "es_attention_operator=local; es_attention_operator__mini=mini", authorization: "Basic bG9jYWw6c2VjcmV0" },
  })
  expect(sent.status).toBe(200)
  expect(mini.seen.at(-1)).toEqual({ path: "/session/ses_m/input", cookie: null, authorization: null, origin: mini.origin })
  // The same request ID is checked on that host, never elsewhere.
  expect((await get("/hosts/mini/oc/session/ses_m/input/11111111-2222-4333-8444-555555555555")).status).toBe(200)
  expect(mini.seen.at(-1)).toMatchObject({ path: "/session/ses_m/input/11111111-2222-4333-8444-555555555555", cookie: null })
  const stopped = await get("/hosts/mini/oc/session/ses_m/abort", { method: "POST", headers: { origin: server.origin } })
  expect(stopped.status).toBe(200)
  const replied = await get("/hosts/mini/oc/permission/per_1/reply", { method: "POST", body: '{"reply":"once"}', headers: { origin: server.origin, "content-type": "application/json" } })
  expect(replied.status).toBe(200)
  expect(mini.seen.at(-1)).toMatchObject({ path: "/permission/per_1/reply", origin: mini.origin, cookie: null })
  const before = mini.seen.length
  expect((await get("/hosts/mini/oc/session/ses_m/input", { method: "POST", body })).status).toBe(403)
  expect((await get("/hosts/mini/oc/session/ses_m/input", { method: "POST", body, headers: { origin: "https://evil.test" } })).status).toBe(403)
  for (const pathname of ["/oc/session/ses_m/message", "/oc/session/ses_m/fork", "/es/api/pins/session:ses_m", "/es/api/frontdesk/memory"])
    expect((await get(`/hosts/mini${pathname}`, { method: "POST", body, headers: { origin: server.origin } })).status).toBe(403)
  expect(mini.seen.length).toBe(before)
})

test("another host's attention carries only that host's operator cookie, minted by its dashboard and scoped to /hosts/<id>/", async () => {
  const minted: string[] = []
  const seen: { path: string; cookie: string | null; origin: string | null }[] = []
  const dashboard = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url)
      await request.text()
      seen.push({ path: url.pathname, cookie: request.headers.get("cookie"), origin: request.headers.get("origin") })
      if (url.pathname === "/es/api/attention/session" && request.method === "POST") {
        minted.push("op-mini")
        return Response.json({ ok: true }, { headers: { "set-cookie": "es_attention_operator=op-mini; HttpOnly; SameSite=Strict; Path=/" } })
      }
      return Response.json({ ok: true })
    },
  })
  cleanup.push(async () => void (await dashboard.stop(true)))
  const { server, get } = await workListener({ origin: dashboard.url.origin } as ReturnType<typeof fakeHost>)
  const headers = { origin: server.origin, "content-type": "application/json", "x-attention-csrf": "1" }
  const signIn = await get("/hosts/mini/es/api/attention/session", { method: "POST", body: "{}", headers: { ...headers, cookie: "es_attention_operator=local-op; es_attention_operator__wing=wing-op" } })
  expect(signIn.headers.get("set-cookie")).toBe("es_attention_operator__mini=op-mini; HttpOnly; SameSite=Strict; Path=/hosts/mini/")
  expect(seen.at(-1)).toEqual({ path: "/es/api/attention/session", cookie: null, origin: dashboard.url.origin })
  const command = await get("/hosts/mini/es/api/attention/00000000-0000-4000-8000-000000000000/commands", {
    method: "POST", body: "{}", headers: { ...headers, cookie: "es_attention_operator=local-op; es_attention_operator__wing=wing-op; es_attention_operator__mini=op-mini" },
  })
  expect(command.status).toBe(200)
  expect(seen.at(-1)).toEqual({ path: "/es/api/attention/00000000-0000-4000-8000-000000000000/commands", cookie: "es_attention_operator=op-mini", origin: dashboard.url.origin })
})

test("host writes are exactly the own-host session, Aside, model, reply and attention writes; encoded or other paths are refused", async () => {
  const { hostWriteAllowed } = await import("./policy")
  const uuid = "00000000-0000-4000-8000-000000000000"
  for (const [method, pathname] of [
    ["POST", "/oc/session/ses_m/prompt_async"], ["POST", "/oc/session/ses_m/input"], ["PATCH", "/oc/session/ses_m/input/req_1"], ["DELETE", "/oc/session/ses_m/input/req_1"],
    ["POST", "/oc/session/ses_m/input/req_1/deliver"], ["POST", "/oc/session/ses_m/recover"], ["POST", "/oc/session/ses_m/abort"],
    ["POST", "/oc/permission/per_1/reply"], ["POST", "/oc/question/que_1/reject"], ["POST", "/es/api/attention/session"],
    ["POST", `/es/api/attention/${uuid}/commands`], ["POST", `/es/api/attention/${uuid}/delivery`],
    ["PATCH", "/oc/session/ses_m"], ["POST", "/oc/session/ses_m/aside"], ["DELETE", "/oc/session/ses_m/aside/req_1"],
    ["PUT", "/es/api/pins/session:ses_m"], ["DELETE", "/es/api/pins/lane:opencode%2Forchestrator"], ["PATCH", "/es/api/pins/lane:opencode%2Forchestrator/order"],
  ]) expect(hostWriteAllowed(method, pathname)).toBe(true)
  for (const [method, pathname] of [
    ["PUT", "/oc/session/ses_m/input"], ["POST", "/oc/session/ses_m%2F..%2Fx/input"], ["POST", "/oc/session/ses_m/input/req_1"], ["DELETE", "/oc/session/ses_m"],
    ["POST", "/oc/session/ses_m/fork"], ["POST", "/oc/session"], ["PATCH", "/oc/session/ses_m/aside/req_1"], ["DELETE", "/oc/session/ses_m/aside"],
    ["POST", "/es/api/pins/session:ses_m"], ["PATCH", "/es/api/pins/session:ses_m"], ["PUT", "/es/api/pins/lane:opencode/x"], ["PUT", "/es/api/pins/lane:opencode%2Fx%2Fy"],
    ["DELETE", "/es/api/pins/session:ses_m/order"], ["PUT", "/es/api/pins/other:ses_m"], ["GET", "/es/api/pins/session:ses_m"], ["POST", "/es/api/attention/publish"], ["POST", `/es/api/attention/${uuid}`],
    ["POST", "/es/api/secret-intake/h1"], ["POST", "/es/api/frontdesk"], ["POST", "/oc/permission/per_1/reply/x"],
  ]) expect(hostWriteAllowed(method, pathname)).toBe(false)
})

test("pin, unpin and reorder reach only that Work host's own store, with only its operator cookie, from the native origin", async () => {
  const seen: Record<string, { method: string; path: string; cookie: string | null; origin: string | null; csrf: string | null; body: string }[]> = { mini: [], wing: [], local: [] }
  const host = (name: string) => {
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async (request) => {
      const url = new URL(request.url)
      seen[name]!.push({ method: request.method, path: url.pathname, cookie: request.headers.get("cookie"), origin: request.headers.get("origin"), csrf: request.headers.get("x-attention-csrf"), body: await request.text() })
      return Response.json({ rev: 1, applied: true, host: name })
    } })
    cleanup.push(async () => void (await server.stop(true)))
    return server.url.origin
  }
  const peers = { mini: host("mini"), wing: host("wing") }
  const server = await serve({ root: await renderer(), opencode: host("local"), dashboard: host("local"), peers: [{ id: "mini", origin: peers.mini }, { id: "wing", origin: peers.wing }] })
  cleanup.push(() => Promise.race([server.close(), Bun.sleep(500)]))
  const cookie = "es_attention_operator=local-op; es_attention_operator__mini=m-op; es_attention_operator__wing=w-op"
  const write = (pathname: string, method: string, headers: Record<string, string> = {}) => fetch(`${server.origin}${pathname}`, {
    method, body: '{"at":1,"op":"op-12345678"}', headers: { "x-editspace-key": server.key, origin: server.origin, cookie, "content-type": "application/json", "x-attention-csrf": "1", ...headers },
  })
  // The same lane ref on two hosts is two pins: each write reaches only its own host, with only its own operator cookie.
  expect(await (await write("/hosts/mini/es/api/pins/lane:opencode%2Forchestrator", "PUT")).json()).toMatchObject({ host: "mini", applied: true })
  expect(await (await write("/hosts/wing/es/api/pins/lane:opencode%2Forchestrator", "PUT")).json()).toMatchObject({ host: "wing" })
  expect((await write("/hosts/mini/es/api/pins/lane:opencode%2Forchestrator/order", "PATCH")).status).toBe(200)
  expect((await write("/hosts/mini/es/api/pins/session:ses_same", "DELETE")).status).toBe(200)
  const mini = { origin: new URL(peers.mini).origin, csrf: "1", body: '{"at":1,"op":"op-12345678"}' }
  expect(seen.mini).toEqual([
    { method: "PUT", path: "/es/api/pins/lane:opencode%2Forchestrator", cookie: "es_attention_operator=m-op", ...mini },
    { method: "PATCH", path: "/es/api/pins/lane:opencode%2Forchestrator/order", cookie: "es_attention_operator=m-op", ...mini },
    { method: "DELETE", path: "/es/api/pins/session:ses_same", cookie: "es_attention_operator=m-op", ...mini },
  ])
  expect(seen.wing).toEqual([{ method: "PUT", path: "/es/api/pins/lane:opencode%2Forchestrator", cookie: "es_attention_operator=w-op", origin: new URL(peers.wing).origin, csrf: "1", body: '{"at":1,"op":"op-12345678"}' }])
  // Refused before any upstream: another page origin, no origin, a wrong ref, method or path, an unknown, Personal or local host, no key.
  const before = { mini: seen.mini.length, wing: seen.wing.length, local: seen.local.length }
  expect((await write("/hosts/mini/es/api/pins/session:ses_a", "PUT", { origin: "http://127.0.0.1:1" })).status).toBe(403)
  expect((await fetch(`${server.origin}/hosts/mini/es/api/pins/session:ses_a`, { method: "PUT", body: "{}", headers: { "x-editspace-key": server.key } })).status).toBe(403)
  for (const [method, pathname] of [
    ["PUT", "/es/api/pins/lane:opencode/orchestrator"], ["PUT", "/es/api/pins/lane:opencode%2F..%2Fx"], ["PUT", "/es/api/pins/other:x"],
    ["POST", "/es/api/pins/session:ses_a"], ["PATCH", "/es/api/pins/session:ses_a"], ["DELETE", "/es/api/pins/session:ses_a/order"], ["PUT", "/es/api/pins"],
  ]) expect((await write(`/hosts/mini${pathname}`, method)).status).toBe(403)
  for (const id of ["personal", "local", "Mini", "other"]) expect((await write(`/hosts/${id}/es/api/pins/session:ses_a`, "PUT")).status).toBe(404)
  expect((await fetch(`${server.origin}/hosts/mini/es/api/pins/session:ses_a`, { method: "PUT", body: "{}", headers: { origin: server.origin } })).status).toBe(403)
  expect({ mini: seen.mini.length, wing: seen.wing.length, local: seen.local.length }).toEqual(before)
})

test("the Work view frames another host's file surface from that host through the Local listener; capabilities never cross hosts", async () => {
  const seen: Record<string, { path: string; cookie: string | null; authorization: string | null }[]> = { mini: [], wing: [] }
  const gate = (name: string) => {
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => {
      const url = new URL(request.url)
      seen[name]!.push({ path: url.pathname, cookie: request.headers.get("cookie"), authorization: request.headers.get("authorization") })
      if (url.pathname === "/es/api/surfaces") return Response.json({ surfaces: [{ id: "report", upstream: "/api/surfaces/report/static/" }, { id: "board", upstream: "http://127.0.0.1:9/" }] })
      if (url.pathname === "/es/api/surfaces/report/static/") return new Response(`<h1>${name} report</h1>`, { headers: { "content-type": "text/html" } })
      return new Response("not found", { status: 404 })
    } })
    cleanup.push(async () => void (await server.stop(true)))
    return server.url.origin
  }
  const server = await serve({ root: await renderer(), opencode: fakeHost("local").origin, dashboard: fakeHost("local").origin, peers: [{ id: "mini", origin: gate("mini") }, { id: "wing", origin: gate("wing") }] })
  cleanup.push(() => Promise.race([server.close(), Bun.sleep(500)]))
  const get = (pathname: string) => fetch(`${server.origin}${pathname}`, { headers: { "x-editspace-key": server.key, cookie: "es_attention_operator=local-op; es_attention_operator__mini=m-op" } })
  // The Surface list is a host read like the decision list: no credential travels.
  expect(await (await get("/hosts/mini/es/api/surfaces")).json()).toMatchObject({ surfaces: [{ id: "report" }, { id: "board" }] })
  // The same surface id on two hosts: each mints its own address and frames its own host's content.
  expect((await fetch(`${server.origin}/hosts/mini/__es/surface/report`)).status).toBe(403)
  const mini = (await (await get("/hosts/mini/__es/surface/report")).json()).src as string
  const wing = (await (await get("/hosts/wing/__es/surface/report")).json()).src as string
  expect(mini).toMatch(/^\/__cap\/host\/mini\/surface\/report\/[0-9a-z]+-[0-9a-f]{32}\/$/)
  const frame = await fetch(`${server.origin}${mini}`)
  expect([frame.status, await frame.text()]).toEqual([200, "<h1>mini report</h1>"])
  expect(frame.headers.get("content-security-policy")).toContain(`script-src ${server.origin}${mini} 'unsafe-inline'`)
  expect(await (await fetch(`${server.origin}${wing}`)).text()).toBe("<h1>wing report</h1>")
  // A capability is valid only for the host that minted it, and never for this host's own surfaces.
  expect((await fetch(`${server.origin}${mini.replace("/host/mini/", "/host/wing/")}`)).status).toBe(404)
  expect((await fetch(`${server.origin}${mini.replace("/host/mini/", "/")}`)).status).toBe(404)
  // A URL surface on that host is an explicit own-host-only refusal; unknown hosts are not found.
  const board = (await (await get("/hosts/mini/__es/surface/board")).json()).src as string
  const refused = await fetch(`${server.origin}${board}`)
  expect([refused.status, await refused.text()]).toEqual([502, "This surface is served only on its own host"])
  for (const id of ["personal", "local", "other"]) expect((await get(`/hosts/${id}/__es/surface/report`)).status).toBe(404)
  expect((await fetch(`${server.origin}/__cap/host/other/surface/report/x-${"0".repeat(32)}/`)).status).toBe(404)
  expect([...seen.mini, ...seen.wing].every((item) => !item.cookie && !item.authorization)).toBe(true)
})

test("host reads add exactly what the session view reads: pending inputs, subagents and providers", async () => {
  const { hostApiAllowed } = await import("./policy")
  for (const pathname of ["/oc/session/ses_m/input", "/oc/session/ses_m/input/req_1", "/oc/session/ses_m/children", "/oc/config/providers"])
    expect(hostApiAllowed("GET", pathname)).toBe(true)
  for (const pathname of ["/oc/config", "/oc/session/ses_m/aside", "/oc/session/ses_m/children/x", "/oc/agent", "/oc/session/ses_m/input/req_1/deliver"])
    expect(hostApiAllowed("GET", pathname)).toBe(false)
  expect(hostApiAllowed("POST", "/oc/session/ses_m/input")).toBe(false)
})

test("writes reach only a configured Work host; an unknown id, a Personal host or a stopped host never falls back to this one", async () => {
  const mini = fakeHost("mini")
  const local = fakeHost("local")
  const { server, get } = await workListener(mini, local)
  const body = JSON.stringify({ requestID: "11111111-2222-4333-8444-555555555555", delivery: "steer", text: "x" })
  const write = (host: string) => get(`/hosts/${host}/oc/session/ses_m/input`, { method: "POST", body, headers: { origin: server.origin, "content-type": "application/json" } })
  const before = { mini: mini.seen.length, local: local.seen.length }
  expect((await write("personal")).status).toBe(404)
  expect((await write("local")).status).toBe(404)
  expect((await write("Mini")).status).toBe(404)
  expect(mini.seen.length).toBe(before.mini)
  await mini.stop()
  expect(await (await write("mini")).json()).toEqual({ error: "Host unavailable" })
  expect(local.seen.length).toBe(before.local)
})

test("two hosts' operator cookies never cross", async () => {
  const seen: Record<string, (string | null)[]> = { mini: [], wing: [] }
  const host = (name: string) => {
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async (request) => { await request.text(); seen[name]!.push(request.headers.get("cookie")); return Response.json({}) } })
    cleanup.push(async () => void (await server.stop(true)))
    return server.url.origin
  }
  const root = await renderer()
  const server = await serve({ root, opencode: fakeHost("local").origin, dashboard: fakeHost("local").origin, peers: [{ id: "mini", origin: host("mini") }, { id: "wing", origin: host("wing") }] })
  cleanup.push(() => Promise.race([server.close(), Bun.sleep(500)]))
  const cookie = "es_attention_operator=local; es_attention_operator__mini=m-op; es_attention_operator__wing=w-op"
  const command = (id: string) => fetch(`${server.origin}/hosts/${id}/es/api/attention/00000000-0000-4000-8000-000000000000/commands`, {
    method: "POST", body: "{}", headers: { "x-editspace-key": server.key, origin: server.origin, cookie, "content-type": "application/json", "x-attention-csrf": "1" },
  })
  await command("mini")
  await command("wing")
  expect(seen).toEqual({ mini: ["es_attention_operator=m-op"], wing: ["es_attention_operator=w-op"] })
})

test("a remote or paired listener never offers host-qualified routes", async () => {
  const mini = fakeHost("mini")
  const server = await serve({ root: await renderer(), remote: { id: "mini", origin: mini.origin }, peers: [{ id: "other", origin: fakeHost("other").origin }] })
  cleanup.push(server.close)
  expect((await fetch(`${server.origin}/hosts/other/oc/experimental/session`, { headers: { "x-editspace-key": server.key } })).status).toBe(404)
})

test("an unreachable host answers its own reads as unavailable while local reads continue", async () => {
  const mini = fakeHost("mini")
  const { get } = await workListener(mini)
  await mini.stop()
  expect((await get("/hosts/mini/oc/experimental/session")).status).toBe(502)
  expect(await (await get("/oc/experimental/session")).json()).toMatchObject({ host: "local" })
})

test("with Work view hosts the app loads even when local services are down", async () => {
  const local = fakeHost("local")
  const { get } = await workListener(fakeHost("mini"), local)
  await local.stop()
  const page = await get("/", { headers: { "sec-fetch-dest": "document" } })
  expect(page.status).toBe(200)
  expect(await page.text()).toContain("Fixture renderer")
})

test("another host's session events arrive through the local socket with that host's origin only", async () => {
  const mini = fakeHost("mini")
  const { server } = await workListener(mini)
  const packets = await new Promise<{ id: number; type: string; data?: string; code?: number }[]>((resolve, reject) => {
    const seen: { id: number; type: string; data?: string; code?: number }[] = []
    const socket = new WebSocket(`${server.origin.replace("http", "ws")}/oc/global/event`, "opencode-events-v1", {
      headers: { origin: server.origin, "x-editspace-key": server.key },
    })
    socket.on("open", () => {
      socket.send(JSON.stringify({ type: "subscribe", id: 1, url: "/hosts/other/oc/global/event" }))
      socket.send(JSON.stringify({ type: "subscribe", id: 2, url: "/hosts/mini/oc/global/event" }))
    })
    socket.on("message", (data) => {
      const packet = JSON.parse(data.toString())
      seen.push(packet)
      if (packet.type !== "message") return
      socket.on("close", () => resolve(seen))
      socket.close()
    })
    socket.on("error", reject)
  })
  // An unknown host fails only its own subscription; the socket keeps serving the others.
  expect(packets).toContainEqual({ id: 1, type: "error", code: 502 })
  expect(JSON.parse(packets.find((packet) => packet.type === "message")!.data!)).toEqual({ type: "session.updated", host: "mini" })
  expect(mini.seen.find((item) => item.path === "/global/event")).toMatchObject({ origin: mini.origin, authorization: null, cookie: null })
})

test("a host's profile defaults by mode, may be set, and is validated, as is its kind", async () => {
  const directory = await renderer()
  expect(await serviceHosts(directory, { ES_REMOTE_HOSTS: '[{"id":"mini","origin":"https://a.b.ts.net","kind":"mini"},{"id":"wing","origin":"https://w.b.ts.net","profile":"personal","kind":"pc"}]' })).toEqual([
    { id: "mini", label: "mini", origin: "https://a.b.ts.net", mode: "proxy", profile: "work", kind: "mini" },
    { id: "wing", label: "wing", origin: "https://w.b.ts.net", mode: "proxy", profile: "personal", kind: "pc" },
  ])
  await expect(serviceHosts(directory, { ES_REMOTE_HOSTS: '[{"id":"mini","origin":"https://a.b.ts.net","profile":"home"}]' })).rejects.toThrow("profile")
  await expect(serviceHosts(directory, { ES_REMOTE_HOSTS: '[{"id":"mini","origin":"https://a.b.ts.net","kind":"phone"}]' })).rejects.toThrow("kind")
})

test("this machine's own identity comes from service-origins.json self, validated; absent it stays local", async () => {
  const { serviceSelf } = await import("./policy")
  const directory = await mkdtemp(path.join(tmpdir(), "es-self-"))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  expect(await serviceSelf(directory)).toBeUndefined()
  await writeFile(path.join(directory, "service-origins.json"), JSON.stringify({ self: { id: "laptop", label: "Laptop", profile: "work", kind: "laptop" } }))
  expect(await serviceSelf(directory)).toEqual({ id: "laptop", label: "Laptop", profile: "work", kind: "laptop" })
  for (const self of [{ id: "local" }, { id: "Laptop" }, { id: "laptop", profile: "home" }, { id: "laptop", kind: "phone" }, "laptop"]) {
    await writeFile(path.join(directory, "service-origins.json"), JSON.stringify({ self }))
    await expect(serviceSelf(directory)).rejects.toThrow("Invalid host")
  }
})

test("a listener reports its own identity and the Work hosts' profile and kind at /__es/host", async () => {
  const server = await serve({ root: await renderer(), hostInfo: () => ({ id: "laptop", label: "Laptop", remote: false, hosts: [], profile: "work", kind: "laptop",
    work: [{ id: "laptop", label: "Laptop", origin: "http://127.0.0.1:1", profile: "work", kind: "laptop" }, { id: "mini", label: "Mac Mini", origin: "http://127.0.0.1:2", profile: "work", kind: "mini", default: true }] }) })
  cleanup.push(server.close)
  const body = await (await fetch(`${server.origin}/__es/host`, { headers: { "x-editspace-key": server.key } })).json()
  expect(body).toMatchObject({ id: "laptop", profile: "work", kind: "laptop", work: [{ id: "laptop", profile: "work" }, { id: "mini", profile: "work", kind: "mini", default: true }] })
})

test("one proxied host may be the default for new work", async () => {
  const directory = await renderer()
  expect(await serviceHosts(directory, { ES_REMOTE_HOSTS: '[{"id":"mini","origin":"https://a.b.ts.net","default":true},{"id":"personal","origin":"https://x.y","mode":"page","default":true}]' })).toEqual([
    { id: "mini", label: "mini", origin: "https://a.b.ts.net", mode: "proxy", profile: "work", default: true },
    { id: "personal", label: "personal", origin: "https://x.y", mode: "page", profile: "personal" },
  ])
  await expect(serviceHosts(directory, { ES_REMOTE_HOSTS: '[{"id":"mini","origin":"https://a.b.ts.net","default":true},{"id":"m2","origin":"https://c.b.ts.net","default":true}]' })).rejects.toThrow("Only one default host")
})
