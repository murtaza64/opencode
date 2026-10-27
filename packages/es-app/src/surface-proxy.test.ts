import { afterEach, describe, expect, test } from "bun:test"
import { createServer, type Server } from "node:http"
import { surfaceProxy, type SurfaceEntry } from "../surface-proxy"

const cleanups: (() => void)[] = []
afterEach(() => cleanups.splice(0).forEach(close => close()))

const upstream = () => {
  const seen: Request[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      seen.push(req)
      const url = new URL(req.url)
      if (url.pathname === "/board/moved") return Response.redirect("/oc/session", 302)
      return new Response(`upstream ${req.method} ${url.pathname}${url.search}`, {
        headers: { "content-type": "text/plain", "set-cookie": "leak=1", "content-security-policy": "default-src *", "x-frame-options": "DENY" },
      })
    },
  })
  cleanups.push(() => server.stop(true))
  return { origin: `http://127.0.0.1:${server.port}`, seen }
}

const app = async (entries: () => SurfaceEntry[], dashboard?: string, publicOrigin?: string) => {
  const proxy = surfaceProxy({ dashboard, registry: async () => entries(), publicOrigin })
  const server: Server = createServer((req, res) => {
    if (req.url?.startsWith("/__es/surface/")) return proxy.address(req, res)
    void proxy.serve(req, res)
  })
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
  cleanups.push(() => server.close())
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("no address")
  return `http://127.0.0.1:${address.port}`
}

describe("surface proxy", () => {
  test("serves a surface under its capability path inside a prefix-scoped sandbox, without app credentials", async () => {
    const board = upstream()
    const base = await app(() => [{ id: "relay-board", upstream: `${board.origin}/board/` }])
    const { src } = await fetch(`${base}/__es/surface/relay-board`).then(response => response.json())
    expect(src).toMatch(/^\/__surface\/relay-board\/[0-9a-f]{32}\/$/)

    const response = await fetch(`${base}${src}api/data?x=1`, { headers: { cookie: "es_attention_operator=secret", authorization: "Basic abc", "x-editspace-key": "k" } })

    expect(await response.text()).toBe("upstream GET /board/api/data?x=1")
    expect(board.seen[0].headers.get("cookie")).toBeNull()
    expect(board.seen[0].headers.get("authorization")).toBeNull()
    expect(board.seen[0].headers.get("x-editspace-key")).toBeNull()
    expect(response.headers.get("set-cookie")).toBeNull()
    expect(response.headers.get("x-frame-options")).toBeNull()
    const csp = response.headers.get("content-security-policy") ?? ""
    expect(csp).toStartWith("sandbox allow-scripts allow-forms")
    expect(csp).not.toContain("allow-same-origin")
    expect(csp).toContain(`connect-src ${base}${src};`)
    expect(response.headers.get("access-control-allow-origin")).toBe("null")
  })

  test("allows the public origin's prefix when a proxy fronts the gateway with a loopback Host", async () => {
    const board = upstream()
    const base = await app(() => [{ id: "relay-board", upstream: `${board.origin}/board/` }], undefined, "https://mini.example.ts.net:8443")
    const { src } = await fetch(`${base}/__es/surface/relay-board`).then(response => response.json())

    const csp = (await fetch(`${base}${src}api/status`)).headers.get("content-security-policy") ?? ""

    expect(csp).toContain(`connect-src ${base}${src} https://mini.example.ts.net:8443${src};`)
    expect(csp).toContain(`script-src ${base}${src} https://mini.example.ts.net:8443${src} 'unsafe-inline'`)
  })

  test("refuses a wrong capability without contacting the surface", async () => {
    const board = upstream()
    const base = await app(() => [{ id: "relay-board", upstream: `${board.origin}/board/` }])

    const response = await fetch(`${base}/__surface/relay-board/${"0".repeat(32)}/`)

    expect(response.status).toBe(404)
    expect(board.seen).toHaveLength(0)
  })

  test("a capability for one surface does not open another", async () => {
    const board = upstream()
    const base = await app(() => [{ id: "one", upstream: `${board.origin}/` }, { id: "two", upstream: `${board.origin}/` }])
    const { src } = await fetch(`${base}/__es/surface/one`).then(response => response.json())

    const response = await fetch(`${base}${src.replace("/one/", "/two/")}`)

    expect(response.status).toBe(404)
  })

  test("blocks upstream redirects, which would escape the path-scoped policy", async () => {
    const board = upstream()
    const base = await app(() => [{ id: "relay-board", upstream: `${board.origin}/board/` }])
    const { src } = await fetch(`${base}/__es/surface/relay-board`).then(response => response.json())

    const response = await fetch(`${base}${src}moved`, { redirect: "manual" })

    expect(response.status).toBe(502)
    expect(response.headers.get("location")).toBeNull()
  })

  test("reports a withdrawn surface", async () => {
    const board = upstream()
    let entries: SurfaceEntry[] = [{ id: "relay-board", upstream: `${board.origin}/` }]
    const base = await app(() => entries)
    const { src } = await fetch(`${base}/__es/surface/relay-board`).then(response => response.json())
    entries = []

    const response = await fetch(`${base}${src}`)

    expect([response.status, await response.text()]).toEqual([404, "Surface withdrawn"])
  })

  test("resolves a dashboard-served surface against the dashboard", async () => {
    const dashboard = upstream()
    const base = await app(() => [{ id: "migration", upstream: "/api/surfaces/migration/static/" }], dashboard.origin)
    const { src } = await fetch(`${base}/__es/surface/migration`).then(response => response.json())

    const response = await fetch(`${base}${src}data.json`)

    expect(await response.text()).toBe("upstream GET /api/surfaces/migration/static/data.json")
  })

  test("answers the sandboxed frame's preflight for writes to its own backend", async () => {
    const board = upstream()
    const base = await app(() => [{ id: "relay-board", upstream: `${board.origin}/` }])
    const { src } = await fetch(`${base}/__es/surface/relay-board`).then(response => response.json())

    const preflight = await fetch(`${base}${src}api/note`, { method: "OPTIONS" })
    const write = await fetch(`${base}${src}api/note`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })

    expect(preflight.status).toBe(204)
    expect(preflight.headers.get("access-control-allow-methods")).toContain("POST")
    expect(await write.text()).toBe("upstream POST /api/note")
  })
})
