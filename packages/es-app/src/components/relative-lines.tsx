import { createEffect, createSignal, For, onCleanup, onMount } from "solid-js"
import { invalidateTextareaLayout, textareaProbe } from "../textarea-layout"

export const RelativeLines = (props: { target: HTMLTextAreaElement; value: string }) => {
  const [lines, setLines] = createSignal<{ number: number; label: number; top: number; current: boolean }[]>([])
  const [font, setFont] = createSignal("")
  const [height, setHeight] = createSignal(0)
  const [direction, setDirection] = createSignal<"ltr" | "rtl">("ltr")
  // Only the rows in view are measured (DD #432): line starts come from a string scan, and the first visible line is
  // found by bisecting their tops, so a keystroke in a 200k-char draft measures about as much as in a short one.
  const update = () => {
    const target = props.target
    const probe = textareaProbe(target)
    const starts = probe.lineStarts()
    const width = `${Math.max(3, String(starts.length).length) + 1}ch`
    if (target.parentElement!.style.getPropertyValue("--line-number-width") !== width)
      target.parentElement!.style.setProperty("--line-number-width", width)
    const lineTop = (index: number) => probe.point(starts[index]!).top - target.scrollTop + target.clientTop
    let low = 0
    let high = starts.length
    while (low < high) {
      const middle = (low + high) >> 1
      if (lineTop(middle) + probe.lineHeight < 0) low = middle + 1
      else high = middle
    }
    let currentLow = 0
    let currentHigh = starts.length - 1
    while (currentLow < currentHigh) {
      const middle = (currentLow + currentHigh + 1) >> 1
      if (starts[middle]! <= target.selectionStart) currentLow = middle
      else currentHigh = middle - 1
    }
    const current = currentLow
    const visible: { number: number; label: number; top: number; current: boolean }[] = []
    for (let index = low; index < starts.length; index++) {
      const top = lineTop(index)
      if (top > target.clientHeight) break
      visible.push({ number: index + 1, label: index === current ? index + 1 : Math.abs(index - current), top, current: index === current })
    }
    setFont(getComputedStyle(target).font)
    setDirection(getComputedStyle(target).direction === "rtl" ? "rtl" : "ltr")
    setHeight(probe.point(0).height)
    setLines(visible)
  }
  // One measure per frame, before it paints (DD #443): a 200k paste fires thousands of selectionchange/scroll
  // events (one per pasted line) and each measured the gutter again: 3,700 updates, ~6 s. The last state wins, so
  // nothing is dropped and the numbers never lag the text by a frame.
  let frame = 0
  const schedule = () => {
    if (frame) return
    frame = requestAnimationFrame(() => {
      frame = 0
      update()
    })
  }
  onCleanup(() => cancelAnimationFrame(frame))
  createEffect(() => {
    props.value
    schedule()
  })
  onMount(() => {
    const target = props.target
    const observer = new ResizeObserver(schedule)
    observer.observe(target)
    const mutation = new MutationObserver(schedule)
    mutation.observe(target, { attributes: true, attributeFilter: ["style", "dir", "class"] })
    const fontsLoaded = () => {
      invalidateTextareaLayout()
      schedule()
    }
    document.fonts.addEventListener("loadingdone", fontsLoaded)
    for (const event of ["input", "select", "selectionchange", "keyup", "click", "scroll"])
      target.addEventListener(event, schedule)
    update()
    onCleanup(() => {
      observer.disconnect()
      mutation.disconnect()
      document.fonts.removeEventListener("loadingdone", fontsLoaded)
      for (const event of ["input", "select", "selectionchange", "keyup", "click", "scroll"])
        target.removeEventListener(event, schedule)
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
