import { expect, test } from "bun:test"
import type { AttentionRecord } from "./attention"
import type { Surface } from "./surfaces"
import { entityView, mentionRef, parseEntityHref, type EntityStores } from "./entity-ref"

const surface = { id: "decision-briefs", title: "Decision briefs", summary: "21 cases", kind: "path", owner: "desktop-delivery", lane: "ux-feel", editspace: "opencode",
  updated_at: Date.UTC(2026, 10, 3, 15), revision: 3, health: { state: "ok" } } as unknown as Surface
const decision = { id: "dec_1", editspace: "opencode", title: "Annotations prototype", status: "answered", options: [{ id: "dev", label: "Develop" }],
  answer: { id: "a", text: "", choice_id: "dev", answered_at: 1 }, updated_at: 5, context: "develop, revise or park?", lane: "relay" } as unknown as AttentionRecord
const stores: EntityStores = { here: "laptop:4000", surfaces: [surface], decisions: [decision], lanes: [{ editspace: "opencode", lane: "es-app-mini", activity: "Shell run-tests.sh" }],
  personas: [{ name: "Ferry", owner_lane: "opencode/es-app-mini", avatar_url: "https://example.com/ferry.png" }, { name: "Gaming", owner_lane: "mini:dotfiles/gaming-pc-setup" }], hostLabel: (id) => id === "mini" ? "Mac Mini" : undefined }

test("links to Surfaces and decisions parse to refs; other paths are not refs", () => {
  expect(parseEntityHref("/?surface=decision-briefs&rev=2#g3", stores.here)).toEqual({ kind: "surface", id: "decision-briefs", host: stores.here, revision: 2, section: "g3" })
  expect(parseEntityHref("/hosts/mini/__es/surface/visuals", stores.here)).toMatchObject({ kind: "surface", id: "visuals", host: "mini" })
  expect(parseEntityHref("/?item=mini~attention:opencode:dec_9", stores.here)).toEqual({ kind: "decision", id: "dec_9", editspace: "opencode", host: "mini" })
  expect(parseEntityHref("https://github.com/x/y/pull/1", stores.here)).toBeUndefined()
})

test("a Surface ref shows the current title, and says when it changed since mentioned, is elsewhere or missing", () => {
  expect(entityView({ kind: "surface", id: "decision-briefs", host: stores.here }, stores)).toMatchObject({ title: "Decision briefs", state: "ok" })
  expect(entityView({ kind: "surface", id: "decision-briefs", host: stores.here, revision: 2 }, stores)).toMatchObject({ state: "stale", label: expect.stringContaining("was rev 2") })
  expect(entityView({ kind: "surface", id: "visuals", host: "mini", label: "Visuals" }, stores)).toMatchObject({ state: "elsewhere", host: "Mac Mini", title: "Visuals" })
  expect(entityView({ kind: "surface", id: "old-board", host: stores.here }, stores)).toMatchObject({ state: "missing", label: "Surface: old-board, not found on this host" })
})

test("a decision ref shows its current state and answer; never more", () => {
  expect(entityView({ kind: "decision", id: "dec_1", editspace: "opencode", host: stores.here }, stores))
    .toMatchObject({ title: "Annotations prototype", decision: { status: "answered", answer: "Develop" }, label: "Decision: Annotations prototype, answered: Develop" })
})

test("@mentions resolve only to known lanes or registered personas; unknown names stay text", () => {
  expect(mentionRef("Ferry", stores)).toMatchObject({ kind: "agent", id: "es-app-mini", host: stores.here, label: "Ferry" })
  expect(mentionRef("es-app-mini", stores)).toMatchObject({ kind: "agent", id: "es-app-mini" })
  expect(mentionRef("Gaming", stores)).toMatchObject({ host: "mini", id: "gaming-pc-setup" })
  expect(mentionRef("somebody", stores)).toBeUndefined()
  const ferry = entityView(mentionRef("Ferry", stores)!, stores)
  expect(ferry).toMatchObject({ title: "Ferry", avatar: { url: "https://example.com/ferry.png", initials: "F" } })
  expect(ferry.rows.map(([name]) => name)).not.toContain("Mentioned")
})

test("a query-only link is root-relative, and item=<host>~surface:<id> is a Surface on that host (DD #1222)", () => {
  expect(parseEntityHref("?item=mini~surface%3Adiff-stream-catchup-20261103", stores.here)).toEqual({ kind: "surface", id: "diff-stream-catchup-20261103", host: "mini" })
  expect(parseEntityHref("/?item=surface:decision-briefs", stores.here)).toEqual({ kind: "surface", id: "decision-briefs", host: stores.here })
  expect(parseEntityHref("?item=attention:opencode:dec_1", stores.here)).toEqual({ kind: "decision", id: "dec_1", editspace: "opencode", host: stores.here })
})
