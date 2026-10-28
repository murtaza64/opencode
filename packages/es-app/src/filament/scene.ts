/* The filament: a thread down the transcript gutter with one node per real item. Everything
 * that moves is explained by a snapshot delta (text growth, tool end, ask open) or by a phase
 * the snapshot is in (thinking wave, running arc, waiting ring, retry fracture). Nothing here
 * reads the store or the DOM; it receives a snapshot, deltas and measured rects. */
import type { Delta, Node, Phase, Snapshot } from "./adapter"
import type { Layout, Rect } from "./geometry"
import type { Painter, RGBA } from "./paint"

const ACCENT = [0.29, 0.62, 1.0] as const
const YELLOW = [0.96, 0.85, 0.42] as const
const RED = [1.0, 0.42, 0.42] as const
const GREEN = [0.55, 0.9, 0.6] as const
const BRANCH = [0.7, 0.55, 0.95] as const
const rgba = (c: readonly [number, number, number], a: number): RGBA => [c[0], c[1], c[2], a]
const ease = (x: number) => 1 - Math.pow(1 - Math.min(1, Math.max(0, x)), 3)
const clamp01 = (x: number) => Math.min(1, Math.max(0, x))

type Pulse = { born: number; from: number; to: number; x: number; kind: "text" | "reasoning" | "jet" }
type Flash = { born: number; x: number; y: number; status: "done" | "error" }

export type Frame = { now: number; wall: number; reduced: boolean; hidden: boolean }

