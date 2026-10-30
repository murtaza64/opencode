/* Preload for Personal (page-mode) views only. Runs at document start in the view's isolated world, before any page
 * script and before any user input, and exposes nothing to the page. It watches trusted input, takes one baseline when
 * the load has settled with no input, and answers reads from the same world (`__esPageGuard.read()`, see
 * page-guard-core.ts) with counts only. A new document starts over; a page that was already loaded gets no baseline. */
import { guardResult, hashValue, SETTLE_MS, type Entry, type Snapshot, type Unsupported } from "./page-guard-core"

const TEXT_SKIP = new Set(["hidden", "checkbox", "radio", "password", "file", "submit", "button", "image", "reset", "range", "color"])
const generation = crypto.randomUUID()
const state: { baseline?: Snapshot & { url: string }; interactedBeforeBaseline: boolean; interacted: boolean } = { interactedBeforeBaseline: false, interacted: false }

const visible = (element: Element) => element.getClientRects().length > 0
const fields = (): Entry[] => {
  const seen = new Map<string, number>()
  return Array.from(document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("input, textarea"))
    .filter((element) => visible(element) && !(element instanceof HTMLInputElement && TEXT_SKIP.has(element.type)))
    .map((element) => {
      const base = `${element.tagName}:${element instanceof HTMLInputElement ? element.type : "textarea"}:${element.name || element.id}`
      const ordinal = seen.get(base) ?? 0
      seen.set(base, ordinal + 1)
      return { key: `${base}:${ordinal}`, hash: hashValue(element.value) }
    })
}
const session = (): Entry[] => {
  try {
    return Object.keys(sessionStorage).sort().map((key) => ({ key, hash: hashValue(sessionStorage.getItem(key) ?? "") }))
  } catch {
    return []
  }
}
const unsupported = (): Unsupported => {
  const all = Array.from(document.querySelectorAll("*"))
  const active = document.activeElement
  return {
    password: Array.from(document.querySelectorAll<HTMLInputElement>("input[type=password]")).some((element) => element.value.length > 0),
    file: Array.from(document.querySelectorAll<HTMLInputElement>("input[type=file]")).some((element) => (element.files?.length ?? 0) > 0),
    contenteditable: Array.from(document.querySelectorAll<HTMLElement>("[contenteditable]:not([contenteditable=false])")).some((element) => visible(element) && (element.textContent ?? "").length > 0),
    frame: document.querySelectorAll("iframe, frame").length > 0,
    shadow: all.some((element) => element.shadowRoot !== null),
    selection: !(document.getSelection()?.isCollapsed ?? true) ||
      ((active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) && active.selectionStart !== active.selectionEnd),
  }
}

for (const type of ["beforeinput", "input", "change", "compositionstart", "paste", "drop", "cut"])
  window.addEventListener(type, (event) => {
    if (!event.isTrusted) return
    state.interacted = true
    if (!state.baseline) state.interactedBeforeBaseline = true
  }, { capture: true })

window.addEventListener("load", () => setTimeout(() => {
  if (state.interactedBeforeBaseline) return
  state.baseline = { fields: fields(), session: session(), url: location.href }
}, SETTLE_MS), { once: true })

Object.defineProperty(globalThis, "__esPageGuard", {
  value: Object.freeze({
    version: 1,
    read: () => guardResult({ generation, baseline: state.baseline, interactedBeforeBaseline: state.interactedBeforeBaseline, interacted: state.interacted,
      url: location.href, current: { fields: fields(), session: session() }, unsupported: unsupported() }),
  }),
})
