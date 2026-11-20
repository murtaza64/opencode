// Faceclaw/38 draw protocol, pinned to g2flash 845f665e and Faceclaw 0.9.0.
import { crc16, type G2 } from "./g2-transport"

export const PANEL = { width: 640, height: 480 }
const u16 = (v: number) => [v & 255, (v >> 8) & 255]
export const ext = (v: number) => {
  if (!Number.isInteger(v) || v < -8192 || v > 8191) throw new RangeError("Extended integer out of range")
  return v >= -64 && v <= 63 ? [v & 127] : [0x80 | ((v >> 8) & 63), v & 255]
}
const clampDepth = (depth: number) => Math.max(-62, Math.min(62, Math.round(depth)))
const header = (op: number, depth: number) => depth ? [op, 2, depth & 255] : [op, 0]

export type Draw = ReturnType<typeof clear | typeof rect | typeof text>
export const clear = () => Object.assign([9, 0, 0], { meta: { kind: "clear" as const } })
export const rect = (box: { x: number; y: number; w: number; h: number; r?: number; fill?: number; border?: number; depth?: number }) => {
  const meta = { kind: "rect" as const, ...box, r: box.r ?? 0, fill: box.fill ?? 0, border: box.border ?? 15, depth: clampDepth(box.depth ?? 0) }
  return Object.assign([...header(8, meta.depth), ...ext(meta.x), ...ext(meta.y), ...u16(meta.w), ...u16(meta.h), ...u16(meta.r), meta.fill, meta.border], { meta })
}
export const text = (label: { x: number; y: number; value: string; brightness?: number; depth?: number }) => {
  const meta = { kind: "text" as const, ...label, brightness: label.brightness ?? 15, depth: clampDepth(label.depth ?? 0) }
  const bytes = new Uint8Array(255)
  const size = new TextEncoder().encodeInto(label.value, bytes).written
  const utf8 = bytes.subarray(0, size)
  return Object.assign([...header(3, meta.depth), ...u16(meta.x), ...u16(meta.y), (meta.brightness & 15) | 16, size, ...utf8], {
    meta: { ...meta, value: new TextDecoder().decode(utf8) },
  })
}
export const drawCalls = (calls: Draw[]) => {
  const data = [26, ...u16(calls.length)]
  for (const call of calls) data.push(...u16(call.length), ...call)
  if (data.length > 65535) throw new RangeError("Draw calls exceed one record")
  return Uint8Array.from(data)
}

// One uncompressed record, both lenses, with a fresh compression context on every record.
export const cfwPackets = (message: Uint8Array, stream: number) => {
  if (message.length > 65535) throw new RangeError("Message exceeds one record")
  const record = new Uint8Array(message.length + 5)
  record.set([0x0b, ...u16(message.length), ...u16(crc16(message))])
  record.set(message, 5)
  return Array.from({ length: Math.ceil(record.length / 160) }, (_, i) => {
    const offset = i * 160
    const slice = record.subarray(offset, offset + 160)
    const body = Uint8Array.of(3 | (i === 0 ? 0x80 : 0) | (offset + slice.length === record.length ? 0x40 : 0), ...slice)
    return Uint8Array.of(0xaa, 0x21, (stream + i) & 255, body.length + 2, 1, 1, 0xf0, 0, ...body, ...u16(crc16(body)))
  })
}
export const crcOk = (packet: Uint8Array) => {
  const sum = crc16(packet.subarray(8, packet.length - 2))
  return packet.at(-2) === (sum & 255) && packet.at(-1) === sum >> 8
}
export const parseCfwAck = (raw: Uint8Array) => {
  if (raw.length < 19 || raw[0] !== 0xaa || raw[1] !== 0x12 || raw[3] !== raw.length - 8 || raw[6] !== 0xf0 || !crcOk(raw)) return
  if ((raw[8] !== 1 && raw[8] !== 3) || (raw[12] !== 1 && raw[12] !== 2)) return
  return { ok: raw[8] === 1, stream: raw[9]!, lens: raw[12] }
}
export const leasePayload = (op: number) => Uint8Array.of(0x08, 0x01, 0x10, 0, 0xaa, 0x06, 0x06, 0x46, 0x43, 0x01, op, 0, 0)

export const eyeShift = (depth: number, right: boolean) => {
  const value = right ? depth + 1 : depth
  const half = Math.floor(value / 2)
  return right ? 0 - half : half
}

export class CfwSession {
  #stream = 1
  #renew?: ReturnType<typeof setInterval>
  #listeners = new AbortController()
  #ack?: (raw: Uint8Array) => void
  #queue = Promise.resolve()
  #stopping = false

  constructor(private readonly link: G2) {
    link.addEventListener("cfw", event => this.#ack?.((event as CustomEvent<Uint8Array>).detail), { signal: this.#listeners.signal })
  }

  async start() {
    await this.link.settingsBoth(leasePayload(5))
    if (this.#stopping) return
    this.#renew = setInterval(() => void this.link.settingsBoth(leasePayload(5)).catch(() => {}), 45_000)
  }

  show(calls: Draw[]) {
    if (this.#stopping) return Promise.reject(new Error("Display closed"))
    const result = this.#queue.then(async () => {
      await this.#send(drawCalls(calls))
      if (!this.#stopping) await this.#send(Uint8Array.of(28))
    })
    this.#queue = result.catch(() => {})
    return result
  }

  async stop() {
    if (this.#stopping) return
    this.#stopping = true
    clearInterval(this.#renew)
    await this.#queue
    if (this.link.connected) await this.#send(Uint8Array.of(11), 1500).catch(() => {})
    this.#listeners.abort()
  }

  async #send(message: Uint8Array, timeout = 3000) {
    const id = this.#stream
    const packets = cfwPackets(message, id)
    this.#stream = (id + packets.length) & 255
    const lenses = new Set<number>()
    let timer: ReturnType<typeof setTimeout> | undefined
    const reply = new Promise<boolean>(resolve => {
      timer = setTimeout(() => resolve(false), timeout)
      this.#ack = raw => {
        const ack = parseCfwAck(raw)
        if (!ack || ack.stream !== id) return
        if (!ack.ok) return resolve(false)
        lenses.add(ack.lens)
        if (lenses.size === 2) resolve(true)
      }
    })
    try {
      await this.link.writeRaw(packets)
      if (!(await reply)) throw new Error("Display not acknowledged")
    } finally {
      clearTimeout(timer)
      this.#ack = undefined
    }
  }
}
