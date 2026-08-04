/* Block caret for normal mode at positions the selection trick can't render
 * (end of line, empty buffer): measures the caret x/y with a hidden mirror of
 * the textarea's content and overlays a block. */
import { createMemo, Show } from "solid-js"
import type { VimMode } from "../vim"

let mirror: HTMLDivElement | null = null
const MIRROR_PROPS = [
  "fontFamily",
  "fontSize",
  "fontWeight",
  "lineHeight",
  "letterSpacing",
  "paddingTop",
  "paddingRight",
  "paddingBottom",
  "paddingLeft",
  "borderTopWidth",
  "borderRightWidth",
  "borderBottomWidth",
  "borderLeftWidth",
  "boxSizing",
] as const

function measure(t: HTMLTextAreaElement, pos: number) {
  if (!mirror) {
    mirror = document.createElement("div")
    mirror.style.position = "fixed"
    mirror.style.visibility = "hidden"
    mirror.style.left = "-9999px"
    mirror.style.top = "0"
    mirror.style.whiteSpace = "pre-wrap"
    mirror.style.wordBreak = "break-word"
    mirror.style.overflowWrap = "break-word"
    document.body.appendChild(mirror)
  }
  const cs = getComputedStyle(t)
  for (const p of MIRROR_PROPS) (mirror.style as any)[p] = (cs as any)[p]
  mirror.style.width = `${t.clientWidth}px`
  mirror.textContent = t.value.slice(0, pos)
  const marker = document.createElement("span")
  marker.textContent = "M"
  mirror.appendChild(marker)
  const left = marker.offsetLeft - t.scrollLeft
  const top = marker.offsetTop - t.scrollTop
  const width = marker.offsetWidth
  const height = marker.offsetHeight
  mirror.textContent = ""
  return { left, top, width, height }
}

export default function FakeCaret(props: {
  target: HTMLTextAreaElement | undefined
  caret: { el: HTMLTextAreaElement; pos: number; hasChar: boolean } | null
  mode: VimMode
}) {
  const style = createMemo(() => {
    const c = props.caret
    if (props.mode !== "normal" || !c || c.hasChar || !props.target || c.el !== props.target) return null
    const m = measure(c.el, c.pos)
    // clip when scrolled out of the textarea's visible box
    if (m.top < 0 || m.top > c.el.clientHeight - 4) return null
    return {
      left: `${m.left}px`,
      top: `${m.top}px`,
      width: `${Math.max(6, m.width)}px`,
      height: `${m.height}px`,
    }
  })
  return (
    <Show when={style()}>
      {(s) => <div class="vim-caret" style={s()} />}
    </Show>
  )
}
