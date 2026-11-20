import { expect, test } from "bun:test"
import { cfwPackets, clear, crcOk, drawCalls, ext, eyeShift, leasePayload, parseCfwAck, rect, text } from "./cfw"
import { buildScene } from "./cfw-scene"
import { lensFontReady, textWidth } from "./lens-font"
import { crc16, frames } from "./g2-transport"
import { connectOutcome, pickFailure, replyLines, replyPages, toggleAction, toolVerb, type HudState } from "./live-hud"

const hex = (bytes: ArrayLike<number>) => Buffer.from(Array.from(bytes)).toString("hex")

const baseState = (overrides: Partial<HudState> = {}): HudState => ({
  mode: "ambient",
  voice: { phase: "idle" },
  tool: "",
  reply: "",
  page: 0,
  needsIndex: 0,
  needsCount: 0,
  askSelected: 0,
  askArmed: false,
  depth: { distance: 0, spread: 8 },
  queueKnown: true,
  ...overrides,
})

test("crc16 and frames match upstream golden vectors", () => {
  expect(crc16(new TextEncoder().encode("123456789"))).toBe(0x29b1)
  const prelude = "aa219213010101200802109c01220a1a081206120408001000a142"
  const body = new Uint8Array(Buffer.from(prelude, "hex").subarray(8, -2))
  expect(hex(frames(body, 0x92, 0x01)[0]!)).toBe(prelude)
  const big = frames(new Uint8Array(600), 0x41, 0xe0)
  expect(big.map(f => [f[2], f[4], f[5]])).toEqual([[0x41, 4, 1], [0x41, 4, 2], [0x41, 4, 3], [0x41, 4, 4]])
})

test("drawCalls matches spec bordered box with text at depth", () => {
  const message = drawCalls([
    clear(),
    rect({ x: 80, y: 120, w: 480, h: 120, r: 8, fill: 0, border: 15, depth: 48 }),
    text({ x: 100, y: 168, value: "Hello depth", brightness: 15, depth: 48 }),
  ])
  expect(hex(message)).toBe("1a0300" + "0300090000" + "0f0008023080508078e00178000800000f" + "14000302306400a8001f0b48656c6c6f206465707468")
})

test("ext encodes 7-bit and 14-bit signed values", () => {
  expect([ext(63), ext(-64), ext(80), ext(-100)]).toEqual([[0x3f], [0x40], [0x80, 0x50], [0xbf, 0x9c]])
  expect(() => ext(9000)).toThrow(RangeError)
})

test("cfwPackets frames one record with reset, end, and valid crc", () => {
  const message = new Uint8Array(300).fill(7)
  const packets = cfwPackets(message, 250)
  expect(packets).toHaveLength(2)
  expect(packets.map(p => [p[2], p[6], p[7], p[8]])).toEqual([[250, 0xf0, 0, 0x83], [251, 0xf0, 0, 0x43]])
  expect(Array.from(packets[0]!.subarray(9, 14))).toEqual([0x0b, 300 & 0xff, 300 >> 8, crc16(message) & 0xff, crc16(message) >> 8])
  for (const p of packets) {
    expect(p[3]).toBe(p.length - 8)
    expect(crcOk(p)).toBe(true)
  }
})

test("parseCfwAck reads stream and lens", () => {
  const body = Uint8Array.of(1, 42, 0, 0, 2, 5, 0, 0, 0, 0, 0)
  const crc = crc16(body)
  const ack = Uint8Array.of(0xaa, 0x12, 9, body.length + 2, 1, 1, 0xf0, 0, ...body, crc & 0xff, crc >> 8)
  expect(parseCfwAck(ack)).toEqual({ ok: true, stream: 42, lens: 2 })
  expect(parseCfwAck(Uint8Array.of(0xaa, 0x12, 9, 11, 1, 1, 0xe0, 0))).toBeUndefined()
})

test("leasePayload matches spec fb_acquire", () => {
  expect(hex(leasePayload(5))).toBe("08011000aa0606464301050000")
})

test("eyeShift shifts lenses in opposite directions and right takes odd pixel", () => {
  expect([eyeShift(48, false), eyeShift(48, true)]).toEqual([24, -24])
  expect([eyeShift(1, false), eyeShift(1, true)]).toEqual([0, -1])
  expect([eyeShift(-1, false), eyeShift(-1, true)]).toEqual([-1, 0])
})

const texts = (calls: ReturnType<typeof buildScene>) =>
  calls.flatMap(call => (call.meta.kind === "text" ? [call.meta.value] : []))

test("sleep scene is only a clear", () => {
  const calls = buildScene(baseState({ mode: "sleep" }), 0)
  expect(calls).toHaveLength(1)
  expect(calls[0]!.meta.kind).toBe("clear")
})

test("needs scene shows title without session jargon", () => {
  const calls = buildScene(baseState({
    mode: "needs",
    needs: { title: "Roll back smart-tips?", context: "Error rate 4% after deploy" },
    needsCount: 2,
    needsIndex: 0,
  }), 0)
  expect(texts(calls).slice(0, 4)).toEqual(["NEEDS YOU", "1 of 2", "Roll back smart-tips?", "Error rate 4% after deploy"])
  expect(texts(calls).some(t => /ses_|SSE|ms|cloud/.test(t))).toBe(false)
})

test("thinking scene names the tool in plain words", () => {
  expect(toolVerb("bash (running)")).toBe("running a command")
  const calls = buildScene(baseState({ mode: "thinking", tool: "grep (running)" }), 0)
  expect(texts(calls)).toEqual(["searching"])
})

