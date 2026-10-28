import { describe, expect, test } from "bun:test"
import { createScene } from "./scene"
import type { Delta, Snapshot } from "./adapter"
import type { Layout } from "./geometry"
import type { Painter } from "./paint"

// A painter that records nothing: the scene's energy accounting is what these tests observe.
const painter: Painter = { kind: "null", begin() {}, capsule() {}, ring() {}, dot() {}, flush() {}, count: () => 0, destroy() {} }
const layout = (ids: string[]): Layout => ({ compact: new Map(), icons: new Map(), scrollTop: 0, w: 800, h: 600, sign: 1, gx: 20, composerTop: 600, rects: new Map(ids.map((id, i) => [id, { x: 40, y: 40 + i * 40, w: 600, h: 30, cx: 340, cy: 55 + i * 40 }])) })
const snap = (phase: Snapshot["phase"]): Snapshot => ({ turns: [], phase, status: "busy", nodes: [{ id: "t1", anchor: "part", kind: "text", messageID: "a1", status: "running", length: 0 }], branches: [], errors: 0 })
const frame = (now: number) => ({ now, wall: 16, reduced: false, hidden: false })

describe("stream energy is chunk-invariant", () => {
  const run = (chunks: number[]) => {
    const scene = createScene(painter)
    const lay = layout(["t1"])
    let now = 1000
    // 1200 characters delivered over 1 second, in `chunks.length` deltas.
    const step = 1000 / chunks.length
    for (const grew of chunks) {
      scene.absorb([{ type: "text", id: "t1", kind: "text", grew } as Delta], lay, now)
      scene.render(snap("streaming"), lay, frame(now))
      now += step
    }
    return scene.activityNow()
  }
  test("3 big deltas and 300 tiny deltas of the same text give the same energy", () => {
    const coarse = run([400, 400, 400])
    const fine = run(Array.from({ length: 300 }, () => 4))
    expect(Math.abs(coarse - fine)).toBeLessThan(0.05)
    expect(coarse).toBeGreaterThan(0.5)
  })
  test("a quarter of the text rate reads as clearly less energy (saturation starts around 240 chars/s)", () => {
    const full = run([400, 400, 400])
    const quarter = run([100, 100, 100])
    expect(quarter).toBeLessThan(full)
    expect(quarter).toBeGreaterThan(0.1)
  })
})

describe("phases that are not this session's work stay calm", () => {
  test("delegated and disconnected do not keep the loop hot once energy settles", () => {
    for (const phase of ["delegated", "disconnected"] as const) {
      const scene = createScene(painter)
      const lay = layout(["t1"])
      let moving = true
      for (let i = 0; i < 400 && moving; i++) moving = scene.render(snap(phase), lay, frame(i * 16))
      expect(moving).toBe(false)
    }
  })
  test("thinking keeps the loop alive", () => {
    const scene = createScene(painter)
    const lay = layout(["t1"])
    let moving = false
    for (let i = 0; i < 60; i++) moving = scene.render(snap("thinking"), lay, frame(i * 16))
    expect(moving).toBe(true)
  })
})
