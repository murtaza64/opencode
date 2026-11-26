import { afterEach, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { lstat, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { createAppearance, legacyPaletteDigest, legacyPaletteOf } from "./appearance"
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

// A producer snapshot as delivered: fixture bytes stand in for the wallpaper; nothing here is a real asset.
const snapshot = async (options: { image?: string; background?: string; manifest?: Record<string, unknown>; transfer?: string } = {}) => {
  const from = await temp("es-snapshot-")
  const image = options.image ?? "joi fixture bytes"
  const palette = JSON.stringify({ schema: "pywal-legacy/1", special: { background: options.background ?? "#1a0b2e", foreground: "#f0e6ff", cursor: "#ff66cc" }, colors: { color0: "#1a0b2e", color5: "#ff66cc", bad: "url(x)" } })
  await writeFile(path.join(from, "wallpaper.jpg"), image)
  await writeFile(path.join(from, "palette.json"), palette)
  await writeFile(path.join(from, "manifest.json"), JSON.stringify({
    schema: "es-private-artifact/1", kind: "profile-appearance", profile: "personal", producer: "excalibur", producer_zone: "personal",
    receiver: { host: "laptop", zone: "work", profile: "personal", destination: "profile-appearance" },
    transfer: options.transfer ?? `personal-appearance:${"1".repeat(32)}`, consent: ["ses_a/msg_b/prt_c@1793540000000"],
    files: { "wallpaper.jpg": { sha256: sha(image), bytes: image.length }, "palette.json": { sha256: sha(palette), bytes: palette.length } },
    image: { type: "image/jpeg", width: 3840, height: 2160 },
    paletteDigest: legacyPaletteDigest(legacyPaletteOf(JSON.parse(palette))!),
    source: { snapshot: "f".repeat(64), producer_receipt_sha256: "e".repeat(64), files: {} },
    ...options.manifest,
  }))
  return { from, sha256: sha(image) }
}

const serve = async (to: string, receipt?: string) => {
  const appearance = createAppearance({ directory: to, profile: "personal", poll: 20, debounce: 20, receipt, blur: async (file) => Buffer.from(path.basename(file)) })
  cleanup.push(() => appearance.close())
  await appearance.ready
  return appearance
}

test("an import verifies the snapshot and writes a private cache the Personal appearance serves", async () => {
  const snap = await snapshot()
  const to = path.join(await temp("es-cache-"), "personal")
  const receipt = await importProfileAppearance({ profile: "personal", from: snap.from, to })
  expect(receipt).toEqual({ state: "imported", profile: "personal", transfer: `personal-appearance:${"1".repeat(32)}`, sha256: snap.sha256, paletteDigest: expect.stringMatching(/^[0-9a-f]{64}$/) })
  expect((await stat(to)).mode & 0o777).toBe(0o700)
  expect((await stat(path.join(to, "assets", `${snap.sha256}.jpg`))).mode & 0o777).toBe(0o600)
  const descriptor = JSON.parse(await readFile(path.join(to, "descriptor.json"), "utf8"))
  expect(descriptor.consent).toEqual(["ses_a/msg_b/prt_c@1793540000000"])
  expect(descriptor.palette.colors).toEqual({ color0: "#1a0b2e", color5: "#ff66cc" })
  const receiptFile = path.join(path.dirname(to), "appearance-receipt-personal.json")
  const appearance = await serve(to, receiptFile)
  expect(appearance.body()?.palette.background).toBe("#1a0b2e")
  expect(appearance.image()?.toString()).toBe(`${snap.sha256}.jpg`)
  // One palette digest: what the importer reported is what the consumer serves.
  const served = JSON.parse(await readFile(receiptFile, "utf8")).consumed
  expect([served.transfer, served.sha256, served.paletteDigest]).toEqual([receipt.state === "imported" && receipt.transfer, snap.sha256, receipt.state === "imported" && receipt.paletteDigest])
})

test("the palette digest is the producer's: canonical JSON of {schema, special, colors}, keys sorted at every level", () => {
  // Golden value from dotfiles es_artifact_lib.palette_digest_of (274245cd) for this palette.
  const palette = legacyPaletteOf({ schema: "pywal-legacy/1", special: { background: "#1a0b2e", foreground: "#f0e6ff", cursor: "#ff66cc" }, colors: { color5: "#ff66cc", color0: "#1a0b2e" } })!
  expect(legacyPaletteDigest(palette)).toBe("c922ea4026fbd7a5fd90df70683d0722a8b24cef57a2059e349be27c7d912572")
})

test("importing the same snapshot again changes nothing", async () => {
  const snap = await snapshot()
  const to = path.join(await temp("es-cache-"), "personal")
  await importProfileAppearance({ profile: "personal", from: snap.from, to })
  const before = (await stat(path.join(to, "descriptor.json"))).mtimeMs
  expect((await importProfileAppearance({ profile: "personal", from: snap.from, to })).state).toBe("unchanged")
  expect((await stat(path.join(to, "descriptor.json"))).mtimeMs).toBe(before)
})

test.each([
  ["another profile", { manifest: { profile: "work" } }, "profile work"],
  ["an unknown schema", { manifest: { schema: "es-private-artifact/2" } }, "schema"],
  ["a wallpaper digest that does not match", { manifest: { files: { "wallpaper.jpg": { sha256: "0".repeat(64), bytes: 17 }, "palette.json": {} } } }, "does not match"],
  ["an unsupported image type", { manifest: { image: { type: "image/svg+xml" } } }, "image type"],
  ["an image type that does not match the file name", { manifest: { image: { type: "image/png" } } }, "wallpaper.png"],
  ["a palette that is not the manifest's", { manifest: { paletteDigest: "0".repeat(64) } }, "paletteDigest"],
  ["another receiver", { manifest: { receiver: { host: "laptop", zone: "work", profile: "work", destination: "profile-appearance" } } }, "another receiver"],
])("a snapshot with %s is refused and the last good cache stays", async (_name, options, reason) => {
  const to = path.join(await temp("es-cache-"), "personal")
  const good = await snapshot()
  await importProfileAppearance({ profile: "personal", from: good.from, to })
  const before = await readFile(path.join(to, "descriptor.json"), "utf8")
  const bad = await snapshot({ ...options, image: "other bytes", transfer: "xfer-2" })
  const receipt = await importProfileAppearance({ profile: "personal", from: bad.from, to })
  expect(receipt.state).toBe("refused")
  expect(receipt.state === "refused" && receipt.reason).toContain(reason)
  expect(await readFile(path.join(to, "descriptor.json"), "utf8")).toBe(before)
  expect(await readdir(path.join(to, "assets"))).toEqual([`${good.sha256}.jpg`])
})

test("a snapshot with an extra file or a symlinked wallpaper is refused", async () => {
  const to = path.join(await temp("es-cache-"), "personal")
  const extra = await snapshot()
  await writeFile(path.join(extra.from, "notes.txt"), "x")
  expect((await importProfileAppearance({ profile: "personal", from: extra.from, to })).state).toBe("refused")
  const linked = await snapshot()
  const outside = path.join(await temp("es-outside-"), "wall.jpg")
  await writeFile(outside, "joi fixture bytes")
  await rm(path.join(linked.from, "wallpaper.jpg"))
  await symlink(outside, path.join(linked.from, "wallpaper.jpg"))
  const receipt = await importProfileAppearance({ profile: "personal", from: linked.from, to })
  expect(receipt.state === "refused" && receipt.reason).toContain("not a regular file")
  expect(await lstat(path.join(to, "descriptor.json")).catch(() => undefined)).toBeUndefined()
})

test("a new snapshot replaces the served look and keeps only the current and previous asset", async () => {
  const to = path.join(await temp("es-cache-"), "personal")
  const first = await snapshot({ image: "first" })
  const second = await snapshot({ image: "second", background: "#22113a", transfer: "xfer-2" })
  const third = await snapshot({ image: "third", transfer: "xfer-3" })
  await importProfileAppearance({ profile: "personal", from: first.from, to })
  const appearance = await serve(to)
  await importProfileAppearance({ profile: "personal", from: second.from, to })
  await Bun.sleep(120)
  expect(appearance.body()?.palette.background).toBe("#22113a")
  await importProfileAppearance({ profile: "personal", from: third.from, to })
  expect((await readdir(path.join(to, "assets"))).sort()).toEqual([`${second.sha256}.jpg`, `${third.sha256}.jpg`].sort())
})

test("the served receipt has exactly the checked-in shape the producer's ledger reads", async () => {
  // test/fixtures/appearance-receipt-personal.json is shared with dotfiles es_artifact_lib (es_desktop_receipt()): the
  // receipt this snapshot yields, with updatedAt fixed. Inputs are fixed so every digest in it is fixed.
  const from = await temp("es-snapshot-")
  const image = "receipt fixture wallpaper bytes"
  const palette = JSON.stringify({ schema: "pywal-legacy/1", special: { background: "#1a0b2e", foreground: "#f0e6ff", cursor: "#ff66cc" }, colors: { color0: "#1a0b2e", color5: "#ff66cc" } })
  await writeFile(path.join(from, "wallpaper.jpg"), image)
  await writeFile(path.join(from, "palette.json"), palette)
  await writeFile(path.join(from, "manifest.json"), JSON.stringify({
    schema: "es-private-artifact/1", kind: "profile-appearance", profile: "personal", producer: "excalibur", transfer: `personal-appearance:${"3".repeat(32)}`, consent: [],
    files: { "wallpaper.jpg": { sha256: sha(image), bytes: image.length }, "palette.json": { sha256: sha(palette), bytes: palette.length } },
    image: { type: "image/jpeg", width: 1, height: 1 },
    paletteDigest: "c922ea4026fbd7a5fd90df70683d0722a8b24cef57a2059e349be27c7d912572",
  }))
  const root = await temp("es-receipt-")
  expect((await importProfileAppearance({ profile: "personal", from, to: path.join(root, "personal") })).state).toBe("imported")
  const appearance = createAppearance({ directory: path.join(root, "personal"), profile: "personal", renderer: "studio-gaussian-1", receipt: path.join(root, "receipt.json"), blur: async () => Buffer.from("x") })
  cleanup.push(() => appearance.close())
  await appearance.ready
  const written = await readFile(path.join(root, "receipt.json"), "utf8")
  const expected = await readFile(path.join(import.meta.dir, "../test/fixtures/appearance-receipt-personal.json"), "utf8")
  expect({ ...JSON.parse(written), updatedAt: 1793540000000 }).toEqual(JSON.parse(expected))
  expect(Object.keys(JSON.parse(written))).toEqual(Object.keys(JSON.parse(expected)))
})
