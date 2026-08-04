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

export function startDrag(side: "left" | "right", down: MouseEvent) {
  down.preventDefault()
  const [min, max] = CLAMP[side]
  const set = side === "left" ? setLeftWidth : setRightWidth
  const move = (e: MouseEvent) => {
    const raw = side === "left" ? e.clientX : window.innerWidth - e.clientX
    set(Math.min(max, Math.max(min, raw)))
  }
  const up = () => {
    window.removeEventListener("mousemove", move)
    window.removeEventListener("mouseup", up)
    document.body.style.cursor = ""
    localStorage.setItem(
      side === "left" ? "es-app-left-width" : "es-app-right-width",
      String(side === "left" ? leftWidth() : rightWidth()),
    )
  }
  document.body.style.cursor = "col-resize"
  window.addEventListener("mousemove", move)
  window.addEventListener("mouseup", up)
}

/** window-level ^h/^l toggles; safe inside textareas (no browser default) */
export function installSidebarKeys(): () => void {
  const handler = (e: KeyboardEvent) => {
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
