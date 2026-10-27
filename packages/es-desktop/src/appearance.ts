/* This laptop's desktop appearance (pywal): the palette from ~/.cache/wal/colors.json and a small
 * pre-blurred copy of its wallpaper, served to app pages at fixed routes. Only the file pywal
 * names is read, only as an image, and only on this machine; host tabs show the same local look. */
import { unwatchFile, watchFile } from "node:fs"
import { readFile, stat } from "node:fs/promises"
import path from "node:path"

export type AppearanceState = { palette: Record<string, string>; wallpaper?: string; updatedAt: number }

const IMAGE = /\.(png|jpe?g|webp|heic|tiff?|gif|bmp)$/i
const COLOR = /^#[0-9a-f]{3,8}$/i

export const createAppearance = (options: {
  directory: string
  // Downscaled, blurred JPEG of an image file; the desktop app uses Electron's image decoder.
  blur: (file: string) => Promise<Buffer>
  debounce?: number
  poll?: number
}) => {
  const file = path.join(options.directory, "colors.json")
  const listeners = new Set<() => void>()
  const state: { body?: AppearanceState; image?: Buffer; source?: string } = {}
  const reload = async () => {
    const raw: unknown = await readFile(file, "utf8").then((text) => JSON.parse(text)).catch(() => undefined)
    const palette = paletteOf(raw)
    // A missing or partial write keeps the last good state.
    if (!palette) return
    const wallpaper = typeof (raw as Record<string, unknown>).wallpaper === "string" ? ((raw as Record<string, unknown>).wallpaper as string) : undefined
    const info = wallpaper && path.isAbsolute(wallpaper) && IMAGE.test(wallpaper) ? await stat(wallpaper).catch(() => undefined) : undefined
    const source = info?.isFile() ? `${wallpaper}:${info.mtimeMs}:${info.size}` : undefined
    if (source && source !== state.source) {
      const image = await options.blur(wallpaper!).catch(() => undefined)
      if (image) Object.assign(state, { image, source })
    }
    const version = state.source ? encodeURIComponent(String(hash(state.source))) : undefined
    const next = { palette, wallpaper: version && source ? `/__es/appearance/wallpaper?v=${version}` : undefined }
    if (state.body && JSON.stringify({ palette: state.body.palette, wallpaper: state.body.wallpaper }) === JSON.stringify(next)) return
    state.body = { ...next, updatedAt: Date.now() }
    listeners.forEach((listener) => listener())
  }
  const ready = reload()
  let timer: ReturnType<typeof setTimeout> | undefined
  // pywal rewrites colors.json for every palette or wallpaper change. A stat poll also notices the
  // file appearing later and works where directory events are unreliable; changes are debounced.
  const changed = () => {
    clearTimeout(timer)
    timer = setTimeout(() => void reload(), options.debounce ?? 300)
  }
  watchFile(file, { interval: options.poll ?? 500, persistent: false }, changed)
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
      listeners.clear()
    },
  }
}

export type Appearance = ReturnType<typeof createAppearance>

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

const hash = (value: string) => [...value].reduce((sum, char) => (sum * 31 + char.charCodeAt(0)) >>> 0, 7)
