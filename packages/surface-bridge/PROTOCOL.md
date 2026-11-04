# @opencode-ai/surface-bridge

Framework-free comment bridge for framed Surfaces: the in-frame anchor and privacy rules, pick mode, and the `postMessage` protocol. No store, auth, identity or comment bodies.

- Single writer: opencode/ux-feel. Consumers import it and do not copy it.
- Version: `1.5.0` (`VERSION` in `src/index.js` = `package.json`). Bump on any change to the protocol or the anchor rules, and record it below.

## Files

| Path | Use |
|---|---|
| `src/index.js` (+ `index.d.ts`) | Host side: `NS`, `VERSION`, `POLICIES`, `BRIDGE_SOURCE`, `injectBridge(html)`, `isBridgeMessage(event, frameWindow)`, `toFrame(frameWindow, message)`; re-exports the frame functions. |
| `src/frame.js` (+ `frame.d.ts`) | Frame side: `createAnchorKit(window)` (anchor and privacy rules only) and `installSurfaceBridge(window, createAnchorKit)` (the full controller). Both are self-contained. |
| `src/marks.js` (+ `marks.d.ts`), `./marks` | Drawing marks (from MCR, unchanged): `isValidMark`, `isValidShape`, `describeShapes`, `normRoute`, `toDocShapes`, `paintShape`, `MARK_TOOLS`, `MAX_SHAPES`, `MAX_PEN`. See "Marks". |
| `src/geometry.js` (+ `geometry.d.ts`), `./geometry` | Card placement over the stage (from es-app M1, unchanged): `CARD`, `focusHole`, `placeCard`, `maskRects`. Pure numbers in, numbers out. |

Plain ES2017 modules with no dependencies. Use them as-is from vanilla JS, React/webpack or Solid/Vite.

## Use

- Full controller: inline `BRIDGE_SOURCE` into the served page (`injectBridge(html)` puts it first in `<head>`), or call `installSurfaceBridge(window, createAnchorKit)` from a frame bundle. Then drive it from the host with `toFrame` and filter replies with `isBridgeMessage`.
- Own frame runtime: import `createAnchorKit(window)` and call `target`, `candidates`, `anchorOf`, `resolve` and `elementOf` from your own UI. If you keep your own anchor text or hash, build it from `kit.textOf(el)` (capped at 4000 chars; `kit.textOf(el, { max: Infinity })` for the full text), so the skip list has one source. Messages are then yours to define. The privacy rules still apply because they live in the kit.

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
| `pick` | `on`, `keyboard?`, `policy?`, `point?` | enter or leave pick mode; `keyboard` starts on the first visible candidate; `point` also reports where in the element the pick landed |
| `track` | `anchors: [{ key, anchor }]` (max 500), `policy?` | report these anchors now and on every scroll, resize or DOM change |
| `pick-key` | `key`, `shift?` | a pick-mode key pressed while the host had focus (Esc, arrows, j/k, Tab, Enter, Space) |
| `reveal` | `key` | scroll that tracked anchor into view |
| `locate` | `key`, `x`, `y`, `policy?` | 1.5.0: report the pickable part at that frame-viewport point (`located`) |

Frame → host:

| type | fields |
|---|---|
| `ready` | `policy` (the page's own), `version` (protocol, `1`), `features?` (`["point"]` from 1.4.0) |
| `picked` | `anchor`, `rect` (frame-viewport px), `point?` (point picks: `{ x, y }` fractions of the picked element's box, clamped to 0-1; the keyboard picks the centre) |
| `pick-end` | none (Esc, or a pick under `off`) |
| `located` | `key`, `anchor \| null`, `rect \| null` (1.5.0; nulls outside the page, in private content, or with no anchor under `declared`/`off`) |
| `rects` | `items: [{ key, rect \| null, state: shown \| changed \| hidden \| missing }]` |
| `key` | `key: "c" \| "m" \| "Escape"`, pressed in the page outside a text field |

## Marks

- Record: `{ frame: "anchor" | "doc", ref, state, s, shapes: [{ tool: "pin" | "pen" | "arrow" | "rect" | "ellipse", pts }] }`.
  - Anchor-frame points are fractions of the `ref` anchor's box, in [-1, 2].
  - Doc-frame points are document pixels. That frame is legacy: still drawn, no longer written.
- Limits: 1–20 shapes. A pin has 2 coordinates, pen 4–400 (even), every other tool 4. `ref` ≤ 300, `state` ≤ 500, `s` ≤ 200.
- Hosts draw only marks that pass `isValidMark`, and only on the revision, route (`normRoute`) and view state they were drawn on.
- `paintShape` builds SVG from validated numbers, never markup.
- Store, ids, numbering and the "drawn elsewhere" copy stay with each host.

## Host rules

- Never focus the iframe from the host to forward keys. Use `pick-key`: focusing the frame delayed message delivery by seconds in Chromium.
- Keep comment text out of the frame. The frame is agent-authored.

## Tests

- `packages/surface-bridge`: `bun test` covers the marks and geometry vectors (`src/marks.test.js`, `src/geometry.test.js`). It also checks that the serialized script runs on its own, installs once and only in a frame, reads the page policy, places the bridge with `injectBridge`, and filters messages with `isBridgeMessage`.
- es-app browser tests drive this module in a real sandboxed frame:
  - `test/surface-bridge-privacy.browser.mjs`: private click ignored; private, declared, selector and id fallbacks `missing`; hash unchanged by private, field or editable edits; host-declared pick; page not loosened; `off`.
  - `test/surface-comments.browser.mjs`: full pick, track and reveal flow.

## Changelog

- 1.5.0: `locate` / `located`: the host asks which pickable part is at a point (a drawing's start, for example) and gets that part's anchor and rect, under the same policy and privacy rules as a pick. `ready.features` adds `"locate"`. Additive; nothing else changes. Hosts can then store a drawing as an anchor-frame mark on that part ("box on Costs") instead of the whole page.
- 1.4.0: point picks. `pick` takes an optional `point`; the frame then adds `point` (the click as 0-1 fractions of the picked element's box) to `picked`, and `ready` lists `features: ["point"]` so hosts can detect it. The picked element, anchor rules, privacy and every other message are unchanged; a host that never sends `point` sees 1.3.1 behaviour. Hosts store a point as an anchor-frame `pin` mark on the element anchor (`./marks`), so no store field is added.
- 1.3.1: the frame also forwards `m` (tell the author) as a `key` message, like `c`. Additive; other keys, anchors and privacy unchanged.

- 1.3.0: additive `./marks` (MCR mark record, validation, description, route scoping, SVG painting) and `./geometry` (es-app card placement and anchor hole), both moved unchanged. Frame script, protocol and anchors unchanged: `frame.js` is byte-identical to 1.2.0.
- 1.2.0: `textOf(el, { max })`: optional cap, where `Infinity` or `0` means the full text. The default (4000), the hash and the protocol are unchanged.
- 1.1.0: the kit exports `textOf` (visible text with the privacy skip list). Additive: the protocol and anchors are unchanged.
- 1.0.0: extracted from es-app M1 + M1.1 (opencode `knvkxtlo`, `rlvtrklu`) with no behaviour change; `ready` gains `version`.

## Distribution

- Source: this directory at a pinned commit.
- Artifact: `bun pm pack` in this directory gives `opencode-ai-surface-bridge-<version>.tgz`. It is reproducible (same bytes for the same commit), and the `files` list leaves tests out. Consumers pin it by full sha256.
