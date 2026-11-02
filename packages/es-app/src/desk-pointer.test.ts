import { expect, test } from "bun:test"
import { earlierDesks, homeOf, readPointer, resolveHome, sharedNotice, writePointer, type DeskHome, type PointerView } from "./desk-pointer"
import type { WorkHost } from "./host"

const mini: WorkHost = { id: "mini", label: "Mac Mini", origin: "https://mini.test" }
const pc: WorkHost = { id: "pc", label: "PC", origin: "https://pc.test" }
const desk = (home: boolean, session?: string): PointerView =>
  session ? { home, revision: 1, session, directory: "/Users/me/desk" } : { home, revision: 0, none: true }

/** Answers GET/PUT of the pointer per host prefix ("" = this host); records every request. */
const hosts = (views: Record<string, PointerView | number>) => {
  const calls: { method: string; url: string; body?: unknown }[] = []
  const fetcher = (async (url: string, init?: RequestInit) => {
    calls.push({ method: init?.method ?? "GET", url, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) })
    const prefix = url.replace("/es/api/frontdesk/pointer", "")
    const view = views[prefix]
    if (view === undefined) return new Response("not found", { status: 404 })
    return typeof view === "number" ? new Response("{}", { status: view }) : Response.json(view)
  }) as typeof fetch
  return { fetcher, calls }
}

test("this host is the home when it says so, whatever other hosts report", () => {
  expect(homeOf(desk(true, "ses_desk_aaaaaa"), [{ host: mini, view: desk(true, "ses_other00") }]).kind).toBe("local")
})

test("another Work host that reports itself home holds the desk, reached through /hosts/<id>/oc", () => {
  const home = homeOf(desk(false), [{ host: pc, view: undefined }, { host: mini, view: desk(true, "ses_desk_4b10150d6e9544589674") }])
  expect(home).toEqual({ kind: "remote", host: { id: "mini", label: "Mac Mini", base: "/hosts/mini/oc" }, view: desk(true, "ses_desk_4b10150d6e9544589674") })
})

test("no home anywhere leaves the feature off, so the device keeps its own desk", () => {
  expect(homeOf(undefined, [{ host: mini, view: undefined }])).toEqual({ kind: "off" })
})

test("a remote home used before that cannot be read now stays the home, read-only, never a second desk", () => {
  expect(homeOf(undefined, [{ host: mini, view: undefined }], "mini")).toEqual({ kind: "unreachable", host: { id: "mini", label: "Mac Mini", base: "/hosts/mini/oc" } })
})

test("reading goes through /hosts/<id>/ for other hosts and treats errors and odd bodies as unknown", async () => {
  const { fetcher, calls } = hosts({ "": 503, "/hosts/mini": desk(true, "ses_desk_aaaaaa") })
  expect(await readPointer("", fetcher)).toBeUndefined()
  expect((await readPointer("/hosts/mini", fetcher))?.session).toBe("ses_desk_aaaaaa")
  expect(calls.map(call => call.url)).toEqual(["/es/api/frontdesk/pointer", "/hosts/mini/es/api/frontdesk/pointer"])
})

test("resolving a remote home never writes anything", async () => {
  const { fetcher, calls } = hosts({ "": desk(false), "/hosts/mini": desk(true, "ses_desk_aaaaaa") })
  expect((await resolveHome([mini], fetcher)).kind).toBe("remote")
  expect(calls.every(call => call.method === "GET")).toBe(true)
})

test("a lost create race returns the pointer that won", async () => {
  const fetcher = (async () => Response.json(desk(true, "ses_winner00"), { status: 409 })) as unknown as typeof fetch
  expect(await writePointer({ expected_revision: 0, session: "ses_loser000", directory: "/d", reason: "create" }, fetcher))
    .toEqual({ ok: false, view: desk(true, "ses_winner00") })
})

test("writes go to this host only, with CSRF, and report a refusal's reason", async () => {
  const calls: { url: string; init?: RequestInit }[] = []
  const fetcher = (async (url: string, init?: RequestInit) => { calls.push({ url, init }); return Response.json({ error: "not the home" }, { status: 409 }) }) as unknown as typeof fetch
  await writePointer({ expected_revision: 0, session: "ses_desk_aaaaaa", directory: "/d", reason: "import" }, fetcher)
  expect(calls[0]!.url).toBe("/es/api/frontdesk/pointer")
  expect(calls[0]!.init?.method).toBe("PUT")
  expect((calls[0]!.init?.headers as Record<string, string>)["X-Attention-CSRF"]).toBe("1")
  const refused = (async () => Response.json({ error: "only the operator UI" }, { status: 403 })) as unknown as typeof fetch
  expect(await writePointer({ expected_revision: 0, session: "ses_desk_aaaaaa", directory: "/d", reason: "create" }, refused)).toEqual({ ok: false, error: "only the operator UI" })
})

const local = (view: PointerView): DeskHome => ({ kind: "local", view })
const remoteHome = (view: PointerView): DeskHome => ({ kind: "remote", host: { id: "mini", label: "Mac Mini", base: "/hosts/mini/oc" }, view })

test("earlier desks: this device's own, then the home's replaced desks newest first, never the current one", () => {
  const view: PointerView = { home: true, revision: 3, session: "ses_desk_current", directory: "/d",
    predecessors: [{ session: "ses_desk_first01", directory: "/d", until: 1 }, { session: "ses_desk_second1", directory: "/d", until: 2 }] }
  const list = earlierDesks(remoteHome(view), "ses_desk_current", [{ session: "ses_mylaptopdesk", directory: "/l" }, { session: "ses_desk_current", directory: "/d" }])
  expect(list.map(entry => [entry.session, entry.from, entry.host?.id])).toEqual([
    ["ses_mylaptopdesk", "device", undefined], ["ses_desk_second1", "home", "mini"], ["ses_desk_first01", "home", "mini"]])
})

test("the same earlier desk known to both the device and the home is listed once", () => {
  const view: PointerView = { home: true, revision: 2, session: "ses_desk_current", directory: "/d", predecessors: [{ session: "ses_mylaptopdesk", directory: "/l", until: 1 }] }
  expect(earlierDesks(local(view), "ses_desk_current", [{ session: "ses_mylaptopdesk", directory: "/l" }]).length).toBe(1)
})

test("the shared-desk line shows once per shared desk, only where this device had its own desk", () => {
  const view: PointerView = { home: true, revision: 1, session: "ses_desk_current", directory: "/d" }
  const mine = earlierDesks(local(view), "ses_desk_current", [{ session: "ses_mylaptopdesk", directory: "/l" }])
  expect(sharedNotice(local(view), "ses_desk_current", mine, undefined)).toBe(true)
  expect(sharedNotice(local(view), "ses_desk_current", mine, "ses_desk_current")).toBe(false)
  expect(sharedNotice(local(view), "ses_desk_current", [], undefined)).toBe(false)
  expect(sharedNotice({ kind: "off" }, "ses_desk_current", mine, undefined)).toBe(false)
})
