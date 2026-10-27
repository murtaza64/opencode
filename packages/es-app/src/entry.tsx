import "./index.css"
import "./appearance.css"
import { render } from "solid-js/web"
import { onCleanup, onMount, Show, type ParentProps } from "solid-js"
import { MetaProvider } from "@solidjs/meta"
import { Navigate, Route, Router, useLocation, useNavigate } from "@solidjs/router"
import { DialogProvider } from "@opencode-ai/ui/context/dialog"
import { FileComponentProvider } from "@opencode-ai/ui/context/file"
import { MarkedProvider } from "@opencode-ai/ui/context/marked"
import { File } from "@opencode-ai/session-ui/file"
import CloudPage from "./pages/cloud"
import AgentMap from "./pages/map"
import UsagePage from "./pages/usage"
import Desk from "./pages/desk"
import SessionPage from "./pages/session"
import NewSessionPage from "./pages/new-session"
import IssuePage from "./pages/issue"
import DocPage from "./pages/doc"
import Sidebar from "./components/sidebar"
import { DashboardProvider } from "./state"
import { BriefsProvider } from "./desk-briefs"
import { DeskQueueProvider } from "./desk-queue"
import { TicketTip, wrapTicketRefs } from "./ticket-refs"
import { SessionRefs, wrapSessionRefs } from "./session-mention-dom"
import { installSidebarKeys, leftOpen, startDrag } from "./ui"
import { installAppLinks, installInkLinks } from "./link-url"
import { modeOf, trackModes } from "./components/mode-switch"
import { installAppearance } from "./appearance"
import { startPerfTelemetry } from "./perf-telemetry"

startPerfTelemetry()

function Providers(props: ParentProps) {
  onMount(() => onCleanup(installSidebarKeys()))
  onMount(() => onCleanup(installInkLinks()))
  onMount(() => onCleanup(installAppearance()))
  const navigate = useNavigate()
  onMount(() => onCleanup(installAppLinks(navigate)))
  const location = useLocation()
  trackModes()
  // Front desk brings its own sidebar (the queue); Agents mode keeps the session sidebar.
  const agents = () => modeOf(location.pathname) === "agents"
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
      // Walk only what was added, not the (often transcript-sized) parent it was added to.
      for (const record of records ?? []) for (const node of record.addedNodes) {
        const target = node instanceof HTMLElement ? node : node.parentElement
        if (target) dirty.add(target)
      }
      if (frame !== undefined || !dirty.size) return
      frame = requestAnimationFrame(() => {
        frame = undefined
        // Our own decorations never need a second pass.
        const added = [...dirty].filter((el) => el.isConnected && !el.closest(".session-ref, .ticket-ref, .session-chip, .context-picker, .context-chips"))
        dirty.clear()
        const set = new Set(added)
        const roots = added.filter((el) => { for (let up = el.parentElement; up; up = up.parentElement) if (set.has(up)) return false; return true })
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
              <DeskQueueProvider>
              <div class="shell" ref={shellEl}>
                <Show when={agents()}><Sidebar /></Show>
                <Show when={agents() && leftOpen()}>
                  <div class="drag-handle" onMouseDown={(e) => startDrag("left", e)} />
                </Show>
                <div class="content">{props.children}</div>
                <TicketTip container={() => shellEl} />
                <SessionRefs container={() => shellEl} />
              </div>
              </DeskQueueProvider>
              </BriefsProvider>
            </DashboardProvider>
          </FileComponentProvider>
        </MarkedProvider>
      </DialogProvider>
    </MetaProvider>
  )
}

const DeskRedirect = () => {
  const location = useLocation()
  return <Navigate href={`/${location.search}${location.hash}`} />
}
const MapRedirect = () => {
  const location = useLocation()
  return <Navigate href={`/agents${location.search}${location.hash}`} />
}

render(
  () => (
    <Router root={(p) => <Providers>{p.children}</Providers>}>
      <Route path="/" component={Desk} />
      <Route path="/cloud" component={CloudPage} />
      <Route path="/agents" component={AgentMap} />
      <Route path="/usage" component={UsagePage} />
      {/* The map became Agents mode's default page; keep old /map links working. */}
      <Route path="/map" component={MapRedirect} />
      <Route path="/new" component={NewSessionPage} />
      {/* Front desk replaced the old Home at "/"; keep old /desk links working. */}
      <Route path="/desk" component={DeskRedirect} />
      <Route path="/session/:id" component={SessionPage} />
      <Route path="/issue" component={IssuePage} />
      <Route path="/doc" component={DocPage} />
    </Router>
  ),
  document.getElementById("root")!,
)
