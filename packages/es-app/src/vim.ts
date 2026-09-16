/* Modal (vim-like) editing for a textarea: normal/insert modes with the core
 * motions and operators — h j k l, w b e, 0 ^ $, gg G, i a I A o O, x s D C S,
 * d/c/y + motion, dd cc yy, p P, u / ctrl-r. Counts on j/k and gj/gk only.
 * No marks, registers
 * beyond one internal, or visual mode. The block cursor in normal mode is a
 * one-grapheme selection styled via ::selection. */
import { createSignal } from "solid-js"
import { textareaLayout } from "./textarea-layout"

export type VimMode = "normal" | "insert"

type Snapshot = { value: string; sel: number }

const isWordChar = (c: string) => /[\w]/.test(c)
const isSpace = (c: string) => /\s/.test(c)

function lineStart(text: string, pos: number): number {
  const i = text.lastIndexOf("\n", pos - 1)
  if (pos === 0) return 0
  return i === -1 ? 0 : i + 1
}

function lineEnd(text: string, pos: number): number {
  const i = text.indexOf("\n", pos)
  return i === -1 ? text.length : i
}

function firstNonBlank(text: string, pos: number): number {
  const start = lineStart(text, pos)
  const end = lineEnd(text, pos)
  let i = start
  while (i < end && isSpace(text[i]!)) i++
  return i
}

function wordForward(text: string, pos: number): number {
  let i = pos
  const n = text.length
  if (i >= n) return n
  const startClass = isWordChar(text[i]!) ? "w" : isSpace(text[i]!) ? "s" : "p"
  if (startClass !== "s") {
    while (i < n && !isSpace(text[i]!) && (isWordChar(text[i]!) ? "w" : "p") === startClass) i++
  }
  while (i < n && isSpace(text[i]!)) i++
  return i
}

function wordBack(text: string, pos: number): number {
  let i = pos
  while (i > 0 && isSpace(text[i - 1]!)) i--
  if (i === 0) return 0
  const cls = isWordChar(text[i - 1]!) ? "w" : "p"
  while (i > 0 && !isSpace(text[i - 1]!) && (isWordChar(text[i - 1]!) ? "w" : "p") === cls) i--
  return i
}

function wordForwardBig(text: string, pos: number): number {
  let i = pos
  const n = text.length
  while (i < n && !isSpace(text[i]!)) i++
  while (i < n && isSpace(text[i]!)) i++
  return i
}

function wordBackBig(text: string, pos: number): number {
  let i = pos
  while (i > 0 && isSpace(text[i - 1]!)) i--
  while (i > 0 && !isSpace(text[i - 1]!)) i--
  return i
}

function wordEnd(text: string, pos: number): number {
  let i = pos + 1
  const n = text.length
  while (i < n && isSpace(text[i]!)) i++
  if (i >= n) return n - 1
  const cls = isWordChar(text[i]!) ? "w" : "p"
  while (i + 1 < n && !isSpace(text[i + 1]!) && (isWordChar(text[i + 1]!) ? "w" : "p") === cls) i++
  return i
}

// Both layout points and logical line starts are ordered UTF-16 boundaries.
const boundaryIndex = (points: { pos: number }[], pos: number) => {
  let low = 0
  let high = points.length
  while (low < high) {
    const mid = Math.floor((low + high) / 2)
    if (points[mid]!.pos <= pos) low = mid + 1
    else high = mid
  }
  return Math.max(0, low - 1)
}

