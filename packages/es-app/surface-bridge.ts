/* The on-surface comment bridge: a small script the Surface proxy inlines into every HTML page it serves, so the reader
 * can anchor comments on a cross-origin, sandboxed frame. It owns only anchors and their positions; the app chrome owns
 * comment text, identity and storage, and never sends comment bodies into the frame (the page is agent-authored).
 *
 * Protocol (postMessage, `ns: "es-comments"`):
 *   app -> frame  { type: "pick", on, keyboard }      enter/leave pick mode; keyboard starts on the first visible candidate
 *                 { type: "track", anchors: [{ key, anchor }] }   report where these anchors are (and keep reporting)
 *                 { type: "pick-key", key, shift }    a pick-mode key pressed while the app had focus
 *                 { type: "reveal", key }             scroll that anchor into view
 *   frame -> app  { type: "ready" }
 *                 { type: "picked", anchor, rect }    rect in frame-viewport pixels
 *                 { type: "pick-end" }                left pick mode without picking (Esc)
 *                 { type: "rects", items: [{ key, rect, state }] }   state: shown | changed | hidden | missing
 *                 { type: "key", key }                "c" (comment) or "Escape", pressed while the page had focus
 *
 * Kept as a string (not a bundled module) so every server that serves Surfaces, packaged or not, inlines the same bytes. */
