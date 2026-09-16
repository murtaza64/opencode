import { createEffect, createSignal, For, onCleanup, onMount } from "solid-js"
import { invalidateTextareaLayout, textareaLayout } from "../textarea-layout"

export const RelativeLines = (props: { target: HTMLTextAreaElement; value: string }) => {
  const [lines, setLines] = createSignal<{ number: number; label: number; top: number; current: boolean }[]>([])
  const [font, setFont] = createSignal("")
  const [height, setHeight] = createSignal(0)
  const [direction, setDirection] = createSignal<"ltr" | "rtl">("ltr")
  const update = () => {
    const target = props.target
    const width = `${Math.max(3, String(target.value.split("\n").length).length) + 1}ch`
    if (target.parentElement!.style.getPropertyValue("--line-number-width") !== width)
      target.parentElement!.style.setProperty("--line-number-width", width)
    const layout = textareaLayout(target)
    const current = layout.lines.findLastIndex((line) => line.pos <= target.selectionStart)
    setFont(getComputedStyle(target).font)
    setDirection(getComputedStyle(target).direction === "rtl" ? "rtl" : "ltr")
    setHeight(layout.points[0]!.height)
    setLines(
      layout.lines.flatMap((line, index) => {
        const top = line.top - target.scrollTop + target.clientTop
        if (top + layout.lineHeight < 0 || top > target.clientHeight) return []
        return [
          {
            number: index + 1,
            label: index === current ? index + 1 : Math.abs(index - current),
            top,
            current: index === current,
          },
        ]
      }),
    )
  }
  createEffect(() => {
    props.value
    queueMicrotask(update)
  })
  onMount(() => {
    const target = props.target
    const observer = new ResizeObserver(update)
    observer.observe(target)
    const mutation = new MutationObserver(update)
    mutation.observe(target, { attributes: true, attributeFilter: ["style", "dir", "class"] })
    const fontsLoaded = () => {
      invalidateTextareaLayout()
      update()
    }
    document.fonts.addEventListener("loadingdone", fontsLoaded)
    for (const event of ["input", "select", "selectionchange", "keyup", "click", "scroll"])
      target.addEventListener(event, update)
    update()
    onCleanup(() => {
      observer.disconnect()
      mutation.disconnect()
      document.fonts.removeEventListener("loadingdone", fontsLoaded)
      for (const event of ["input", "select", "selectionchange", "keyup", "click", "scroll"])
        target.removeEventListener(event, update)
    })
  })
  return (
    <div
      class="relative-lines"
      aria-hidden="true"
      dir={direction()}
      style={{ font: font(), "line-height": `${height()}px` }}
    >
      <For each={lines()}>
        {(line) => (
          <span data-line={line.number} classList={{ current: line.current }} style={{ top: `${line.top}px` }}>
            {line.label}
          </span>
        )}
      </For>
    </div>
  )
}