export function createVim(opts: {
  value: () => string
  setValue: (v: string) => void
  /** navigation hooks (normal mode) */
  onTab?: (back: boolean) => void
  onEnter?: () => void
  /** fired whenever the normal-mode cursor moves; hasChar=false means the
   * selection block can't render (EOL/empty) and a fake caret is needed */
  onCursor?: (info: { el: HTMLTextAreaElement; pos: number; hasChar: boolean }) => void
}) {
  const [mode, updateMode] = createSignal<VimMode>("normal")
  let pendingOp: "d" | "c" | "y" | null = null
  let gPending = false
  let register = ""
  let registerLinewise = false
  let goal: { kind: "visual" | "logical"; value: number } | undefined
  let count = 0
  let operatorCount = 1
  let observed:
    | { el: HTMLTextAreaElement; value: string; start: number; end: number; layout: ReturnType<typeof textareaLayout> }
    | undefined
  const undoStack: Snapshot[] = []
  const redoStack: Snapshot[] = []

  const el = (e: KeyboardEvent) => e.currentTarget as HTMLTextAreaElement

  const cursor = (t: HTMLTextAreaElement) => t.selectionStart ?? 0

  const resetCommand = () => {
    pendingOp = null
    gPending = false
    count = 0
    operatorCount = 1
  }

  const setMode = (next: VimMode) => {
    goal = undefined
    resetCommand()
    return updateMode(next)
  }

  const remember = (t: HTMLTextAreaElement) => {
    observed = { el: t, value: t.value, start: t.selectionStart, end: t.selectionEnd, layout: textareaLayout(t) }
  }

  const sync = (t: HTMLTextAreaElement) => {
    if (
      observed?.el === t &&
      observed.value === t.value &&
      observed.start === t.selectionStart &&
      observed.end === t.selectionEnd &&
      observed.layout === textareaLayout(t)
    )
      return false
    goal = undefined
    resetCommand()
    remember(t)
    return true
  }

  const adjacent = (t: HTMLTextAreaElement, pos: number, dir: 1 | -1) => {
    const points = textareaLayout(t).points
    const i = boundaryIndex(points, pos)
    return points[Math.max(0, Math.min(points.length - 1, i + (dir === 1 ? 1 : points[i]!.pos < pos ? 0 : -1)))]!.pos
  }

  const paint = (t: HTMLTextAreaElement, pos: number, scroll = true) => {
    const text = t.value
    const layout = textareaLayout(t)
    const i = boundaryIndex(layout.points, Math.max(0, Math.min(pos, text.length)))
    const point = layout.points[i]!
    const p = point.pos
    const hasChar = p < text.length && text[p] !== "\n"
    if (mode() === "normal" && hasChar) {
      t.setSelectionRange(p, layout.points[i + 1]!.pos, "forward")
    } else {
      t.setSelectionRange(p, p)
    }
    if (scroll) {
      // Layout coordinates already include padding, but not the textarea border.
      const bottom = point.top + (point.height || layout.lineHeight)
      if (point.top < t.scrollTop) t.scrollTop = point.top
      else if (bottom > t.scrollTop + t.clientHeight) t.scrollTop = bottom - t.clientHeight
    }
    remember(t)
    opts.onCursor?.({ el: t, pos: p, hasChar })
  }

  const verticalMove = (t: HTMLTextAreaElement, dir: 1 | -1, amount: number, logical: boolean) => {
    const layout = textareaLayout(t)
    const i = boundaryIndex(layout.points, cursor(t))
    const point = layout.points[i]!
    if (!logical) {
      // Match native textarea navigation's integer-pixel horizontal goal.
      if (goal?.kind !== "visual") goal = { kind: "visual", value: Math.floor(point.left) }
      const x = goal.value
      const row = layout.rows[Math.max(0, Math.min(layout.rows.length - 1, point.row + dir * amount))]!
      return row.reduce((best, next) => (Math.abs(next.left - x) < Math.abs(best.left - x) ? next : best)).pos
    }

    const line = boundaryIndex(layout.lines, point.pos)
    const target = layout.lines[Math.max(0, Math.min(layout.lines.length - 1, line + dir * amount))]!
    const style = getComputedStyle(t)
    const tab = Math.max(1, Number.parseFloat(style.tabSize) || 8)
    const tabSize = (() => {
      if (!style.tabSize.endsWith("px")) return tab
      const context = t.ownerDocument.createElement("canvas").getContext("2d")!
      context.font = style.font
      return tab / (context.measureText(" ").width || 1)
    })()
    const nextColumn = (col: number, pos: number) =>
      t.value[pos] === "\t" ? (Math.floor(col / tabSize) + 1) * tabSize : col + 1
    if (goal?.kind !== "logical") {
      let col = 0
      for (let j = boundaryIndex(layout.points, layout.lines[line]!.pos); j < i; j++) {
        col = nextColumn(col, layout.points[j]!.pos)
      }
      goal = { kind: "logical", value: col }
    }
    const end = lineEnd(t.value, target.pos)
    let j = boundaryIndex(layout.points, target.pos)
    let col = 0
    while (layout.points[j + 1] && layout.points[j + 1]!.pos <= end) {
      const next = nextColumn(col, layout.points[j]!.pos)
      if (next > goal.value) break
      col = next
      j++
    }
    return layout.points[j]!.pos
  }

  const snapshot = (t: HTMLTextAreaElement) => {
    undoStack.push({ value: t.value, sel: cursor(t) })
    if (undoStack.length > 200) undoStack.shift()
    redoStack.length = 0
  }

  const apply = (t: HTMLTextAreaElement, value: string, pos: number) => {
    goal = undefined
    opts.setValue(value)
    t.value = value
    paint(t, pos)
  }

  const enterInsert = (t: HTMLTextAreaElement, pos: number) => {
    setMode("insert")
    const points = textareaLayout(t).points
    const p = points[boundaryIndex(points, pos)]!.pos
    t.setSelectionRange(p, p)
    remember(t)
  }

  const motionTarget = (
    t: HTMLTextAreaElement,
    key: string,
    forOperator: boolean,
    amount = 1,
  ): [number, number, boolean] | null => {
    // returns [from, to, linewise]
    const text = t.value
    const pos = cursor(t)
    switch (key) {
      case "h":
        return [Math.max(lineStart(text, pos), adjacent(t, pos, -1)), pos, false]
      case "l":
        return [pos, Math.min(lineEnd(text, pos), adjacent(t, pos, 1)), false]
      case "w": {
        const to = wordForward(text, pos)
        // dw/cw stop at line end when the word continues past it (approximation)
        return [pos, forOperator ? Math.min(to, lineEnd(text, pos) + 1) : to, false]
      }
      case "W": {
        const to = wordForwardBig(text, pos)
        return [pos, forOperator ? Math.min(to, lineEnd(text, pos) + 1) : to, false]
      }
      case "b":
        return [wordBack(text, pos), pos, false]
      case "B":
        return [wordBackBig(text, pos), pos, false]
      case "e": {
        const to = wordEnd(text, pos)
        return [pos, forOperator ? to + 1 : to, false]
      }
      case "0":
        return [lineStart(text, pos), pos, false]
      case "^":
        return [firstNonBlank(text, pos), pos, false]
      case "$":
        return [pos, lineEnd(text, pos), false]
      case "j":
      case "k": {
        const lines = textareaLayout(t).lines
        const line = boundaryIndex(lines, pos)
        const target = lines[Math.max(0, Math.min(lines.length - 1, line + (key === "j" ? amount : -amount)))]!.pos
        return [
          lineStart(text, Math.min(pos, target)),
          Math.min(lineEnd(text, Math.max(pos, target)) + 1, text.length),
          true,
        ]
      }
      case "G":
        return [lineStart(text, pos), text.length, true]
      default:
        return null
    }
  }

  const runOperator = (t: HTMLTextAreaElement, op: "d" | "c" | "y", from: number, to: number, linewise: boolean) => {
    goal = undefined
    const points = textareaLayout(t).points
    from = points[boundaryIndex(points, from)]!.pos
    const end = boundaryIndex(points, to)
    to = points[Math.min(points.length - 1, end + (points[end]!.pos < to ? 1 : 0))]!.pos
    const text = t.value
    const chunk = text.slice(from, to)
    register = chunk
    registerLinewise = linewise
    if (op === "y") {
      paint(t, from)
      return
    }
    snapshot(t)
    const next = text.slice(0, from) + text.slice(to)
    apply(t, next, from)
    if (op === "c") enterInsert(t, from)
  }

  const lineRange = (text: string, pos: number): [number, number] => [
    lineStart(text, pos),
    Math.min(lineEnd(text, pos) + 1, text.length),
  ]

  const handleNormal = (e: KeyboardEvent): boolean => {
    const t = el(e)
    sync(t)
    const text = t.value
    const pos = cursor(t)
    const key = e.key
    if (e.metaKey) return false
    if (e.ctrlKey) {
      if (key === "r") {
        const snap = redoStack.pop()
        if (snap) {
          undoStack.push({ value: t.value, sel: pos })
          apply(t, snap.value, snap.sel)
        }
        return true
      }
      return false
    }

    if (/^[0-9]$/.test(key) && (key !== "0" || count > 0)) {
      count = Math.min(1000000, count * 10 + Number(key))
      return true
    }
    const amount = (count || 1) * operatorCount
    if (key !== "g" && key !== "d" && key !== "c" && key !== "y") count = 0

    // pending operator: expect a motion (or doubled operator for linewise)
    if (pendingOp) {
      const op = pendingOp
      pendingOp = null
      if (gPending) {
        resetCommand()
        if (key === "g") runOperator(t, op, 0, Math.min(lineEnd(text, pos) + 1, text.length), true)
        if (key === "j" || key === "k") {
          const m = motionTarget(t, key, true, amount)
          if (m) runOperator(t, op, m[0], m[1], m[2])
        }
        return true
      }
      if (key === op) {
        resetCommand()
        const [from, to] = lineRange(text, pos)
        runOperator(t, op, from, to, true)
        return true
      }
      if (key === "g") {
        gPending = true
        pendingOp = op
        return true
      }
      resetCommand()
      const m = motionTarget(t, key, true, amount)
      if (m) runOperator(t, op, m[0], m[1], m[2])
      return true
    }

    if (gPending) {
      resetCommand()
      if (key === "g") {
        goal = undefined
        paint(t, 0)
        return true
      }
      if (key === "j" || key === "k") paint(t, verticalMove(t, key === "j" ? 1 : -1, amount, true))
      return true
    }

    switch (key) {
      case "Escape":
        goal = undefined
        resetCommand()
        return true
      case "i":
        enterInsert(t, pos)
        return true
      case "a":
        enterInsert(t, Math.min(adjacent(t, pos, 1), lineEnd(text, pos)))
        return true
      case "I":
        enterInsert(t, firstNonBlank(text, pos))
        return true
      case "A":
        enterInsert(t, lineEnd(text, pos))
        return true
      case "o": {
        snapshot(t)
        const end = lineEnd(text, pos)
        apply(t, text.slice(0, end) + "\n" + text.slice(end), end + 1)
        enterInsert(t, end + 1)
        return true
      }
      case "O": {
        snapshot(t)
        const start = lineStart(text, pos)
        apply(t, text.slice(0, start) + "\n" + text.slice(start), start)
        enterInsert(t, start)
        return true
      }
      case "h":
      case "l":
      case "w":
      case "W":
      case "b":
      case "B":
      case "e":
      case "0":
      case "^":
      case "$": {
        goal = undefined
        const m = motionTarget(t, key, false)
        if (!m) return true
        let target = ["h", "b", "B", "0", "^"].includes(key) ? m[0] : m[1]
        // $ sits ON the last character, not past it
        if (key === "$" && target > lineStart(text, pos)) target = adjacent(t, target, -1)
        paint(t, target)
        return true
      }
      case "j":
      case "k": {
        paint(t, verticalMove(t, key === "j" ? 1 : -1, amount, false))
        return true
      }
      case "g":
        gPending = true
        return true
      case "G": {
        goal = undefined
        paint(t, lineStart(text, text.length))
        return true
      }
      case "x": {
        if (pos < text.length && text[pos] !== "\n") {
          snapshot(t)
          const end = adjacent(t, pos, 1)
          register = text.slice(pos, end)
          registerLinewise = false
          apply(t, text.slice(0, pos) + text.slice(end), pos)
        }
        return true
      }
      case "s": {
        snapshot(t)
        apply(t, text.slice(0, pos) + text.slice(adjacent(t, pos, 1)), pos)
        enterInsert(t, pos)
        return true
      }
      case "D":
      case "C": {
        snapshot(t)
        const end = lineEnd(text, pos)
        register = text.slice(pos, end)
        registerLinewise = false
        apply(t, text.slice(0, pos) + text.slice(end), pos)
        if (key === "C") enterInsert(t, pos)
        return true
      }
      case "S": {
        snapshot(t)
        const [from, to] = lineRange(text, pos)
        const keepNl = text[to - 1] === "\n" ? "\n" : ""
        apply(t, text.slice(0, from) + keepNl + text.slice(to), from)
        enterInsert(t, from)
        return true
      }
      case "d":
      case "c":
      case "y":
        pendingOp = key as "d" | "c" | "y"
        operatorCount = count || 1
        count = 0
        return true
      case "p":
      case "P": {
        if (!register) return true
        snapshot(t)
        if (registerLinewise) {
          const at = key === "p" ? Math.min(lineEnd(text, pos) + 1, text.length) : lineStart(text, pos)
          const chunk = register.endsWith("\n") ? register : register + "\n"
          apply(t, text.slice(0, at) + chunk + text.slice(at), at)
        } else {
          const at = key === "p" ? adjacent(t, pos, 1) : pos
          apply(t, text.slice(0, at) + register + text.slice(at), at + register.length - 1)
        }
        return true
      }
      case "u": {
        const snap = undoStack.pop()
        if (snap) {
          redoStack.push({ value: t.value, sel: pos })
          apply(t, snap.value, snap.sel)
        }
        return true
      }
      case "Tab": {
        opts.onTab?.(e.shiftKey)
        return true
      }
      case "Enter": {
        opts.onEnter?.()
        return true
      }
      default:
        // swallow printable keys in normal mode so they don't type
        return key.length === 1
    }
  }

  /** returns true when the event was consumed */
  const handleKeyDown = (e: KeyboardEvent): boolean => {
    const t = el(e)
    if (mode() === "insert") {
      if (e.key === "Escape") {
        snapshot(t)
        undoStack.pop() // snapshot() cleared redo; keep a light heuristic:
        const pos = adjacent(t, cursor(t), -1)
        undoStack.push({ value: t.value, sel: pos })
        setMode("normal")
        paint(t, pos)
        e.preventDefault()
        return true
      }
      // emacs-style word motion; match on code — macOS alt+f/b types ƒ/∫
      if (e.altKey && !e.ctrlKey && !e.metaKey && (e.code === "KeyF" || e.code === "KeyB")) {
        const pos = cursor(t)
        const next = e.code === "KeyF" ? wordForward(t.value, pos) : wordBack(t.value, pos)
        t.setSelectionRange(next, next)
        e.preventDefault()
        return true
      }
      return false
    }
    const consumed = handleNormal(e)
    if (consumed) e.preventDefault()
    return consumed
  }

  /** re-assert the block cursor (e.g. after focus or external value change) */
  const refresh = (t: HTMLTextAreaElement | undefined) => {
    if (t && mode() === "normal") {
      sync(t)
      paint(t, cursor(t), false)
    }
  }

  return { mode, setMode, handleKeyDown, refresh, enterInsertAt: enterInsert }
}
