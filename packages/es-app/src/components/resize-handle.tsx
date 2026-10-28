import { leftWidth, panelBounds, rightWidth, keyResize, startDrag } from "../ui"

/** The resize edge of a side panel: no layout width of its own, a narrow hit strip centred on the panel's
 * seam, a keyboard-operable separator. */
export const ResizeHandle = (props: { side: "left" | "right" }) => (
  <div class="drag-handle" role="separator" aria-orientation="vertical" tabindex="0"
    aria-label={props.side === "left" ? "Resize sidebar" : "Resize info panel"}
    aria-valuemin={panelBounds(props.side)[0]} aria-valuemax={panelBounds(props.side)[1]}
    aria-valuenow={props.side === "left" ? leftWidth() : rightWidth()}
    onPointerDown={(e) => startDrag(props.side, e)} onKeyDown={(e) => keyResize(props.side, e)} />
)
