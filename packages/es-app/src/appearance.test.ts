import { expect, test } from "bun:test"
import { contrast, themeVars } from "./appearance"

// The viewing laptop's pywal output for hades-2-mel.png (abridged).
const hades = {
  background: "#000001", foreground: "#c4dee5", color0: "#3159a9", color2: "#59bee7", color6: "#7a553c",
  color10: "#97c1d2", color12: "#c6798f", color14: "#b3764f", color15: "#8496cb",
  red: "#a5526c", green: "#42b76b", yellow: "#847500", blue: "#213dff", magenta: "#3763c9", cyan: "#59bee7",
  bright_red: "#c6798f", bright_green: "#6dc188", bright_yellow: "#998d42", bright_blue: "#8496cb",
  bright_magenta: "#8097c9", bright_cyan: "#97c1d2", bright_white: "#c4dee5",
  surface0: "#02050c", surface1: "#10151f", surface2: "#242933", surface3: "#383e49", surface4: "#4e5460", surface5: "#656c78",
}

test("maps semantic pywal keys onto the app's surface and text tokens", () => {
  const vars = themeVars(hades)!
  expect(vars["--mantle"]).toBe("#000001")
  expect(vars["--base"]).toBe("#10151f")
  expect(vars["--surface0"]).toBe("#242933")
  expect(vars["--surface1"]).toBe(vars["--surface2"])
  expect(vars["--crust"]).toBe(vars["--mantle"])
  expect(vars["--text"]).toBe("#c4dee5")
})

test("every accent stays readable on the base surface", () => {
  const vars = themeVars(hades)!
  for (const name of ["--red", "--green", "--yellow", "--blue", "--peach", "--accent", "--mauve"] as const)
    expect(contrast(vars[name], vars["--base"])).toBeGreaterThanOrEqual(4.5)
})

test("a palette without background or foreground keeps the default theme", () => {
  expect(themeVars({ color0: "#3159a9" })).toBeUndefined()
  expect(themeVars({ background: "nope", foreground: "#ffffff" })).toBeUndefined()
})

test("a light palette keeps the default theme", () => {
  expect(themeVars({ background: "#f4f1ea", foreground: "#222222" })).toBeUndefined()
})

test("low-contrast foreground falls back to a readable text colour", () => {
  expect(themeVars({ background: "#101010", foreground: "#303030" })!["--text"]).toBe("#e6e9ef")
})
