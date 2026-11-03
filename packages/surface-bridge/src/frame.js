// In-frame half of the Surface comment bridge. Both functions are self-contained (no imports, no module scope) so
// index.js can serialize them into one injectable script; a host with its own frame runtime may import
// createAnchorKit directly and keep its own rendering. Plain ES2017: consumers bundle it as is.

/** Anchor and privacy rules for one document: which elements are pickable, what an anchor records, and where a
 * stored anchor is now. Holds the host's policy narrowing; the page's own declaration is a floor it cannot loosen. */
export function createAnchorKit(win) {
  const document = win.document
  const CANDIDATES = "[data-anchor], h1, h2, h3, h4, p, li, pre, table, figure, img, section, article, blockquote, dd, td, th, button, a, label, summary"
  const PRIVATE = "[data-es-private]"
  // Visible text only: private subtrees, form fields and editable regions (drafts) never contribute.
  const SKIP = PRIVATE + ", input, textarea, select, option, [contenteditable]:not([contenteditable=false]), script, style, template"
  const RANK = { open: 0, declared: 1, off: 2 }
  let hostPolicy = "open"
  const fnv = (text) => {
    let h = 0x811c9dc5
    for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193) }
    return (h >>> 0).toString(16).padStart(8, "0")
  }
  const pagePolicy = () => {
    const meta = document.querySelector('meta[name="es-comments-anchors"]')
    const value = meta && meta.getAttribute("content")
    return value in RANK ? value : "open"
  }
  const policy = () => { const page = pagePolicy(); return RANK[hostPolicy] > RANK[page] ? hostPolicy : page }
  const isPrivate = (el) => !!(el && el.closest && el.closest(PRIVATE))
  const textOf = (el) => {
    let text = ""
    const walk = document.createTreeWalker(el, win.NodeFilter.SHOW_ELEMENT | win.NodeFilter.SHOW_TEXT, {
      acceptNode: (node) => node.nodeType === 1 && node.matches(SKIP) ? win.NodeFilter.FILTER_REJECT : win.NodeFilter.FILTER_ACCEPT,
    })
    for (let node = walk.nextNode(); node && text.length < 8000; node = walk.nextNode()) if (node.nodeType === 3) text += node.data
    return text.replace(/\s+/g, " ").trim().slice(0, 4000)
  }
  const hashOf = (el) => fnv(el.tagName + "|" + textOf(el))
  const esc = (value) => win.CSS && win.CSS.escape ? win.CSS.escape(value) : String(value).replace(/[^a-zA-Z0-9_-]/g, (ch) => "\\" + ch)
  const ownId = (el) => el.getAttribute("data-anchor") || (el.id && !/^\d/.test(el.id) ? el.id : "")
  // tag:nth-of-type steps from the nearest ancestor with a stable id (or body); no classes, which pages regenerate.
  const selectorOf = (el) => {
    const steps = []
    for (let node = el; node && node.nodeType === 1 && node !== document.body && node !== document.documentElement; node = node.parentElement) {
      const id = node !== el && ownId(node)
      if (id) { steps.unshift(node.hasAttribute("data-anchor") ? '[data-anchor="' + id.replace(/"/g, '\\"') + '"]' : "#" + esc(id)); break }
      let index = 1
      for (let sib = node.previousElementSibling; sib; sib = sib.previousElementSibling) if (sib.tagName === node.tagName) index++
      steps.unshift(node.tagName.toLowerCase() + ":nth-of-type(" + index + ")")
    }
    const selector = steps.join(" > ")
    return selector.length <= 500 ? selector : ""
  }
  const docSize = () => ({ w: Math.max(document.documentElement.scrollWidth, 1), h: Math.max(document.documentElement.scrollHeight, 1) })
  const round = (n) => Math.round(Math.max(0, Math.min(1, n)) * 10000) / 10000
  const viewRect = (r) => ({ x: r.left, y: r.top, w: r.width, h: r.height })
  // Never move a comment to a "nearest" element: an anchor whose id and selector both fail is missing.
  const elementOf = (anchor) => {
    const declared = policy() === "declared"
    let el = null
    if (anchor.id) el = document.querySelector('[data-anchor="' + String(anchor.id).replace(/"/g, '\\"') + '"]') || (declared ? null : document.getElementById(anchor.id))
    if (!el && anchor.selector && !declared) { try { el = document.querySelector(anchor.selector) } catch (e) { el = null } }
    return isPrivate(el) ? null : el
  }
  const selectors = () => policy() === "declared" ? "[data-anchor]" : CANDIDATES
  return {
    pagePolicy,
    policy,
    /** Narrow (never loosen) the page's policy: "declared" or "open". */
    setHostPolicy: (value) => { hostPolicy = value === "declared" ? "declared" : "open" },
    isPrivate,
    hashOf,
    viewRect,
    /** What a pick records: declared = { id, rect }; open = { hash, rect, id?, selector? }. rect is in document fractions. */
    anchorOf: (el) => {
      const r = el.getBoundingClientRect(), size = docSize()
      const rect = { x: round((r.left + win.scrollX) / size.w), y: round((r.top + win.scrollY) / size.h), w: round(r.width / size.w), h: round(r.height / size.h) }
      if (policy() === "declared") return { id: el.getAttribute("data-anchor").slice(0, 200), rect }
      const anchor = { hash: hashOf(el), rect }
      const id = ownId(el)
      if (id) anchor.id = id.slice(0, 200)
      const selector = selectorOf(el)
      if (selector) anchor.selector = selector
      return anchor
    },
    elementOf,
    /** Where a stored anchor is in the viewport: shown | changed | hidden | missing (off: always missing). A rect-only
     * anchor from another client is placed by its document fractions. */
    resolve: (anchor) => {
      if (policy() === "off") return { rect: null, state: "missing" }
      const el = elementOf(anchor)
      if (el) {
        const r = el.getBoundingClientRect()
        if (!r.width && !r.height) return { rect: null, state: "hidden" }
        return { rect: viewRect(r), state: anchor.hash && policy() !== "declared" && hashOf(el) !== anchor.hash ? "changed" : "shown" }
      }
      if (!anchor.id && !anchor.selector && anchor.rect) {
        const size = docSize()
        return { rect: { x: anchor.rect.x * size.w - win.scrollX, y: anchor.rect.y * size.h - win.scrollY, w: anchor.rect.w * size.w, h: anchor.rect.h * size.h }, state: "shown" }
      }
      return { rect: null, state: "missing" }
    },
    /** Visible pickable elements in document order (never private). */
    candidates: () => Array.from(document.querySelectorAll(selectors())).filter((el) => {
      const r = el.getBoundingClientRect()
      return r.width > 0 && r.height > 0 && !isPrivate(el)
    }),
    /** The nearest pickable ancestor of el, or null inside a private subtree or (declared) outside any [data-anchor]. */
    target: (el) => {
      if (isPrivate(el)) return null
      const match = selectors()
      for (let node = el; node && node !== document.body; node = node.parentElement) if (node.matches && node.matches(match)) return node
      return policy() === "declared" ? null : el
    },
  }
}

/** The full es-comments controller in a framed page: pick mode (pointer and keyboard), anchor tracking and the
 * postMessage protocol (PROTOCOL.md). Owns anchors and positions only; comment text never enters the frame. */
export function installSurfaceBridge(win, createKit) {
  if (win.__esComments || win.parent === win) return
  win.__esComments = true
  const document = win.document
  const kit = createKit(win)
  const NS = "es-comments"
  const post = (type, payload) => win.parent.postMessage(Object.assign({ ns: NS, type }, payload || {}), "*")
  const on = (type, handler, options) => win.addEventListener(type, handler, options)
  const reducedMotion = () => win.matchMedia("(prefers-reduced-motion: reduce)").matches

  let tracked = []
  let frame = 0
  const report = () => { frame = 0; post("rects", { items: tracked.map((item) => Object.assign({ key: item.key }, kit.resolve(item.anchor))) }) }
  const schedule = () => { if (!frame) frame = win.requestAnimationFrame(report) }
  on("scroll", schedule, { passive: true, capture: true })
  on("resize", schedule)
  new win.MutationObserver(schedule).observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true })

  // Pick mode: an outline follows the pointer (or the keyboard's current candidate); a click or Enter picks.
  let picking = false, current = null, outline = null
  const hide = () => { current = null; if (outline) outline.style.width = "0px" }
  const show = (el) => {
    current = el
    if (!outline) {
      outline = document.createElement("div")
      outline.setAttribute("aria-hidden", "true")
      outline.style.cssText = "position:fixed;z-index:2147483647;pointer-events:none;border:2px solid #89b4fa;border-radius:4px;background:rgba(137,180,250,.10);box-shadow:0 0 0 4000px rgba(0,0,0,.18);transition:all .08s ease-out"
      if (reducedMotion()) outline.style.transition = "none"
      document.documentElement.appendChild(outline)
    }
    const r = el.getBoundingClientRect()
    Object.assign(outline.style, { left: r.left - 3 + "px", top: r.top - 3 + "px", width: r.width + 6 + "px", height: r.height + 6 + "px" })
  }
  const stop = () => { picking = false; current = null; if (outline) { outline.remove(); outline = null } document.documentElement.style.cursor = "" }
  const pick = (el) => { const anchor = kit.anchorOf(el), rect = kit.viewRect(el.getBoundingClientRect()); stop(); post("picked", { anchor, rect }) }
  const step = (delta) => {
    const list = kit.candidates()
    if (!list.length) return
    let index = current ? list.indexOf(current) : -1
    index = index < 0 ? (delta > 0 ? 0 : list.length - 1) : Math.max(0, Math.min(list.length - 1, index + delta))
    list[index].scrollIntoView({ block: "nearest" })
    show(list[index])
  }
  on("pointermove", (event) => {
    if (!picking || !(event.target instanceof win.Element) || event.target === outline) return
    const el = kit.target(event.target)
    if (el) show(el); else hide()
  }, true)
  on("click", (event) => {
    if (!picking) return
    event.preventDefault(); event.stopPropagation()
    const el = event.target instanceof win.Element && kit.target(event.target)
    if (el) pick(el)
  }, true)
  const typing = (el) => el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))
  // Pick-mode keys, pressed in the page or forwarded by the host while its own window has focus.
  const pickKey = (key, shift) => {
    if (key === "Escape") { stop(); post("pick-end"); return true }
    if (["ArrowDown", "ArrowRight", "j"].includes(key) || (key === "Tab" && !shift)) { step(1); return true }
    if (["ArrowUp", "ArrowLeft", "k"].includes(key) || (key === "Tab" && shift)) { step(-1); return true }
    if ((key === "Enter" || key === " ") && current) { pick(current); return true }
    return false
  }
  on("keydown", (event) => {
    if (picking) {
      if (pickKey(event.key, event.shiftKey)) event.preventDefault()
      return
    }
    if (typing(document.activeElement) || event.metaKey || event.ctrlKey || event.altKey) return
    if (event.key === "c" || event.key === "Escape") post("key", { key: event.key })
  }, true)

  on("message", (event) => {
    const data = event.data
    if (event.source !== win.parent || !data || data.ns !== NS) return
    if (data.type === "pick") {
      if (!data.on) return stop()
      kit.setHostPolicy(data.policy)
      if (kit.policy() === "off") { post("pick-end"); return }
      picking = true
      document.documentElement.style.cursor = "crosshair"
      if (data.keyboard) {
        const first = kit.candidates().find((el) => { const r = el.getBoundingClientRect(); return r.top >= 0 && r.top < win.innerHeight })
        if (first) show(first)
      }
    }
    if (data.type === "pick-key" && picking) pickKey(String(data.key), !!data.shift)
    if (data.type === "track" && (data.policy === "declared" || data.policy === "open")) kit.setHostPolicy(data.policy)
    if (data.type === "track") { tracked = Array.isArray(data.anchors) ? data.anchors.slice(0, 500) : []; schedule() }
    if (data.type === "reveal") {
      const item = tracked.find((entry) => entry.key === data.key)
      const found = item && item.anchor && kit.elementOf(item.anchor)
      if (found) found.scrollIntoView({ block: "center", behavior: reducedMotion() ? "auto" : "smooth" })
    }
  })
  // After parsing, so the page's policy meta (which follows this script in <head>) is known.
  const ready = () => post("ready", { policy: kit.pagePolicy(), version: 1 })
  if (document.readyState === "loading") on("DOMContentLoaded", ready, { once: true }); else ready()
}
