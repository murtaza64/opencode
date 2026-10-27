/* Wallpaper appearance (pywal). The viewing laptop's desktop app serves its palette and a
 * pre-blurred wallpaper at a fixed local route; this module maps the palette onto the app's
 * existing colour tokens and applies it to :root. It never reads from an agent host, and a
 * missing or partial palette leaves the default theme in place. */
import { createSignal } from "solid-js"

export type Appearance = {
  palette: Record<string, string>
  // Same-origin URL of a small pre-blurred image, or absent.
  wallpaper?: string
  updatedAt?: number
}

const ROUTE = "/__es/appearance"
const KEY = "es.appearance"
const HEX = /^#[0-9a-f]{6}$/i

const [enabled, setEnabledSignal] = createSignal(read())
export { enabled }
const [current, setCurrent] = createSignal<Appearance>()
export { current }

function read() {
  try {
    return globalThis.localStorage?.getItem(KEY) === "wallpaper"
  } catch {
    return false
  }
}

export const setEnabled = (on: boolean) => {
  try {
    globalThis.localStorage?.setItem(KEY, on ? "wallpaper" : "default")
  } catch {
    // Storage may be unavailable (private window); the choice then lasts for this page only.
  }
  setEnabledSignal(on)
  apply()
}

// Returns CSS custom properties for a palette, or undefined when it is unusable.
export const themeVars = (palette: Record<string, string>) => {
  const pick = (...keys: string[]) => keys.map((key) => palette[key]).find((value) => value && HEX.test(value))
  const bg = pick("background", "surface0")
  const fg = pick("foreground", "bright_white", "white")
  if (!bg || !fg) return undefined
  const dark = luminance(bg) < 0.4
  if (!dark) return undefined // Light palettes keep the default theme until a light variant exists.
  const base = pick("surface1") ?? mix(bg, fg, 0.06)
  const raised = pick("surface2") ?? mix(bg, fg, 0.12)
  const text = contrast(fg, base) >= 7 ? fg : "#e6e9ef"
  // Accents are boosted to stay readable on the darkest surface; pywal often yields muted mid-tones.
  const accent = (value: string | undefined, fallback: string) => readable(value ?? fallback, base, 4.5)
  return {
    "--crust": pick("subsurface0") ?? mix(bg, "#000000", 0.4),
    "--mantle": bg,
    "--base": base,
    "--surface0": raised,
    "--surface1": pick("surface3") ?? mix(bg, fg, 0.2),
    "--surface2": pick("surface4") ?? mix(bg, fg, 0.28),
    "--overlay0": pick("surface5") ?? mix(bg, fg, 0.4),
    "--overlay1": mix(bg, text, 0.5),
    "--subtext0": mix(bg, text, 0.68),
    "--subtext1": mix(bg, text, 0.82),
    "--text": text,
    "--red": accent(pick("bright_red", "red"), "#f38ba8"),
    "--green": accent(pick("bright_green", "green"), "#a6e3a1"),
    "--yellow": accent(pick("bright_yellow", "yellow"), "#f9e2af"),
    "--blue": accent(pick("bright_blue", "blue"), "#89b4fa"),
    "--sky": accent(pick("bright_cyan", "cyan"), "#89dceb"),
    "--sapphire": accent(pick("cyan", "color2"), "#74c7ec"),
    "--teal": accent(pick("bright_cyan", "color10"), "#94e2d5"),
    "--mauve": accent(pick("bright_magenta", "magenta"), "#cba6f7"),
    "--lavender": accent(pick("color15", "bright_blue"), "#b4befe"),
    "--pink": accent(pick("color12", "bright_red"), "#f5c2e7"),
    "--peach": accent(pick("color14", "color6"), "#fab387"),
    "--accent": accent(pick("color2", "cyan", "blue"), "#89b4fa"),
  }
}

let applied: string[] = []
const apply = () => {
  const root = document.documentElement
  applied.forEach((name) => root.style.removeProperty(name))
  applied = []
  const value = current()
  const vars = enabled() && value ? themeVars(value.palette) : undefined
  root.dataset.appearance = vars ? "wallpaper" : "default"
  if (!vars) return
  Object.entries(vars).forEach(([name, color]) => root.style.setProperty(name, color))
  applied = Object.keys(vars)
  if (value?.wallpaper) {
    root.style.setProperty("--wallpaper", `url("${value.wallpaper.replace(/"/g, "")}")`)
    applied.push("--wallpaper")
  }
}

// Loads the laptop's appearance once and follows its change events. A missing route (web,
// remote browser, older desktop) is silent and keeps the default theme.
export const installAppearance = () => {
  let stopped = false
  const load = async () => {
    const response = await fetch(ROUTE, { cache: "no-store" }).catch(() => undefined)
    if (stopped || !response?.ok) return
    const body = await response.json().catch(() => undefined)
    if (!body || typeof body.palette !== "object" || !body.palette) return
    setCurrent({ palette: body.palette, wallpaper: typeof body.wallpaper === "string" ? body.wallpaper : undefined, updatedAt: body.updatedAt })
    apply()
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
