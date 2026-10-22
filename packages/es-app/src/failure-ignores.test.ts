import { expect, test } from "bun:test"
import type { SessionFailure } from "@opencode-ai/sdk/v2"
import { createRoot } from "solid-js"
import { createFailureIgnores, type IgnoredFailure } from "./failure-ignores"

const failure = (sessionID: string, messageID: string): SessionFailure => ({
  sessionID, directory: "/repo", messageID, parentID: "msg_user", time: 1_700_000_000_000, error: { name: "APIError", statusCode: 529 }, retry: "available",
})

// Stands in for the dashboard's ignored-failures file: one shared list, idempotent ops.
const dashboard = () => {
  const file = { entries: [] as IgnoredFailure[], posts: [] as Record<string, unknown>[], status: 200, drop: false }
  const request = (async (_url: string, init?: RequestInit) => {
    if (file.status !== 200) return new Response("{}", { status: file.status })
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body))
      file.posts.push(body)
      const same = (item: IgnoredFailure) => item.sessionID === body.sessionID && item.messageID === body.messageID
      if (body.op === "unignore") file.entries = file.entries.filter(item => !same(item))
      if (body.op === "ignore" && !file.entries.some(same)) file.entries.push({ ...body, ignoredAt: 1 })
      if (file.drop) { file.drop = false; throw new TypeError("network") }
    }
    return Response.json({ entries: file.entries })
  }) as typeof fetch
  return { file, fetch: request }
}
const store = (fetch: typeof globalThis.fetch) => createRoot(() => createFailureIgnores({ fetch }))

test("an ignore hides that exact failure for a later client and keeps its failure time", async () => {
  const server = dashboard()
  const first = store(server.fetch)
  await first.load()
  await first.ignore(failure("ses_a", "msg_a1"), "Provider error 529")
  const reloaded = store(server.fetch)
  await reloaded.load()
  expect(reloaded.ignored(failure("ses_a", "msg_a1"))).toBe(true)
  expect(reloaded.ignored(failure("ses_b", "msg_b1"))).toBe(false)
  expect(server.file.posts[0]).toMatchObject({ op: "ignore", failedAt: 1_700_000_000_000, label: "Provider error 529" })
})

test("a newer failure in an ignored session is not hidden", async () => {
  const server = dashboard()
  const ignores = store(server.fetch)
  await ignores.load()
  await ignores.ignore(failure("ses_a", "msg_a1"), "x")
  expect(ignores.ignored(failure("ses_a", "msg_a2"))).toBe(false)
})

test("unignore shows the failure again everywhere", async () => {
  const server = dashboard()
  const ignores = store(server.fetch)
  await ignores.load()
  await ignores.ignore(failure("ses_a", "msg_a1"), "x")
  await ignores.unignore(ignores.entries()[0]!)
  const reloaded = store(server.fetch)
  await reloaded.load()
  expect(reloaded.ignored(failure("ses_a", "msg_a1"))).toBe(false)
})

test("an unreadable store hides nothing and says so", async () => {
  const server = dashboard()
  server.file.entries = [{ sessionID: "ses_a", messageID: "msg_a1", directory: "/repo", failedAt: null, label: "", ignoredAt: 1 }]
  server.file.status = 503
  const ignores = store(server.fetch)
  await ignores.load()
  expect(ignores.ignored(failure("ses_a", "msg_a1"))).toBe(false)
  expect(ignores.notice()).toContain("all failures are shown")
})

test("a lost response re-reads the file and reflects what committed", async () => {
  const server = dashboard()
  const ignores = store(server.fetch)
  await ignores.load()
  server.file.drop = true
  await ignores.ignore(failure("ses_a", "msg_a1"), "x")
  expect(ignores.ignored(failure("ses_a", "msg_a1"))).toBe(true)
  expect(ignores.notice()).toContain("not confirmed")
})
