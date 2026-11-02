import { createSignal, onCleanup, onMount, Show, type ParentProps } from "solid-js"
import { Portal } from "solid-js/web"
import "./native-header.css"
import { current, enabled, setEnabled, themeVars } from "../appearance"
import { TodayCost } from "./today-cost"
import { Glyph } from "./icons"
import { useDeskChatOptional } from "../desk-companion"

export const nativeHeader =
  typeof navigator !== "undefined" &&
  /\bElectron\/\d/.test(navigator.userAgent) &&
  /Macintosh/.test(navigator.userAgent)
const [headerTarget, setHeaderTarget] = createSignal<HTMLDivElement>()

export const NativeHeader = (props: ParentProps) => {
  const host = document.createElement("div")
  document.body.prepend(host)
  // The title starts where the pane's text does. Both edges are measured, not assumed: the desktop's native host tabs
  // move the header's start (tabs.ts inset), and the sidebar moves the pane. Each is an inline-start distance in px.
  const [edges, setEdges] = createSignal<{ pane: number; header: number }>()
  let observer: ResizeObserver | undefined
  let frame = 0
  let safe: HTMLDivElement | undefined
  const measure = () => {
    const content = document.querySelector<HTMLElement>(".shell > .content")
    if (!content || !safe) return
    const rtl = getComputedStyle(document.documentElement).direction === "rtl"
    const pane = content.getBoundingClientRect(), header = safe.getBoundingClientRect()
    const pad = parseFloat(getComputedStyle(safe).paddingInlineStart) || 0
    setEdges(rtl ? { pane: innerWidth - pane.right, header: innerWidth - header.right + pad } : { pane: pane.left, header: header.left + pad })
  }
  const watch = () => {
    const content = document.querySelector<HTMLElement>(".shell > .content")
    if (!content || !safe) { frame = requestAnimationFrame(watch); return }
    observer = new ResizeObserver(measure)
    observer.observe(content)
    observer.observe(safe)
    measure()
  }
  onMount(() => {
    document.documentElement.classList.add("native-mac-header")
    watch()
    addEventListener("resize", measure)
  })
  onCleanup(() => {
    cancelAnimationFrame(frame)
    observer?.disconnect()
    removeEventListener("resize", measure)
    setHeaderTarget(undefined)
    document.documentElement.classList.remove("native-mac-header")
    host.remove()
  })
  return (
    <Portal mount={host}>
      <div class="native-header" role="banner" aria-label="Application header" style={edges() ? { "--pane-start": `${edges()!.pane}px`, "--header-start": `${edges()!.header}px` } : undefined}>
        <div class="native-header-safe" ref={safe}>
          <div class="native-header-project">{props.children}</div>
          <div class="native-header-session" ref={setHeaderTarget} />
          <TodayCost />
          <DeskToggle />
          {/* Offered only when this laptop has a usable wallpaper palette. */}
          <Show when={current() && themeVars(current()!.palette)}>
            <button class="appearance-toggle" aria-pressed={enabled()} title={enabled() ? "Use the default colours" : "Use colours from your wallpaper"}
              aria-label="Wallpaper colours" onClick={() => setEnabled(!enabled())}>
              <span class="appearance-swatch" aria-hidden="true" />
            </button>
          </Show>
        </div>
      </div>
    </Portal>
  )
}

/** `inline` keeps the header in its own pane instead of the native titlebar, for a page embedded beside others.
 */
export const AppHeader = (props: ParentProps<{ inline?: boolean }>) => (
  <Show when={nativeHeader && !props.inline} fallback={<header class="topbar">{props.children}</header>}>
    <Show when={headerTarget()}>
      {(mount) => (
        <Portal mount={mount()}>
          <div class="topbar">{props.children}</div>
        </Portal>
      )}
    </Show>
  </Show>
)

/** The Front desk chat toggle in the top bar: the same open state and action as the sidebar's Front desk entry, so
 * either control shows and changes the one companion. */
const DeskToggle = () => {
  const chat = useDeskChatOptional()
  return <Show when={chat}>{(desk) =>
    <button type="button" class="header-desk-toggle" aria-pressed={desk().open()} aria-label="Front desk chat"
      title={desk().open() ? "Hide Front desk chat" : "Show Front desk chat"} onClick={() => desk().setOpen(!desk().open())}>
      <Glyph name="comment-discussion" />
    </button>}</Show>
}
