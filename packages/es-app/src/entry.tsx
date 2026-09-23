import "./index.css"
import { render } from "solid-js/web"
import { onCleanup, onMount, Show, type ParentProps } from "solid-js"
import { MetaProvider } from "@solidjs/meta"
import { Route, Router } from "@solidjs/router"
import { DialogProvider } from "@opencode-ai/ui/context/dialog"
import { FileComponentProvider } from "@opencode-ai/ui/context/file"
import { MarkedProvider } from "@opencode-ai/ui/context/marked"
import { File } from "@opencode-ai/session-ui/file"
import Home from "./pages/home"
import SessionPage from "./pages/session"
import IssuePage from "./pages/issue"
import DocPage from "./pages/doc"
import Sidebar from "./components/sidebar"
import { DashboardProvider } from "./state"
import { TicketTip, wrapTicketRefs } from "./ticket-refs"
import { installSidebarKeys, leftOpen, startDrag } from "./ui"
import { installInkLinks } from "./link-url"

function Providers(props: ParentProps) {
  onMount(() => onCleanup(installSidebarKeys()))
  onMount(() => onCleanup(installInkLinks()))
  let shellEl: HTMLDivElement | undefined
  // ticket refs everywhere in the shell (transcript, sidebar, panels):
  // rAF-debounced since streaming produces mutation bursts, and the wrap
  // itself mutates the DOM (idempotent, so the observer converges)
  onMount(() => {
    if (!shellEl) return
    let frame: number | undefined
    const wrap = () => {
      if (frame !== undefined) return
      frame = requestAnimationFrame(() => {
        frame = undefined
        if (shellEl) wrapTicketRefs(shellEl)
      })
    }
    wrap()
    const mo = new MutationObserver(wrap)
    mo.observe(shellEl, { childList: true, subtree: true })
    onCleanup(() => {
      mo.disconnect()
      if (frame !== undefined) cancelAnimationFrame(frame)
    })
  })
  return (
    <MetaProvider>
      <DialogProvider>
        <MarkedProvider>
          {/* same component packages/app mounts here: code/diff viewer for
            * tool renders (edit/write/read) incl. inline image media */}
          <FileComponentProvider component={File}>
            <DashboardProvider>
              <div class="shell" ref={shellEl}>
                <Sidebar />
                <Show when={leftOpen()}>
                  <div class="drag-handle" onMouseDown={(e) => startDrag("left", e)} />
                </Show>
                <div class="content">{props.children}</div>
                <TicketTip container={() => shellEl} />
              </div>
            </DashboardProvider>
          </FileComponentProvider>
        </MarkedProvider>
      </DialogProvider>
    </MetaProvider>
  )
}

render(
  () => (
    <Router root={(p) => <Providers>{p.children}</Providers>}>
      <Route path="/" component={Home} />
      <Route path="/session/:id" component={SessionPage} />
      <Route path="/issue" component={IssuePage} />
      <Route path="/doc" component={DocPage} />
    </Router>
  ),
  document.getElementById("root")!,
)
