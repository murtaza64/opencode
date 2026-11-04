import { afterAll, describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import path from "node:path"
import { createRoot } from "solid-js"
import { needsYou, needsYouFromInputs, type NeedsYouInputs } from "./needs-you"
import { createSurfaces, deliverables, renewDelay, tryLine, type Surface, buildinghubLink } from "./surfaces"

const surface = (id: string, extra: Partial<Surface>): Surface => ({
  id, title: id, summary: null, kind: "path", owner: "Relay", lane: "orchestrator", editspace: "opencode",
  updated_at: 1, revision: 1, health: { state: "ok" }, ...extra,
})

test("new deliverables lead newest first; Done ones and boards stay out of the new list", () => {
  const list = [
    surface("board", { purpose: "board" }),
    surface("old-report", { purpose: "deliverable", created_at: 10, seen: false }),
    surface("week-review", { purpose: "deliverable", created_at: 30, seen: false }),
    surface("read-report", { purpose: "deliverable", created_at: 20, seen: true }),
  ]
  const split = deliverables(list, new Map())
  expect(split.fresh.map(item => item.id)).toEqual(["week-review", "old-report"])
  expect(split.earlier.map(item => item.id)).toEqual(["read-report"])
})

test("a Done in flight for one revision hides only that revision; an Undo in flight shows it again", () => {
  expect(deliverables([surface("week-review", { purpose: "deliverable", seen: false })], new Map([["week-review:1", true]])).fresh).toEqual([])
  expect(deliverables([surface("week-review", { purpose: "deliverable", seen: false, revision: 2 })], new Map([["week-review:1", true]])).fresh.map(item => item.id)).toEqual(["week-review"])
  expect(deliverables([surface("week-review", { purpose: "deliverable", seen: true })], new Map([["week-review:1", false]])).fresh.map(item => item.id)).toEqual(["week-review"])
})

test("surfaces from a dashboard without purposes are boards and never reach Needs you", () => {
  expect(deliverables([surface("relay-board", {})], new Map())).toEqual({ fresh: [], earlier: [] })
  expect(deliverables([surface("relay-board", { purpose: "board", seen: false })], new Map())).toEqual({ fresh: [], earlier: [] })
})

test("the Needs-you line is deterministic: Try, title, maintainer, revision, then any health problem", () => {
  expect(tryLine(surface("r", { title: "API tests", owner: "api-lead", revision: 3, purpose: "deliverable" }))).toBe("Try · API tests · api-lead · rev 3")
  expect(tryLine(surface("r", { title: "API tests", owner: "api-lead", revision: 3, purpose: "deliverable", health: { state: "error", detail: "index.html missing" } })))
    .toBe("Try · API tests · api-lead · rev 3 · index.html missing")
})

test("frame addresses are renewed a few minutes before they expire, never in a tight loop", () => {
  expect(renewDelay(undefined, 0)).toBeUndefined()
  expect(renewDelay(3600_000, 0)).toBe(55 * 60_000)
  expect(renewDelay(60_000, 0)).toBe(30_000)
})

const DOTFILES_BIN = process.env.DOTFILES_BIN ?? path.join(homedir(), "dotfiles/bin")
const hasStore = existsSync(path.join(DOTFILES_BIN, "es_dashboard_surfaces.py"))
// A stale Undo needs the store that applies an Undo only at or above the Done revision (dotfiles Desk2814 N1).
const hasRevisionUndo = hasStore && readFileSync(path.join(DOTFILES_BIN, "es_dashboard_surfaces.py"), "utf8").includes("revision >= current")
const cleanup: (() => Promise<unknown>)[] = []
afterAll(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

// One host running the real dashboard Surface store behind the real attention guard, in its own temporary HOME.
const storeHost = async () => {
  const home = await mkdtemp(path.join(tmpdir(), "es-surfaces-host-"))
  const child = Bun.spawn(["uv", "run", "--script", path.join(import.meta.dir, "fixtures/surfaces-host.py")], {
    env: { ...process.env, HOME: home, DOTFILES_BIN, UV_CACHE_DIR: process.env.UV_CACHE_DIR ?? path.join(homedir(), ".cache/uv") },
    stdout: "pipe",
    stderr: "inherit",
  })
  cleanup.push(async () => {
    child.kill()
    await child.exited
    await rm(home, { recursive: true, force: true })
  })
  const reader = child.stdout.getReader()
  const port = new TextDecoder().decode((await reader.read()).value).trim()
  reader.releaseLock()
  const origin = `http://127.0.0.1:${port}`
  for (let wait = 50; ; wait *= 2) {
    if (await fetch(`${origin}/api/surfaces`).then((response) => response.status < 500, () => false)) break
    await Bun.sleep(wait)
  }
  const publish = async (id: string, summary: string) =>
    (await (await fetch(`${origin}/__fixture/publish`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id, title: `Report ${id}`, summary }) })).json()) as { revision: number }
  return { origin, publish }
}

