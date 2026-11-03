import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { findRequest, surfaceFrameFocused, type FindRequest } from "./surface-find"
import { serve } from "./server"

const FRAME = "/__cap/surface/opencode-week-review/mabc123-0123456789abcdef0123456789abcdef/"
const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((item) => item()))
})

test("a find request names one Surface frame directory, an action and a bounded query, nothing else", () => {
  expect(findRequest({ frame: FRAME, action: "find", query: "migrated" })).toEqual({ frame: FRAME, action: "find", query: "migrated" })
  expect(findRequest({ frame: "/__cap/host/mini/surface/srf/m1-0123456789abcdef0123456789abcdef/", action: "next", query: "x" })).toBeDefined()
  expect(findRequest({ frame: FRAME, action: "clear" })).toEqual({ frame: FRAME, action: "clear" })
  for (const body of [
    { frame: "/es/api/surfaces", action: "find", query: "x" },
    { frame: `${FRAME}index.html`, action: "find", query: "x" },
    { frame: "https://evil.example/__cap/surface/a/m1-0123456789abcdef0123456789abcdef/", action: "find", query: "x" },
    { frame: FRAME, action: "eval", query: "x" },
    { frame: FRAME, action: "find" },
    { frame: FRAME, action: "find", query: "x".repeat(201) },
    { frame: FRAME, action: "find", query: "x", script: "alert(1)" },
    null,
    [],
  ]) expect(findRequest(body)).toBeUndefined()
})

test("a frame inside a Surface counts as Surface focus; the app's own frames do not", () => {
  const main = { url: "http://127.0.0.1:5000/?surface=x", parent: null } as unknown as Electron.WebFrameMain
  const surface = { url: `http://127.0.0.1:5000${FRAME}index.html`, parent: main } as unknown as Electron.WebFrameMain
  const nested = { url: "about:srcdoc", parent: surface } as unknown as Electron.WebFrameMain
  const other = { url: "http://127.0.0.1:5000/brief.html", parent: main } as unknown as Electron.WebFrameMain
  expect(surfaceFrameFocused(surface, main)).toBe(true)
  expect(surfaceFrameFocused(nested, main)).toBe(true)
  expect(surfaceFrameFocused(main, main)).toBe(false)
  expect(surfaceFrameFocused(other, main)).toBe(false)
  expect(surfaceFrameFocused(null, main)).toBe(false)
})

test("the listener offers Surface find to its own window only and passes it a validated request", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "es-surface-find-"))
  await writeFile(path.join(root, "index.html"), "<!doctype html><title>app</title>")
  const seen: FindRequest[] = []
  const server = await serve({ root, find: async (input) => (seen.push(input), { state: "ok", current: 1, total: 3 }) })
  cleanup.push(() => Promise.race([server.close(), Bun.sleep(500)]), () => rm(root, { recursive: true, force: true }))
  const native = { "x-editspace-key": server.key, origin: server.origin, "content-type": "application/json" }
  const post = (body: unknown, headers: Record<string, string> = native) =>
    fetch(`${server.origin}/__es/find`, { method: "POST", headers, body: JSON.stringify(body) })

  expect(await (await fetch(`${server.origin}/__es/find`, { headers: { "x-editspace-key": server.key } })).json()).toEqual({ available: true })
  const found = await post({ frame: FRAME, action: "find", query: "migrated" })
  expect(await found.json()).toEqual({ state: "ok", current: 1, total: 3 })
  expect(seen).toEqual([{ frame: FRAME, action: "find", query: "migrated" }])
  expect((await post({ frame: "/es/api/state", action: "find", query: "x" })).status).toBe(400)
  expect((await post({ frame: FRAME, action: "find", query: "x" }, { "x-editspace-key": server.key, "content-type": "application/json" })).status).toBe(403)
  expect((await post({ frame: FRAME, action: "find", query: "x" }, { origin: server.origin, "content-type": "application/json" })).status).toBe(403)
  expect(seen).toHaveLength(1)

  const plain = await serve({ root })
  cleanup.push(() => Promise.race([plain.close(), Bun.sleep(500)]))
  expect((await fetch(`${plain.origin}/__es/find`, { headers: { "x-editspace-key": plain.key } })).status).toBe(404)
})