export const createScene = (paint: Painter) => {
  const pulses: Pulse[] = []
  const flashes: Flash[] = []
  let energy = 0
  let clock = 0
  let lastJet = 0

  // Feeds one update's deltas into transients. Geometry decides where each lands.
  const absorb = (deltas: readonly Delta[], layout: Layout, now: number) => {
    for (const d of deltas) {
      if (d.type === "text") {
        const r = layout.rects.get(d.id)
        if (!r) continue
        // One packet per update, sized by how much arrived; bursts stay one packet, not a storm.
        pulses.push({ born: now, from: Math.max(0, r.y - 120), to: r.y + r.h - 6, x: layout.gx, kind: d.kind })
        if (pulses.length > 24) pulses.shift()
      } else if (d.type === "tool.end") {
        const r = layout.rects.get(d.id)
        if (r) flashes.push({ born: now, x: layout.gx, y: r.cy, status: d.status })
      }
    }
  }

  const render = (s: Snapshot, layout: Layout, f: Frame) => {
    const gx = layout.gx
    const top = 0, bottom = layout.h
    const active = s.phase !== "idle" && s.phase !== "complete"
    const target = active ? 1 : s.phase === "complete" ? 0.25 : 0.12
    energy += (target - energy) * clamp01(f.wall / 400)
    clock += f.wall

    paint.begin(layout.w, layout.h, 1)
    const live = s.nodes.filter((n) => layout.rects.has(n.id))
    if (!live.length) { paint.flush(); return false }
    const first = layout.rects.get(live[0]!.id)!
    const lastNode = live[live.length - 1]!
    const lastR = layout.rects.get(lastNode.id)!
    const headY = s.waiting ? Math.min(bottom - 14, lastR.y + lastR.h + 18) : layout.thinking ? layout.thinking.cy : lastR.y + lastR.h - 4
    // Quieter than the standalone prototype: this sits a few px from body text.
    const col = rgba(ACCENT, 0.22 + energy * 0.38)
    const width = 1.1 + energy * 0.4
    const glow = 0.8 + energy * 1.8

    // ---- main thread ----
    const segs: number[][] = []
    let y = Math.max(first.y, top - 10)
    const endY = Math.min(headY, bottom + 10)
    const thinking = live.find((n) => n.kind === "reasoning" && n.status === "running")
    if (thinking && !f.reduced) {
      const tr = layout.rects.get(thinking.id)!
      const y0 = Math.max(y, tr.y), y1 = Math.min(endY, tr.y + tr.h)
      if (y0 > y) segs.push([gx, y, gx, y0])
      const steps = Math.max(2, Math.floor((y1 - y0) / 8))
      for (let i = 0; i < steps; i++) {
        const ya = y0 + ((y1 - y0) * i) / steps, yb = y0 + ((y1 - y0) * (i + 1)) / steps
        segs.push([gx + Math.sin(ya * 0.09 - clock * 0.006) * 2.4, ya, gx + Math.sin(yb * 0.09 - clock * 0.006) * 2.4, yb])
      }
      y = Math.max(y, y1)
    }
    if (s.phase === "error" && !f.reduced) {
      const y0 = Math.max(y, endY - 80)
      if (y0 > y) segs.push([gx, y, gx, y0])
      for (let yy = y0; yy < endY - 8; yy += 10) {
        const jx = Math.round(Math.sin(yy * 1.7) * 4)
        paint.capsule(gx + jx, yy, gx - jx, yy + 7, 1.4, rgba(RED, 0.85), 3)
      }
      y = endY
    }
    if (y < endY) {
      if (s.waiting) {
        const y0 = Math.max(y, lastR.y + lastR.h - 4)
        if (y0 > y) segs.push([gx, y, gx, y0])
        for (let yy = y0; yy < endY - 12; yy += 12) paint.capsule(gx, yy, gx, yy + 6, 1.2, rgba(YELLOW, 0.7), 2)
      } else segs.push([gx, y, gx, endY])
    }
    for (const sg of segs) paint.capsule(sg[0]!, sg[1]!, sg[2]!, sg[3]!, width, col, glow)

    // ---- subagent branches: a short side thread beside a running task tool ----
    for (const b of s.branches) {
      const r = layout.rects.get(b.id)
      if (!r) continue
      const bx = gx + layout.sign * 9
      const bc = rgba(BRANCH, b.alive ? 0.85 : 0.35)
      paint.capsule(gx, r.y + 4, bx, r.y + 12, 1.3, bc, b.alive ? 4 : 1)
      paint.capsule(bx, r.y + 12, bx, r.y + r.h - 6, 1.3, bc, b.alive ? 4 : 1)
      if (b.alive && !f.reduced) { const a = (clock * 0.004) % 6.283; paint.ring(bx, r.y + r.h - 6, 3.5, 1.3, bc, 4, a, a + 4.2) }
      else paint.dot(bx, r.y + r.h - 6, 2.2, bc, 1)
    }

    // ---- nodes ----
    for (const n of live) {
      const r = layout.rects.get(n.id)!
      if (r.y < -40 || r.y > bottom + 40) continue
      drawNode(n, r, gx, layout.sign, f, clock)
    }

    // ---- head (a running tool at the tail is its own head: no second ring) ----
    const tailIsTool = lastNode.kind === "tool" && lastNode.status === "running" && !layout.thinking
    if (s.waiting) {
      const br = f.reduced ? 1 : 1 + Math.sin(clock * 0.0031) * 0.12
      paint.ring(gx, headY, 7 * br, 1.6, rgba(YELLOW, 0.95), 8)
    } else if (tailIsTool) { /* ring drawn with the node */ }
    else if (!active) paint.dot(gx, headY, 2.6, rgba(ACCENT, 0.9), 1.5)
    else if (s.phase === "error") paint.dot(gx, headY, 2.6, rgba(RED, 0.95), 5)
    else if (!f.reduced) { const a = (clock * 0.004) % 6.283; paint.ring(gx, headY, 4.5, 1.4, col, 5, a, a + 4.4) }
    else paint.ring(gx, headY, 4.5, 1.4, col, 1.5)

    // ---- Stage micro-effect: a jet feeds the running tool while nothing else moves ----
    const running = live.findLast((n) => n.kind === "tool" && n.status === "running")
    if (running && !f.reduced && f.now - lastJet > 420) {
      const r = layout.rects.get(running.id)!
      lastJet = f.now
      pulses.push({ born: f.now, from: Math.max(0, r.cy - 70), to: r.cy - 7, x: gx, kind: "jet" })
    }

    // ---- transients ----
    if (!f.reduced) {
      for (let i = pulses.length - 1; i >= 0; i--) {
        const p = pulses[i]!
        const k = (f.now - p.born) / 420
        if (k > 1 || k < 0) { pulses.splice(i, 1); continue }
        const y1 = p.from + (p.to - p.from) * ease(k)
        const len = (p.kind === "jet" ? 14 : 22) * (1 - k * 0.5)
        paint.capsule(p.x, Math.max(p.from, y1 - len), p.x, y1, p.kind === "text" ? 2 : 1.2, rgba(ACCENT, (1 - k) * (p.kind === "text" ? 0.95 : 0.5)), 5)
      }
      for (let i = flashes.length - 1; i >= 0; i--) {
        const fl = flashes[i]!
        const k = (f.now - fl.born) / 650
        if (k > 1 || k < 0) { flashes.splice(i, 1); continue }
        paint.ring(fl.x, fl.y, 5 + ease(k) * 14, 1.1, rgba(fl.status === "done" ? GREEN : RED, (1 - k) * 0.8), 5)
      }
    } else { pulses.length = 0; flashes.length = 0 }
    paint.flush()
    return pulses.length > 0 || flashes.length > 0 || active || Math.abs(energy - target) > 0.01
  }

  const drawNode = (n: Node, r: Rect, gx: number, sign: number, f: Frame, t: number) => {
    switch (n.kind) {
      case "user":
        paint.capsule(gx - 3.5 * sign, r.y + 12, gx + 3.5 * sign, r.y + 12, 2.6, rgba(ACCENT, 0.95), 2)
        return
      case "text":
        paint.dot(gx, r.y + 9, 2, rgba(ACCENT, 0.9), n.status === "running" ? 4 : 0.8)
        return
      case "reasoning":
        paint.dot(gx, r.y + 9, 1.5, rgba(ACCENT, 0.5), 0.8)
        return
      case "tool": {
        const c = n.status === "running" ? ACCENT : n.status === "done" ? GREEN : RED
        if (n.status === "running" && !f.reduced) {
          const a = (t * 0.005) % 6.283
          paint.ring(gx, r.cy, 5, 1.4, rgba(c, 0.95), 5, a, a + 3.6)
          paint.ring(gx, r.cy, 5, 0.7, rgba(c, 0.25), 0)
        } else paint.ring(gx, r.cy, 5, 1.4, rgba(c, 0.8), n.status === "running" ? 3 : 0.8)
        if (n.status === "done") paint.dot(gx, r.cy, 1.8, rgba(GREEN, 0.9), 0)
        if (n.status === "error") { paint.capsule(gx - 2.5, r.cy - 2.5, gx + 2.5, r.cy + 2.5, 1.2, rgba(RED, 0.95), 1.5); paint.capsule(gx - 2.5, r.cy + 2.5, gx + 2.5, r.cy - 2.5, 1.2, rgba(RED, 0.95), 1.5) }
        return
      }
      case "task":
        paint.dot(gx, r.y + 10, 2.2, rgba(BRANCH, 0.9), 2)
        return
      case "ask": {
        const br = f.reduced ? 1 : 1 + Math.sin(t * 0.0031) * 0.1
        paint.ring(gx, r.y + 14, 6 * br, 1.5, rgba(YELLOW, 0.95), 6)
        return
      }
    }
  }

  return { absorb, render, phaseOf: (p: Phase) => p }
}
