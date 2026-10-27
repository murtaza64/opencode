/* One-shot decays that mark what just changed. State itself always applies on
 * the frame of the event (instant attack); these only fade a highlight away
 * afterwards, so they never delay input or move layout. Each runs once with
 * the Web Animations API on a small element and ends with no residue, unlike
 * an infinite animation. Reduced motion skips them. */
import { createEffect, on } from "solid-js"

const reduced = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches
const ease = "cubic-bezier(.2,0,0,1)"

// A ring that expands from a status dot when it newly needs attention.
const ring = (el: HTMLElement) => {
  if (reduced() || typeof el.animate !== "function") return
  const color = getComputedStyle(el).backgroundColor
  el.animate([
    { boxShadow: `0 0 0 0 color-mix(in srgb, ${color} 70%, transparent)` },
    { boxShadow: "0 0 0 7px transparent" },
  ], { duration: 600, easing: ease })
}

// Rings only on a change to an attention state after mount, never on first paint.
// The element is read after the change renders, since a state may swap the node.
export const ringOnChange = (el: () => HTMLElement | undefined, state: () => string, attention = ["pending", "failed"]) =>
  createEffect(on(state, (next, previous) => {
    if (previous === undefined || next === previous || !attention.includes(next)) return
    queueMicrotask(() => { const node = el(); if (node?.isConnected) ring(node) })
  }))

// Tints a jump target and fades it, so the eye lands on what the jump selected.
export const flash = (el: Element | null | undefined) => {
  if (!el || typeof (el as HTMLElement).animate !== "function") return
  if (reduced()) {
    // Static marker instead of motion.
    el.animate([{ outline: "1px solid var(--yellow)" }, { outline: "1px solid var(--yellow)" }], { duration: 1200 })
    return
  }
  el.animate([
    { backgroundColor: "color-mix(in srgb, var(--yellow) 20%, transparent)" },
    { backgroundColor: "transparent" },
  ], { duration: 600, easing: ease })
}
