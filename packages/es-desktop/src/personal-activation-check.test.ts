import { afterEach, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import path from "node:path"
import { legacyPaletteDigest, legacyPaletteOf } from "./appearance"
import { postCheck, preCheck } from "./personal-activation-check"
import { importProfileAppearance } from "./profile-appearance-import"

const cleanup: (() => Promise<unknown> | unknown)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})
const temp = async (prefix: string) => {
  const directory = await mkdtemp(path.join(tmpdir(), prefix))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  return directory
}
const sha = (bytes: string) => createHash("sha256").update(bytes).digest("hex")
const TRANSFER = `personal-appearance:64b951fe${"0".repeat(24)}`
const page = { id: "personal", label: "Personal", origin: "https://agents.murtaza.earth", mode: "page" }
const bridged = { id: "excalibur", label: "Excalibur", origin: "https://excalibur.murtaza.earth", mode: "bridged", access: { keychain: "excalibur-access" }, kind: "pc" }
const workReceipt = { schema: "es-appearance-receipt/1", background: "#101010", foreground: "#eeeeee", walRevision: "work-rev-1", updatedAt: 1, applied: [{ host: "local", walRevision: "work-rev-1", theme: "wallpaper", appliedAt: 2 }] }

// A Laptop before activation: the page host only, the Work receipt, and the imported Personal cache (fixture bytes).
const laptop = async () => {
  const userData = await temp("es-userdata-")
  const cache = path.join(await temp("es-cache-root-"), "personal")
  const from = await temp("es-snapshot-")
  const image = "joi fixture bytes"
  const palette = JSON.stringify({ schema: "pywal-legacy/1", special: { background: "#1a0b2e", foreground: "#f0e6ff" }, colors: { color0: "#1a0b2e" } })
  await writeFile(path.join(from, "wallpaper.jpg"), image)
  await writeFile(path.join(from, "palette.json"), palette)
  await writeFile(path.join(from, "manifest.json"), JSON.stringify({
    schema: "es-private-artifact/1", kind: "profile-appearance", profile: "personal", producer: "excalibur", producer_zone: "personal",
    receiver: { host: "laptop", zone: "work", profile: "personal", destination: "profile-appearance" },
    transfer: TRANSFER, consent: ["ses_a/msg_b/prt_c@1793540000000"],
    files: { "wallpaper.jpg": { sha256: sha(image), bytes: image.length }, "palette.json": { sha256: sha(palette), bytes: palette.length } },
    image: { type: "image/jpeg", width: 3840, height: 2160 },
    paletteDigest: legacyPaletteDigest(legacyPaletteOf(JSON.parse(palette))!),
    source: { snapshot: "f".repeat(64), producer_receipt_sha256: "e".repeat(64), files: {} },
  }))
  const imported = await importProfileAppearance({ profile: "personal", from, to: cache })
  if (imported.state === "refused") throw new Error(imported.reason)
  await writeFile(path.join(userData, "service-origins.json"), JSON.stringify({ opencode: "http://127.0.0.1:4096", dashboard: "http://127.0.0.1:7777", hosts: [page] }))
  await writeFile(path.join(userData, "appearance-receipt.json"), JSON.stringify(workReceipt))
  return { userData, cache, imported }
}

const snapshotOf = async (directory: string) => Promise.all((await readdir(directory, { recursive: true })).toSorted().map(async (name) => {
  const info = await stat(path.join(directory, name))
  return [name, info.mtimeMs, info.size]
}))

test("pre records the config, page entry bytes, Keychain presence by exit code, the verified cache and Work's look, and writes nothing", async () => {
  const machine = await laptop()
  const before = [await snapshotOf(machine.userData), await snapshotOf(machine.cache)]
  const asked: string[] = []
  const pre = await preCheck({ ...machine, host: "excalibur", transfer: "64b951fe", keychain: ["excalibur-access"],
    keychainExit: async (item, account) => { asked.push(`${item}/${account}`); return account === "client-id" ? 0 : 44 } })
  expect(pre.serviceOrigins).toMatchObject({ present: true, valid: true, sha256: sha(await readFile(path.join(machine.userData, "service-origins.json"), "utf8")),
    hosts: [{ id: "personal", mode: "page", profile: "personal" }], pageEntry: { json: JSON.stringify(page), sha256: sha(JSON.stringify(page)) } })
  expect(asked).toEqual(["excalibur-access/client-id", "excalibur-access/client-secret"])
  expect(pre.keychain).toEqual([
    { item: "excalibur-access", account: "client-id", present: true, exitCode: 0 },
    { item: "excalibur-access", account: "client-secret", present: false, exitCode: 44 },
  ])
  expect(pre.profileCache).toMatchObject({ present: true, profile: "personal", producer: "excalibur", transfer: TRANSFER, transferMatches: true,
    assetVerified: true, asset: { sha256: machine.imported.sha256 }, paletteDigest: machine.imported.paletteDigest })
  expect(pre.work).toMatchObject({ present: true, walRevision: "work-rev-1", background: "#101010" })
  expect([await snapshotOf(machine.userData), await snapshotOf(machine.cache)]).toEqual(before)
})

