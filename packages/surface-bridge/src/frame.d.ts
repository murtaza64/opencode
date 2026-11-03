import type { Anchor, AnchorState, Policy, ViewRect } from "./index"

export type AnchorKit = {
  pagePolicy(): Policy
  policy(): Policy
  setHostPolicy(value: "open" | "declared" | undefined): void
  isPrivate(el: Element | null): boolean
  textOf(el: Element, options?: { max?: number }): string
  hashOf(el: Element): string
  viewRect(rect: DOMRect): ViewRect
  anchorOf(el: Element): Anchor
  elementOf(anchor: Anchor): Element | null
  resolve(anchor: Anchor): { rect: ViewRect | null; state: AnchorState }
  candidates(): Element[]
  target(el: Element): Element | null
}

export declare function createAnchorKit(win: Window): AnchorKit
export declare function installSurfaceBridge(win: Window, createKit: typeof createAnchorKit): void
