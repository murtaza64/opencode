// Host half of the Surface comment bridge, plus the serialized frame script. Framework-free, no store, auth or
// comment bodies. Contract: ../PROTOCOL.md. Single writer: opencode/ux-feel.
import { createAnchorKit, installSurfaceBridge } from "./frame.js"

export { createAnchorKit, installSurfaceBridge }

/** Package version; bump with any protocol or anchor-rule change and record it in PROTOCOL.md. */
export const VERSION = "1.5.0"
/** postMessage namespace for every bridge message, both directions. */
export const NS = "es-comments"
/** Page policies, weakest to strictest: <meta name="es-comments-anchors" content="declared|off">. */
export const POLICIES = ["open", "declared", "off"]

/** The frame controller as one self-contained script, for inlining into served pages or a <script> tag. */
export const BRIDGE_SOURCE = `(${installSurfaceBridge})(window, ${createAnchorKit});`

/** `html` with the bridge inlined as the first script in its head, so it runs before the page's own scripts (which
 * may stop propagation of the events pick mode needs). Inserting before a doctype would switch the page to quirks
 * mode. */
export const injectBridge = (html) => {
  const tag = `<script data-es-comments>${BRIDGE_SOURCE}</script>`
  const at = [/<head\b[^>]*>/i, /<html\b[^>]*>/i, /<!doctype[^>]*>/i].map((pattern) => pattern.exec(html)).find((match) => match)
  if (!at) return tag + html
  const end = at.index + at[0].length
  return html.slice(0, end) + tag + html.slice(end)
}

/** Whether a host-side MessageEvent is a bridge message from this frame. Check before trusting any anchor: the frame
 * posts with targetOrigin "*" because a sandboxed frame has an opaque origin. */
export const isBridgeMessage = (event, frameWindow) =>
  !!frameWindow && event.source === frameWindow && !!event.data && event.data.ns === NS && typeof event.data.type === "string"

/** Post one host-to-frame message. */
export const toFrame = (frameWindow, message) => { if (frameWindow) frameWindow.postMessage(Object.assign({ ns: NS }, message), "*") }
