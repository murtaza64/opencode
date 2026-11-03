# @opencode-ai/surface-bridge

Framework-free comment bridge for framed Surfaces: the in-frame anchor and privacy rules, pick mode, and the `postMessage` protocol. No store, auth, identity or comment bodies.

- Single writer: opencode/ux-feel. Consumers import it and do not copy it.
- Version: `1.0.0` (`VERSION` in `src/index.js` = `package.json`). Bump on any change to the protocol or the anchor rules, and record it below.

## Files

| Path | Use |
|---|---|
| `src/index.js` (+ `index.d.ts`) | Host side: `NS`, `VERSION`, `POLICIES`, `BRIDGE_SOURCE`, `injectBridge(html)`, `isBridgeMessage(event, frameWindow)`, `toFrame(frameWindow, message)`; re-exports the frame functions. |
| `src/frame.js` (+ `frame.d.ts`) | Frame side: `createAnchorKit(window)` (anchor and privacy rules only) and `installSurfaceBridge(window, createAnchorKit)` (the full controller). Both are self-contained. |

Plain ES2017 modules with no dependencies. Use them as-is from vanilla JS, React/webpack or Solid/Vite.

## Use

- Full controller: inline `BRIDGE_SOURCE` into the served page (`injectBridge(html)` puts it first in `<head>`), or call `installSurfaceBridge(window, createAnchorKit)` from a frame bundle. Then drive it from the host with `toFrame` and filter replies with `isBridgeMessage`.
- Own frame runtime: import `createAnchorKit(window)` and call `target`, `candidates`, `anchorOf`, `resolve` and `elementOf` from your own UI. Messages are then yours to define. The privacy rules still apply because they live in the kit.

## Policy

- Page: `<meta name="es-comments-anchors" content="declared|off">`; absent or unknown means `open`.
- Host: `pick`/`track` with `policy: "declared"` narrows it. The host can never loosen the page's policy: the strictest wins (`open` < `declared` < `off`).

| Policy | Pickable | Anchor recorded | Reads page text |
|---|---|---|---|
| `open` | `[data-anchor]` plus common blocks (h1-h4, p, li, pre, table, figure, img, section, article, blockquote, dd, td, th, button, a, label, summary) | `{ hash, rect, id?, selector? }` | yes, for the hash |
| `declared` | `[data-anchor]` only | `{ id, rect }` | no (no text, element id or structure) |
| `off` | nothing; `pick` replies `pick-end` | none; every tracked anchor is `missing` | no |

## Privacy rules (all policies)

- `[data-es-private]` and everything inside it is never picked, outlined or tracked: an anchor that resolves into it reports `missing`.
- An `open` element that contains private parts may be picked. Its hash skips private subtrees, `input`, `textarea`, `select`, `option`, `[contenteditable]`, `script`, `style` and `template`. Input values are never read.
- `open` anchors carry a structural selector (`tag:nth-of-type` steps from the nearest ancestor with an id) and the element's own id. Pages whose ids derive from private content should declare `declared`.
- An anchor is never moved to a "nearest" element. If its id and selector both fail, it is `missing`. A rect-only anchor is placed by its document fractions.

## Messages

All carry `ns: "es-comments"`. The frame posts with targetOrigin `"*"` (sandboxed frames have an opaque origin), so the host must check `event.source` (`isBridgeMessage`).

Host → frame:

| type | fields | effect |
|---|---|---|
| `pick` | `on`, `keyboard?`, `policy?` | enter or leave pick mode; `keyboard` starts on the first visible candidate |
| `track` | `anchors: [{ key, anchor }]` (max 500), `policy?` | report these anchors now and on every scroll, resize or DOM change |
| `pick-key` | `key`, `shift?` | a pick-mode key pressed while the host had focus (Esc, arrows, j/k, Tab, Enter, Space) |
| `reveal` | `key` | scroll that tracked anchor into view |

Frame → host:

| type | fields |
|---|---|
| `ready` | `policy` (the page's own), `version` (protocol, `1`) |
| `picked` | `anchor`, `rect` (frame-viewport px) |
| `pick-end` | none (Esc, or a pick under `off`) |
| `rects` | `items: [{ key, rect \| null, state: shown \| changed \| hidden \| missing }]` |
| `key` | `key: "c" \| "Escape"`, pressed in the page outside a text field |

## Host rules

- Never focus the iframe from the host to forward keys. Use `pick-key`: focusing the frame delayed message delivery by seconds in Chromium.
- Keep comment text out of the frame. The frame is agent-authored.

## Tests

- `packages/surface-bridge`: `bun test` checks that the serialized script runs on its own, installs once and only in a frame, reads the page policy, places the bridge with `injectBridge`, and filters messages with `isBridgeMessage`.
- es-app browser tests drive this module in a real sandboxed frame:
  - `test/surface-bridge-privacy.browser.mjs`: private click ignored; private, declared, selector and id fallbacks `missing`; hash unchanged by private, field or editable edits; host-declared pick; page not loosened; `off`.
  - `test/surface-comments.browser.mjs`: full pick, track and reveal flow.

## Changelog

- 1.0.0: extracted from es-app M1 + M1.1 (opencode `knvkxtlo`, `rlvtrklu`) with no behaviour change; `ready` gains `version`.
