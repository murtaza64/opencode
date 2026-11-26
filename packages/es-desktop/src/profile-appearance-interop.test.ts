/* Interop with the producer's ledger: a receipt this consumer writes, read by dotfiles es-artifact `consumed`
 * (es_artifact_lib ProfileAppearance.consumed). Runs when ES_ARTIFACT_LIB names that dotfiles bin directory:
 *   ES_ARTIFACT_LIB=~/dotfiles/bin bun test src/profile-appearance-interop.test.ts */
import { afterEach, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { createAppearance, legacyPaletteDigest, legacyPaletteOf } from "./appearance"
import { importProfileAppearance } from "./profile-appearance-import"

const cleanup: (() => Promise<unknown> | unknown)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

const lib = process.env.ES_ARTIFACT_LIB

test.skipIf(!lib)("es-artifact consumed accepts the receipt this consumer writes for a served snapshot", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "es-interop-"))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const from = path.join(root, "snap")
  await mkdir(from)
  const image = "joi fixture bytes"
  const palette = JSON.stringify({ schema: "pywal-legacy/1", special: { background: "#1a0b2e", foreground: "#f0e6ff", cursor: "#ff66cc" }, colors: { color0: "#1a0b2e" } })
  const sha = (value: string) => createHash("sha256").update(value).digest("hex")
  const transfer = `personal-appearance:${"2".repeat(32)}`
  await writeFile(path.join(from, "wallpaper.jpg"), image)
  await writeFile(path.join(from, "palette.json"), palette)
  await writeFile(path.join(from, "manifest.json"), JSON.stringify({
    schema: "es-private-artifact/1", kind: "profile-appearance", profile: "personal", producer: "excalibur", transfer, consent: [],
    receiver: { host: "laptop", zone: "work", profile: "personal", destination: "profile-appearance" },
    files: { "wallpaper.jpg": { sha256: sha(image), bytes: image.length }, "palette.json": { sha256: sha(palette), bytes: palette.length } },
    image: { type: "image/jpeg", width: 1, height: 1 },
    paletteDigest: legacyPaletteDigest(legacyPaletteOf(JSON.parse(palette))!),
  }))
  const cache = path.join(root, "appearance")
  const userData = path.join(root, "userdata")
  await mkdir(userData)
  expect((await importProfileAppearance({ profile: "personal", from, to: cache })).state).toBe("imported")
  const appearance = createAppearance({ directory: cache, profile: "personal", receipt: path.join(userData, "appearance-receipt-personal.json"), blur: async () => Buffer.from("x") })
  cleanup.push(() => appearance.close())
  await appearance.ready
  const item = { id: transfer, descriptor: { asset: { digest: `sha256:${sha(image)}`, mime: "image/jpeg" }, palette: JSON.parse(palette) } }
  const script = `import json, sys; sys.path.insert(0, ${JSON.stringify(lib)}); import es_artifact_lib as art
print(json.dumps(art.DESTINATIONS["profile-appearance"].consumed({"receiver_profile": "personal"}, json.loads(sys.argv[1]))))`
  const run = Bun.spawnSync(["python3", "-c", script, JSON.stringify(item)], { env: { ...process.env, ES_DESKTOP_USERDATA: userData, ES_PERSONAL_APPEARANCE_DIR: cache } })
  expect(run.stderr.toString()).toBe("")
  const evidence = JSON.parse(run.stdout.toString())
  expect(evidence).toMatchObject({ consumer: "es-desktop", level: "served", paletteDigest: legacyPaletteDigest(legacyPaletteOf(JSON.parse(palette))!) })
})
