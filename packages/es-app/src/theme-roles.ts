/* App colour tokens from the wal-palette/1 roles (pywal docs/wal-palette.md), so the app chrome and
 * briefs draw from one palette and one `--wal-revision` identifies both. The roles already carry
 * pywal's readability checks (text 7:1, accents 4.5:1 on the surface), so they are used as given.
 * Not wired yet: appearance.ts keeps its colors.json mapping until the integrator switches to this. */
import type { WalPalette } from "./appearance"

const HEX = /^#[0-9a-f]{6}$/i
const NEUTRALS = ["bg", "surface", "raised", "line", "fg", "muted", "faint", "accent", "ok", "warn", "risk", "info"] as const

/** CSS custom properties for the app tokens, or undefined when the roles cannot theme the app. */
export const roleVars = (wal: WalPalette | undefined) => {
  if (!wal) return undefined
  // Light palettes keep the default theme until a light app variant exists (as the colors.json path does).
  if (wal.scheme !== "dark") return undefined
  const r = wal.roles
  if (!NEUTRALS.every((name) => HEX.test(r[name] ?? ""))) return undefined
  const highlights = wal.highlights.filter((value) => HEX.test(value))
  const hl = (i: number) => highlights[i] ?? r.accent
  // Highlight order depends on the palette, so the two call-to-act hues are guarded: pins (mauve) must
  // not read as the accent, and attention (peach) must read as neither the accent nor risk.
  const mauve = distinct(highlights, 0, [r.accent]) ?? hl(0)
  const peach = distinct(highlights.filter((value) => value !== mauve), 2, [r.accent, r.risk]) ?? r.warn
  return {
    "--crust": r.bg,
    "--mantle": r.bg,
    "--base": r.surface,
    "--surface0": r.raised,
    "--surface1": r.line,
    // One step above the line colour, so hover on a lined row stays visible.
    "--surface2": mix(r.line, r.muted, 0.25),
    "--overlay0": r.faint,
    "--overlay1": r.faint,
    "--subtext0": r.muted,
    "--subtext1": r.muted,
    "--text": r.fg,
    "--red": r.risk,
    "--green": r.ok,
    "--yellow": r.warn,
    "--blue": r.accent,
    "--sky": r.info,
    "--sapphire": r.info,
    "--teal": r.info,
    "--mauve": mauve,
    "--lavender": r.accent,
    "--pink": hl(1),
    "--peach": peach,
    "--accent": r.accent,
  }
}

// The first highlight from `start` (wrapping) that is chromatic and at least 30 degrees of hue from every colour in `away`.
const distinct = (highlights: string[], start: number, away: string[]) =>
  [...highlights.slice(start), ...highlights.slice(0, start)].find((value) => {
    const hue = hueOf(value)
    return hue !== undefined && away.every((other) => {
      const h = hueOf(other)
      return h === undefined || Math.min(Math.abs(hue - h), 360 - Math.abs(hue - h)) >= 30
    })
  })

const channels = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16))

// HSL hue in degrees; undefined for near-greys, whose hue carries no meaning.
const hueOf = (hex: string) => {
  const [r, g, b] = channels(hex).map((value) => value / 255) as [number, number, number]
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min
  if (d < 0.08) return undefined
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4
  return (h * 60 + 360) % 360
}

const mix = (from: string, to: string, amount: number) => {
  const a = channels(from), b = channels(to)
  return `#${a.map((value, i) => Math.round(value + (b[i]! - value) * amount).toString(16).padStart(2, "0")).join("")}`
}
