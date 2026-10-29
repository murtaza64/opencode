/* Wallpaper appearance (pywal). The viewing laptop's desktop app serves its palette and a
 * pre-blurred wallpaper at a fixed local route; this module maps the palette onto the app's
 * existing colour tokens and applies it to :root. It never reads from an agent host, and a
 * missing or partial palette leaves the default theme in place. */
import { createSignal } from "solid-js"
import { roleVars } from "./theme-roles"

/** The viewing device's wal-palette/1 artifact roles (pywal docs/wal-palette.md), as served by its desktop app. */
export type WalPalette = { revision: string; scheme: "dark" | "light"; roles: Record<string, string>; highlights: string[]; okRiskCvdSafe: boolean }

export type Appearance = {
  palette: Record<string, string>
  wal?: WalPalette
  // Same-origin URL of a small pre-blurred image, or absent.
  wallpaper?: string
  // WalStudio's dim of that image toward black (0-0.8); absent: none.
  dim?: number
  updatedAt?: number
}

const ROUTE = "/__es/appearance"
const KEY = "es.appearance"
export const LIVING_ACTIVITY_KEY = "es.appearance.livingActivity"
const HEX = /^#[0-9a-f]{6}$/i

const [enabled, setEnabledSignal] = createSignal(read())
export { enabled }
const [livingActivity, setLivingActivitySignal] = createSignal(readLivingActivity())
export { livingActivity }
const [current, setCurrent] = createSignal<Appearance>()
export { current }

function read() {
  try {
    // On whenever this laptop has a usable palette, unless the person turned it off.
    return globalThis.localStorage?.getItem(KEY) !== "default"
  } catch {
    return false
  }
}

function readLivingActivity() {
  if (typeof location !== "undefined" && new URLSearchParams(location.search).get("filament") === "1") return true
  try {
    return globalThis.localStorage?.getItem(LIVING_ACTIVITY_KEY) === "1"
  } catch {
    return false
  }
}

export const setLivingActivity = (on: boolean) => {
  try {
    globalThis.localStorage?.setItem(LIVING_ACTIVITY_KEY, on ? "1" : "0")
  } catch {
    // Storage may be unavailable; keep the choice for this page.
  }
  setLivingActivitySignal(on)
  if (typeof document !== "undefined") document.documentElement.toggleAttribute("data-living-activity", on)
}

export const setEnabled = (on: boolean) => {
  try {
    globalThis.localStorage?.setItem(KEY, on ? "wallpaper" : "default")
  } catch {
    // Storage may be unavailable (private window); the choice then lasts for this page only.
  }
  setEnabledSignal(on)
  apply()
  if (current()) acknowledge()
}

// Returns CSS custom properties for a palette, or undefined when it is unusable.
export const themeVars = (palette: Record<string, string>) => {
  const pick = (...keys: string[]) => keys.map((key) => palette[key]).find((value) => value && HEX.test(value))
  const bg = pick("background", "surface0")
  const fg = pick("foreground", "bright_white", "white")
  if (!bg || !fg) return undefined
  const dark = luminance(bg) < 0.4
  if (!dark) return undefined // Light palettes keep the default theme until a light variant exists.
  // Few neutral levels, as in manadj: page, panel, raised (fields, hover, selection base) and one line
  // colour. The older token names map onto these so every surface draws from the same four.
  const page = bg
  const panel = pick("surface1") ?? mix(bg, fg, 0.05)
  const raised = pick("surface2") ?? mix(bg, fg, 0.12)
  const line = pick("surface3") ?? mix(bg, fg, 0.2)
  const text = contrast(fg, panel) >= 7 ? fg : "#e6e9ef"
  const muted = mix(bg, text, 0.72)
  const faint = mix(bg, text, 0.5)
  // Accents are boosted to stay readable on the panel; pywal often yields muted mid-tones.
  const accent = (value: string | undefined, fallback: string) => readable(value ?? fallback, panel, 4.5)
  return {
    "--crust": page,
    "--mantle": page,
    "--base": panel,
    "--surface0": raised,
    "--surface1": line,
    "--surface2": line,
    "--overlay0": faint,
    "--overlay1": faint,
    "--subtext0": muted,
    "--subtext1": muted,
    "--text": text,
    "--red": accent(pick("bright_red", "red"), "#ff2d55"),
    "--green": accent(pick("bright_green", "green"), "#00e676"),
    "--yellow": accent(pick("bright_yellow", "yellow"), "#ffcc00"),
    "--blue": accent(pick("bright_blue", "blue"), "#4a9eff"),
    "--sky": accent(pick("bright_cyan", "cyan"), "#00e5ff"),
    "--sapphire": accent(pick("cyan", "color2"), "#00e5ff"),
    "--teal": accent(pick("bright_cyan", "color10"), "#00ffc4"),
    "--mauve": accent(pick("bright_magenta", "magenta"), "#8f4dff"),
    "--lavender": accent(pick("color15", "bright_blue"), "#4a9eff"),
    "--pink": accent(pick("color12", "bright_red"), "#ff2d95"),
    "--peach": accent(pick("color14", "color6"), "#ff9500"),
    "--accent": accent(pick("color2", "cyan", "blue"), "#4a9eff"),
  }
}

let applied: string[] = []
const apply = () => {
  const root = document.documentElement
  applied.forEach((name) => root.style.removeProperty(name))
  applied = []
  const value = current()
  // wal-palette/1 roles when the desktop serves them, so one --wal-revision covers app and briefs.
  const vars = enabled() && value ? roleVars(value.wal) ?? themeVars(value.palette) : undefined
  root.dataset.appearance = vars ? "wallpaper" : "default"
  if (!vars) return
  Object.entries(vars).forEach(([name, color]) => root.style.setProperty(name, color))
  applied = Object.keys(vars)
  if (value?.wallpaper) {
    root.style.setProperty("--wallpaper", `url("${value.wallpaper.replace(/"/g, "")}")`)
    applied.push("--wallpaper")
    if (value.dim) {
      root.style.setProperty("--wallpaper-dim", String(value.dim))
      applied.push("--wallpaper-dim")
    }
  }
}