test("reply scene pages long text", () => {
  const long = "word ".repeat(400)
  expect(replyPages(long)).toBeGreaterThan(1)
  const calls = buildScene(baseState({ mode: "reply", reply: long, page: 1 }), 0)
  expect(texts(calls).length).toBeLessThanOrEqual(10)
})

test("every scene encodes within one record", () => {
  const modes = ["ambient", "thinking", "reply", "needs", "ask", "voice"] as const
  for (const mode of modes) {
    const calls = buildScene(baseState({
      mode,
      reply: "ok",
      tool: "read",
      needs: { title: "t", context: "c" },
      ask: { kind: "question", id: "q1", title: "Deploy?", detail: "staging or prod", options: ["Staging", "Prod"], answerable: true },
      voice: { phase: "confirm", transcript: "ship it" },
    }), 0)
    expect(drawCalls(calls).length).toBeLessThan(4000)
  }
})

test("recording ring and dot share one depth so the dot stays centered on both lenses", () => {
  const calls = buildScene(baseState({ mode: "voice", voice: { phase: "recording" } }), 0)
  const shapes = calls.flatMap(call => (call.meta.kind === "rect" ? [call.meta] : []))
  expect(shapes.length).toBe(2)
  expect(new Set(shapes.map(shape => shape.depth)).size).toBe(1)
  expect(shapes.map(shape => shape.x + shape.w / 2)).toEqual([320, 320])
})

test("thinking dots share one depth", () => {
  const calls = buildScene(baseState({ mode: "thinking", tool: "read" }), 0)
  const dots = calls.flatMap(call => (call.meta.kind === "rect" ? [call.meta.depth] : []))
  expect(new Set(dots).size).toBe(1)
})

test("title-bar toggle opens the Glasses page and picks from the same click", () => {
  expect(toggleAction("disconnected", true)).toEqual({ open: false, run: "connect" })
  expect(toggleAction("disconnected", false)).toEqual({ open: true, run: "connect" })
  expect(toggleAction("partial", false)).toEqual({ open: true, run: "connect-left" })
  expect(toggleAction("connecting", false)).toEqual({ open: false, run: "cancel" })
  expect(toggleAction("connected", true)).toEqual({ open: false, run: "disconnect" })
})

test("only both temples ready counts as connected", () => {
  expect(connectOutcome({ left: "connected", faceclaw: true })).toEqual({ state: "connected", status: "Connected." })
  expect(connectOutcome({ left: "connected", faceclaw: false }).state).toBe("connected")
  expect(connectOutcome({ left: "not-picked", faceclaw: false }).state).toBe("partial")
  expect(connectOutcome({ left: "failed", faceclaw: true }).state).toBe("partial")
})

test("a desktop-cancelled pick explains the cause", () => {
  expect(pickFailure("timeout")).toContain("Take them out of the case")
  expect(pickFailure("not-glasses-page")).toBe("Open the Glasses tab to connect.")
  expect(pickFailure(undefined)).toBeUndefined()
})

/** Horizontal centre of a drawn element on the fused (both-lens) image: each lens shifts by opposite halves. */
const fusedCenter = (meta: { kind: string; x: number; depth: number; w?: number; value?: string }) =>
  (meta.x + eyeShift(meta.depth, false) + meta.x + eyeShift(meta.depth, true)) / 2 + (meta.kind === "rect" ? meta.w! : textWidth(meta.value!)) / 2

test("centered scenes put every centered element on the panel axis with real font widths", async () => {
  await lensFontReady
  const scenes: Partial<HudState>[] = [
    { mode: "voice", voice: { phase: "recording" } },
    { mode: "voice", voice: { phase: "transcribing" } },
    { mode: "thinking", tool: "grep" },
    { mode: "ambient" },
    { mode: "align" },
  ]
  for (const depth of [{ distance: 0, spread: 8 }, { distance: 30, spread: 12 }, { distance: -20, spread: 4 }]) {
    for (const scene of scenes) {
      const calls = buildScene(baseState({ ...scene, depth }), 0)
      // Shapes are centred by construction except the row of thinking dots, whose middle dot is the axis.
      const elements = calls.map(call => call.meta).filter(meta => meta.kind === "text" || (meta.kind === "rect" && meta.w < 600 && meta.h > 2))
      const dots = elements.filter(meta => meta.kind === "rect" && meta.w === 20)
      for (const meta of elements.filter(meta => !dots.includes(meta))) {
        if (meta.kind === "clear") continue
        // Odd-width text can only be centred to the half pixel.
        const off = Math.abs(fusedCenter(meta as never) - 320)
        expect({ mode: scene.mode, value: meta.kind === "text" ? meta.value : "shape", centred: off <= 0.5 }).toEqual({ mode: scene.mode, value: meta.kind === "text" ? meta.value : "shape", centred: true })
      }
      if (dots.length) expect(Math.abs(fusedCenter(dots[1] as never) - 320)).toBeLessThanOrEqual(0.5)
    }
  }
})

test("firmware font widths come from Even's tables, not a fixed estimate", async () => {
  await lensFontReady
  expect(textWidth("Listening")).toBe(78)
  expect(textWidth("iiii")).toBeLessThan(textWidth("MMMM"))
})

test("body text wraps to the column's pixel width", async () => {
  await lensFontReady
  for (const line of replyLines("word ".repeat(80) + "supercalifragilisticexpialidocious".repeat(4), 0)) expect(textWidth(line)).toBeLessThanOrEqual(488)
})
