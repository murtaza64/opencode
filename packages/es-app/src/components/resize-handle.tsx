import { panelBounds, panelWidth, keyResize, startDrag, type Side } from "../ui"

const LABEL: Record<Side, string> = { left: "Resize sidebar", right: "Resize info panel", companion: "Resize Front desk chat" }

/** The resize edge of a side panel: no layout width of its own, a narrow hit strip centred on the panel's
 * seam, a keyboard-operable separator. */
export const ResizeHandle = (props: { side: Side }) => (
  <div class="drag-handle" role="separator" aria-orientation="vertical" tabindex="0" data-side={props.side}
    aria-label={LABEL[props.side]} aria-valuemin={panelBounds(props.side)[0]} aria-valuemax={panelBounds(props.side)[1]}
    aria-valuenow={panelWidth(props.side)}
    onPointerDown={(e) => startDrag(props.side, e)} onKeyDown={(e) => keyResize(props.side, e)} />
)
