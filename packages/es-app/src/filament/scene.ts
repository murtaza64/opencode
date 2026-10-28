/* The filament: a thread down the transcript gutter with one node per real item. Everything
 * that moves is explained by a snapshot delta (text growth, tool end, ask open) or by a phase
 * the snapshot is in (thinking wave, running arc, waiting ring, retry fracture). Nothing here
 * reads the store or the DOM; it receives a snapshot, deltas and measured rects. */
import type { Delta, Node, Phase, Snapshot } from "./adapter"
import type { CommandKind } from "./command-kind"
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
type Knit = { born: number; messageID: string; to: "warm" | "cold" | "mixed" }

export type Frame = { now: number; wall: number; reduced: boolean; hidden: boolean; activity?: number }

export const createScene = (paint: Painter) => {
  const pulses: Pulse[] = []
  const flashes: Flash[] = []
  const knits: Knit[] = []
  let energy = 0
  let clock = 0
  let lastJet = 0
  // Observed work in a sliding window: characters that arrived (text/reasoning) and tool events,
  // with timestamps. Energy derives from chars/second, so the same text split into 3 or 300
  // deltas yields the same energy; delivery granularity is not evidence of more work.
  const recent: { at: number; chars: number }[] = []

  // Feeds one update's deltas into transients. Geometry decides where each lands.
  // Transients are born in content space (so they ride with the rows through scrolling).
  const absorb = (deltas: readonly Delta[], layout: Layout, now: number) => {
    for (const d of deltas) {
      if (d.type === "text") {
        const r = layout.rects.get(d.id)
        if (!r) continue
        // One packet per update, sized by how much arrived; bursts stay one packet, not a storm.
        // One packet per update capped so a chunky stream and a fine one look alike in motion count.
        if (!pulses.some((p) => now - p.born < 120)) pulses.push({ born: now, from: Math.max(0, r.y - 120), to: r.y + r.h - 6, x: layout.gx, kind: d.kind })
        if (pulses.length > 12) pulses.shift()
        recent.push({ at: now, chars: d.grew })
      } else if (d.type === "tool.end") {
        const r = layout.rects.get(d.id)
        if (r) flashes.push({ born: now, x: layout.gx, y: r.cy, status: d.status })
        recent.push({ at: now, chars: 120 })
      } else if (d.type === "cache" && d.to !== "unknown") {
        // Late usage: the seam re-knits (or cuts) when the evidence lands, not when the turn began.
        knits.push({ born: now, messageID: d.messageID, to: d.to })
        if (knits.length > 8) knits.shift()
      }
    }
  }

  const render = (s: Snapshot, content: Layout, f: Frame) => {
    // Project content-space rects into the viewport once per frame; the thread is drawn in viewport px.
    const dy = content.scrollTop
    const shift = (r: Rect): Rect => ({ x: r.x, y: r.y - dy, w: r.w, h: r.h, cx: r.cx, cy: r.cy - dy })
    const layout: Layout = { ...content, rects: new Map([...content.rects].map(([id, r]) => [id, shift(r)])), icons: new Map([...content.icons].map(([id, r]) => [id, shift(r)])), thinking: content.thinking ? shift(content.thinking) : undefined }
    const gx = layout.gx
    const top = 0, bottom = layout.h
    const active = s.phase === "thinking" || s.phase === "streaming" || s.phase === "tool" || s.phase === "error" || s.phase === "waiting"
    // Delegated (a subagent is working, not this session) and disconnected (no evidence at all) stay calm.
    const target = active ? 1 : s.phase === "delegated" ? 0.4 : s.phase === "disconnected" ? 0.08 : s.phase === "complete" ? 0.25 : 0.12
    energy += (target - energy) * clamp01(f.wall / 400)
    clock += f.wall

    paint.begin(layout.w, layout.h, 1)
    const live = s.nodes.filter((n) => layout.rects.has(n.id))
    if (!live.length) { paint.flush(); return false }
    const first = layout.rects.get(live[0]!.id)!
    const lastNode = live[live.length - 1]!
    const lastR = layout.rects.get(lastNode.id)!
    while (recent.length && f.now - recent[0]!.at > 1500) recent.shift()
    // ~60 chars/s (a slow model) reads as 0.25; ~240 chars/s saturates. Tool events count as 120 chars.
    const rate = recent.reduce((sum, r) => sum + r.chars, 0) / 1.5
    const liveWork = s.phase === "streaming" || s.phase === "tool" || s.phase === "thinking"
    const activity = f.reduced || !liveWork ? 0 : Math.min(1, rate / 240)
    const headY = s.waiting ? Math.min(bottom - 14, lastR.y + lastR.h + 18) : layout.thinking ? layout.thinking.cy : lastR.y + lastR.h + 2
    // Orb: fuller when active; the thread stops at its leading edge, never under it.
    const orbR = s.waiting ? 7 : 3 + energy * 4 + activity * 1.5
    // Quieter than the standalone prototype: this sits a few px from body text.
    const col = rgba(ACCENT, 0.22 + energy * 0.38)
    const width = 1.1 + energy * 0.4
    const glow = 0.8 + energy * 1.8

    // ---- main thread ----
    const segs: number[][] = []
    let y = Math.max(first.y, top - 10)
    const endY = Math.min(headY - orbR - 1, bottom + 10)
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
    // ---- prompt-cache seams at provider-turn starts (usage-driven; never timing) ----
    for (const turn of s.turns) {
      const r = turn.anchor ? layout.rects.get(turn.anchor) : undefined
      if (!r) continue
      const sy = r.y - 2
      if (sy < top - 10 || sy > bottom + 10) continue
      const knit = knits.find((k) => k.messageID === turn.messageID)
      const k = knit ? Math.min(1, (f.now - knit.born) / 700) : 1
      const span = 26
      if (turn.cache === "warm") {
        // Warm: the thread dims to a thin ember over the seam but never breaks; a fresh knit fades it in.
        const dim = f.reduced ? 0.35 : 0.35 + 0.65 * (knit ? 1 - ease(k) : 0)
        paint.capsule(gx, sy - span, gx, sy, width + 1.2, rgba([0.02, 0.03, 0.05], 0.97), 0)
        paint.capsule(gx, sy - span, gx, sy, Math.max(0.8, width * 0.55), rgba(ACCENT, 0.25 + 0.6 * dim), 0.5)
        paint.dot(gx, sy - span / 2, 1.2, rgba(ACCENT, 0.9), 2)
      } else if (turn.cache === "cold") {
        // Write/rebuild: a hard gap with cut ends; the bridge grows back over 700ms on a fresh knit.
        const gap = f.reduced ? 6 : knit ? 10 * (1 - ease(k)) + 6 : 6
        const mid = sy - span / 2
        paint.capsule(gx, sy - span, gx, sy, width + 1.2, rgba([0.02, 0.03, 0.05], 0.97), 0)
        paint.capsule(gx, sy - span, gx, mid - gap / 2, width, rgba(ACCENT, 0.3 + energy * 0.5), glow)
        paint.capsule(gx, mid + gap / 2, gx, sy, width, rgba(ACCENT, 0.3 + energy * 0.5), glow)
        paint.capsule(gx - 4 * layout.sign, mid - gap / 2, gx + 4 * layout.sign, mid - gap / 2, 1.4, rgba([1, 0.72, 0.4], 0.95), 2)
        paint.capsule(gx - 4 * layout.sign, mid + gap / 2, gx + 4 * layout.sign, mid + gap / 2, 1.4, rgba([1, 0.72, 0.4], 0.95), 2)
      } else if (turn.cache === "mixed") {
        // Mixed: continuity kept plus an extension sleeve, brighter and wider than the thread.
        const p = f.reduced ? 1 : knit ? ease(k) : 1
        paint.capsule(gx, sy - span * p, gx, sy, width + 2.2, rgba([0.7, 0.86, 1.0], 0.55 + (knit ? (1 - k) * 0.35 : 0)), 5 + (knit ? (1 - k) * 4 : 0))
        paint.capsule(gx - 3.5 * layout.sign, sy - span * p, gx + 3.5 * layout.sign, sy - span * p, 1.2, rgba([0.7, 0.86, 1.0], 0.9), 2)
      }
      // Unknown: plain thread (provisional until usage arrives).
    }
    for (let i = knits.length - 1; i >= 0; i--) if (f.now - knits[i]!.born > 800) knits.splice(i, 1)

    // Energetic active stretch: a brightness wave travels down the last 160px toward the orb; its
    // speed and brightness follow evidence rate, so a quiet model turn reads calmer than a burst.
    if (liveWork && !f.reduced && segs.length) {
      const yStart = Math.max(endY - 160, Math.max(first.y, top))
      const span = endY - yStart
      if (span > 20) {
        const k = (clock * (0.0012 + activity * 0.0025)) % 1
        const wy = yStart + span * k
        const len = 22 + activity * 18
        paint.capsule(gx, Math.max(yStart, wy - len), gx, Math.min(endY, wy), width + 0.6, rgba([0.7, 0.86, 1.0], 0.35 + activity * 0.45), 4 + activity * 4)
      }
    }

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

    // ---- nodes (a compact tool-run strip draws once, as its worst member) ----
    const seenRuns = new Set<string>()
    for (const n of live) {
      const r = layout.rects.get(n.id)!
      if (r.y < -40 || r.y > bottom + 40) continue
      const icon = n.kind === "tool" || n.kind === "task" ? layout.icons.get(n.id) : undefined
      if (icon) { lightIcon(n, icon, gx, layout.sign, { ...f, activity }, clock); continue }
      const run = layout.compact.get(n.id)
      if (run) {
        if (seenRuns.has(run)) continue
        seenRuns.add(run)
        const members = live.filter((m) => layout.compact.get(m.id) === run)
        const worst = members.find((m) => m.status === "error") ?? members.find((m) => m.status === "running") ?? members[members.length - 1]!
        drawNode({ ...worst, inputRank: Math.max(...members.map((m) => m.inputRank ?? 0)), outputRank: Math.max(...members.map((m) => m.outputRank ?? 0)) }, r, gx, layout.sign, { ...f, activity }, clock, members.length)
        continue
      }
      drawNode(n, r, gx, layout.sign, { ...f, activity }, clock)
    }

    // ---- head: the orb. Filled core + halo; waiting = hollow yellow ring; error = red ----
    if (s.waiting) {
      const br = f.reduced ? 1 : 1 + Math.sin(clock * 0.0031) * 0.12
      paint.ring(gx, headY, orbR * br, 1.6, rgba(YELLOW, 0.95), 8)
    } else if (s.phase === "error") {
      paint.dot(gx, headY, orbR, rgba(RED, 0.9), 6)
    } else if (s.phase === "delegated") {
      // Handed off: hollow orb with a slow, faint ring; the work is elsewhere.
      paint.ring(gx, headY, orbR, 1.4, rgba(BRANCH, 0.8), 3)
      if (!f.reduced) { const a = (clock * 0.0015) % 6.283; paint.ring(gx, headY, orbR + 3, 0.9, rgba(BRANCH, 0.4), 1.5, a, a + 2.2) }
    } else if (s.phase === "disconnected") {
      paint.ring(gx, headY, orbR, 1.2, rgba([0.5, 0.52, 0.6], 0.6), 0)
    } else if (!active) {
      paint.dot(gx, headY, orbR, rgba(ACCENT, 0.85), 1.5)
    } else {
      const breathe = f.reduced ? 1 : 1 + Math.sin(clock * 0.005) * 0.06
      paint.dot(gx, headY, orbR * breathe, rgba(ACCENT, 0.35), 10 + activity * 6)
      paint.dot(gx, headY, orbR * 0.62 * breathe, rgba([0.75, 0.88, 1.0], 0.95), 3)
      if (!f.reduced) { const a = (clock * 0.004) % 6.283; paint.ring(gx, headY, orbR + 2.5, 1.1, rgba(ACCENT, 0.5 + activity * 0.4), 3, a, a + 3.8) }
    }
    // ---- shimmer: a continuous, slowly wandering filament off the active node; brightness and
    // reach follow the observed work rate, phase moves smoothly (no random regeneration). ----
    if (activity > 0 && !f.reduced) {
      const writing = live.findLast((n) => (n.kind === "text" || n.kind === "reasoning") && n.status === "running")
      const tool = live.findLast((n) => n.kind === "tool" && n.status === "running")
      const src = tool ? layout.rects.get(tool.id)! : writing ? layout.rects.get(writing.id)! : undefined
      if (src) {
        const sy = tool ? src.cy : Math.min(src.y + src.h - 8, bottom - 4)
        const reach = (8 + activity * 12) * layout.sign
        const t1 = clock * 0.0019, t2 = clock * 0.0031
        let x = gx, yy = sy
        for (let k = 0; k < 4; k++) {
          const nx = x + reach / 4
          const ny = sy + Math.sin(t1 + k * 1.7) * (1.5 + activity * 2.5) + Math.sin(t2 + k * 0.9) * 1.2
          paint.capsule(x, yy, nx, ny, 0.9, rgba([0.8, 0.9, 1.0], (0.55 - k * 0.11) * activity), 2.5)
          x = nx; yy = ny
        }
      }
    }

    // ---- transients ----
    if (!f.reduced) {
      for (let i = pulses.length - 1; i >= 0; i--) {
        const p = pulses[i]!
        const k = (f.now - p.born) / 420
        if (k > 1 || k < 0) { pulses.splice(i, 1); continue }
        const y1 = p.from + (p.to - p.from) * ease(k) - (p.kind === "jet" ? 0 : dy)
        const len = (p.kind === "jet" ? 14 : 22) * (1 - k * 0.5)
        paint.capsule(p.x, Math.max(p.from - (p.kind === "jet" ? 0 : dy), y1 - len), p.x, y1, p.kind === "text" ? 2 : 1.2, rgba(ACCENT, (1 - k) * (p.kind === "text" ? 0.95 : 0.5)), 5)
      }
      for (let i = flashes.length - 1; i >= 0; i--) {
        const fl = flashes[i]!
        const k = (f.now - fl.born) / 650
        if (k > 1 || k < 0) { flashes.splice(i, 1); continue }
        paint.ring(fl.x, fl.y - dy, 5 + ease(k) * 14, 1.1, rgba(fl.status === "done" ? GREEN : RED, (1 - k) * 0.8), 5)
      }
    } else { pulses.length = 0; flashes.length = 0 }
    paint.flush()
    // Rest: delegated/disconnected keep a slow ring only while energy settles, then stop.
    return pulses.length > 0 || flashes.length > 0 || knits.length > 0 || active || activity > 0 || Math.abs(energy - target) > 0.01
  }
  // Test hook: current activity level (0..1) from observed work rate.
  const activityNow = () => { const now = recent[recent.length - 1]?.at ?? 0; const r = recent.filter((x) => now - x.at <= 1500).reduce((sum, x) => sum + x.chars, 0) / 1.5; return Math.min(1, r / 240) }
  const energyNow = () => energy

  // Size vocabulary (ranks 0..4 = XS..XL): input sets the ring radius, output fills the core.
  const RING = [3.2, 4, 5, 6.2, 7.6]
  const CORE = [0.8, 1.4, 2.2, 3.2, 4.4]

  // Icon-first rows (composer's base grammar) expose the real tool/mail icon via data-filament-icon.
  // The filament then lights THAT icon: a branch from the spine into the icon and a halo on it,
  // sized by the same ranks; no separate ring, count tick or command glyph beside the spine.
  const lightIcon = (n: Node, icon: Rect, gx: number, sign: number, f: Frame, t: number) => {
    const c = n.status === "running" ? ACCENT : n.status === "done" ? GREEN : n.status === "error" ? RED : [0.5, 0.52, 0.6] as const
    const edgeX = sign > 0 ? icon.x : icon.x + icon.w
    const halo = Math.max(icon.w, icon.h) / 2 + 2
    const live = n.status === "running" && !f.reduced
    // Branch: spine -> icon leading edge; carries a packet while running.
    paint.capsule(gx, icon.cy, edgeX, icon.cy, 1.1, rgba(c, live ? 0.85 : 0.45), live ? 2 : 0.6)
    if (live) {
      const k = ((t * 0.0022) % 1)
      paint.dot(gx + (edgeX - gx) * k, icon.cy, 1.6, rgba([0.8, 0.9, 1.0], 0.9), 3)
      const a = (t * 0.004) % 6.283
      paint.ring(icon.cx, icon.cy, halo + 1.5, 1.1, rgba(c, 0.8), 4, a, a + 3.6)
    }
    // Halo on the icon: glow weight by output rank when done, steady while running, muted otherwise.
    const weight = n.status === "done" ? 1.5 + (n.outputRank ?? 0) * 0.9 : live ? 3 : 0.8
    paint.dot(icon.cx, icon.cy, halo, rgba(c, live ? 0.18 : 0.14), weight)
    if (n.status === "error") paint.ring(icon.cx, icon.cy, halo + 1, 1.2, rgba(RED, 0.85), 1.5)
  }

  const drawNode = (n: Node, r: Rect, gx: number, sign: number, f: Frame, t: number, count = 1) => {
    switch (n.kind) {
      case "user":
        paint.capsule(gx - 3.5 * sign, r.y + 12, gx + 3.5 * sign, r.y + 12, 2.6, rgba(ACCENT, 0.95), 2)
        return
      case "text":
        paint.dot(gx, r.y + 9, n.status === "running" ? 2 + (f.activity ?? 0) * 1.2 : 2, rgba(ACCENT, 0.9), n.status === "running" ? 4 + (f.activity ?? 0) * 4 : 0.8)
        return
      case "reasoning":
        paint.dot(gx, r.y + 9, 1.5, rgba(ACCENT, 0.5), 0.8)
        return
      case "tool": {
        const c = n.status === "running" ? ACCENT : n.status === "done" ? GREEN : RED
        const ring = RING[n.inputRank ?? 1]!
        const core = n.status === "done" ? Math.min(CORE[n.outputRank ?? 0]!, ring - 1.6) : 0
        if (n.status === "running" && !f.reduced) {
          const a = (t * 0.005) % 6.283
          paint.ring(gx, r.cy, ring, 1.4, rgba(c, 0.95), 5, a, a + 3.6)
          paint.ring(gx, r.cy, ring, 0.7, rgba(c, 0.25), 0)
        } else paint.ring(gx, r.cy, ring, 1.4, rgba(c, 0.8), n.status === "running" ? 3 : 0.8)
        if (n.status === "done") paint.dot(gx, r.cy, core, rgba(GREEN, 0.9), core > 2.5 ? 1.5 : 0)
        if (n.status === "error") { const e = Math.max(2.5, ring * 0.5); paint.capsule(gx - e, r.cy - e, gx + e, r.cy + e, 1.2, rgba(RED, 0.95), 1.5); paint.capsule(gx - e, r.cy + e, gx + e, r.cy - e, 1.2, rgba(RED, 0.95), 1.5) }
        if (count > 1) { const tx = gx - sign * (ring + 5); paint.capsule(tx, r.cy - 2.5, tx, r.cy + 2.5, 1.2, rgba(c, 0.6), 0); for (let i = 1; i < Math.min(count, 4); i++) paint.capsule(tx - sign * i * 2.4, r.cy - 2.5 + i * 0.4, tx - sign * i * 2.4, r.cy + 2.5 - i * 0.4, 1.2, rgba(c, 0.6 - i * 0.12), 0) }
        if (n.command && n.command !== "shell") drawGlyph(n.command, gx, r.cy, ring, c, n.status === "running" && !f.reduced ? t : 0, sign)
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

  // Program glyphs ride just outside the ring on the content side; `t` > 0 animates (running), 0 = static.
  const drawGlyph = (kind: CommandKind, gx: number, cy0: number, ring: number, c: readonly [number, number, number], t: number, sign0: number) => {
    // Glyphs sit on the gutter side of the ring (away from the chip), drawn at 1.8x so the shapes read.
    const G = 1.8
    const sign = -sign0
    const ox0 = gx + sign * (ring + 4 + 4 * G)
    const col = rgba(c, 0.85)
    const ph = t ? (t * 0.004) % 6.283 : 0
    // Scale helpers: local coordinates around (ox0, cy0) in glyph units.
    const X = (dx: number) => ox0 + dx * G
    const Y = (dy: number) => cy0 + dy * G
    const cap = (x0: number, y0: number, x1: number, y1: number, w: number, col2: RGBA, glow = 0) => paint.capsule(X(x0), Y(y0), X(x1), Y(y1), w * G, col2, glow)
    const dot = (x: number, y: number, r: number, col2: RGBA, glow = 0) => paint.dot(X(x), Y(y), r * G, col2, glow)
    const rng = (x: number, y: number, r: number, w: number, col2: RGBA, glow = 0, a0 = 0, a1 = Math.PI * 2) => paint.ring(X(x), Y(y), r * G, w * G, col2, glow, a0, a1)
    switch (kind) {
      case "git":
      case "jj": {
        // Two commits on a short DAG; running = the newer one orbits in. jj adds the working-copy ring.
        const k = t ? (Math.sin(ph) + 1) / 2 : 1
        cap(0, 3, 0, -3, 1, rgba(c, 0.5))
        dot(0, 3, 1.3, col)
        dot(sign * 3 * (1 - k), -3 * k, 1.3, col, t ? 2 : 0)
        if (kind === "jj") rng(0, -3, 2.2, 0.8, rgba(c, 0.6))
        return
      }
      case "gh": {
        cap(0, -3.5, 0, 3.5, 1, rgba(c, 0.5))
        rng(sign * 2.5, 0, 2.5, 1, rgba(c, 0.6), 0, sign > 0 ? Math.PI / 2 : -Math.PI / 2, sign > 0 ? Math.PI * 1.5 : Math.PI / 2)
        const k = t ? (Math.sin(ph) + 1) / 2 : 0.5
        dot(0, -3.5 + 7 * k, 1.4, col, t ? 2 : 0)
        return
      }
      case "es": {
        for (let i = 0; i < 3; i++) { const lit = t ? ((Math.floor(t / 180) + i) % 3 === 0) : true; cap(sign * (i - 1) * 2.4, -3, sign * (i - 1) * 2.4, 3, 1.1, rgba(c, lit ? 0.9 : 0.3), lit && t ? 2 : 0) }
        return
      }
      case "aws": {
        rng(0, 1, 3, 1, rgba(c, 0.6), 0, Math.PI, Math.PI * 2)
        cap(-3, 1, 3, 1, 1, rgba(c, 0.6))
        const k = t ? ((t / 500) % 1) : 0.5
        dot(0, 3 - 5 * k, 1.1, rgba(c, 0.9 * (1 - k * 0.6)), t ? 1.5 : 0)
        return
      }
      case "test": {
        for (let i = 0; i < 4; i++) { const on = t ? (Math.floor(t / 220) % 4) >= i : true; dot((i - 1.5) * 2.6, 0, 1, rgba(c, on ? 0.9 : 0.3)) }
        return
      }
      case "http": {
        cap(-3.5, -2, 3.5, -2, 0.8, rgba(c, 0.35))
        cap(-3.5, 2, 3.5, 2, 0.8, rgba(c, 0.35))
        const k = t ? ((t / 600) % 1) : 0.5
        dot(-3.5 + 7 * k, -2, 1.1, col, t ? 1.5 : 0)
        dot(3.5 - 7 * k, 2, 1.1, col, t ? 1.5 : 0)
        return
      }
      case "container": {
        for (let i = 0; i < 3; i++) { const lift = t ? Math.max(0, Math.sin(ph + i * 1.2)) * 1.5 : 0; cap(-2.5, 2.4 - i * 2.4 - lift, 2.5, 2.4 - i * 2.4 - lift, 1.6, rgba(c, 0.5 + i * 0.15)) }
        return
      }
      case "search": {
        const sx = (t ? Math.sin(ph) * 1.2 : 0)
        rng(sx - 0.5, -1, 2.2, 1, col)
        cap(sx + 1.1, 0.6, sx + 3.1, 2.6, 1.1, col)
        return
      }
      case "build": {
        rng(0, 0, 2.4, 1, col)
        for (let i = 0; i < 4; i++) { const a = ph + (i * Math.PI) / 2; cap(Math.cos(a) * 2.4, Math.sin(a) * 2.4, Math.cos(a) * 3.8, Math.sin(a) * 3.8, 1, col) }
        return
      }
      default:
        return
    }
  }

  return { absorb, render, energyNow, activityNow, phaseOf: (p: Phase) => p }
}
