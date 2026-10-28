/* Filament is opt-in: localStorage `es-app:filament` = "1", set deliberately by an operator.
 * Default off. `?filament=1|0` applies to the current page load only and writes nothing, so a
 * stray review link can never leave the overlay enabled on the stable app. `?filamentHud=1`
 * shows the measurement overlay. */
export const FLAG_KEY = "es-app:filament"

const read = (key: string) => {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}
const param = (name: string) => (typeof location === "undefined" ? null : new URLSearchParams(location.search).get(name))

export const filamentEnabled = () => {
  const url = param("filament")
  if (url !== null) return url === "1"
  return read(FLAG_KEY) === "1"
}
export const filamentHud = () => param("filamentHud") === "1"
export const reducedMotion = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches
