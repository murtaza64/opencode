import { describe, expect, test } from "bun:test"
import { esSurfaceHost, mintCommentId, placement, pointMark, pointOf, receiptLabel, threads, type SurfaceComment } from "./surface-comments"

const comment = (id: string, at: number, extra: Partial<SurfaceComment> = {}): SurfaceComment => ({
  comment_id: id, surface_id: "board", revision: 2, anchor: { id: "sec/intro" }, author: { role: "operator", name: "Murtaza" }, body: id, created_at: at, parent_id: null, state: "open", ...extra,
})

// A stand-in for the dashboard at the network boundary, answering in the es-surface-comments/1 shape.
const store = () => {
  const calls: { path: string; method: string; body?: string }[] = []
  const saved = new Map<string, string>()
  let operator = false
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
  const fetch = (async (input: string, init?: RequestInit) => {
    const path = String(input)
    calls.push({ path, method: init?.method ?? "GET", body: init?.body as string | undefined })
    if (path.endsWith("/attention/session")) { operator = true; return json({ ok: true }) }
    if (init?.method !== "POST") return json({ schema: "es-surface-comments/1", surface_id: "board", comments: [comment("b", 2), comment("a", 1)] })
    if (!operator) return json({ error: "operator required" }, 401)
    const body = JSON.parse(init.body as string)
    const prior = saved.get(body.comment_id)
    if (prior !== undefined && prior !== init.body) return json({ error: "comment id conflict" }, 409)
    saved.set(body.comment_id, init.body as string)
    return json({ schema: "es-surface-comments/1", comment: { ...comment(body.comment_id, 3), body: body.body }, receipt: { state: "stored", duplicate: prior !== undefined } })
  })
  return { fetch, calls }
}

describe("surface comments", () => {
  test("a reply nests under its root, and a reply whose parent is missing stands as its own root", () => {
    const list = threads([comment("r2", 3, { parent_id: "root" }), comment("root", 1), comment("r1", 2, { parent_id: "root" }), comment("lost", 4, { parent_id: "gone" })])

    expect(list.map((thread) => [thread.root.comment_id, thread.replies.map((reply) => reply.comment_id)])).toEqual([["root", ["r1", "r2"]], ["lost", []]])
  })

  test("a comment from another revision gets no marker on the revision on screen", () => {
    expect(placement(comment("a", 1, { revision: 1 }), 2, "shown")).toBe("other-revision")
    expect(placement(comment("a", 1), 2, "missing")).toBe("missing")
    expect(placement(comment("a", 1), 2, undefined)).toBe("locating")
  })

  test("the receipt says stored or routed, never read", () => {
    expect(receiptLabel(comment("a", 1))).toBe("Saved · goes to the owner within ~2 min")
    expect(receiptLabel(comment("a", 1, { routing: { state: "routed", to: "opencode/ux-feel" } }))).toBe("Saved · sent to opencode/ux-feel · not a read receipt")
  })

  test("minted ids fit the store's id rule", () => {
    expect(mintCommentId()).toMatch(/^[A-Za-z0-9_-]{8,64}$/)
  })

  test("sending sets up the operator session once, then the identical retry is a duplicate", async () => {
    const dashboard = store()
    const host = esSurfaceHost("board", "/hosts/mini", dashboard.fetch)
    const sealed = { comment_id: "c0ffee0001", revision: 2, anchor: { id: "sec/intro" }, body: "Tighten this" }

    const first = await host.send(sealed)
    const retry = await host.send(sealed)

    expect(first).toMatchObject({ ok: true, duplicate: false, comment: { comment_id: "c0ffee0001", body: "Tighten this" } })
    expect(retry).toMatchObject({ ok: true, duplicate: true })
    expect(dashboard.calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      "POST /hosts/mini/es/api/surfaces/board/comments",
      "POST /hosts/mini/es/api/attention/session",
      "POST /hosts/mini/es/api/surfaces/board/comments",
      "POST /hosts/mini/es/api/surfaces/board/comments",
    ])
  })

  test("the same id with different text is refused and reported as not sent", async () => {
    const dashboard = store()
    const host = esSurfaceHost("board", "", dashboard.fetch)
    await host.send({ comment_id: "c0ffee0002", revision: 2, anchor: { id: "x" }, body: "one" })

    expect(await host.send({ comment_id: "c0ffee0002", revision: 2, anchor: { id: "x" }, body: "two" })).toEqual({ ok: false, error: "Not sent: this comment id was already used for different text." })
  })

  test("a host without the comments route reads as unavailable, not as an empty list", async () => {
    const host = esSurfaceHost("board", "", (async () => new Response("<!doctype html>", { status: 200, headers: { "content-type": "text/html" } })) )

    expect(await host.read()).toEqual({ unavailable: "This host does not store comments yet." })
  })
})

describe("point comments", () => {
  test("a point is one anchor-frame pin on its element anchor, and reads back", () => {
    const mark = pointMark({ id: "costs", selector: "#costs" }, { x: 0.82, y: 0.75 })
    expect(mark).toEqual({ frame: "anchor", ref: "costs", state: "", s: "", shapes: [{ tool: "pin", pts: [0.82, 0.75] }] })
    expect(pointOf({ mark })).toEqual({ x: 0.82, y: 0.75 })
  })

  test("drawings, doc-frame marks and out-of-box pins are not points", () => {
    expect(pointOf({})).toBeUndefined()
    expect(pointOf({ mark: { frame: "doc", ref: "", state: "", s: "", shapes: [{ tool: "pin", pts: [1, 2] }] } })).toBeUndefined()
    expect(pointOf({ mark: { frame: "anchor", ref: "a", state: "", s: "", shapes: [{ tool: "arrow", pts: [0, 0, 1, 1] }] } })).toBeUndefined()
    expect(pointOf({ mark: { frame: "anchor", ref: "a", state: "", s: "", shapes: [{ tool: "pin", pts: [1.5, 0.2] }] } })).toBeUndefined()
  })
})
