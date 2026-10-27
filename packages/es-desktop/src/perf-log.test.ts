import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { serve } from "./server"

const dirs: string[] = []
const temp = async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "es-perf-"))
  dirs.push(dir)
  return dir
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

const journal = async (dir: string) => {
  const files = await readdir(dir).catch(() => [] as string[])
  const lines = (await Promise.all(files.map((file) => readFile(path.join(dir, file), "utf8")))).join("").trim()
  return lines ? lines.split("\n").map((line) => JSON.parse(line) as Record<string, unknown>) : []
}

const settle = async (dir: string, count: number) => {
  for (const delay of [10, 20, 50, 100, 200, 400]) {
    if ((await journal(dir)).length >= count) return
    await Bun.sleep(delay)
  }
}

describe("performance journal", () => {
  test("records renderer events posted by the native app in an owner-only file", async () => {
    const root = await temp()
    const perfDir = path.join(await temp(), "perf")
    await Bun.write(path.join(root, "index.html"), "<!doctype html>")
    const server = await serve({ root, perfDir })
    try {
      const response = await fetch(`${server.origin}/__es/perf`, {
        method: "POST",
        headers: { "x-editspace-key": server.key, origin: server.origin, "content-type": "application/json" },
        body: JSON.stringify({ events: [{ kind: "session.open", ms: 1234, sessionID: "ses_1" }, { nokind: true }] }),
      })
      expect(response.status).toBe(204)
      await settle(perfDir, 1)
      const records = await journal(perfDir)
      expect(records).toMatchObject([{ kind: "session.open", ms: 1234, sessionID: "ses_1", source: "renderer", host: "local" }])
      const [file] = await readdir(perfDir)
      expect((await stat(path.join(perfDir, file!))).mode & 0o777).toBe(0o600)
    } finally {
      await server.close()
    }
  })

  test("refuses reports without the native capability", async () => {
    const root = await temp()
    const perfDir = path.join(await temp(), "perf")
    await Bun.write(path.join(root, "index.html"), "<!doctype html>")
    const server = await serve({ root, perfDir })
    try {
      const response = await fetch(`${server.origin}/__es/perf`, { method: "POST", body: JSON.stringify({ events: [{ kind: "x" }] }) })
      expect(response.status).toBe(403)
      expect(await journal(perfDir)).toEqual([])
    } finally {
      await server.close()
    }
  })

  test("journals slow proxied Core requests with upstream wait and size", async () => {
    const root = await temp()
    const perfDir = path.join(await temp(), "perf")
    await Bun.write(path.join(root, "index.html"), "<!doctype html>")
    const core = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: async (request) => {
        const url = new URL(request.url)
        if (url.pathname.endsWith("/message")) await Bun.sleep(400)
        return Response.json(url.pathname.endsWith("/message") ? [{ text: "x".repeat(1000) }] : {})
      },
    })
    const server = await serve({ root, perfDir, opencode: `http://127.0.0.1:${core.port}` })
    try {
      const headers = { "x-editspace-key": server.key, origin: server.origin }
      expect((await fetch(`${server.origin}/oc/session/ses_1`, { headers })).status).toBe(200)
      expect((await fetch(`${server.origin}/oc/session/ses_1/message?limit=80`, { headers })).status).toBe(200)
      await settle(perfDir, 1)
      const records = await journal(perfDir)
      expect(records).toHaveLength(1)
      expect(records[0]).toMatchObject({ kind: "proxy.request", route: "oc/session/ses_1/message", method: "GET", status: 200, aborted: false })
      expect(records[0]!.waitMs as number).toBeGreaterThanOrEqual(350)
      expect(records[0]!.bytes as number).toBeGreaterThan(1000)
    } finally {
      await server.close()
      core.stop(true)
    }
  })
})
