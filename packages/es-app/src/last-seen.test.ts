import { afterEach, beforeEach, expect, test } from "bun:test"
import { forgetSeen, loadSeen, saveSeen } from "./last-seen"

// One browser profile's localStorage, fresh per test.
const items = new Map<string, string>()
const storage = {
  getItem: (key: string) => items.get(key) ?? null,
  setItem: (key: string, value: string) => void items.set(key, value),
  removeItem: (key: string) => void items.delete(key),
}
const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage")
beforeEach(() => {
  items.clear()
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: new Proxy(storage, { ownKeys: () => [...items.keys()], getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true }) }) })
})
afterEach(() => {
  if (original) Object.defineProperty(globalThis, "localStorage", original)
})

const row = (id: string, updated: number) => ({ id, title: `${id} title`, directory: "/repo", updated, live: "busy", project: "x", host: "mini" })

test("keeps only id, title, directory and update time, newest first, at most 200 rows", () => {
  saveSeen("mini", [row("ses_old", 1), row("ses_new", 2), ...Array.from({ length: 250 }, (_, i) => row(`ses_${i}`, 0))], "opencode", 5)
  const seen = loadSeen("mini", "opencode")!
  expect(seen.cachedAt).toBe(5)
  expect(seen.rows.length).toBe(200)
  expect(seen.rows[0]).toEqual({ id: "ses_new", title: "ses_new title", directory: "/repo", updated: 2 })
})

test("rows are used only for the project they were listed for", () => {
  saveSeen("mini", [row("ses_a", 1)], "opencode", 5)
  expect(loadSeen("mini", "opencode")?.rows.map((item) => item.id)).toEqual(["ses_a"])
  expect(loadSeen("mini", "other")).toBeUndefined()
  expect(loadSeen("mini", undefined)).toBeUndefined()
})

test("this host and each other host keep separate rows", () => {
  saveSeen("local", [row("ses_l", 1)], undefined, 5)
  saveSeen("mini", [row("ses_m", 1)], undefined, 6)
  expect(loadSeen("local", undefined)?.rows[0]?.id).toBe("ses_l")
  expect(loadSeen("mini", undefined)?.rows[0]?.id).toBe("ses_m")
})

test("a host removed from the Work view leaves no rows behind; this host's stay", () => {
  saveSeen("local", [row("ses_l", 1)], undefined, 5)
  saveSeen("mini", [row("ses_m", 1)], undefined, 5)
  saveSeen("wing", [row("ses_w", 1)], undefined, 5)
  forgetSeen(["local", "mini"])
  expect(loadSeen("wing", undefined)).toBeUndefined()
  expect(loadSeen("mini", undefined)).toBeDefined()
  expect(loadSeen("local", undefined)).toBeDefined()
})

test("unreadable stored rows are ignored, never shown", () => {
  items.set("host:mini:es-app-work-rows", "{not json")
  expect(loadSeen("mini", undefined)).toBeUndefined()
  items.set("host:mini:es-app-work-rows", JSON.stringify({ rows: [{ id: 1 }], cachedAt: 3 }))
  expect(loadSeen("mini", undefined)?.rows).toEqual([])
})
