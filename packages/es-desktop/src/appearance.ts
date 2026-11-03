/* This laptop's desktop appearance (pywal): the palette from ~/.cache/wal/colors.json, a small
 * pre-blurred copy of its wallpaper (WalStudio's `studio` blur and dim when colors.json names them), and the wal-palette/1 artifact roles from palette.json beside
 * it, served to app pages at fixed routes. Only the file pywal names is read, only as an image, and
 * only on this machine; host tabs show the same local look, never an execution host's palette.
 *
 * A profile appearance (`profile` option) instead reads one verified private cache that a profile's producer filled
 * (contract: lanes/remote-host-client/contracts/work-hosts-and-pins.md §5a): descriptor.json naming one asset by its
 * sha256 and a pywal legacy palette. Only that profile's listeners serve it, so the Work look never shows there and the
 * profile's look never shows in Work. */
import { createHash } from "node:crypto"
import { unwatchFile, watchFile } from "node:fs"
import { lstat, readFile, rename, stat, writeFile } from "node:fs/promises"
import path from "node:path"

/** wal-palette/1 (pywal docs/wal-palette.md): role colours artifacts use as `--wal-<role>`. */
export type WalPalette = { revision: string; scheme: "dark" | "light"; roles: Record<string, string>; highlights: string[]; okRiskCvdSafe: boolean }
/** WalStudio's wallpaper look from colors.json `studio`: blur sigma in pixels of the full image (0-64) and dim toward
 * black (0-0.8), the ranges Studio writes. */
export type StudioLook = { blur: number; dim: number }
export type AppearanceState = { palette: Record<string, string>; wallpaper?: string; wal?: WalPalette; look?: StudioLook; updatedAt: number }

/** How a Studio look is rendered: resize the image to `work` pixels wide, blur there with `sigma` (work pixels; 0 = none),
 * then scale to `output`, the widest display's device width (never past the image, never under 640), since the page
 * stretches it over the window. Studio's sigma is in pixels of the full image; the work width keeps the blur at least
 * 4 work pixels so a cheap blur stays smooth when scaled up (resampling alone left a visible sample grid). */
export const blurPlan = (imageWidth: number, sigma: number, displayWidth: number) => {
  const output = Math.max(640, Math.min(Math.round(imageWidth), Math.round(displayWidth)))
  if (sigma <= 0) return { work: output, sigma: 0, output }
  const work = Math.max(16, Math.min(output, Math.round((imageWidth * 4) / sigma)))
  return { work, sigma: (sigma * work) / imageWidth, output }
}

/** Gaussian blur of 4-channel pixels in place, approximated by three box blurs per axis (running sums, so the cost does
 * not grow with sigma). Edges repeat the border pixel. Self-contained (no outer references): blur-worker.ts runs its
 * source in a worker thread. */
export const gaussianBlur = (pixels: Uint8Array, width: number, height: number, sigma: number) => {
  if (sigma <= 0) return pixels
  // One box blur along lines of `length` pixels (`step` bytes apart), `lines` lines `stride` bytes apart, src -> dst.
  const boxPass = (src: Uint8Array, dst: Uint8Array, length: number, lines: number, radius: number, step: number, stride: number) => {
    const scale = 1 / (2 * radius + 1)
    for (let line = 0; line < lines; line++) {
      const base = line * stride
      for (let channel = 0; channel < 4; channel++) {
        const at = (index: number) => src[base + Math.min(length - 1, Math.max(0, index)) * step + channel]!
        let sum = 0
        for (let index = -radius; index <= radius; index++) sum += at(index)
        for (let index = 0; index < length; index++) {
          dst[base + index * step + channel] = Math.round(sum * scale)
          sum += at(index + radius + 1) - at(index - radius)
        }
      }
    }
  }
  const ideal = Math.sqrt((12 * sigma * sigma) / 3 + 1)
  const lower = Math.floor(ideal) % 2 === 0 ? Math.floor(ideal) - 1 : Math.floor(ideal)
  const count = Math.round((12 * sigma * sigma - 3 * lower * lower - 12 * lower - 9) / (-4 * lower - 4))
  const radii = [0, 1, 2].map((index) => ((index < count ? lower : lower + 2) - 1) / 2)
  const scratch = new Uint8Array(pixels.length)
  for (const radius of radii) {
    boxPass(pixels, scratch, width, height, radius, 4, width * 4)
    boxPass(scratch, pixels, height, width, radius, width * 4, 4)
  }
  return pixels
}

