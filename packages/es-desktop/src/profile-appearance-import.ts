/* Import one producer snapshot of a profile's appearance (A0, contracts/work-hosts-and-pins.md §5a) into that profile's
 * private content-digest cache, which createAppearance({ profile }) serves. The snapshot is the producer's immutable
 * transfer (manifest.json + wallpaper.<jpg|png|webp> + palette.json; schema frozen with the producer in dotfiles
 * docs/private-artifact-transfer.md); this verifies every byte against the manifest and writes the
 * asset, then the descriptor, each by rename, so a refused or interrupted import leaves the last good cache as it was.
 * No network and no credentials: the transfer itself happens on the producer's approved path. */
import { createHash } from "node:crypto"
import { chmod, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { legacyPaletteDigest, legacyPaletteOf } from "./appearance"

export const SNAPSHOT_SCHEMA = "es-private-artifact/1"
const MAX_ASSET = 64 * 1024 * 1024
const MAX_PALETTE = 64 * 1024
const TYPES: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" }

export type ImportReceipt =
  | { state: "imported" | "unchanged"; profile: string; transfer: string; sha256: string; paletteDigest: string }
  | { state: "refused"; profile: string; reason: string }

export const importProfileAppearance = async (input: { profile: string; from: string; to: string }): Promise<ImportReceipt> => {
  const snapshot = await readSnapshot(input.from, input.profile).catch((error: unknown) => error instanceof Refusal ? error : new Refusal("snapshot unreadable"))
  if (snapshot instanceof Refusal) return { state: "refused", profile: input.profile, reason: snapshot.message }
  const cache = await prepareCache(input.to)
  if (cache instanceof Refusal) return { state: "refused", profile: input.profile, reason: cache.message }
  const asset = `assets/${snapshot.sha256}.${snapshot.extension}`
  const descriptor = JSON.stringify({
    schema: "es-profile-appearance/1",
    profile: input.profile,
    producer: snapshot.producer,
    transfer: snapshot.transfer,
    consent: snapshot.consent,
    asset: { sha256: snapshot.sha256, file: asset, type: snapshot.type, bytes: snapshot.image.length, ...snapshot.size },
    palette: snapshot.palette,
  })
  const done = { profile: input.profile, transfer: snapshot.transfer, sha256: snapshot.sha256, paletteDigest: snapshot.paletteDigest }
  if (await readFile(path.join(input.to, "descriptor.json"), "utf8").catch(() => "") === descriptor) return { state: "unchanged", ...done }
  await replace(path.join(input.to, asset), snapshot.image)
  await replace(path.join(input.to, "descriptor.json"), Buffer.from(descriptor))
  // Keep the asset just replaced as well, so a page still holding the previous version can finish loading it.
  const previous = cache.previous
  const keep = new Set([path.basename(asset), ...(previous ? [previous] : [])])
  const assets = await readdir(path.join(input.to, "assets"))
  await Promise.all(assets.filter((name) => !keep.has(name)).map((name) => rm(path.join(input.to, "assets", name), { force: true })))
  return { state: "imported", ...done }
}

class Refusal extends Error {}

const readSnapshot = async (from: string, profile: string) => {
  const folder = await lstat(from)
  if (!folder.isDirectory()) throw new Refusal("snapshot is not a directory")
  const manifest = record(JSON.parse(await regular(from, "manifest.json", MAX_PALETTE).then((bytes) => bytes.toString("utf8"))))
  const meta = record(manifest.image)
  const type = typeof meta.type === "string" ? meta.type : ""
  const extension = TYPES[type]
  if (!extension) throw new Refusal("unsupported image type")
  const wallpaper = `wallpaper.${extension}`
  const names = (await readdir(from)).sort()
  if (names.join(",") !== ["manifest.json", "palette.json", wallpaper].sort().join(",")) throw new Refusal(`snapshot must hold exactly manifest.json, palette.json and ${wallpaper}`)
  if (manifest.schema !== SNAPSHOT_SCHEMA || manifest.kind !== "profile-appearance") throw new Refusal("unknown snapshot schema or kind")
  if (manifest.profile !== profile) throw new Refusal(`snapshot is for profile ${String(manifest.profile)}`)
  if (typeof manifest.producer !== "string" || !/^[a-z][a-z0-9-]{0,31}$/.test(manifest.producer)) throw new Refusal("bad producer")
  if (typeof manifest.transfer !== "string" || !/^[A-Za-z0-9:._-]{1,128}$/.test(manifest.transfer)) throw new Refusal("bad transfer id")
  // The producer names who receives it; when it does, it must be this profile's appearance cache.
  const receiver = record(manifest.receiver)
  if (manifest.receiver !== undefined && (receiver.profile !== profile || receiver.destination !== "profile-appearance")) throw new Refusal("snapshot is addressed to another receiver")
  const files = record(manifest.files)
  const image = await verified(from, wallpaper, record(files[wallpaper]), MAX_ASSET)
  const paletteBytes = await verified(from, "palette.json", record(files["palette.json"]), MAX_PALETTE)
  const palette = legacyPaletteOf(JSON.parse(paletteBytes.toString("utf8")))
  if (!palette) throw new Refusal("palette must be pywal-legacy/1 with a background and a foreground")
  // The producer states the digest of the palette it sent; what this import will serve must be exactly that palette.
  if (manifest.paletteDigest !== legacyPaletteDigest(palette)) throw new Refusal("palette does not match the manifest paletteDigest")
  const consent = Array.isArray(manifest.consent) ? manifest.consent.filter((value): value is string => typeof value === "string").map((value) => value.slice(0, 128)).slice(0, 8) : []
  return {
    producer: manifest.producer,
    transfer: manifest.transfer,
    consent,
    type,
    extension,
    size: dimensions(meta),
    image,
    sha256: createHash("sha256").update(image).digest("hex"),
    palette,
    paletteDigest: legacyPaletteDigest(palette),
  }
}

// The cache directory is created private; an existing one must already be the user's and not writable by others.
const prepareCache = async (to: string) => {
  await mkdir(path.join(to, "assets"), { recursive: true, mode: 0o700 })
  const info = await lstat(to)
  const owner = process.getuid?.()
  if (!info.isDirectory() || (owner !== undefined && info.uid !== owner)) return new Refusal("cache directory is not this user's")
  await chmod(to, 0o700)
  const current = record(await readFile(path.join(to, "descriptor.json"), "utf8").then((text): unknown => JSON.parse(text)).catch(() => ({})))
  const asset = record(current.asset)
  return { previous: typeof asset.file === "string" ? path.basename(asset.file) : undefined }
}

const regular = async (from: string, name: string, limit: number) => {
  const info = await lstat(path.join(from, name))
  if (!info.isFile()) throw new Refusal(`${name} is not a regular file`)
  if (info.size > limit) throw new Refusal(`${name} is too large`)
  return readFile(path.join(from, name))
}

const verified = async (from: string, name: string, expected: Record<string, unknown>, limit: number) => {
  const bytes = await regular(from, name, limit)
  if (expected.bytes !== bytes.length || expected.sha256 !== createHash("sha256").update(bytes).digest("hex")) throw new Refusal(`${name} does not match the manifest`)
  return bytes
}

const dimensions = (meta: Record<string, unknown>) => {
  const width = Number.isInteger(meta.width) && (meta.width as number) > 0 ? (meta.width as number) : undefined
  const height = Number.isInteger(meta.height) && (meta.height as number) > 0 ? (meta.height as number) : undefined
  return width && height ? { width, height } : {}
}

const record = (value: unknown) => (value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {})

const replace = async (file: string, bytes: Buffer) => {
  await writeFile(`${file}.tmp`, bytes, { mode: 0o600 })
  await rename(`${file}.tmp`, file)
}
