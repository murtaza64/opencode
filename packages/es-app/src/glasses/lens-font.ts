// Pixel widths of the glasses' built-in 20 px font, from Even's own measurement tables (@evenrealities/pretext,
// MIT). Loaded on demand; until it arrives an 11 px average stands in, which only matters for the first frames.
type Measure = (text: string) => number
let measure: Measure | undefined
export const lensFontReady = import("@evenrealities/pretext").then(module => { measure = module.getTextWidth })

export const textWidth = (value: string) => measure ? measure(value) : value.length * 11

/** Greedy word wrap to a pixel width; words wider than the line are split by characters. */
export const wrapPx = (value: string, maxPx: number) => {
  const lines: string[] = []
  let line = ""
  const push = (word: string) => {
    if (textWidth(word) <= maxPx) {
      const next = line ? `${line} ${word}` : word
      if (!line || textWidth(next) <= maxPx) { line = next; return }
      lines.push(line)
      line = word
      return
    }
    if (line) { lines.push(line); line = "" }
    let piece = ""
    for (const char of word) {
      if (piece && textWidth(piece + char) > maxPx) { lines.push(piece); piece = "" }
      piece += char
    }
    line = piece
  }
  for (const word of value.trim().split(/\s+/)) if (word) push(word)
  if (line) lines.push(line)
  return lines
}
