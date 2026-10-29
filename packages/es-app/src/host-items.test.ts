import { afterEach, expect, test } from "bun:test"
import { readHostDecision } from "./host-items"

const original = globalThis.fetch
afterEach(() => void (globalThis.fetch = original))

test("another host's decision reads that host's record from the route's { record, events } body", async () => {
  const seen: string[] = []
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => {
    seen.push(new URL(request.url).pathname + new URL(request.url).search)
    return Response.json({ record: { id: "11111111-1111-4111-8111-111111111111", editspace: "opencode", source_ref: { session_id: "ses_m", directory: "/r" } }, events: [] })
  } })
  // Relative app paths resolve against the Local listener; here a stand-in for it.
  globalThis.fetch = ((input: string, init?: RequestInit) => original(`${server.url.origin}${input}`, init)) as typeof fetch
  try {
    const record = await readHostDecision("mini", { editspace: "opencode", id: "11111111-1111-4111-8111-111111111111" })
    expect(record?.source_ref.session_id).toBe("ses_m")
    expect(seen).toEqual(["/hosts/mini/es/api/attention/11111111-1111-4111-8111-111111111111?es=opencode"])
  } finally {
    await server.stop(true)
  }
})
