/* This laptop's desktop appearance (pywal): the palette from ~/.cache/wal/colors.json, a small
 * pre-blurred copy of its wallpaper, and the wal-palette/1 artifact roles from palette.json beside
 * it, served to app pages at fixed routes. Only the file pywal names is read, only as an image, and
 * only on this machine; host tabs show the same local look, never an execution host's palette. */
import { unwatchFile, watchFile } from "node:fs"
import { readFile, rename, stat, writeFile } from "node:fs/promises"
import path from "node:path"

/** wal-palette/1 (pywal docs/wal-palette.md): role colours artifacts use as `--wal-<role>`. */
export type WalPalette = { revision: string; scheme: "dark" | "light"; roles: Record<string, string>; highlights: string[]; okRiskCvdSafe: boolean }
export type AppearanceState = { palette: Record<string, string>; wallpaper?: string; wal?: WalPalette; updatedAt: number }

const IMAGE = /\.(png|jpe?g|webp|heic|tiff?|gif|bmp)$/i
const COLOR = /^#[0-9a-f]{3,8}$/i

export const createAppearance = (options: {
  directory: string
  // Downscaled, blurred JPEG of an image file; the desktop app uses Electron's image decoder.
  blur: (file: string) => Promise<Buffer>
  debounce?: number
  poll?: number
  // Where to record what the app now shows, so Palette Studio can prove an Apply landed without the
  // per-launch key. Holds colours and the wal-palette revision only, never paths.
  receipt?: string
}) => {
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
    const info = wallpaper && path.isAbsolute(wallpaper) && IMAGE.test(wallpaper) ? await stat(wallpaper).catch(() => undefined) : undefined
    const source = info?.isFile() ? `${wallpaper}:${info.mtimeMs}:${info.size}` : undefined
    if (source && source !== state.source) {
      const image = await options.blur(wallpaper!).catch(() => undefined)
      if (image) Object.assign(state, { image, source })
    }
    const version = state.source ? encodeURIComponent(String(hash(state.source))) : undefined
    const next = { palette, wallpaper: version && source ? `/__es/appearance/wallpaper?v=${version}` : undefined, wal: state.wal }
    if (state.body && JSON.stringify({ palette: state.body.palette, wallpaper: state.body.wallpaper, wal: state.body.wal }) === JSON.stringify(next)) return
    state.body = { ...next, updatedAt: Date.now() }
    listeners.forEach((listener) => listener())
    if (options.receipt) await writeReceipt(options.receipt, state.body).catch(() => undefined)
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

const writeReceipt = async (file: string, body: AppearanceState) => {
  const receipt = { schema: "es-appearance-receipt/1", background: body.palette.background, foreground: body.palette.foreground, walRevision: body.wal?.revision, updatedAt: body.updatedAt }
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