// A browser tab of that host through its listener: its own origin and cookie jar. `operator` signs it in the way the
// desk does (attention session), so its writes carry the operator cookie.
const tab = async (origin: string, operator = true) => {
  const jar = new Map<string, string>()
  const send = async (input: string, init?: RequestInit) => {
    const headers = new Headers(init?.headers)
    headers.set("origin", origin)
    if (jar.size) headers.set("cookie", [...jar].map(([name, value]) => `${name}=${value}`).join("; "))
    const response = await fetch(String(input).replace(/^\/es\/api\//, `${origin}/api/`), { ...init, headers })
    for (const cookie of response.headers.getSetCookie()) {
      const [name, value] = cookie.split(";")[0]!.split("=")
      jar.set(name!, value!)
    }
    return response
  }
  if (operator) await send("/es/api/attention/session", { method: "POST", headers: { "content-type": "application/json", "X-Attention-CSRF": "1" }, body: "{}" })
  return send
}

// The desk's Surface client over one tab, read once.
const page = async (send: Awaited<ReturnType<typeof tab>>) => {
  const surfaces = createRoot(() => createSurfaces({ fetch: send, poll: false }))
  await surfaces.refresh()
  return surfaces
}
const freshIds = (surfaces: Awaited<ReturnType<typeof page>>) => surfaces.deliverables().fresh.map((item) => item.id)

describe.skipIf(!hasStore)("requested deliverables against the real host store", () => {
  test("reading a new deliverable leaves it in Needs you; Done clears it and holds on another page of that host", async () => {
    const host = await storeHost()
    await host.publish("report", "first")
    const desk = await page(await tab(host.origin))
    expect(freshIds(desk)).toEqual(["report"])
    // Reading the list again (what opening does) changes nothing.
    await desk.refresh()
    expect(freshIds(desk)).toEqual(["report"])
    const current = desk.list()[0]!
    expect(await desk.markSeen(current, current.revision)).toBe(true)
    expect(freshIds(desk)).toEqual([])
    expect(desk.list()[0]).toMatchObject({ seen: true, seen_at: expect.any(Number) })
    const phone = await page(await tab(host.origin))
    expect(freshIds(phone)).toEqual([])
  }, 60_000)

  test("a new revision brings a Done deliverable back once; an exact-retry publish does not", async () => {
    const host = await storeHost()
    expect(await host.publish("report", "first")).toEqual({ revision: 1 })
    const desk = await page(await tab(host.origin))
    await desk.markSeen(desk.list()[0]!, 1)
    expect(await host.publish("report", "first")).toEqual({ revision: 1 })
    await desk.refresh()
    expect(freshIds(desk)).toEqual([])
    expect(await host.publish("report", "second")).toEqual({ revision: 2 })
    await desk.refresh()
    expect(freshIds(desk)).toEqual(["report"])
    await desk.markSeen(desk.list()[0]!, 2)
    expect(await host.publish("report", "second")).toEqual({ revision: 2 })
    await desk.refresh()
    expect(freshIds(desk)).toEqual([])
  }, 60_000)

  test("Done on the revision on screen while a newer one exists keeps the newer one in Needs you", async () => {
    const host = await storeHost()
    await host.publish("report", "first")
    const desk = await page(await tab(host.origin))
    const onScreen = desk.list()[0]!
    await host.publish("report", "second")
    expect(await desk.markSeen(onScreen, onScreen.revision)).toBe(true)
    expect(desk.list()[0]).toMatchObject({ revision: 2, seen: false })
    expect(freshIds(desk)).toEqual(["report"])
  }, 60_000)

  test("Undo makes a Done deliverable new again", async () => {
    const host = await storeHost()
    await host.publish("report", "first")
    const desk = await page(await tab(host.origin))
    await desk.markSeen(desk.list()[0]!, 1)
    expect(await desk.markSeen(desk.list()[0]!, 1, false)).toBe(true)
    expect(freshIds(desk)).toEqual(["report"])
  }, 60_000)

  test.skipIf(!hasRevisionUndo)("an Undo from a device still showing an older revision never clears a newer Done", async () => {
    const host = await storeHost()
    await host.publish("report", "first")
    const phone = await page(await tab(host.origin))
    const stale = phone.list()[0]!
    await host.publish("report", "second")
    const desk = await page(await tab(host.origin))
    await desk.markSeen(desk.list()[0]!, 2)
    expect(await phone.markSeen(stale, 1, false)).toBe(true)
    await desk.refresh()
    expect(freshIds(desk)).toEqual([])
  }, 60_000)

  test("without the operator connection a seen mark is not saved: it stays new and says why", async () => {
    const host = await storeHost()
    await host.publish("report", "first")
    const desk = await page(await tab(host.origin, false))
    expect(await desk.markSeen(desk.list()[0]!, 1)).toBe(false)
    expect(freshIds(desk)).toEqual(["report"])
    expect(desk.seenError()).toBe("Seen is not saved: the operator connection is unavailable.")
  }, 60_000)

  test("Done reaches only the host whose page marked it", async () => {
    const [laptop, mini] = await Promise.all([storeHost(), storeHost()])
    await laptop.publish("report", "first")
    await mini.publish("report", "first")
    const laptopDesk = await page(await tab(laptop.origin))
    const miniDesk = await page(await tab(mini.origin))
    await laptopDesk.markSeen(laptopDesk.list()[0]!, 1)
    await miniDesk.refresh()
    expect([freshIds(laptopDesk), freshIds(miniDesk)]).toEqual([[], ["report"]])
  }, 60_000)

  test("the Dock's count from needs-you inputs matches the sidebar's for the same deliverables", async () => {
    const host = await storeHost()
    await host.publish("report", "first")
    await host.publish("seen-report", "first")
    const desk = await page(await tab(host.origin))
    await desk.markSeen(desk.list().find((item) => item.id === "seen-report")!, 1)
    const source = { checked_at: 1, ok: true }
    const body: NeedsYouInputs = {
      records: [], projects: [], partial: false, limit: 50,
      inputs: { schema: "needs-you-inputs/1", boot: "b", rev: 1, requests: [], failures: [], ignores: [], deliverables: desk.list(),
        sources: { requests: source, failures: source, ignores: source, deliverables: source } },
    }
    const sidebar = needsYou({ items: [], feeds: [], fresh: desk.deliverables().fresh })
    expect(needsYouFromInputs(body, [])!.label).toEqual(sidebar.label)
    expect(sidebar.label.text).toBe("1")
  }, 60_000)
})

test("a Surface links to its deployed BuildingHub version, says whether it is this revision, and shows nothing without a deploy", () => {
  const url = "https://diff-stream.buildinghub.duolingo.com/#/s/diff-stream"
  expect(buildinghubLink({ buildinghub: { state: "deployed", url, version: "v3", current: true } })).toEqual({ url, version: "v3", current: true, copy: null, from: undefined, unverified: false })
  // A redeploy building or failed keeps linking to the last deploy; that version is older than this revision.
  expect(buildinghubLink({ buildinghub: { state: "building", version: "v4", current: false, last_deployed: { url, version: "v3" } } })).toEqual({ url, version: "v3", current: false, copy: null, from: undefined, unverified: false })
  expect(buildinghubLink({ buildinghub: { state: "deployed", url, version: "v3", current: null } })?.current).toBeNull()
  // Nothing deployed yet, no receipt, or a link that is not a BuildingHub https page: no link.
  expect(buildinghubLink({ buildinghub: { state: "failed", version: "v1" } })).toBeUndefined()
  expect(buildinghubLink({})).toBeUndefined()
  for (const bad of ["http://diff-stream.buildinghub.duolingo.com/", "https://evil.example/#/s/x", "https://u:p@x.buildinghub.duolingo.com/"])
    expect(buildinghubLink({ buildinghub: { state: "deployed", url: bad, current: true } })).toBeUndefined()
})

test("the reader's BuildingHub share links only a copy built from this revision", async () => {
  const { buildinghubShare } = await import("./surfaces")
  const url = "https://diff-stream.buildinghub.duolingo.com/#/s/show"
  expect(buildinghubShare({ revision: 3, buildinghub: { state: "deployed", url, version: "v4", copy: "current", source_revision: 3 } }))
    .toEqual({ state: "current", text: "On BuildingHub: v4 from r3", url })
  expect(buildinghubShare({ revision: 3, buildinghub: { state: "deployed", url, version: "v4", copy: "older", source_revision: 2 } }))
    .toEqual({ state: "older", text: "BuildingHub copy v4 is from r2 (older than r3)" })
  expect(buildinghubShare({ revision: 3, buildinghub: { state: "deployed", url, version: "v4", copy: "different" } }))
    .toEqual({ state: "different", text: "BuildingHub has a different copy v4" })
  // A host without lineage: bundle comparison only.
  expect(buildinghubShare({ revision: 3, buildinghub: { state: "deployed", url, version: "v4", current: true } })).toEqual({ state: "current", text: "On BuildingHub: v4", url })
  // A path Surface's copy: from r3, bytes unverified, still linked.
  expect(buildinghubShare({ revision: 3, buildinghub: { state: "deployed", url, version: "v1", copy: "current", source_verified: false, source_revision: 3 } }))
    .toEqual({ state: "current", text: "On BuildingHub: v1 from r3 (bundle not verified)", url })
  expect(buildinghubShare({ revision: 3 })).toEqual({ state: "none", text: "Not on BuildingHub" })
  expect(buildinghubShare({ revision: 3, buildinghub: { state: "failed", version: "v1" } })).toEqual({ state: "none", text: "Not on BuildingHub" })
})
