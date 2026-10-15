/* Shared low-rate clock for activity indicators. An infinite CSS animation
 * makes the compositor produce a frame every vsync (120 Hz on ProMotion) even
 * under steps() timing; two indicators cost ~3% GPU + ~1.5% renderer CPU while
 * the app sat idle. Two discrete updates per second read the same. The timer
 * runs only while an indicator is mounted, and never under reduced motion. */
import { createSignal, onCleanup } from "solid-js"

const [tick, setTick] = createSignal(0)
let users = 0
let timer: ReturnType<typeof setInterval> | undefined

export const usePulse = () => {
  users++
  if (!timer && !matchMedia("(prefers-reduced-motion: reduce)").matches)
    timer = setInterval(() => setTick((value) => value + 1), 500)
  onCleanup(() => {
    users--
    if (users || !timer) return
    clearInterval(timer)
    timer = undefined
  })
  return tick
}
