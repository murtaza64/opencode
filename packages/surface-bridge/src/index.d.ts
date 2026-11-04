export { createAnchorKit, installSurfaceBridge, type AnchorKit } from "./frame"

export type Policy = "open" | "declared" | "off"
/** Document fractions (0-1) of the anchored element when it was picked. */
export type AnchorRect = { x: number; y: number; w: number; h: number }
/** Frame-viewport pixels. */
export type ViewRect = { x: number; y: number; w: number; h: number }
/** declared: { id, rect }. open: { hash, rect, id?, selector? }. At least one of id, selector or rect. */
export type Anchor = { id?: string; selector?: string; hash?: string; rect?: AnchorRect }
export type AnchorState = "shown" | "changed" | "hidden" | "missing"

export type HostMessage =
  /** `point` (1.4.0): also report where in the picked element the click landed. */
  | { type: "pick"; on: boolean; keyboard?: boolean; policy?: "declared" | "open"; point?: boolean }
  | { type: "track"; anchors: { key: string; anchor: Anchor }[]; policy?: "declared" | "open" }
  | { type: "pick-key"; key: string; shift?: boolean }
  /** 1.5.0: which pickable part is at (x, y), frame-viewport px; answered by "located" with the same key. */
  | { type: "locate"; key: string; x: number; y: number; policy?: "declared" | "open" }
  | { type: "reveal"; key: string }

export type FrameMessage =
  /** `features` (1.4.0): optional protocol additions this frame supports; absent on older frames. */
  | { type: "ready"; policy: Policy; version: number; features?: ("point" | "locate")[] }
  /** `point` (1.4.0, point picks only): the click as fractions (0-1) of the picked element's box. */
  | { type: "picked"; anchor: Anchor; rect: ViewRect; point?: { x: number; y: number } }
  | { type: "pick-end" }
  /** 1.5.0: the part at the asked point, or nulls when there is none (outside, private, declared without anchor, off). */
  | { type: "located"; key: string; anchor: Anchor | null; rect: ViewRect | null }
  | { type: "rects"; items: { key: string; rect: ViewRect | null; state: AnchorState }[] }
  | { type: "key"; key: "c" | "m" | "Escape" }

export declare const VERSION: string
export declare const NS: "es-comments"
export declare const POLICIES: readonly Policy[]
export declare const BRIDGE_SOURCE: string
export declare function injectBridge(html: string): string
export declare function isBridgeMessage(event: MessageEvent, frameWindow: Window | null | undefined): event is MessageEvent<FrameMessage & { ns: "es-comments" }>
export declare function toFrame(frameWindow: Window | null | undefined, message: HostMessage): void
