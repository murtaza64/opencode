import { createSignal, onCleanup, onMount, Show, type ParentProps } from "solid-js"
import { Portal } from "solid-js/web"
import "./native-header.css"
import { current, enabled, setEnabled, themeVars } from "../appearance"
import { TodayCost } from "./today-cost"

export const nativeHeader =
  typeof navigator !== "undefined" &&
  /\bElectron\/\d/.test(navigator.userAgent) &&
  /Macintosh/.test(navigator.userAgent)
const [headerTarget, setHeaderTarget] = createSignal<HTMLDivElement>()

export const NativeHeader = (props: ParentProps) => {
  const host = document.createElement("div")
  document.body.prepend(host)
  // The session title starts where the chat's text does: the content pane's inline-start edge, measured whenever the
  // pane moves (sidebar resized, collapsed or the window resized) and handed to CSS as --chat-start.
  const [chatStart, setChatStart] = createSignal<number>()
  let observer: ResizeObserver | undefined
  let frame = 0
  const watch = () => {
    const content = document.querySelector<HTMLElement>(".shell > .content")
    if (!content) { frame = requestAnimationFrame(watch); return }
    observer = new ResizeObserver(() => setChatStart(content.getBoundingClientRect().left))
    observer.observe(content)
  }
  onMount(() => {
    document.documentElement.classList.add("native-mac-header")
    watch()
  })
  onCleanup(() => {
    cancelAnimationFrame(frame)
    observer?.disconnect()
    setHeaderTarget(undefined)
    document.documentElement.classList.remove("native-mac-header")
    host.remove()
  })
  return (
    <Portal mount={host}>
      <div class="native-header" role="banner" aria-label="Application header" style={{ "--chat-start": chatStart() === undefined ? undefined : `${chatStart()}px` }}>
        <div class="native-header-safe">
          <div class="native-header-project">{props.children}</div>
          <div class="native-header-session" ref={setHeaderTarget} />
          <TodayCost />
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
