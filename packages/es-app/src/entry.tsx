import "./index.css"
import { render } from "solid-js/web"
import { onCleanup, onMount, Show, type ParentProps } from "solid-js"
import { MetaProvider } from "@solidjs/meta"
import { Route, Router, useNavigate } from "@solidjs/router"
import { DialogProvider } from "@opencode-ai/ui/context/dialog"
import { FileComponentProvider } from "@opencode-ai/ui/context/file"
import { MarkedProvider } from "@opencode-ai/ui/context/marked"
import { File } from "@opencode-ai/session-ui/file"
import Home from "./pages/home"
import CloudPage from "./pages/cloud"
import AgentMap from "./pages/map"
import Desk from "./pages/desk"
import SessionPage from "./pages/session"
import NewSessionPage from "./pages/new-session"
import IssuePage from "./pages/issue"
import DocPage from "./pages/doc"
import Sidebar from "./components/sidebar"
import { DashboardProvider } from "./state"
import { BriefsProvider } from "./desk-briefs"
import { TicketTip, wrapTicketRefs } from "./ticket-refs"
import { SessionRefs, wrapSessionRefs } from "./session-mention-dom"
import { installSidebarKeys, leftOpen, startDrag } from "./ui"
import { installAppLinks, installInkLinks } from "./link-url"

function Providers(props: ParentProps) {
  onMount(() => onCleanup(installSidebarKeys()))
  onMount(() => onCleanup(installInkLinks()))
  const navigate = useNavigate()
  onMount(() => onCleanup(installAppLinks(navigate)))
  let shellEl: HTMLDivElement | undefined
  // ticket refs everywhere in the shell (transcript, sidebar, panels):
  // rAF-debounced since streaming produces mutation bursts, and the wrap
  // itself mutates the DOM (idempotent, so the observer converges)
  onMount(() => {
    if (!shellEl) return
    let frame: number | undefined
    // Only walk subtrees that actually changed; a full-shell TreeWalker per
    // mutation burst costs ~50% of the main thread on long transcripts.
    const dirty = new Set<HTMLElement>()
    const wrap = (records?: MutationRecord[]) => {
      if (!records) dirty.add(shellEl!)
      for (const record of records ?? []) {
        if (!record.addedNodes.length) continue
        const target = record.target instanceof HTMLElement ? record.target : record.target.parentElement
        // Our own decorations never need a second pass.
        if (!target || target.closest(".session-ref, .ticket-ref, .session-chip, .session-picker")) continue
        dirty.add(target)
      }
      if (frame !== undefined || !dirty.size) return
      frame = requestAnimationFrame(() => {
        frame = undefined
        const roots = [...dirty].filter((el) => el.isConnected && ![...dirty].some((other) => other !== el && other.contains(el)))
        dirty.clear()
        for (const root of roots) {
          wrapTicketRefs(root)
          wrapSessionRefs(root)
        }
        if (roots.length) shellEl?.dispatchEvent(new Event("session-refs-wrapped"))
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
              <BriefsProvider>
              <div class="shell" ref={shellEl}>
                <Sidebar />
                <Show when={leftOpen()}>
                  <div class="drag-handle" onMouseDown={(e) => startDrag("left", e)} />
                </Show>
                <div class="content">{props.children}</div>
                <TicketTip container={() => shellEl} />
                <SessionRefs container={() => shellEl} />
              </div>
              </BriefsProvider>
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
      <Route path="/cloud" component={CloudPage} />
      <Route path="/map" component={AgentMap} />
      <Route path="/new" component={NewSessionPage} />
      <Route path="/desk" component={Desk} />
      <Route path="/session/:id" component={SessionPage} />
      <Route path="/issue" component={IssuePage} />
      <Route path="/doc" component={DocPage} />
    </Router>
  ),
  document.getElementById("root")!,
)
