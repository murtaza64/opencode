import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm, stat, writeFile, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { encode } from "uqr"
import { canonicalCode, pairingSources, pairingURI, pairingView, pairingWindowPage, phoneOrigin, readPairing, rotatePairing, sshDestination, type Run } from "./pair-phone"

const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})
const code = "ABCD2-EFGH3-JKLM4-NPQR5"
const gateway = async (files: { code?: string; descriptor?: string }) => {
  const dir = await mkdtemp(path.join(tmpdir(), "es-pair-phone-"))
  cleanup.push(() => rm(dir, { recursive: true, force: true }))
  if (files.code !== undefined) await writeFile(path.join(dir, "remote-pairing-code"), files.code, { mode: 0o600 })
  if (files.descriptor !== undefined) await writeFile(path.join(dir, "gateway.json"), files.descriptor)
  return dir
}

test("the QR payload is the agreed opencode-desk URI with the exact origin and canonical code", () => {
  expect(pairingURI({ origin: "https://murtaza-mac-mini.tailc81fd.ts.net:8443", code }))
    .toBe("opencode-desk://pair?v=1&url=https%3A%2F%2Fmurtaza-mac-mini.tailc81fd.ts.net%3A8443&code=ABCD2-EFGH3-JKLM4-NPQR5")
})

test("only generated codes get the canonical form (and a QR)", () => {
  expect(canonicalCode(" abcd2efgh3 jklm4-npqr5\n")).toBe(code)
  for (const value of ["ABCD2-EFGH3-JKLM4", "ABCD1-EFGH3-JKLM4-NPQR5", "my-own-long-secret-code"]) expect(canonicalCode(value)).toBeUndefined()
})

test("phone origins are https without a path, or http on loopback", () => {
  expect(phoneOrigin("https://murtaza-mac-mini.tailc81fd.ts.net:8443")).toBe("https://murtaza-mac-mini.tailc81fd.ts.net:8443")
  expect(phoneOrigin("http://127.0.0.1:47120")).toBe("http://127.0.0.1:47120")
  for (const value of ["http://murtaza-mac-mini.tailc81fd.ts.net", "https://host/path", "https://u:p@host", "https://host/?x=1", "opencode-desk://pair", 42])
    expect(phoneOrigin(value)).toBeUndefined()
})

test("SSH destinations from config are aliases or user@host, never options or shell text", () => {
  expect(sshDestination("mini")).toBe("mini")
  expect(sshDestination("murtaza@excalibur.local")).toBe("murtaza@excalibur.local")
  for (const value of ["-oProxyCommand=x", "a b", "a;b", "$(id)", "a@b@c", "", 3]) expect(sshDestination(value)).toBeUndefined()
  const sources = pairingSources({ pairing: { mini: { ssh: "mini" }, bad: { ssh: "-F x" }, local: { ssh: "laptop" } } })
  expect([...sources.entries()]).toEqual([["mini", { kind: "ssh", destination: "mini" }]])
  expect(pairingSources({}).size).toBe(0)
})

test("this machine's gateway is read from its code file and descriptor", async () => {
  const dir = await gateway({ code: `${code}\n`, descriptor: JSON.stringify({ v: 1, origin: "https://murtaza-mac-mini.tailc81fd.ts.net:8443" }) })
  expect(await readPairing({ kind: "local", dir })).toEqual({ origin: "https://murtaza-mac-mini.tailc81fd.ts.net:8443", code })
})

test("a missing gateway, a missing descriptor or a non-https origin is an error, not a guess", async () => {
  expect(await readPairing({ kind: "local", dir: await gateway({}) })).toEqual({ error: expect.stringContaining("No phone gateway") })
  expect(await readPairing({ kind: "local", dir: await gateway({ code }) })).toEqual({ error: expect.stringContaining("No phone gateway") })
  expect(await readPairing({ kind: "local", dir: await gateway({ code, descriptor: '{"origin":"http://100.64.0.1:47120"}' }) })).toEqual({ error: expect.stringContaining("https origin") })
  expect(await readPairing({ kind: "local", dir: await gateway({ code: "short", descriptor: '{"origin":"https://h.ts.net"}' }) })).toEqual({ error: expect.stringContaining("no usable pairing code") })
})

test("another host is read over its owner SSH with a fixed script; the code never appears in the command", async () => {
  const calls: { destination: string; script: string; input?: string }[] = []
  const run: Run = async (destination, script, input) => {
    calls.push({ destination, script, input })
    return `${code}\n{"v":1,"origin":"https://excalibur.example.com"}\n`
  }
  expect(await readPairing({ kind: "ssh", destination: "excalibur" }, run)).toEqual({ origin: "https://excalibur.example.com", code })
  expect(calls).toEqual([{ destination: "excalibur", script: expect.stringContaining('cat -- "$d/remote-pairing-code"'), input: undefined }])
  const down: Run = async () => { throw new Error("unreachable") }
  expect(await readPairing({ kind: "ssh", destination: "excalibur" }, down)).toEqual({ error: "Could not read the gateway on excalibur over SSH." })
})

test("rotating writes a new owner-only code locally, and sends it over SSH stdin only", async () => {
  const dir = await gateway({ code, descriptor: '{"origin":"https://h.ts.net"}' })
  await rotatePairing({ kind: "local", dir })
  const rotated = (await readFile(path.join(dir, "remote-pairing-code"), "utf8")).trim()
  expect(canonicalCode(rotated)).toBe(rotated)
  expect(rotated).not.toBe(code)
  expect((await stat(path.join(dir, "remote-pairing-code"))).mode & 0o777).toBe(0o600)
  const calls: { script: string; input?: string }[] = []
  await rotatePairing({ kind: "ssh", destination: "mini" }, async (_destination, script, input) => (calls.push({ script, input }), ""))
  expect(canonicalCode(calls[0]!.input!.trim())).toBe(calls[0]!.input!.trim())
  expect(calls[0]!.script).not.toContain(calls[0]!.input!.trim())
  expect(calls[0]!.script).toContain("umask 077")
})

test("the window view carries a QR of the URI for a generated code and none for a hand-set one", () => {
  const view = pairingView("Mac Mini", { origin: "https://h.ts.net", code })
  expect(view).toMatchObject({ label: "Mac Mini", origin: "https://h.ts.net", code })
  expect(view.qr).toStartWith("<svg")
  expect(encode(pairingURI({ origin: "https://h.ts.net", code })).size).toBeGreaterThan(20)
  expect(pairingView("Mac Mini", { origin: "https://h.ts.net", code: "my-own-long-secret-code" }).qr).toBeUndefined()
  expect(pairingView("Mac Mini", { error: "nope" })).toEqual({ label: "Mac Mini", error: "nope" })
})

test("the window page itself holds no code and allows no network", () => {
  expect(pairingWindowPage).toContain("default-src 'none'")
  expect(pairingWindowPage).not.toMatch(/[2-9A-HJ-NP-Z]{5}-[2-9A-HJ-NP-Z]{5}/)
})
