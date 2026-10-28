/* Human #420 icon chips: a private preview variant, off unless chosen. `?chips=icons|off` applies to the current page
 * load only; otherwise localStorage `es-app:chips` = "icons", which only the disposable preview server sets for its
 * own origin. Production pages never set it. */
const choice = () => {
  if (typeof location === "undefined") return null
  const param = new URLSearchParams(location.search).get("chips")
  if (param !== null) return param
  try {
    return localStorage.getItem("es-app:chips")
  } catch {
    return null
  }
}
export const iconChips = choice() === "icons"
// Scopes the preview's CSS (appearance.css "Icon chips") to pages that chose it.
if (iconChips) document.documentElement.dataset.chips = "icons"