export const SURFACE_BRIDGE = String.raw`(() => {
  if (window.__esComments || window.parent === window) return;
  window.__esComments = true;
  const NS = "es-comments";
  const post = (type, payload) => parent.postMessage(Object.assign({ ns: NS, type }, payload || {}), "*");
  const CANDIDATES = "[data-anchor], h1, h2, h3, h4, p, li, pre, table, figure, img, section, article, blockquote, dd, td, th, button, a, label, summary";
  const FNV = text => { let h = 0x811c9dc5; for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193); } return (h >>> 0).toString(16).padStart(8, "0"); };
  const textOf = el => (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 4000);
  const hashOf = el => FNV(el.tagName + "|" + textOf(el));
  const esc = value => (window.CSS && CSS.escape) ? CSS.escape(value) : String(value).replace(/[^a-zA-Z0-9_-]/g, ch => "\\" + ch);
  const ownId = el => el.getAttribute("data-anchor") || (el.id && !/^\d/.test(el.id) ? el.id : "");
  // A path of tag:nth-of-type steps from the nearest ancestor with a stable id (or body): no classes, which pages
  // regenerate freely.
  const selectorOf = el => {
    const steps = [];
    for (let node = el; node && node.nodeType === 1 && node !== document.body && node !== document.documentElement; node = node.parentElement) {
      const id = node !== el && ownId(node);
      if (id) { steps.unshift(node.hasAttribute("data-anchor") ? '[data-anchor="' + id.replace(/"/g, '\\"') + '"]' : "#" + esc(id)); break; }
      let index = 1;
      for (let sib = node.previousElementSibling; sib; sib = sib.previousElementSibling) if (sib.tagName === node.tagName) index++;
      steps.unshift(node.tagName.toLowerCase() + ":nth-of-type(" + index + ")");
    }
    const selector = steps.join(" > ");
    return selector.length <= 500 ? selector : "";
  };
  const docSize = () => ({ w: Math.max(document.documentElement.scrollWidth, 1), h: Math.max(document.documentElement.scrollHeight, 1) });
  const round = n => Math.round(Math.max(0, Math.min(1, n)) * 10000) / 10000;
  const anchorOf = el => {
    const r = el.getBoundingClientRect(), size = docSize();
    const anchor = { hash: hashOf(el), rect: { x: round((r.left + scrollX) / size.w), y: round((r.top + scrollY) / size.h), w: round(r.width / size.w), h: round(r.height / size.h) } };
    const id = ownId(el);
    if (id) anchor.id = id.slice(0, 200);
    const selector = selectorOf(el);
    if (selector) anchor.selector = selector;
    return anchor;
  };
  const viewRect = r => ({ x: r.left, y: r.top, w: r.width, h: r.height });
  // Never move a comment to a "nearest" element: an anchor whose id and selector both fail is missing, and a
  // rect-only anchor (from another client) is placed by its document fractions.
  const elementOf = anchor => {
    let el = null;
    if (anchor.id) el = document.querySelector('[data-anchor="' + String(anchor.id).replace(/"/g, '\\"') + '"]') || document.getElementById(anchor.id);
    if (!el && anchor.selector) { try { el = document.querySelector(anchor.selector); } catch (e) { el = null; } }
    return el;
  };
  const resolve = anchor => {
    const el = elementOf(anchor);
    if (el) {
      const r = el.getBoundingClientRect();
      if (!r.width && !r.height) return { rect: null, state: "hidden" };
      return { rect: viewRect(r), state: anchor.hash && hashOf(el) !== anchor.hash ? "changed" : "shown" };
    }
    if (!anchor.id && !anchor.selector && anchor.rect) {
      const size = docSize();
      return { rect: { x: anchor.rect.x * size.w - scrollX, y: anchor.rect.y * size.h - scrollY, w: anchor.rect.w * size.w, h: anchor.rect.h * size.h }, state: "shown" };
    }
    return { rect: null, state: "missing" };
  };

  let tracked = [];
  let frame = 0;
  const report = () => { frame = 0; post("rects", { items: tracked.map(item => Object.assign({ key: item.key }, resolve(item.anchor))) }); };
  const schedule = () => { if (!frame) frame = requestAnimationFrame(report); };
  addEventListener("scroll", schedule, { passive: true, capture: true });
  addEventListener("resize", schedule);
  new MutationObserver(schedule).observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });

  // Pick mode: an outline follows the pointer (or the keyboard's current candidate); a click or Enter picks.
  let picking = false, current = null, outline = null;
  const candidates = () => Array.from(document.querySelectorAll(CANDIDATES)).filter(el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
  const target = el => { for (let node = el; node && node !== document.body; node = node.parentElement) if (node.matches && node.matches(CANDIDATES)) return node; return el; };
  const show = el => {
    current = el;
    if (!outline) {
      outline = document.createElement("div");
      outline.setAttribute("aria-hidden", "true");
      outline.style.cssText = "position:fixed;z-index:2147483647;pointer-events:none;border:2px solid #89b4fa;border-radius:4px;background:rgba(137,180,250,.10);box-shadow:0 0 0 4000px rgba(0,0,0,.18);transition:all .08s ease-out";
      if (matchMedia("(prefers-reduced-motion: reduce)").matches) outline.style.transition = "none";
      document.documentElement.appendChild(outline);
    }
    const r = el.getBoundingClientRect();
    Object.assign(outline.style, { left: r.left - 3 + "px", top: r.top - 3 + "px", width: r.width + 6 + "px", height: r.height + 6 + "px" });
  };
  const stop = () => { picking = false; current = null; if (outline) { outline.remove(); outline = null; } document.documentElement.style.cursor = ""; };
  const pick = el => { const anchor = anchorOf(el), rect = viewRect(el.getBoundingClientRect()); stop(); post("picked", { anchor, rect }); };
  const step = delta => {
    const list = candidates();
    if (!list.length) return;
    let index = current ? list.indexOf(current) : -1;
    index = index < 0 ? (delta > 0 ? 0 : list.length - 1) : Math.max(0, Math.min(list.length - 1, index + delta));
    list[index].scrollIntoView({ block: "nearest" });
    show(list[index]);
  };
  addEventListener("pointermove", event => { if (picking && event.target instanceof Element && event.target !== outline) show(target(event.target)); }, true);
  addEventListener("click", event => {
    if (!picking) return;
    event.preventDefault(); event.stopPropagation();
    if (event.target instanceof Element) pick(target(event.target));
  }, true);
  const typing = el => el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
  // Pick-mode keys, pressed in the page or forwarded by the app while its own window has focus.
  const pickKey = (key, shift) => {
    if (key === "Escape") { stop(); post("pick-end"); return true; }
    if (["ArrowDown", "ArrowRight", "j"].includes(key) || (key === "Tab" && !shift)) { step(1); return true; }
    if (["ArrowUp", "ArrowLeft", "k"].includes(key) || (key === "Tab" && shift)) { step(-1); return true; }
    if ((key === "Enter" || key === " ") && current) { pick(current); return true; }
    return false;
  };
  addEventListener("keydown", event => {
    if (picking) {
      if (pickKey(event.key, event.shiftKey)) event.preventDefault();
      return;
    }
    if (typing(document.activeElement) || event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key === "c" || event.key === "Escape") post("key", { key: event.key });
  }, true);

  addEventListener("message", event => {
    const data = event.data;
    if (event.source !== parent || !data || data.ns !== NS) return;
    if (data.type === "pick") {
      if (!data.on) return stop();
      picking = true;
      document.documentElement.style.cursor = "crosshair";
      if (data.keyboard) {
        const first = candidates().find(el => { const r = el.getBoundingClientRect(); return r.top >= 0 && r.top < innerHeight; });
        if (first) show(first);
      }
    }
    if (data.type === "pick-key" && picking) pickKey(String(data.key), !!data.shift);
    if (data.type === "track") { tracked = Array.isArray(data.anchors) ? data.anchors.slice(0, 500) : []; schedule(); }
    if (data.type === "reveal") {
      const item = tracked.find(entry => entry.key === data.key);
      const found = item && item.anchor && elementOf(item.anchor);
      if (found) found.scrollIntoView({ block: "center", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    }
  });
  post("ready");
})();`

/** `html` with the bridge inlined as the first script in its head, so it runs before the page's own scripts (which may
 * stop propagation of the events pick mode needs). Inserting before a doctype would switch the page to quirks mode. */
export const injectBridge = (html: string) => {
  const tag = `<script data-es-comments>${SURFACE_BRIDGE}</script>`
  const at = [/<head\b[^>]*>/i, /<html\b[^>]*>/i, /<!doctype[^>]*>/i].map((pattern) => pattern.exec(html)).find((match) => match)
  if (!at) return tag + html
  const end = at.index + at[0].length
  return html.slice(0, end) + tag + html.slice(end)
}
