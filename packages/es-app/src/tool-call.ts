import type { ToolPart } from "@opencode-ai/sdk/v2"
import { chars, duration, inputChars, toolMagnitude } from "./tool-magnitude"
import { toolOutcome, type ToolOutcome } from "./transcript-groups"

// What one tool call shows in its compact row and on hover/focus (CHAT-23, CHAT-26): a glyph for what it does,
// and a short card of facts read from the call itself. The full command stays behind deliberate expansion.

export const STATE_WORDS: Record<ToolOutcome, string> = { ok: "", failed: "failed", interrupted: "interrupted", unfinished: "running", "unknown-exit": "exit unknown" }

// Shell commands get a glyph for what they do; anything unrecognised keeps the tool's own icon.
const COMMAND_GLYPHS: [RegExp, string][] = [
  [/^(git|gh|jj)$/, "branch"],
  [/^(pytest|vitest|jest|playwright)$/, "circle-check"],
  [/^(rg|grep|ag|ack|find|fd|ls|tree|which|locate)$/, "magnifying-glass"],
  [/^(cat|head|tail|less|more|bat|wc|diff)$/, "glasses"],
  [/^(curl|wget|http|https)$/, "link"],
  [/^(rm|rmdir|trash)$/, "trash"],
  [/^(mkdir|cp|mv|touch|ln|rsync)$/, "folder"],
  [/^(docker|kubectl|ssh|scp)$/, "server"],
]
// Package managers and language toolchains: the subcommand says what they do.
const RUNNERS = /^(bun|bunx|npm|npx|pnpm|yarn|uv|pip|pip3|cargo|go|brew|node|python|python3|make)$/
// Words that only wrap the real command.
const WRAPPERS = /^(sudo|env|time|nice|nohup|timeout|command|exec)$/

/** The program a shell command runs: skips `cd dir &&`, env assignments and wrappers like `timeout 60`. */
export const shellProgram = (command: string) => {
  const segments = command.split(/&&|\|\||;|\n/).map((segment) => segment.trim()).filter(Boolean)
  const segment = segments.find((value) => !/^cd(\s|$)/.test(value)) ?? segments[0] ?? ""
  const words = segment.split(/\s+/).filter((word) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(word))
  while (words.length && WRAPPERS.test(words[0]!)) {
    words.shift()
    while (words.length && (/^-/.test(words[0]!) || /^\d+[smh]?$/.test(words[0]!))) words.shift()
  }
  return words.map((word) => word.replace(/^.*\//, ""))
}

export const toolGlyph = (tool: string, input: unknown, icon: string) => {
  if (tool !== "bash" && tool !== "shell") return icon
  const command = input && typeof input === "object" && "command" in input && typeof input.command === "string" ? input.command : ""
  const [program = "", ...rest] = shellProgram(command)
  const sub = rest.find((word) => !word.startsWith("-")) ?? ""
  if (RUNNERS.test(program)) {
    if (/^(test|t)$/.test(sub) || rest.some((word) => /(^|\/|\.)(test|spec)s?(\.|\/|$)/.test(word) || /\.(test|spec|browser)\.[cm]?[jt]sx?$/.test(word))) return "circle-check"
    if (/^(install|i|add|ci|sync)$/.test(sub)) return "download"
    return icon
  }
  return COMMAND_GLYPHS.find(([pattern]) => pattern.test(program))?.[1] ?? icon
}

/** The compact card: state and title, a short description only when the call has one, actual duration, and
 * labelled input/output sizes with units. Running calls show time so far and no output size yet. */
export const callCard = (part: ToolPart, title: string, now: number) => {
  const state = part.state
  const status = toolOutcome(part)
  const input = state.input && typeof state.input === "object" ? state.input as Record<string, unknown> : {}
  const description = typeof input.description === "string" && input.description.trim() ? input.description.trim().slice(0, 120) : ""
  const start = "time" in state && typeof state.time?.start === "number" ? state.time.start : undefined
  const end = (state.status === "completed" || state.status === "error") && typeof state.time.end === "number" ? state.time.end : undefined
  const time = start === undefined ? "" : end !== undefined ? (end >= start ? duration(end - start) : "")
    : now >= start ? `${duration(now - start)} so far` : ""
  const magnitude = toolMagnitude(part)
  const sizes = magnitude.kind === "sized"
    ? `input ${chars(magnitude.input)} chars · ${state.status === "error" ? "error" : "output"} ${magnitude.partial ? "≥" : ""}${chars(magnitude.output)} chars`
    : magnitude.kind === "running" ? `input ${chars(inputChars(state.input).chars)} chars · output pending` : `size unknown: ${magnitude.reason}`
  const head = [title, STATE_WORDS[status]].filter(Boolean).join(" · ")
  return { status, head, description, time, sizes, label: [head, description, time, sizes].filter(Boolean).join(", ") }
}