const IMAGE = /\.(png|jpe?g|webp|heic|tiff?|gif|bmp)$/i
const COLOR = /^#[0-9a-f]{3,8}$/i

export const createAppearance = (options: {
  directory: string
  // Downscaled, blurred JPEG of an image file; the desktop app uses Electron's image decoder. `sigma`: Studio's blur
  // (undefined: this app's own default blur).
  blur: (file: string, sigma?: number) => Promise<Buffer>
  // Names how `blur` renders. It is part of the wallpaper's URL version, so a release that renders differently gets a new
  // URL instead of the year-long immutable copy a page already cached for the same file and look.
  renderer?: string
  debounce?: number
  poll?: number
  // Where to record what the app now shows, so Palette Studio can prove an Apply landed without the
  // per-launch key. Holds colours and the wal-palette revision only, never paths.
  receipt?: string
  // Read `directory` as this profile's private cache (descriptor.json) instead of pywal's files.
  profile?: string
}) => {
  // What each tab's page reports it actually applied, by listener host id (bounded: one entry per host).
  const applied = new Map<string, Applied>()
  const file = path.join(options.directory, options.profile ? "descriptor.json" : "colors.json")
  const contract = path.join(options.directory, "palette.json")
  const listeners = new Set<() => void>()
  // `colors`: the last colors.json that held a usable palette.
  const state: { body?: AppearanceState; image?: Buffer; source?: string; colors?: Record<string, unknown>; palette?: Record<string, string>; wal?: WalPalette; consumed?: Consumed } = {}
  const reload = async () => {
    if (options.profile) return reloadProfile(options.profile)
    return reloadWal()
  }
  // A profile cache: only a fully verified descriptor + asset replaces what is served; anything else keeps the last good.
  const reloadProfile = async (profile: string) => {
    const cache = await readProfileCache(options.directory, profile)
    if (!cache) return
    const look = lookOf(cache.look)
    const source = [profile, cache.producer, cache.sha256, cache.paletteDigest, cache.paletteSchema, look ? `${look.blur}:${look.dim}` : "default", options.renderer ?? ""].join(":")
    if (source !== state.source) {
      const image = await options.blur(cache.file, look?.blur).catch(() => undefined)
      if (!image) return
      Object.assign(state, { image, source, consumed: { transfer: cache.transfer, sha256: cache.sha256, paletteDigest: cache.paletteDigest, identity: createHash("sha256").update(source).digest("hex") } })
    }
    const wallpaper = `/__es/appearance/wallpaper?v=${encodeURIComponent(createHash("sha256").update(source).digest("hex").slice(0, 32))}`
    const next = { palette: cache.palette, wallpaper, wal: undefined, look }
    if (state.body && JSON.stringify({ palette: state.body.palette, wallpaper: state.body.wallpaper, wal: state.body.wal, look: state.body.look }) === JSON.stringify(next)) return
    state.body = { ...next, updatedAt: Date.now() }
    listeners.forEach((listener) => listener())
    if (options.receipt) await writeReceipt(options.receipt, state.body, applied, state.consumed).catch(() => undefined)
  }
  const reloadWal = async () => {
    const [raw, walRaw] = await Promise.all([file, contract].map((name) =>
      readFile(name, "utf8").then((text): unknown => JSON.parse(text)).catch((error: NodeJS.ErrnoException) => (error.code === "ENOENT" ? null : undefined))))
    // A partial write keeps the last good value of that file; a removed palette.json withdraws the
    // artifact roles. palette.json alone (a device without colors.json) still serves the roles, with
    // the default app theme.
    if (paletteOf(raw)) state.colors = raw as Record<string, unknown>
    state.palette = paletteOf(state.colors)
    state.wal = walRaw === null ? undefined : walPaletteOf(walRaw) ?? state.wal
    const palette = state.palette ?? (state.wal || state.body ? {} : undefined)
    if (!palette) return
    const wallpaper = typeof state.colors?.wallpaper === "string" ? state.colors.wallpaper : undefined
    const look = lookOf(state.colors?.studio)
    const info = wallpaper && path.isAbsolute(wallpaper) && IMAGE.test(wallpaper) ? await stat(wallpaper).catch(() => undefined) : undefined
    const source = info?.isFile() ? `${wallpaper}:${info.mtimeMs}:${info.size}:${look?.blur ?? "default"}:${options.renderer ?? ""}` : undefined
    if (source && source !== state.source) {
      const image = await options.blur(wallpaper!, look?.blur).catch(() => undefined)
      if (image) Object.assign(state, { image, source })
    }
    const version = state.source ? encodeURIComponent(String(hash(state.source))) : undefined
    const next = { palette, wallpaper: version && source ? `/__es/appearance/wallpaper?v=${version}` : undefined, wal: state.wal, look }
    if (state.body && JSON.stringify({ palette: state.body.palette, wallpaper: state.body.wallpaper, wal: state.body.wal, look: state.body.look }) === JSON.stringify(next)) return
    state.body = { ...next, updatedAt: Date.now() }
    listeners.forEach((listener) => listener())
    if (options.receipt) await writeReceipt(options.receipt, state.body, applied).catch(() => undefined)
  }
  // One reload at a time, so an older read never lands after a newer one; a change during a reload
  // reads once more after it.
  const flight: { running?: Promise<void>; again: boolean } = { again: false }
  const refresh = (): Promise<void> => {
    if (flight.running) {
      flight.again = true
      return flight.running
    }
    flight.running = reload().finally(() => {
      flight.running = undefined
      if (!flight.again) return
      flight.again = false
      void refresh()
    })
    return flight.running
  }
  const ready = refresh()
  let timer: ReturnType<typeof setTimeout> | undefined
  // pywal rewrites colors.json for every palette or wallpaper change. A stat poll also notices the
  // file appearing later and works where directory events are unreliable; changes are debounced.
  const changed = () => {
    clearTimeout(timer)
    timer = setTimeout(() => void refresh(), options.debounce ?? 300)
  }
  watchFile(file, { interval: options.poll ?? 500, persistent: false }, changed)
  if (!options.profile) watchFile(contract, { interval: options.poll ?? 500, persistent: false }, changed)
  return {
    ready,
    body: () => state.body,
    image: () => (state.body?.wallpaper ? state.image : undefined),
    /** A tab's page reports what it applied; the receipt then shows it beside what this app serves. */
    applied: async (host: string, value: Omit<Applied, "appliedAt">) => {
      if (!applied.has(host) && applied.size >= 16) return
      applied.set(host, { ...value, appliedAt: Date.now() })
      if (options.receipt && state.body) await writeReceipt(options.receipt, state.body, applied, state.consumed).catch(() => undefined)
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    close: () => {
      clearTimeout(timer)
      unwatchFile(file, changed)
      unwatchFile(contract, changed)
      listeners.clear()
    },
  }
}

/** es-palette/1: this host's pywal colours for paired phones (android-ops OPEN-AND-PALETTE-0140; Murtaza chose
 * palette-only). Colours from ~/.cache/wal colors.json (special + colors) and the wal-palette/1 roles from palette.json,
 * read fresh per call. Never the wallpaper path, its pixels, the Studio look or any other field. `revision` is the
 * wal-palette revision when palette.json has one, else a digest of the colours, so a client can skip an unchanged
 * palette. Undefined when neither file holds a usable palette. */
export const readPalette = async (directory: string) => {
  const [raw, walRaw] = await Promise.all(["colors.json", "palette.json"].map((name) =>
    readFile(path.join(directory, name), "utf8").then((text): unknown => JSON.parse(text)).catch(() => undefined)))
  const colors = paletteOf(raw)
  const wal = walPaletteOf(walRaw)
  if (!colors && !wal) return undefined
  const palette = colors ?? {}
  const sorted = Object.fromEntries(Object.entries(palette).sort(([a], [b]) => (a < b ? -1 : 1)))
  const revision = wal?.revision ?? createHash("sha256").update(JSON.stringify(sorted)).digest("hex").slice(0, 16)
  return {
    schema: "es-palette/1" as const,
    revision,
    scheme: wal?.scheme ?? schemeOf(palette.background),
    palette: sorted,
    ...(wal ? { roles: wal.roles, highlights: wal.highlights } : {}),
  }
}
export type HostPalette = NonNullable<Awaited<ReturnType<typeof readPalette>>>

// Dark when the background's relative luminance is below 0.5; unknown without a readable background.
const schemeOf = (background: string | undefined) => {
  const hex = background?.replace("#", "") ?? ""
  const full = hex.length === 3 ? [...hex].map((char) => char + char).join("") : hex.slice(0, 6)
  if (!/^[0-9a-f]{6}$/i.test(full)) return "unknown" as const
  const [r, g, b] = [0, 2, 4].map((at) => parseInt(full.slice(at, at + 2), 16) / 255)
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b! < 0.5 ? ("dark" as const) : ("light" as const)
}

export type Appearance = ReturnType<typeof createAppearance>

/** What one tab's page applied: the wal-palette revision of its style element (null when none) and its theme. */
export type Applied = { walRevision: string | null; theme: "wallpaper" | "default"; appliedAt: number }

/** What a profile appearance SERVES from its producer's cache: the transfer, asset, palette (legacyPaletteDigest) and cache
 * identity, recorded as the receipt's `consumed` object. Three levels stay distinct: the importer's receipt says
 * imported; `consumed` says served (dotfiles es_artifact_lib ProfileAppearance.consumed records level "served" from it);
 * only an `applied` entry for a host says that host's page applied it. */
type Consumed = { transfer: string; sha256: string; paletteDigest: string; identity: string }

const writeReceipt = async (file: string, body: AppearanceState, applied: Map<string, Applied>, consumed?: Consumed) => {
  // `walRevision` is what this app serves; `applied` is what each tab's page confirmed it shows.
  const receipt = {
    schema: "es-appearance-receipt/1",
    ...(consumed ? { consumed, wallpaper: body.wallpaper } : {}),
    background: body.palette.background,
    foreground: body.palette.foreground,
    walRevision: body.wal?.revision,
    look: body.look,
    updatedAt: body.updatedAt,
    applied: [...applied].map(([host, value]) => ({ host, ...value })),
  }
  // Write then rename, so a reader never sees a partial file.
  await writeFile(`${file}.tmp`, JSON.stringify(receipt), { mode: 0o600 })
  await rename(`${file}.tmp`, file)
}

// pywal's special + colors maps, colour values only.
const paletteOf = (raw: unknown) => {
  if (!raw || typeof raw !== "object") return undefined
  const record = raw as Record<string, unknown>
  const merged = { ...(record.special as object), ...(record.colors as object) } as Record<string, unknown>
  const palette = Object.fromEntries(
    Object.entries(merged).filter(([key, value]) => /^[a-z0-9_]{1,32}$/i.test(key) && typeof value === "string" && COLOR.test(value)),
  ) as Record<string, string>
  return palette.background && palette.foreground ? palette : undefined
}

const PROFILE_SCHEMA = "es-profile-appearance/1"
const PALETTE_SCHEMA = "pywal-legacy/1"
const MAX_ASSET = 64 * 1024 * 1024
const ASSET = /^assets\/([0-9a-f]{64})\.(jpe?g|png|webp)$/

/** The profile cache's descriptor and asset, only when every check passes: schema and profile match, the cache directory is
 * the user's and private, the asset is a regular file at exactly assets/<sha256>.<ext> whose bytes hash to that sha256, and
 * the palette has a background and foreground. Undefined otherwise (the caller keeps what it served). */
const readProfileCache = async (directory: string, profile: string) => {
  const owner = process.getuid?.()
  const folder = await lstat(directory).catch(() => undefined)
  if (!folder?.isDirectory() || (folder.mode & 0o022) !== 0 || (owner !== undefined && folder.uid !== owner)) return undefined
  const raw = await readFile(path.join(directory, "descriptor.json"), "utf8").then((text): unknown => JSON.parse(text)).catch(() => undefined)
  if (!raw || typeof raw !== "object") return undefined
  const record = raw as Record<string, unknown>
  const asset = (record.asset && typeof record.asset === "object" ? record.asset : {}) as Record<string, unknown>
  const colors = (record.palette && typeof record.palette === "object" ? record.palette : {}) as Record<string, unknown>
  const match = typeof asset.file === "string" ? ASSET.exec(asset.file) : null
  if (record.schema !== PROFILE_SCHEMA || record.profile !== profile) return undefined
  if (typeof record.producer !== "string" || !/^[a-z][a-z0-9-]{0,31}$/.test(record.producer)) return undefined
  if (!match || asset.sha256 !== match[1]) return undefined
  const legacy = legacyPaletteOf(colors)
  const palette = paletteOf(legacy)
  if (!legacy || !palette) return undefined
  const file = path.join(directory, match[0])
  const info = await lstat(file).catch(() => undefined)
  if (!info?.isFile() || info.size > MAX_ASSET) return undefined
  const bytes = await readFile(file).catch(() => undefined)
  if (!bytes || createHash("sha256").update(bytes).digest("hex") !== match[1]) return undefined
  const paletteDigest = legacyPaletteDigest(legacy)
  return {
    file,
    sha256: match[1],
    producer: record.producer,
    transfer: typeof record.transfer === "string" ? record.transfer.slice(0, 200) : "",
    palette,
    paletteDigest,
    paletteSchema: PALETTE_SCHEMA,
    look: record.look,
  }
}

/** pywal legacy roles as the producer sends them (`pywal-legacy/1`): `special` and `colors` maps of #hex values only,
 * keys sorted; background and foreground required. Undefined for anything else. */
export const legacyPaletteOf = (raw: unknown) => {
  if (!raw || typeof raw !== "object") return undefined
  const value = raw as Record<string, unknown>
  if (value.schema !== PALETTE_SCHEMA) return undefined
  const roles = (group: unknown) => Object.fromEntries(Object.entries(group && typeof group === "object" ? (group as Record<string, unknown>) : {})
    .filter((entry): entry is [string, string] => /^[a-z0-9_]{1,32}$/i.test(entry[0]) && typeof entry[1] === "string" && COLOR.test(entry[1]))
    .sort(([a], [b]) => (a < b ? -1 : 1)))
  const special = roles(value.special)
  if (!special.background || !special.foreground) return undefined
  return { schema: PALETTE_SCHEMA, special, colors: roles(value.colors) }
}

/** The one palette digest shared with the producer (dotfiles es_artifact_lib palette_digest_of): sha256 hex of the palette
 * object {schema, special, colors} as canonical JSON, keys sorted at every level, separators "," and ":", no whitespace,
 * UTF-8. */
export const legacyPaletteDigest = (palette: NonNullable<ReturnType<typeof legacyPaletteOf>>) => {
  const sorted = (group: Record<string, string>) => Object.fromEntries(Object.entries(group).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
  return createHash("sha256").update(JSON.stringify({ colors: sorted(palette.colors), schema: palette.schema, special: sorted(palette.special) })).digest("hex")
}

// Studio's look, numbers only and clamped to Studio's own ranges; anything else is no look (this app's default).
const lookOf = (raw: unknown): StudioLook | undefined => {
  if (!raw || typeof raw !== "object") return undefined
  const record = raw as Record<string, unknown>
  const number = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : undefined
  const blur = number(record.blur)
  if (blur === undefined) return undefined
  return { blur: Math.max(0, Math.min(blur, 64)), dim: Math.max(0, Math.min(number(record.dim) ?? 0, 0.8)) }
}

// wal-palette/1, colour values only: anything else in the file (terminal, checks, prose) is dropped.
const walPaletteOf = (raw: unknown): WalPalette | undefined => {
  if (!raw || typeof raw !== "object") return undefined
  const record = raw as Record<string, unknown>
  if (record.schema !== "wal-palette/1" || (record.scheme !== "dark" && record.scheme !== "light")) return undefined
  if (typeof record.revision !== "string" || !/^[A-Za-z0-9._-]{1,64}$/.test(record.revision)) return undefined
  const roles = Object.fromEntries(
    Object.entries(record.roles && typeof record.roles === "object" ? (record.roles as Record<string, unknown>) : {})
      .filter(([key, value]) => /^[a-z0-9_]{1,24}$/.test(key) && typeof value === "string" && COLOR.test(value)),
  ) as Record<string, string>
  if (!Object.keys(roles).length) return undefined
  const highlights = (Array.isArray(record.highlights) ? record.highlights : []).filter((value): value is string => typeof value === "string" && COLOR.test(value)).slice(0, 8)
  const checks = record.checks && typeof record.checks === "object" ? (record.checks as Record<string, unknown>) : {}
  return { revision: record.revision, scheme: record.scheme, roles, highlights, okRiskCvdSafe: checks.ok_risk_cvd_safe === true }
}

const hash = (value: string) => [...value].reduce((sum, char) => (sum * 31 + char.charCodeAt(0)) >>> 0, 7)
