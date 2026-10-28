import { expect, test } from "bun:test"
import { themeVars } from "./appearance"
import { roleVars } from "./theme-roles"

// wal-palette/1 as the pywal fork writes it (roles abridged to what the app reads).
const wal = {
  revision: "abc123def456",
  scheme: "dark" as const,
  roles: {
    bg: "#000001", surface: "#10151f", raised: "#242933", line: "#5a606b", fg: "#c4dee5", muted: "#9aa9b1", faint: "#6f7b84",
    accent: "#8496cb", on_accent: "#000001", ok: "#6dc188", warn: "#c2b25a", risk: "#e08aa0", info: "#97c1d2",
  },
  highlights: ["#4fd1b5", "#c6798f", "#b3764f"],
  okRiskCvdSafe: true,
}

test("neutrals and status colours come straight from the roles", () => {
  const vars = roleVars(wal)!
  expect([vars["--mantle"], vars["--base"], vars["--surface0"], vars["--surface1"], vars["--text"], vars["--subtext0"], vars["--overlay1"]])
    .toEqual(["#000001", "#10151f", "#242933", "#5a606b", "#c4dee5", "#9aa9b1", "#6f7b84"])
  // One step above the line (25% toward muted), so hover on a lined row stays visible.
  expect(vars["--surface2"]).toBe("#6a727d")
  expect([vars["--red"], vars["--green"], vars["--yellow"], vars["--sky"], vars["--blue"], vars["--accent"]])
    .toEqual(["#e08aa0", "#6dc188", "#c2b25a", "#97c1d2", "#8496cb", "#8496cb"])
})

test("pins and attention take highlights that read apart from the accent and risk", () => {
  // highlights: teal, rose (near risk), copper.
  const vars = roleVars(wal)!
  expect(vars["--mauve"]).toBe("#4fd1b5")
  expect(vars["--pink"]).toBe("#c6798f")
  expect(vars["--peach"]).toBe("#b3764f")
})

test("attention skips a highlight near risk or the accent and falls back to warn", () => {
  // Third highlight is the risk hue; the others are taken or near the accent.
  const nearRisk = { ...wal, highlights: ["#4fd1b5", "#8a9bd0", "#e0899f"] }
  expect(roleVars(nearRisk)!["--peach"]).toBe("#c2b25a")
  // A copper highlight elsewhere in the list is found instead of falling back.
  expect(roleVars({ ...wal, highlights: ["#4fd1b5", "#b3764f", "#e0899f"] })!["--peach"]).toBe("#b3764f")
})

test("pins skip a highlight that reads as the accent", () => {
  expect(roleVars({ ...wal, highlights: ["#8a9bd0", "#4fd1b5"] })!["--mauve"]).toBe("#4fd1b5")
  expect(roleVars({ ...wal, highlights: [] })!["--mauve"]).toBe("#8496cb")
})

test("sets exactly the tokens the colors.json mapping sets, so switching leaves nothing stale", () => {
  const legacy = themeVars({ background: "#000001", foreground: "#c4dee5" })!
  expect(Object.keys(roleVars(wal)!).sort()).toEqual(Object.keys(legacy).sort())
})

test("light, missing or incomplete roles leave the app theme to the fallback", () => {
  expect(roleVars(undefined)).toBeUndefined()
  expect(roleVars({ ...wal, scheme: "light" })).toBeUndefined()
  expect(roleVars({ ...wal, roles: { ...wal.roles, fg: "url(x)" } })).toBeUndefined()
})
