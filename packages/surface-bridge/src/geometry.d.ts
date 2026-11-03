export type StageBox = { x: number; y: number; w: number; h: number }
export type Stage = { w: number; h: number }
export type Hole = { x: number; y: number; r: number; b: number }
export type CardOptions = { gap: number; edge: number; room: number; min: number; max: number; width: number; pad: number }
export type CardPlacement = { below: boolean; left: number; top?: number; bottom?: number; maxBlockSize: number }

export declare const CARD: CardOptions
export declare const focusHole: (box: StageBox, stage: Stage, pad?: number) => Hole
export declare const placeCard: (box: StageBox, stage: Stage, options?: Partial<CardOptions>) => CardPlacement
export declare const maskRects: (hole: Hole, stage: Stage) => StageBox[]
