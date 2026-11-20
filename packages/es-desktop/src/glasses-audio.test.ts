import { expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { decodeLC3 } from "./glasses-audio"

const toneWav = (samples: number) => {
  const data = Buffer.alloc(samples * 2)
  for (let i = 0; i < samples; i++) data.writeInt16LE(Math.round(8000 * Math.sin((2 * Math.PI * 440 * i) / 16000)), i * 2)
  const head = Buffer.alloc(44)
  head.write("RIFF", 0)
  head.writeUInt32LE(36 + data.length, 4)
  head.write("WAVEfmt ", 8)
  head.writeUInt32LE(16, 16)
  head.writeUInt16LE(1, 20)
  head.writeUInt16LE(1, 22)
  head.writeUInt32LE(16000, 24)
  head.writeUInt32LE(32000, 28)
  head.writeUInt16LE(2, 32)
  head.writeUInt16LE(16, 34)
  head.write("data", 36)
  head.writeUInt32LE(data.length, 40)
  return Buffer.concat([head, data])
}

const encode = String.raw`
import ctypes, sys, wave
lib = ctypes.CDLL("/opt/homebrew/lib/liblc3.dylib")
lib.lc3_encoder_size.argtypes = [ctypes.c_int, ctypes.c_int]
lib.lc3_encoder_size.restype = ctypes.c_uint
lib.lc3_setup_encoder.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_void_p]
lib.lc3_setup_encoder.restype = ctypes.c_void_p
lib.lc3_encode.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_void_p, ctypes.c_int, ctypes.c_int, ctypes.c_void_p]
with wave.open(sys.argv[1]) as w:
    pcm = w.readframes(w.getnframes())
mem = ctypes.create_string_buffer(lib.lc3_encoder_size(10000, 16000))
enc = lib.lc3_setup_encoder(10000, 16000, 0, mem)
out = bytearray()
for n, i in enumerate(range(0, len(pcm) // 2 - 800 + 1, 800)):
    packet = bytearray()
    for f in range(5):
        start = (i + f * 160) * 2
        chunk = ctypes.create_string_buffer(pcm[start:start + 320], 320)
        frame = ctypes.create_string_buffer(40)
        lib.lc3_encode(enc, 0, chunk, 1, 40, frame)
        packet += frame.raw
    packet += bytes([0, 0, 0, 0, n & 0xff])
    if n % 5 == 4:
        continue
    out += packet
open(sys.argv[2], "wb").write(out)
`

test.if(existsSync("/opt/homebrew/lib/liblc3.dylib"))("decodeLC3 decodes G2 packets and conceals dropped ones", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "es-lc3-test-"))
  try {
    const inWav = path.join(dir, "in.wav")
    const packets = path.join(dir, "p.bin")
    const outWav = path.join(dir, "out.wav")
    writeFileSync(inWav, toneWav(41 * 800))
    execFileSync("/usr/bin/python3", ["-c", encode, inWav, packets])
    expect(statSync(packets).size).toBe(33 * 205)
    execFileSync("/usr/bin/python3", ["-c", decodeLC3, packets, outWav])
    expect(statSync(outWav).size).toBe(44 + 41 * 800 * 2)
    const pcm = readFileSync(outWav).subarray(44)
    let sum = 0
    for (let i = 0; i < pcm.length; i += 2) sum += pcm.readInt16LE(i) ** 2
    expect(Math.sqrt(sum / (pcm.length / 2))).toBeGreaterThan(3000)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
