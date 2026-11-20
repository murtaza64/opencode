export type Voice = { phase: "idle" | "recording" | "transcribing" | "confirm" | "sending" | "error"; transcript?: string; error?: string }
export type Ask = { id: string; kind: "question" | "permission"; title: string; detail: string; options: string[]; answerable: boolean }
export type HudState = {
  mode: "sleep" | "ambient" | "voice" | "thinking" | "reply" | "needs" | "ask"
  voice: Voice
  tool: string
  reply: string
  page: number
  needs?: { title: string; context: string }
  needsIndex: number
  needsCount: number
  ask?: Ask
  askSelected: number
  askArmed: boolean
  depth: { distance: number; spread: number }
  queueKnown: boolean
}

export const hudMode = (input: {
  voice: Voice; ask?: Ask; needs: boolean; thinking: boolean; reply: boolean; awakeUntil: number
}, now: number): HudState["mode"] => {
  if (input.voice.phase !== "idle") return "voice"
  if (input.ask) return "ask"
  if (input.needs) return "needs"
  if (input.thinking) return "thinking"
  if (now >= input.awakeUntil) return "sleep"
  return input.reply ? "reply" : "ambient"
}

const glyphs = new Map([["•", "*"], ["·", "|"], ["—", "-"], ["–", "-"], ["…", "..."], ["‘", "'"], ["’", "'"], ["“", '"'], ["”", '"'], ["\r", ""]])
export const sanitizeLensText = (value: string) => value
  .replace(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g, "[REDACTED]")
  .replace(/\b(sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{12,}|github_pat_[A-Za-z0-9_]{12,}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[A-Za-z0-9_-]{20,}|AKIA[A-Z0-9]{12,})\b/g, "[REDACTED]")
  .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{16,}/gi, "$1[REDACTED]")
  .replace(/((?:api[_-]?key|token|secret|password|authorization)\s*[:=]\s*["']?)([^\s"',;]{8,})/gi, "$1[REDACTED]")
  .replace(/\bses_[\w-]+\b/g, "[conversation]")
  .replace(/[^\x20-\x7e\n]/gu, char => glyphs.get(char) ?? " ")

export const linesOf = (value: string, width = 44) => {
  const lines: string[] = []
  let line = ""
  for (const word of sanitizeLensText(value).trim().split(/\s+/)) {
    if (!word) continue
    if (line && line.length + word.length + 1 > width) { lines.push(line); line = "" }
    for (let offset = 0; offset < word.length; offset += width) {
      const piece = word.slice(offset, offset + width)
      if (offset + width < word.length) { lines.push(piece); continue }
      line = line ? `${line} ${piece}` : piece
    }
  }
  if (line) lines.push(line)
  return lines
}
const REPLY_ROWS = 8
export const replyPages = (reply: string) => Math.max(1, Math.ceil(linesOf(reply).length / REPLY_ROWS))
export const replyLines = (reply: string, page: number) => linesOf(reply).slice(page * REPLY_ROWS, (page + 1) * REPLY_ROWS)
export const toolVerb = (tool: string) => new Map([
  ["bash", "running a command"], ["read", "reading"], ["edit", "editing"], ["write", "writing"], ["grep", "searching"],
  ["glob", "searching"], ["list", "looking around"], ["webfetch", "browsing"], ["task", "delegating"], ["todowrite", "planning"],
]).get(tool.split(/[\s(]/)[0] ?? "") ?? "thinking"

export const textFrame = (state: HudState, now: number): string[] => {
  const pulse = [0, 1, 2].map(i => i === Math.floor(now / 350) % 3 ? "●" : "○").join(" ")
  if (state.mode === "sleep") return []
  if (state.mode === "voice") {
    const voice = state.voice
    if (voice.phase === "confirm") return ["Send this?", "", ...linesOf(voice.transcript ?? "").slice(0, 4), "", "Tap to send · Swipe to cancel".replace("·", "|")]
    if (voice.phase === "error") return [...linesOf(voice.error ?? "Try again").slice(0, 4), "", "Tap to dismiss"]
    if (voice.phase === "recording") return ["Listening", "", pulse, "", "Release or double-tap when done"]
    return [voice.phase === "sending" ? "Sending" : "Transcribing", "", pulse]
  }
  if (state.mode === "needs" && state.needs) return [
    `Needs you${state.needsCount > 1 ? ` (${state.needsIndex + 1}/${state.needsCount})` : ""}`, "",
    ...linesOf(state.needs.title).slice(0, 2), ...linesOf(state.needs.context).slice(0, 2), "",
    state.needsCount > 1 ? "Answer on the Mac | Swipe for next" : "Answer on the Mac",
  ]
  if (state.mode === "ask" && state.ask) return [
    state.ask.kind === "permission" ? "Porter wants to" : "Porter asks", ...linesOf(state.ask.title).slice(0, 1),
    ...linesOf(state.ask.detail).slice(0, 2), "",
    ...(state.ask.answerable ? state.ask.options.map((label, i) => `${i === state.askSelected ? (state.askArmed ? "■" : "▶") : " "} ${sanitizeLensText(label)}`) : []),
    state.ask.answerable ? (state.askArmed ? "Tap again to confirm" : "Swipe to choose | Tap to select") : "Answer on the Mac",
  ]
  if (state.mode === "thinking") return ["", "", `          ${pulse}   ${toolVerb(state.tool)}`]
  if (state.mode === "reply") return [`Porter  ${state.page + 1}/${replyPages(state.reply)}`, ...replyLines(state.reply, state.page), "Swipe to turn page | Tap to dismiss"]
  return ["", "", state.queueKnown ? "             All clear" : "          Needs you unavailable", "", "          Double-tap to talk"]
}
