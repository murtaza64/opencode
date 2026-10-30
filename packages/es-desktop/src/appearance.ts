/* This laptop's desktop appearance (pywal): the palette from ~/.cache/wal/colors.json, a small
 * pre-blurred copy of its wallpaper (WalStudio's `studio` blur and dim when colors.json names them), and the wal-palette/1 artifact roles from palette.json beside
 * it, served to app pages at fixed routes. Only the file pywal names is read, only as an image, and
 * only on this machine; host tabs show the same local look, never an execution host's palette. */
import { unwatchFile, watchFile } from "node:fs"
import { readFile, rename, stat, writeFile } from "node:fs/promises"
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
 * not grow with sigma). Edges repeat the border pixel. */
export const gaussianBlur = (pixels: Uint8Array, width: number, height: number, sigma: number) => {
  if (sigma <= 0) return pixels
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

// One box blur along lines of `length` pixels (`step` bytes apart), `lines` lines `stride` bytes apart, src -> dst.
const boxPass = (src: Uint8Array, dst: Uint8Array, length: number, lines: number, radius: number, step: number, stride: number) => {
  const scale = 1 / (2 * radius + 1)
  for (let line = 0; line < lines; line++) {
    const base = line * stride
    for (let channel = 0; channel < 4; channel++) {
      const at = (index: number) => src[base + Math.min(length - 1, Math.max(0, index)) * step + channel]
      let sum = 0
      for (let index = -radius; index <= radius; index++) sum += at(index)
      for (let index = 0; index < length; index++) {
        dst[base + index * step + channel] = Math.round(sum * scale)
        sum += at(index + radius + 1) - at(index - radius)
      }
    }
  }
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
}) => {
  // What each tab's page reports it actually applied, by listener host id (bounded: one entry per host).
  const applied = new Map<string, Applied>()
  const file = path.join(options.directory, "colors.json")
  const contract = path.join(options.directory, "palette.json")
  const listeners = new Set<() => void>()
  // `colors`: the last colors.json that held a usable palette.
  const state: { body?: AppearanceState; image?: Buffer; source?: string; colors?: Record<string, unknown>; palette?: Record<string, string>; wal?: WalPalette } = {}
  const reload = async () => {
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
  watchFile(contract, { interval: options.poll ?? 500, persistent: false }, changed)
  return {
    ready,
    body: () => state.body,
    image: () => (state.body?.wallpaper ? state.image : undefined),
    /** A tab's page reports what it applied; the receipt then shows it beside what this app serves. */
    applied: async (host: string, value: Omit<Applied, "appliedAt">) => {
      if (!applied.has(host) && applied.size >= 16) return
      applied.set(host, { ...value, appliedAt: Date.now() })
      if (options.receipt && state.body) await writeReceipt(options.receipt, state.body, applied).catch(() => undefined)
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

export type Appearance = ReturnType<typeof createAppearance>

/** What one tab's page applied: the wal-palette revision of its style element (null when none) and its theme. */
export type Applied = { walRevision: string | null; theme: "wallpaper" | "default"; appliedAt: number }

const writeReceipt = async (file: string, body: AppearanceState, applied: Map<string, Applied>) => {
  // `walRevision` is what this app serves; `applied` is what each tab's page confirmed it shows.
  const receipt = {
    schema: "es-appearance-receipt/1",
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
