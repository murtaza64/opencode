/* Block caret for normal mode at positions the selection trick can't render
 * (end of line, empty buffer): measures the caret x/y with a hidden mirror of
 * the textarea's content and overlays a block. */
import { createEffect, createMemo, createSignal, onCleanup, Show } from "solid-js"
import type { VimMode } from "../vim"
import { invalidateTextareaLayout, textareaLayout } from "../textarea-layout"

export default function FakeCaret(props: {
  target: HTMLTextAreaElement | undefined
  caret: { el: HTMLTextAreaElement; pos: number; hasChar: boolean } | null
  mode: VimMode
}) {
  const [version, setVersion] = createSignal(0)
  createEffect(() => {
    const target = props.target
    if (!target) return
    const update = () => setVersion((value) => value + 1)
    const observer = new ResizeObserver(update)
    observer.observe(target)
    target.addEventListener("scroll", update)
    const fontsLoaded = () => {
      invalidateTextareaLayout()
      update()
    }
    document.fonts.addEventListener("loadingdone", fontsLoaded)
    onCleanup(() => {
      observer.disconnect()
      target.removeEventListener("scroll", update)
      document.fonts.removeEventListener("loadingdone", fontsLoaded)
    })
  })
  const style = createMemo(() => {
    version()
    const c = props.caret
    if (props.mode !== "normal" || !c || c.hasChar || !props.target || c.el !== props.target) return null
    const point = textareaLayout(c.el).points.find((point) => point.pos === c.pos)
    if (!point) return null
    const top = point.top - c.el.scrollTop + c.el.clientTop
    // clip when scrolled out of the textarea's visible box
    if (top < 0 || top > c.el.clientHeight - 4) return null
    return {
      left: `${point.left - c.el.scrollLeft + c.el.clientLeft}px`,
      top: `${top}px`,
      width: "0.6em",
      height: `${point.height}px`,
    }
  })
  return <Show when={style()}>{(s) => <div class="vim-caret" style={s()} />}</Show>
}