/** WalStudio's wallpaper dim from the served look: a number held to Studio's 0-0.8; anything else is no dim. It reaches
 * CSS text, so it is re-checked here. */
export const wallpaperDim = (look: unknown) => {
  const dim = look && typeof look === "object" ? (look as { dim?: unknown }).dim : undefined
  return typeof dim === "number" && Number.isFinite(dim) && dim > 0 ? Math.min(dim, 0.8) : undefined
}

/** The `<style id="wal-palette">` text for a palette: `--wal-<role>` (underscores as hyphens), `--wal-hl1..8`,
 * `--wal-revision`, and `--wal-ok-risk-cvd-safe: 1` only when the palette says ok and risk stay apart.
 * Undefined for anything that is not a usable palette. Values are re-checked here: they reach CSS text. */
export const walStyle = (value: unknown) => {
  if (!value || typeof value !== "object") return undefined
  const wal = value as Partial<WalPalette>
  if (typeof wal.revision !== "string" || !/^[A-Za-z0-9._-]{1,64}$/.test(wal.revision)) return undefined
  const color = (item: unknown): item is string => typeof item === "string" && /^#[0-9a-f]{3,8}$/i.test(item)
  const roles = Object.entries(wal.roles && typeof wal.roles === "object" ? wal.roles : {})
    .filter(([key, item]) => /^[a-z0-9_]{1,24}$/.test(key) && color(item))
    .map(([key, item]) => `--wal-${key.replaceAll("_", "-")}:${item}`)
  if (!roles.length) return undefined
  const highlights = (Array.isArray(wal.highlights) ? wal.highlights : []).filter(color).slice(0, 8).map((item, index) => `--wal-hl${index + 1}:${item}`)
  return `:root{--wal-revision:"${wal.revision}";${[...roles, ...highlights, ...(wal.okRiskCvdSafe === true ? ["--wal-ok-risk-cvd-safe:1"] : [])].join(";")}}`
}

// One stylesheet for the artifact palette. It colours artifacts (brief drawings read it through the
// page), not the app's own theme, so it applies whether or not the wallpaper theme is on.
const applyWal = (value: unknown) => {
  const css = walStyle(value)
  const existing = document.getElementById("wal-palette")
  if (!css) return existing?.remove()
  if (existing?.textContent === css) return
  const style = existing ?? Object.assign(document.createElement("style"), { id: "wal-palette" })
  style.textContent = css
  if (!existing) document.head.append(style)
}

// Tells this app's desktop what this page now shows (the palette style's revision and the theme), so a
// palette tool can confirm an apply reached the page. Sent only when it changes; silent where there is
// no desktop route.
let acknowledged = ""
const acknowledge = () => {
  const style = document.getElementById("wal-palette")?.textContent ?? ""
  const walRevision = /--wal-revision:"([A-Za-z0-9._-]{1,64})"/.exec(style)?.[1] ?? null
  const theme = document.documentElement.dataset.appearance === "wallpaper" ? "wallpaper" : "default"
  const body = JSON.stringify({ walRevision, theme })
  if (body === acknowledged) return
  acknowledged = body
  void fetch(`${ROUTE}/applied`, { method: "POST", headers: { "content-type": "application/json" }, body }).catch(() => undefined)
}

// Loads the laptop's appearance once and follows its change events. A missing route (web,
// remote browser, older desktop) is silent and keeps the default theme.
export const installAppearance = () => {
  document.documentElement.toggleAttribute("data-living-activity", livingActivity())
  let stopped = false
  const load = async () => {
    const response = await fetch(ROUTE, { cache: "no-store" }).catch(() => undefined)
    if (stopped || !response?.ok) return
    const body = await response.json().catch(() => undefined)
    if (!body || typeof body.palette !== "object" || !body.palette) return
    setCurrent({ palette: body.palette, wallpaper: typeof body.wallpaper === "string" ? body.wallpaper : undefined, dim: wallpaperDim(body.look), wal: body.wal, updatedAt: body.updatedAt })
    applyWal(body.wal)
    apply()
    acknowledge()
  }
  void load()
  const events = typeof EventSource === "function" ? new EventSource(`${ROUTE}/events`) : undefined
  events?.addEventListener("message", () => void load())
  events?.addEventListener("error", () => events.close())
  apply()
  return () => {
    stopped = true
    events?.close()
  }
}

const channels = (hex: string) => [1, 3, 5].map((index) => parseInt(hex.slice(index, index + 2), 16))
const toHex = (values: number[]) => `#${values.map((value) => Math.round(Math.min(255, Math.max(0, value))).toString(16).padStart(2, "0")).join("")}`
const mix = (from: string, to: string, amount: number) => {
  const a = channels(from), b = channels(to)
  return toHex(a.map((value, index) => value + (b[index]! - value) * amount))
}
const luminance = (hex: string) => {
  const [r, g, b] = channels(hex).map((value) => {
    const c = value / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!
}
export const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi! + 0.05) / (lo! + 0.05)
}
// Lightens a colour toward white until it reaches the target contrast on the background.
const readable = (color: string, background: string, target: number) => {
  for (let step = 0; step <= 10; step++) {
    const candidate = mix(color, "#ffffff", step / 10)
    if (contrast(candidate, background) >= target) return candidate
  }
  return "#ffffff"
}