test("a cache asset whose bytes do not match its sha256 is reported unverified", async () => {
  const machine = await laptop()
  const descriptor = JSON.parse(await readFile(path.join(machine.cache, "descriptor.json"), "utf8"))
  await writeFile(path.join(machine.cache, descriptor.asset.file), "other bytes")
  const pre = await preCheck({ ...machine, host: "excalibur", transfer: "64b951fe", keychainExit: async () => 44 })
  expect(pre.profileCache).toMatchObject({ assetVerified: false })
  expect(pre.keychain).toEqual([])
})

test("post reads the listener, the Personal receipt's consumed and excalibur applied entries, and finds Work unchanged", async () => {
  const machine = await laptop()
  const pre = await preCheck({ ...machine, host: "excalibur", transfer: "64b951fe", keychainExit: async () => 0 })
  // The activation: the bridged entry added beside the page entry; the app served and the excalibur page applied the look.
  await writeFile(path.join(machine.userData, "service-origins.json"), JSON.stringify({ opencode: "http://127.0.0.1:4096", dashboard: "http://127.0.0.1:7777", hosts: [page, bridged] }))
  await writeFile(path.join(machine.userData, "appearance-receipt-personal.json"), JSON.stringify({
    schema: "es-appearance-receipt/1", consumed: { transfer: TRANSFER, sha256: machine.imported.sha256, paletteDigest: machine.imported.paletteDigest, identity: "x" },
    wallpaper: "/__es/appearance/wallpaper?v=abc", background: "#1a0b2e", foreground: "#f0e6ff", walRevision: "personal-rev", updatedAt: 3,
    applied: [{ host: "excalibur", walRevision: "personal-rev", theme: "wallpaper", appliedAt: 4 }, { host: "local", walRevision: null, theme: "default", appliedAt: 5 }],
  }))
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  cleanup.push(() => new Promise((resolve) => server.close(resolve)))
  const port = (server.address() as { port: number }).port
  await writeFile(path.join(machine.userData, "loopback-port-excalibur"), String(port))
  const post = await postCheck({ ...machine, host: "excalibur", transfer: "64b951fe", pre })
  expect(post.serviceOrigins).toMatchObject({ valid: true, hosts: [{ id: "personal" }, { id: "excalibur", mode: "bridged", access: { keychain: "excalibur-access" } }] })
  expect(post.listener).toMatchObject({ port, reachable: true })
  expect(post.personal.consumed).toEqual({ transfer: TRANSFER, sha256: machine.imported.sha256, paletteDigest: machine.imported.paletteDigest })
  expect(post.personal.applied).toEqual([{ host: "excalibur", walRevision: "personal-rev", theme: "wallpaper", appliedAt: 4 }])
  expect(post.checks).toEqual({ consumedTransfer: true, appliedOnHost: true, workUnchanged: true })
})

test("no Work receipt before or after is not reported as a Work regression", async () => {
  const machine = await laptop()
  await rm(path.join(machine.userData, "appearance-receipt.json"))
  const pre = await preCheck({ ...machine, host: "excalibur", transfer: "64b951fe", keychainExit: async () => 0 })
  const post = await postCheck({ ...machine, host: "excalibur", transfer: "64b951fe", pre })
  expect(post.checks.workUnchanged).toBeNull()
})

test("post reports a changed Work look and a missing Personal receipt as failed checks", async () => {
  const machine = await laptop()
  const pre = await preCheck({ ...machine, host: "excalibur", transfer: "64b951fe", keychainExit: async () => 0 })
  await writeFile(path.join(machine.userData, "appearance-receipt.json"), JSON.stringify({ ...workReceipt, walRevision: "work-rev-2" }))
  const post = await postCheck({ ...machine, host: "excalibur", transfer: "64b951fe", pre })
  expect(post.listener).toEqual({ port: undefined, reachable: false })
  expect(post.checks).toEqual({ consumedTransfer: false, appliedOnHost: false, workUnchanged: false })
})
