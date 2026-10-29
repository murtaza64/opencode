/* Sidebar visibility + widths: module-level signals, persisted, with drag
 * resizing and ^h/^l toggles (installed once from the shell). */
import { createSignal } from "solid-js"
import { isTypingTarget } from "./shortcuts"

const read = (key: string, fallback: number) => {
  const v = Number(localStorage.getItem(key))
  return Number.isFinite(v) && v > 0 ? v : fallback
}

const [leftOpen, setLeftOpen] = createSignal(localStorage.getItem("es-app-left-open") !== "0")
const [rightOpen, setRightOpen] = createSignal(localStorage.getItem("es-app-right-open") !== "0")
const [leftWidth, setLeftWidth] = createSignal(read("es-app-left-width", 240))
const [rightWidth, setRightWidth] = createSignal(read("es-app-right-width", 280))
const [companionWidth, setCompanionWidth] = createSignal(read("es-app-companion-width", 380))
// Whether the Front desk chat is docked open beside the content; the session info panel steps aside then,
// without changing its own remembered visibility or width.
const [companionDocked, setCompanionDocked] = createSignal(false)

export { leftOpen, leftWidth, rightOpen, rightWidth, companionWidth, companionDocked, setCompanionDocked }

export type Side = "left" | "right" | "companion"

export const toggleLeft = () => {
  setLeftOpen(!leftOpen())
  localStorage.setItem("es-app-left-open", leftOpen() ? "1" : "0")
}

export const toggleRight = () => {
  setRightOpen(!rightOpen())
  localStorage.setItem("es-app-right-open", rightOpen() ? "1" : "0")
}

const CLAMP: Record<Side, [number, number]> = {
  left: [160, 480],
  right: [200, 560],
  companion: [300, 720],
}
const WIDTH = { left: leftWidth, right: rightWidth, companion: companionWidth }
const SET = { left: setLeftWidth, right: setRightWidth, companion: setCompanionWidth }
const KEY = { left: "es-app-left-width", right: "es-app-right-width", companion: "es-app-companion-width" }

/** The width bounds of each side panel, in CSS px. */
export const panelBounds = (side: Side) => CLAMP[side]
export const panelWidth = (side: Side) => WIDTH[side]()

// "left" is the nav at the inline start; "right" (info panel) and "companion" sit at the inline end. A panel grows when
// its edge moves away from its own side, so the physical pointer delta flips with the document direction.
const growth = (side: Side, physical: number) => {
  const ltr = getComputedStyle(document.documentElement).direction !== "rtl"
  return physical * (side === "left" ? 1 : -1) * (ltr ? 1 : -1)
}
const resize = (side: Side, width: number) => {
  const [min, max] = CLAMP[side]
  SET[side](Math.round(Math.min(max, Math.max(min, width))))
}
const save = (side: Side) => localStorage.setItem(KEY[side], String(WIDTH[side]()))

export function startDrag(side: Side, down: PointerEvent) {
  if (down.button !== 0) return
  down.preventDefault()
  const handle = down.currentTarget as HTMLElement
  const startX = down.clientX
  const start = WIDTH[side]()
  handle.setPointerCapture(down.pointerId)
  handle.dataset.dragging = ""
  const move = (e: PointerEvent) => resize(side, start + growth(side, e.clientX - startX))
  const up = () => {
    handle.removeEventListener("pointermove", move)
    handle.removeEventListener("pointerup", up)
    handle.removeEventListener("pointercancel", up)
    delete handle.dataset.dragging
    document.body.style.cursor = ""
    save(side)
  }
  document.body.style.cursor = "col-resize"
  handle.addEventListener("pointermove", move)
  handle.addEventListener("pointerup", up)
  handle.addEventListener("pointercancel", up)
}

/** Arrow keys move the edge the way they point (so they mirror in RTL); Home/End go to the bounds. */
export function keyResize(side: Side, e: KeyboardEvent) {
  const width = WIDTH[side]()
  const [min, max] = CLAMP[side]
  const step = e.shiftKey ? 64 : 16
  const next = e.key === "ArrowRight" ? width + growth(side, step) : e.key === "ArrowLeft" ? width + growth(side, -step)
    : e.key === "Home" ? min : e.key === "End" ? max : undefined
  if (next === undefined) return
  e.preventDefault()
  resize(side, next)
  save(side)
}

/** window-level ^h/^l panel toggles. In text fields ^h keeps its text meaning (D6,
 * delete backward on macOS); the composer stops it itself in insert mode so normal
 * mode can still toggle. */
export function installSidebarKeys(): () => void {
  const handler = (e: KeyboardEvent) => {
    if (e.defaultPrevented || (e.target instanceof Element && e.target.closest('[role="dialog"]'))) return
    if (!e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return
    if (e.key === "h" && isTypingTarget(e.target) && !(e.target as Element).closest(".prompt-box")) return
    if (e.key === "h") {
      e.preventDefault()
      toggleLeft()
    } else if (e.key === "l") {
      e.preventDefault()
      toggleRight()
    }
  }
  window.addEventListener("keydown", handler)
  return () => window.removeEventListener("keydown", handler)
}
