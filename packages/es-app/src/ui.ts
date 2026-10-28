/* Sidebar visibility + widths: module-level signals, persisted, with drag
 * resizing and ^h/^l toggles (installed once from the shell). */
import { createSignal } from "solid-js"

const read = (key: string, fallback: number) => {
  const v = Number(localStorage.getItem(key))
  return Number.isFinite(v) && v > 0 ? v : fallback
}

const [leftOpen, setLeftOpen] = createSignal(localStorage.getItem("es-app-left-open") !== "0")
const [rightOpen, setRightOpen] = createSignal(localStorage.getItem("es-app-right-open") !== "0")
const [leftWidth, setLeftWidth] = createSignal(read("es-app-left-width", 240))
const [rightWidth, setRightWidth] = createSignal(read("es-app-right-width", 280))

export { leftOpen, leftWidth, rightOpen, rightWidth }

export const toggleLeft = () => {
  setLeftOpen(!leftOpen())
  localStorage.setItem("es-app-left-open", leftOpen() ? "1" : "0")
}

export const toggleRight = () => {
  setRightOpen(!rightOpen())
  localStorage.setItem("es-app-right-open", rightOpen() ? "1" : "0")
}

const CLAMP: Record<"left" | "right", [number, number]> = {
  left: [160, 480],
  right: [200, 560],
}

/** The width bounds of each side panel, in CSS px. */
export const panelBounds = (side: "left" | "right") => CLAMP[side]

// "left" is the nav at the inline start; "right" is the info panel at the inline end. A panel grows when
// its edge moves away from its own side, so the physical pointer delta flips with the document direction.
const growth = (side: "left" | "right", physical: number) => {
  const ltr = getComputedStyle(document.documentElement).direction !== "rtl"
  return physical * (side === "left" ? 1 : -1) * (ltr ? 1 : -1)
}
const resize = (side: "left" | "right", width: number) => {
  const [min, max] = CLAMP[side]
  ;(side === "left" ? setLeftWidth : setRightWidth)(Math.round(Math.min(max, Math.max(min, width))))
}
const save = (side: "left" | "right") =>
  localStorage.setItem(side === "left" ? "es-app-left-width" : "es-app-right-width", String(side === "left" ? leftWidth() : rightWidth()))

export function startDrag(side: "left" | "right", down: PointerEvent) {
  if (down.button !== 0) return
  down.preventDefault()
  const handle = down.currentTarget as HTMLElement
  const startX = down.clientX
  const start = side === "left" ? leftWidth() : rightWidth()
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
export function keyResize(side: "left" | "right", e: KeyboardEvent) {
  const width = side === "left" ? leftWidth() : rightWidth()
  const [min, max] = CLAMP[side]
  const step = e.shiftKey ? 64 : 16
  const next = e.key === "ArrowRight" ? width + growth(side, step) : e.key === "ArrowLeft" ? width + growth(side, -step)
    : e.key === "Home" ? min : e.key === "End" ? max : undefined
  if (next === undefined) return
  e.preventDefault()
  resize(side, next)
  save(side)
}

/** window-level ^h/^l toggles; safe inside textareas (no browser default) */
export function installSidebarKeys(): () => void {
  const handler = (e: KeyboardEvent) => {
    if (e.defaultPrevented || (e.target instanceof Element && e.target.closest('[role="dialog"]'))) return
    if (!e.ctrlKey || e.metaKey || e.altKey) return
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
