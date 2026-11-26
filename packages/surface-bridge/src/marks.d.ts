export type MarkTool = "pin" | "pen" | "arrow" | "rect" | "ellipse"

export type MarkShape = {
  tool: MarkTool
  /** Flat [x, y, ...]: fractions of the ref anchor's box ("anchor" frame) or document px ("doc"). */
  pts: number[]
}

/** Geometry is valid only for the revision, route and view state it was drawn on; elsewhere hosts report it as not
 * applicable rather than re-anchoring it. */
export type Mark = {
  frame: "anchor" | "doc"
  /** Anchor the coordinates are relative to; "surface" with the anchor frame means the whole document. */
  ref: string
  /** View state of the ref anchor when drawn. */
  state: string
  /** Route state when drawn, to reopen the same view. */
  s: string
  shapes: MarkShape[]
}

export type DocBox = { x: number; y: number; w: number; h: number }

export declare const MARK_TOOLS: MarkTool[]
export declare const MAX_SHAPES: number
export declare const MAX_PEN: number
export declare const isValidShape: (shape: unknown, lo: number, hi: number) => shape is MarkShape
export declare const isValidMark: (mark: unknown) => mark is Mark
export declare const describeShapes: (mark: Mark) => string
export declare const normRoute: (hash: string) => string
export declare const toDocShapes: (mark: Mark, box: DocBox) => MarkShape[]
export declare const paintShape: (group: SVGElement, shape: MarkShape, color: string, width: number, dashed: boolean) => void
