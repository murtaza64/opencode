import { createSignal, onCleanup, onMount, Show, type ParentProps } from "solid-js"
import { Portal } from "solid-js/web"
import "./native-header.css"

export const nativeHeader =
  typeof navigator !== "undefined" &&
  /\bElectron\/\d/.test(navigator.userAgent) &&
  /Macintosh/.test(navigator.userAgent)
const [headerTarget, setHeaderTarget] = createSignal<HTMLDivElement>()

export const NativeHeader = (props: ParentProps) => {
  const host = document.createElement("div")
  document.body.prepend(host)
  onMount(() => document.documentElement.classList.add("native-mac-header"))
  onCleanup(() => {
    setHeaderTarget(undefined)
    document.documentElement.classList.remove("native-mac-header")
    host.remove()
  })
  return (
    <Portal mount={host}>
      <div class="native-header" role="banner" aria-label="Application header">
        <div class="native-header-safe">
          <div class="native-header-project">{props.children}</div>
          <div class="native-header-session" ref={setHeaderTarget} />
        </div>
      </div>
    </Portal>
  )
}

export const AppHeader = (props: ParentProps) => (
  <Show when={nativeHeader} fallback={<header class="topbar">{props.children}</header>}>
    <Show when={headerTarget()}>
      {(mount) => (
        <Portal mount={mount()}>
          <div class="topbar">{props.children}</div>
        </Portal>
      )}
    </Show>
  </Show>
)
