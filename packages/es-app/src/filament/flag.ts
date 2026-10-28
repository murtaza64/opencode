/* The appearance setting controls Filament and icon-first rows together. The HUD remains a preview-only diagnostic. */
const param = (name: string) => (typeof location === "undefined" ? null : new URLSearchParams(location.search).get(name))

export const filamentHud = () => param("filamentHud") === "1"
export const reducedMotion = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches
