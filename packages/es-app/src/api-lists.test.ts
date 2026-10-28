import { afterEach, beforeEach, expect, spyOn, test } from "bun:test"
import { es } from "./api"

let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, "fetch">>
beforeEach(() => { fetchSpy = spyOn(globalThis, "fetch") })
afterEach(() => fetchSpy.mockRestore())

test("repeated session opens reuse one recent tracker issue list", async () => {
  fetchSpy.mockImplementation((async () => Response.json({ backend: "gh", repo: "o/r", issues: [] })) as unknown as typeof fetch)
  await es.issues("reuse-issues")
  await es.issues("reuse-issues")
  expect(fetchSpy.mock.calls).toEqual([["/es/api/issues?es=reuse-issues"]])
})

test("repeated session opens reuse one recent doc list", async () => {
  fetchSpy.mockImplementation((async () => Response.json({ roots: [], sources: [] })) as unknown as typeof fetch)
  await es.docs("reuse-docs")
  await es.docs("reuse-docs")
  expect(fetchSpy.mock.calls).toEqual([["/es/api/docs?es=reuse-docs"]])
})

test("lists are reused per editspace, not across editspaces", async () => {
  fetchSpy.mockImplementation((async () => Response.json({ backend: "gh", repo: "o/r", issues: [] })) as unknown as typeof fetch)
  await es.issues("space-a")
  await es.issues("space-b")
  expect(fetchSpy.mock.calls).toEqual([["/es/api/issues?es=space-a"], ["/es/api/issues?es=space-b"]])
})

test("a failed list read is retried on the next open", async () => {
  fetchSpy.mockResolvedValueOnce(Response.json({ error: "down" }, { status: 503 }))
  fetchSpy.mockResolvedValueOnce(Response.json({ backend: "gh", repo: "o/r", issues: [] }))
  await expect(es.issues("retry-after-failure")).rejects.toThrow("HTTP 503")
  expect(await es.issues("retry-after-failure")).toMatchObject({ repo: "o/r" })
  expect(fetchSpy.mock.calls).toHaveLength(2)
})

test("ticket lookups read tracker metadata fresh even after a recent list read", async () => {
  fetchSpy.mockImplementation((async (input: RequestInfo | URL) =>
    String(input).startsWith("/es/api/issues")
      ? Response.json({ backend: "gh", repo: "murtaza64/dotfiles", issues: [] })
      : Response.json({ ref: "77" })) as unknown as typeof fetch)
  await es.issues("fresh-lookup")
  await es.issue("dotfiles#77", "fresh-lookup")
  expect(fetchSpy.mock.calls).toEqual([
    ["/es/api/issues?es=fresh-lookup"],
    ["/es/api/issues?es=fresh-lookup"],
    ["/es/api/issue?ref=77&es=fresh-lookup"],
  ])
})
