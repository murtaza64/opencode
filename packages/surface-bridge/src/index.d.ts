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
  | { type: "pick"; on: boolean; keyboard?: boolean; policy?: "declared" | "open" }
  | { type: "track"; anchors: { key: string; anchor: Anchor }[]; policy?: "declared" | "open" }
  | { type: "pick-key"; key: string; shift?: boolean }
  | { type: "reveal"; key: string }

export type FrameMessage =
  | { type: "ready"; policy: Policy; version: number }
  | { type: "picked"; anchor: Anchor; rect: ViewRect }
  | { type: "pick-end" }
  | { type: "rects"; items: { key: string; rect: ViewRect | null; state: AnchorState }[] }
  | { type: "key"; key: "c" | "m" | "Escape" }

export declare const VERSION: string
export declare const NS: "es-comments"
export declare const POLICIES: readonly Policy[]
export declare const BRIDGE_SOURCE: string
export declare function injectBridge(html: string): string
export declare function isBridgeMessage(event: MessageEvent, frameWindow: Window | null | undefined): event is MessageEvent<FrameMessage & { ns: "es-comments" }>
export declare function toFrame(frameWindow: Window | null | undefined, message: HostMessage): void
