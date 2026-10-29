import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { createReleaseNotes, releaseNotesOf } from "./release-notes"
import { serve } from "./server"

const cleanup: (() => Promise<unknown> | unknown)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

const notes = (release: string, extra = {}) => ({
  schema: "release-notes/1" as const,
  release,
  items: [{ title: "Pins follow you across hosts", detail: "Pin on the Laptop, see it on the phone.", try: { label: "Open Work", href: "/?view=agents" } }],
  limits: ["Mini pins sync after its next update."],
  ...extra,
})

// One app install: its bundled files and its user data, as main.ts passes them.
const install = async (files: { notes?: unknown; release?: string }) => {
  const directory = await mkdtemp(path.join(tmpdir(), "es-release-notes-"))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  if (files.notes !== undefined) await writeFile(path.join(directory, "release-notes.json"), JSON.stringify(files.notes))
  if (files.release !== undefined) await writeFile(path.join(directory, "build-info.json"), JSON.stringify({ release: files.release }))
  const paths = { notes: path.join(directory, "release-notes.json"), buildInfo: path.join(directory, "build-info.json"), seen: path.join(directory, "release-notes-seen.json") }
  return { directory, paths, launch: () => createReleaseNotes(paths) }
}

test("a new release's notes are unseen; marking them seen survives a relaunch", async () => {
  const app = await install({ notes: notes("0.4.0+a09de30a"), release: "0.4.0+a09de30a" })
  const first = await app.launch()
  expect(first.read()).toEqual({ release: "0.4.0+a09de30a", notes: notes("0.4.0+a09de30a"), seen: false })
  expect(await first.markSeen("0.4.0+a09de30a")).toBe(true)
  expect((await app.launch()).read().seen).toBe(true)
})

test("the next release shows its notes again", async () => {
  const app = await install({ notes: notes("0.4.0+a09de30a"), release: "0.4.0+a09de30a" })
  await (await app.launch()).markSeen("0.4.0+a09de30a")
  await writeFile(app.paths.notes, JSON.stringify(notes("0.5.0+4765c2b6")))
  await writeFile(app.paths.buildInfo, JSON.stringify({ release: "0.5.0+4765c2b6" }))
  expect((await app.launch()).read()).toMatchObject({ release: "0.5.0+4765c2b6", seen: false })
})

test("another release cannot be marked seen", async () => {
  const app = await install({ notes: notes("0.5.0+4765c2b6"), release: "0.5.0+4765c2b6" })
  const store = await app.launch()
  expect(await store.markSeen("0.4.0+a09de30a")).toBe(false)
  expect((await app.launch()).read().seen).toBe(false)
})

test("notes written for another release, or a build that names no release, give no notes", async () => {
  expect((await (await install({ notes: notes("0.4.0+a09de30a"), release: "0.5.0+4765c2b6" })).launch()).read())
    .toEqual({ release: "0.5.0+4765c2b6", notes: null, seen: false })
  expect((await (await install({ notes: notes("0.4.0+a09de30a") })).launch()).read()).toEqual({ release: null, notes: null, seen: false })
  expect((await (await install({ release: "0.5.0+4765c2b6" })).launch()).read()).toEqual({ release: "0.5.0+4765c2b6", notes: null, seen: false })
})

test("notes outside release-notes/1 are no notes", () => {
  const nine = Array.from({ length: 9 }, (_, index) => ({ title: `Item ${index}` }))
  for (const value of [
    notes("x", { schema: "release-notes/2" }),
    notes("x", { items: nine }),
    notes("x", { limits: ["a", "b", "c", "d", "e", "f"] }),
    notes("x", { items: [{ title: "" }] }),
    notes("x", { items: [{ title: "t".repeat(121) }] }),
    notes("x", { items: [{ title: "Try", try: { label: "Go", href: "javascript:alert(1)" } }] }),
    notes("x", { items: [{ title: "Try", try: { label: "Go", href: "//evil.test/x" } }] }),
    notes("x", { items: [{ title: "Try", try: { label: "Go", href: "/oc/session" } }] }),
    notes("bad release!"),
  ]) expect(releaseNotesOf(value)).toBeUndefined()
  expect(releaseNotesOf(notes("x", { items: [{ title: "Docs", try: { label: "Read", href: "https://example.com/notes" } }] }))?.items[0]?.try?.href).toBe("https://example.com/notes")
})

test("the listener serves this release's notes to the app's own pages; only they mark them seen; paired clients never see them", async () => {
  const app = await install({ notes: notes("0.5.0+4765c2b6"), release: "0.5.0+4765c2b6" })
  const releaseNotes = await app.launch()
  await writeFile(path.join(app.directory, "index.html"), "<title>Fixture</title>")
  const server = await serve({ root: app.directory, releaseNotes })
  cleanup.push(() => Promise.race([server.close(), Bun.sleep(500)]))
  const call = (pathname: string, init: RequestInit = {}) => fetch(`${server.origin}${pathname}`, { ...init, headers: { "x-editspace-key": server.key, ...init.headers } })
  expect(await (await call("/__es/release-notes")).json()).toMatchObject({ release: "0.5.0+4765c2b6", seen: false })
  const mark = (release: string, origin = server.origin) => call("/__es/release-notes/seen", { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ release }) })
  expect((await mark("0.5.0+4765c2b6", "http://127.0.0.1:1")).status).toBe(403)
  expect((await mark("0.4.0+a09de30a")).status).toBe(409)
  expect((await mark("0.5.0+4765c2b6")).status).toBe(204)
  expect(await (await call("/__es/release-notes")).json()).toMatchObject({ seen: true })
  expect((await fetch(`${server.origin}/__es/release-notes`)).status).toBe(403)
  const paired = await serve({ root: app.directory, releaseNotes, pairing: { code: "ABCD-EFGH-JKLM" } })
  cleanup.push(() => Promise.race([paired.close(), Bun.sleep(500)]))
  expect((await fetch(`${paired.origin}/__es/release-notes`)).status).not.toBe(200)
})
