import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { gatewayDescriptor, pairingCode, storePairingCode, watchedPairingCode } from "./gateway"

const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close()
})
const scratch = async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "es-gateway-test-"))
  cleanup.push(() => rm(dir, { recursive: true, force: true }))
  return dir
}

test("first run stores a generated code owner-only and later runs reuse it", async () => {
  const file = path.join(await scratch(), "state/remote-pairing-code")
  const first = await pairingCode(file)
  expect((await stat(file)).mode & 0o777).toBe(0o600)
  expect(await pairingCode(file)).toBe(first)
})

test("a truncated code file is replaced instead of trusted", async () => {
  const file = path.join(await scratch(), "remote-pairing-code")
  await writeFile(file, "SHORT\n")
  expect(await pairingCode(file)).toMatch(/^[2-9A-HJ-NP-Z]{5}(-[2-9A-HJ-NP-Z]{5}){3}$/)
})

test("gateway output names where the code lives but never prints it", async () => {
  const dir = await scratch()
  const file = path.join(dir, "remote-pairing-code")
  await writeFile(path.join(dir, "index.html"), "<title>fixture</title>")
  const child = Bun.spawn(["bun", path.join(import.meta.dir, "gateway.ts"), "--port", "0", "--code-file", file, "--root", dir], {
    env: { ...process.env, ES_REMOTE_PAIRING_CODE: "", OPENCODE_URL: "", ES_DASHBOARD_URL: "" },
    stdout: "pipe",
    stderr: "pipe",
  })
  cleanup.push(async () => {
    child.kill()
    await child.exited
  })
  const reader = child.stdout.getReader()
  const output: string[] = []
  while (!output.join("").includes("adb reverse")) {
    const chunk = await reader.read()
    if (chunk.done) break
    output.push(new TextDecoder().decode(chunk.value))
  }
  const code = (await Bun.file(file).text()).trim()
  expect(output.join("")).toContain(file)
  expect(output.join("")).not.toContain(code)
  expect(output.join("")).not.toContain(code.replaceAll("-", ""))
  // Pair a Phone reads the phone-facing origin beside the code file; it holds no secret.
  const descriptor = await Bun.file(gatewayDescriptor(file)).json()
  expect(descriptor).toEqual({ v: 1, origin: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+$/) })
  expect(JSON.stringify(descriptor)).not.toContain(code)
})

test("a rewritten code file is picked up within a second; nothing else changes the code", async () => {
  const file = path.join(await scratch(), "remote-pairing-code")
  const first = await pairingCode(file)
  const clock = { now: 1_000_000 }
  const code = watchedPairingCode(file, first, () => clock.now)
  await Bun.sleep(5)
  const rotated = await storePairingCode(file, "ZZZZZ-YYYYY-XXXXX-WWWWW")
  expect(code()).toBe(first)
  clock.now += 1000
  expect(code()).toBe(rotated)
  await writeFile(file, "SHORT\n")
  clock.now += 1000
  expect(code()).toBe(rotated)
})

test("deleting the code file revokes: a new owner-only code is written", async () => {
  const file = path.join(await scratch(), "remote-pairing-code")
  const first = await pairingCode(file)
  const clock = { now: 1_000_000 }
  const code = watchedPairingCode(file, first, () => clock.now)
  await rm(file)
  clock.now += 1000
  const next = code()
  expect(next).not.toBe(first)
  expect((await Bun.file(file).text()).trim()).toBe(next)
  expect((await stat(file)).mode & 0o777).toBe(0o600)
})
