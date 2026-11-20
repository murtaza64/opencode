/*!
 * Adapted from mrahtz/even-g2-js, revision 1c5fa60ae93944ca545fa9c27b3d066db4585192.
 * MIT License
 * Copyright (c) 2026 Matthew Rahtz
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

// Web Bluetooth is not in lib.dom. Model only the GATT operations used here.
type Characteristic = EventTarget & { uuid: string; value?: DataView; startNotifications(): Promise<unknown>; writeValueWithoutResponse(bytes: Uint8Array): Promise<void> }
type Gatt = { connected: boolean; connect(): Promise<Gatt>; disconnect(): void; getPrimaryServices(): Promise<{ getCharacteristics(): Promise<Characteristic[]> }[]> }
type Device = EventTarget & { name?: string; gatt?: Gatt }
const bluetooth = () => (navigator as Navigator & { bluetooth?: { requestDevice(options: { filters: { namePrefix: string }[]; optionalServices: string[] }): Promise<Device> } }).bluetooth
const uuid = (suffix: string) => `00002760-08c2-11e1-9073-0e8ac72e${suffix}`
const services = ["0000", "5450", "6450", "7450"].map(uuid)
const request = async (side: "R" | "L", pair?: string) => {
  const adapter = bluetooth()
  if (!adapter) throw new Error("Bluetooth unavailable")
  // Electron's chooser does not receive the Web Bluetooth request filters.
  document.documentElement.dataset.glassesSide = side
  delete document.documentElement.dataset.glassesPickResult
  try {
    const device = await adapter.requestDevice({ filters: (pair ? [`${pair}${side}_`] : ["Even G2_", "G2_"]).map(namePrefix => ({ namePrefix })), optionalServices: services })
    if (temple(device.name)?.[2] !== side || (pair && temple(device.name)?.[1] !== pair)) throw new Error("Wrong temple")
    return device
  } finally {
    delete document.documentElement.dataset.glassesSide
  }
}
const temple = (name?: string) => /^(?<pair>(?:Even )?G2_\d+_)([RL])_/i.exec(name ?? "")

export const crc16 = (bytes: Uint8Array) => {
  let crc = 0xffff
  for (const byte of bytes) {
    crc ^= byte << 8
    for (let bit = 0; bit < 8; bit++) crc = ((crc << 1) ^ (crc & 0x8000 ? 0x1021 : 0)) & 0xffff
  }
  return crc
}

export const frames = (payload: Uint8Array, seq: number, sid: number, flag = 0x20) => {
  const crc = crc16(payload)
  const body = Uint8Array.of(...payload, crc & 255, crc >> 8)
  const total = Math.ceil(body.length / 200)
  return Array.from({ length: total }, (_, i) => {
    const piece = body.subarray(i * 200, (i + 1) * 200)
    return Uint8Array.of(0xaa, 0x21, seq & 255, piece.length, total, i + 1, sid, flag, ...piece)
  })
}

const varint = (value: number | bigint) => {
  let n = BigInt(value)
  const bytes: number[] = []
  while (n >= 128n) { bytes.push(Number(n & 127n) | 128); n >>= 7n }
  return [...bytes, Number(n)]
}
const uint = (field: number, value: number | bigint) => value ? [...varint(field << 3), ...varint(value)] : []
const bytes = (field: number, value: ArrayLike<number> & Iterable<number>) => [...varint(field << 3 | 2), ...varint(value.length), ...value]
const encoder = new TextEncoder()
const string = (field: number, value: string) => bytes(field, encoder.encode(value))
type Proto = Map<number, number | Uint8Array>
const decode = (buf?: Uint8Array): Proto => {
  const fields: Proto = new Map()
  if (!buf) return fields
  let offset = 0
  const read = () => {
    let n = 0n
    for (let shift = 0n; shift < 70n && offset < buf.length; shift += 7n) {
      const v = buf[offset++]!
      n |= BigInt(v & 127) << shift
      if (!(v & 128)) return Number(n)
    }
    throw new Error("Invalid protobuf")
  }
  try {
    while (offset < buf.length) {
      const key = read()
      const wire = key & 7
      if (wire === 0) { fields.set(key >>> 3, read()); continue }
      if (wire === 2) {
        const length = read()
        if (length > buf.length - offset) return new Map()
        fields.set(key >>> 3, buf.subarray(offset, offset + length))
        offset += length
        continue
      }
      if (wire !== 1 && wire !== 5) return new Map()
      offset += wire === 1 ? 8 : 4
    }
    return fields
  } catch { return new Map() }
}
const child = (fields: Proto, field: number) => {
  const value = fields.get(field)
  return value instanceof Uint8Array ? decode(value) : undefined
}
const hub = (cmd: number, magic: number, field: number, data: number[]) => Uint8Array.of(...uint(1, cmd), ...uint(2, magic), ...bytes(field, data))
const handshake = (): [number, number[]][] => {
  const clock = (magic: number) => [...uint(1, 128), ...uint(2, magic), ...bytes(128, [...uint(1, Math.floor(Date.now() / 1000)), ...uint(2, 0xffffffffffffffe8n)])]
  return [
    [0, [8, 4, 16, 12, 26, 4, 8, 1, 16, 4]], [32, [8, 5, 16, 14, 34, 2, 8, 2]], [32, clock(15)],
    [0, [8, 4, 16, 16, 26, 4, 8, 1, 16, 4]], [0, [8, 4, 16, 17, 26, 4, 8, 1, 16, 4]],
    [32, [8, 5, 16, 18, 34, 2, 8, 1]], [32, clock(19)],
  ]
}
const PRELUDE = Uint8Array.of(0xaa, 0x21, 0x92, 0x13, 1, 1, 1, 0x20, 8, 2, 16, 0x9c, 1, 34, 10, 26, 8, 18, 6, 18, 4, 8, 0, 16, 0, 0xa1, 0x42)
const gestures = ["tap", "swipe-back", "swipe-forward", "double-tap", "foreground-enter", "foreground-exit", "abnormal-exit", "system-exit", "motion", "long-press", "long-release"] as const
export type Gesture = typeof gestures[number]

const open = async (device: Device, receive: (raw: Uint8Array) => void, mic?: (raw: Uint8Array) => void) => {
  if (!device.gatt) throw new Error("No connection")
  const listeners = new AbortController()
  try {
    const gatt = await device.gatt.connect()
    const chars = (await Promise.all((await gatt.getPrimaryServices()).map(service => service.getCharacteristics().catch(() => [])))).flat()
    const write = chars.find(c => c.uuid === uuid("5401"))
    const notify = chars.find(c => c.uuid === uuid("5402"))
    const audio = mic && chars.find(c => c.uuid === uuid("6402"))
    if (!write || !notify) throw new Error("Missing G2 characteristics")
    const subscribe = async (c: Characteristic, fn: (raw: Uint8Array) => void) => {
      c.addEventListener("characteristicvaluechanged", () => {
        const v = c.value
        if (v) fn(new Uint8Array(v.buffer, v.byteOffset, v.byteLength).slice())
      }, { signal: listeners.signal })
      await c.startNotifications()
    }
    await subscribe(notify, receive)
    const micReady = !!(audio && mic && await subscribe(audio, mic).then(() => true, () => false))
    let queue = Promise.resolve()
    return { device, gatt, micReady, listeners, send: (packets: Uint8Array[]) => {
      const result = queue.then(async () => { for (const packet of packets) await write.writeValueWithoutResponse(packet) })
      queue = result.catch(() => {})
      return result
    } }
  } catch (error) {
    listeners.abort()
    device.gatt.disconnect()
    throw error
  }
}
type Temple = Awaited<ReturnType<typeof open>>

export class G2 extends EventTarget {
  #right?: Temple
  #left?: Temple
  #seq = 0x40
  #magic = 100
  #heartbeat?: ReturnType<typeof setInterval>
  #waiters = new Map<string, (value?: Proto) => void>()
  #fragments = new Map<number, { next: number; body: number[] }>()
  #textName = ""
  #flip = false
  #closed = false
  #ready = false

  static get supported() { return typeof navigator !== "undefined" && !!bluetooth() }

  static async connect(signal: AbortSignal) {
    const device = await request("R")
    signal.throwIfAborted()
    const link = new G2()
    signal.addEventListener("abort", () => link.disconnect(), { once: true })
    try {
      link.#right = await open(device, raw => link.#receive(raw))
      device.addEventListener("gattserverdisconnected", () => link.disconnect(), { signal: link.#right.listeners.signal })
      signal.throwIfAborted()
      for (const [flag, payload] of handshake()) {
        const encoded = Uint8Array.from(payload)
        await link.#send(0x80, encoded, Number(decode(encoded).get(2)), 1000, flag)
      }
      const launch = link.#wait(1, 156, 4000)
      await link.writeRaw([PRELUDE])
      if (!(await launch)) throw new Error("Glasses did not accept the connection")
      const magic = link.#nextMagic()
      const list = [...uint(3, 576), ...uint(4, 288), ...uint(9, 1), ...string(10, "g2web"), ...bytes(11, [...uint(1, 1), ...uint(3, 1), ...string(4, "Glasses")]), ...uint(12, 1)]
      await link.#send(0xe0, hub(0, magic, 3, [...uint(1, 1), ...bytes(2, list), ...uint(5, 10000)]), magic, 4000)
      link.#ready = true
      link.#heartbeat = setInterval(() => {
        const m = link.#nextMagic()
        void link.#send(0xe0, hub(12, m, 14, []), m, 2000).catch(() => {})
      }, 5000)
      return link
    } catch (error) {
      link.disconnect()
      throw error
    }
  }

  get connected() { return this.#ready && !!this.#right?.gatt.connected && !this.#closed }
  get leftConnected() { return !!this.#left?.gatt.connected }
  get micAvailable() { return this.leftConnected && this.#left?.micReady }

  async connectLeft(signal: AbortSignal) {
    const pair = temple(this.#right?.device.name)?.[1]
    if (!pair || !this.connected) throw new Error("Right temple disconnected")
    const device = await request("L", pair)
    signal.throwIfAborted()
    const left = await open(device, () => {}, raw => this.dispatchEvent(new CustomEvent("mic", { detail: raw })))
    this.#left = left
    try {
      for (const [flag, payload] of handshake()) {
        signal.throwIfAborted()
        if (!this.connected) throw new Error("Right temple disconnected")
        await left.send(frames(Uint8Array.from(payload), this.#seq++, 0x80, flag))
        await new Promise(resolve => setTimeout(resolve, 60))
      }
      if (!left.gatt.connected) throw new Error("Left temple disconnected")
      device.addEventListener("gattserverdisconnected", () => {
        left.listeners.abort()
        this.#left = undefined
        this.dispatchEvent(new Event("left-disconnect"))
      }, { signal: left.listeners.signal })
    } catch (error) {
      left.listeners.abort()
      left.gatt.disconnect()
      this.#left = undefined
      throw error
    }
  }

  disconnect() {
    const first = !this.#closed
    this.#closed = true
    clearInterval(this.#heartbeat)
    this.#waiters.forEach(finish => finish())
    for (const arm of [this.#left, this.#right]) {
      arm?.listeners.abort()
      arm?.gatt.disconnect()
    }
    if (first) this.dispatchEvent(new Event("disconnect"))
  }

  writeRaw(packets: Uint8Array[]) {
    if (this.#closed || !this.#right?.gatt.connected) return Promise.reject(new Error("Glasses disconnected"))
    return this.#right.send(packets)
  }

  async settingsBoth(payload: Uint8Array) {
    const left = this.#left
    if (!left?.gatt.connected) throw new Error("Left temple disconnected")
    await this.writeRaw(frames(payload, this.#seq++, 9))
    await left.send(frames(payload, this.#seq++, 9))
  }

  async faceclaw() {
    const m = this.#nextMagic()
    const reply = await this.#send(9, hub(2, m, 4, uint(1, 1)), m, 4000)
    const value = reply?.get(100)
    return value instanceof Uint8Array && /^Faceclaw\/\d+/.test(new TextDecoder().decode(value))
  }

  async mic(on: boolean) {
    const m = this.#nextMagic()
    if (!(await this.#send(0xe0, hub(15, m, 18, uint(1, Number(on))), m)) && on) throw new Error("Glass microphone unavailable")
  }

  // Unchanged geometry updates in place. Stock firmware can evict a container; rebuild if that happens.
  async text(value: string): Promise<void> {
    const content = encoder.encode(value || " ").subarray(0, 990)
    const m = this.#nextMagic()
    if (this.#textName) {
      const ack = await this.#send(0xe0, hub(5, m, 9, [...uint(1, 1), ...string(2, this.#textName), ...uint(4, content.length), ...bytes(5, content)]), m)
      if (ack && child(ack, 10)?.get(1) !== 9) return
      this.#textName = ""
      return this.text(value)
    }
    const name = this.#flip ? "text-b" : "text-a"
    const container = [...uint(3, 576), ...uint(4, 288), ...uint(9, 1), ...string(10, name), ...uint(11, 1), ...bytes(12, content)]
    if (!(await this.#send(0xe0, hub(7, m, 7, [...uint(1, 1), ...bytes(3, container)]), m))) throw new Error("Text not acknowledged")
    this.#flip = !this.#flip
    this.#textName = name
  }

  #nextMagic() { this.#magic = this.#magic >= 255 ? 100 : this.#magic + 1; return this.#magic }

  #wait(sid: number, magic: number, ms: number) {
    const key = `${sid}:${magic}`
    this.#waiters.get(key)?.()
    return new Promise<Proto | undefined>(resolve => {
      const finish = (reply?: Proto) => { clearTimeout(timer); this.#waiters.delete(key); resolve(reply) }
      const timer = setTimeout(finish, ms)
      this.#waiters.set(key, finish)
    })
  }

  async #send(sid: number, payload: Uint8Array, magic: number, ms = 3000, flag = 0x20) {
    const reply = this.#wait(sid, magic, ms)
    await this.writeRaw(frames(payload, this.#seq++, sid, flag))
    return reply
  }

  #receive(raw: Uint8Array) {
    if (raw.length < 8 || raw[0] !== 0xaa || ![0x12, 0x21].includes(raw[1]!)) return
    const [, , seq, length, total, index, sid, flag] = raw as unknown as [number, number, number, number, number, number, number, number]
    if (sid === 0xf0) return this.dispatchEvent(new CustomEvent("cfw", { detail: raw }))
    if (length > raw.length - 8 || index < 1 || index > total) return
    const data = raw.subarray(8, 8 + length)
    if (index === 1) this.#fragments.set(seq, { next: 1, body: [] })
    const fragment = this.#fragments.get(seq)
    if (!fragment || fragment.next !== index) return
    fragment.body.push(...data)
    fragment.next++
    if (index !== total) return
    this.#fragments.delete(seq)
    const pb = decode(Uint8Array.from(fragment.body.slice(0, -2)))
    const waiter = flag !== 1 && this.#waiters.get(`${sid}:${pb.get(2)}`)
    if (waiter) return waiter(pb)
    if (sid !== 0xe0 || ![1, 6].includes(flag) || pb.get(1) !== 2) return
    const event = child(pb, 13)
    if (!event) return
    const code = child(event, 1)?.get(5) ?? child(event, 2)?.get(3) ?? child(event, 3)?.get(1)
    // Proto3 omits the zero-valued tap, but an empty envelope is not a gesture.
    if (![1, 2, 3].some(field => event.has(field))) return
    const gesture = gestures[typeof code === "number" ? code : 0]
    if (gesture) this.dispatchEvent(new CustomEvent("gesture", { detail: gesture }))
  }
}
