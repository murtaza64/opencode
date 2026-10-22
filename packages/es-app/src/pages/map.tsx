/* Agent map in the approved Fleet design (dotfiles#220, "A · Project map"), drawn from real relations only: lane owners, verified
 * handoffs, subagent parentage, cloud lane records, and observed mail for the
 * agents the user selects (one mail read per selected agent; no fleet fanout). */
import { createEffect, createMemo, createResource, createSignal, For, onCleanup, onMount, Show, untrack } from "solid-js"
import { A, useSearchParams } from "@solidjs/router"
import { es } from "../api"
import {
  buildAgentMap, flattenAgents, layoutMap, linkOrigins, mailEdges, mailParty, NODE, stateEvents,
  type AgentStatus, type ClusterBox, type MapAgent, type MapCluster, type MapMail, type ProvenanceRecord, type SessionRef,
} from "../agent-map"
import { cloudHref } from "../cloud-agents"
import { AppHeader } from "../components/native-header"
import { TodoLine, turnOf } from "../components/todo-line"
import { currentWork } from "../current-work"
import { mailSentAt } from "../mail-timeline"
import { ringOnChange } from "../motion"
import { ago, sessionHref, useDashboard } from "../state"
import "./home.css"
import "./map.css"

type MailLoad = { state: "loading" | "ready" | "error"; messages: MapMail[]; error?: string }
const LAYERS = [["all", "All events"], ["major", "Major events"], ["minor", "Minor updates"]] as const

export default function AgentMap() {
  const dashboard = useDashboard()
  const [search, setSearch] = useSearchParams()
  const scope = () => search.agents === "all" || search.show === "all" ? "all" : "active"
  const [projectFilter, setProjectFilter] = createSignal("all")
  const [runtime, setRuntime] = createSignal("all")
  const [layer, setLayer] = createSignal("all")
  // Topology is the map; mail is an opt-in overlay for the selected agent.
  const [showMail, setShowMail] = createSignal(false)
  const [paused, setPaused] = createSignal(false)
  const [reduced, setReduced] = createSignal(false)
  const [systemReduced, setSystemReduced] = createSignal(false)
  const [zoom, setZoom] = createSignal<number | "fit">("fit")
  const [canvasWidth, setCanvasWidth] = createSignal(0)
  // Graph geometry stays LTR; node contents follow the document direction, as in the prototype.
  const [direction, setDirection] = createSignal<"ltr" | "rtl">("ltr")
  const [mailLoads, setMailLoads] = createSignal<Record<string, MailLoad>>({})
  const [selectedMail, setSelectedMail] = createSignal<string>()
  const project = () => dashboard.allProjects() ? undefined : dashboard.editspace() ?? dashboard.editspaces()?.default ?? undefined
  const selectedProject = () => dashboard.editspace() ?? dashboard.editspaces()?.default ?? ""
  // Share the sidebar's dot resolver for attention/busy/failure meaning; only
  // its quiet states are refined here so an unobserved status reads as unknown.
  const status = (id: string): AgentStatus => {
    const dot: string = dashboard.dotFor({ id })
    if (dot === "pending" || dot === "busy" || dot === "failed") return dot
    return dashboard.activity.status(id) === "idle" ? "idle" : "unknown"
  }
  const lanes = createMemo(() => {
    const local = (dashboard.state()?.threads ?? []).flatMap((thread: { lanes?: { lane: string; owner?: string; status?: string; activity?: string; activity_at?: string; activity_session?: string; issue?: string }[] }) => thread.lanes ?? [])
      .flatMap((lane: { lane: string; owner?: string }) => lane.owner ? [{ ...lane, owner: lane.owner, editspace: selectedProject() }] : [])
    if (!dashboard.allProjects()) return local
    // Other projects contribute owners already loaded for handoff reconciliation.
    const other = dashboard.lineageOwners().flatMap((item) => {
      const [editspace, lane] = JSON.parse(item.lane) as [string, string]
      return editspace === selectedProject() ? [] : [{ editspace, lane, owner: item.owner }]
    })
    return [...local, ...other]
  })
  const clusters = createMemo<MapCluster[]>(() => buildAgentMap({
    roots: dashboard.sessions(),
    session: (id) => {
      const session = dashboard.activity.session(id)
      return session ? { id: session.id, title: session.title, directory: session.directory, updated: session.time.updated, parentID: session.parentID } : undefined
    },
    children: dashboard.activity.subagents,
    lanes: lanes(),
    handoffs: dashboard.lineage().map((edge) => {
      const [editspace, lane] = JSON.parse(edge.lane) as [string, string]
      return { editspace, lane, predecessor: edge.predecessor, successor: edge.successor }
    }),
    cloud: dashboard.cloud.observed().filter((item) => !project() || item.editspace === project())
      .map((item) => ({ editspace: item.editspace, lane: item.lane, owner: item.owner, status: item.record["wingman-status"], activity: item.record.activity })),
    status,
    pinned: (id) => dashboard.isPinned({ id, directory: "" }),
    fallbackProject: project() ?? "unregistered",
    filter: scope(),
    now: Date.now(),
  }).filter((cluster) => !project() || cluster.project === project()))
  // One provenance read per project in scope: delegation parents and first spawners.
  const [provenance] = createResource(
    () => project() ? [project()!] : dashboard.editspaces()?.editspaces.map((item) => item.name) ?? [],
    async (names) => {
      const results = await Promise.allSettled(names.map(async (editspace) => {
        const value = await es.laneProvenance(editspace)
        return [
          ...value.delegations.map((item): ProvenanceRecord => ({ editspace, lane: item.lane, kind: "delegated", by: item.parent, status: item.status })),
          ...value.spawned.map((item): ProvenanceRecord => ({ editspace, lane: item.lane, kind: "spawned", by: item.by })),
        ]
      }))
      return {
        records: results.flatMap((result) => result.status === "fulfilled" ? result.value : []),
        failed: names.filter((_, index) => results[index]!.status === "rejected"),
      }
    },
  )
  const agents = createMemo(() => linkOrigins(flattenAgents(clusters()), provenance()?.records ?? []))
  const visible = createMemo(() => agents().filter((agent) => (projectFilter() === "all" || agent.project === projectFilter()) && (runtime() === "all" || agent.runtime === runtime())))
  const layout = createMemo(() => layoutMap(visible(), canvasWidth() ? canvasWidth() - 2 : undefined))
  const events = createMemo(() => stateEvents(visible()).filter((event) => layer() === "all" || event.level === layer()))
  const hidden = () => clusters().reduce((sum, cluster) => sum + cluster.hidden, 0)
  const still = () => paused() || reduced() || systemReduced()
  // Fit: the map shrinks to the panel width (never enlarges).
  const scale = () => {
    const value = zoom()
    if (value !== "fit") return value
    if (!canvasWidth()) return 1
    return Math.min(1, Math.max(0.6, (canvasWidth() - 2) / layout().width))
  }

  // Index every selectable identity: map nodes, handoff predecessors (history),
  // and a lane owner's session (an alias for its lane).
  const index = createMemo(() => {
    const entries = new Map<string, MapAgent>()
    for (const agent of agents()) {
      entries.set(agent.key, agent)
      if (agent.kind === "lane" && agent.session) entries.set(JSON.stringify(["session", agent.session.id]), agent)
      for (const session of agent.laneNode?.predecessors ?? []) entries.set(JSON.stringify(["session", session.id]), {
        key: JSON.stringify(["session", session.id]), project: agent.project, name: session.title, kind: "session", runtime: "local",
        state: session.status === "busy" ? "working" : session.status === "pending" ? "needs input" : session.status,
        tone: "unknown", depth: 0, session, parent: agent.key,
      })
    }
    return entries
  })
  const selectedKey = () => typeof search.select === "string" ? search.select : undefined
  const selected = createMemo(() => { const key = selectedKey(); return key ? index().get(key) : undefined })
  const select = (key: string) => setSearch({ select: index().get(key)?.key ?? key }, { replace: true })
  const registered = (editspace: string) => !!dashboard.editspaces()?.editspaces.some((item) => item.name === editspace)

  // With mail on, one observed-mail read per selected agent (cached for the page).
  createEffect(() => {
    const agent = selected()
    if (!showMail() || !agent || untrack(mailLoads)[agent.key]) return
    const recipient = agent.kind === "lane" && agent.lane ? { lane: agent.lane } : (agent.kind === "session" || agent.kind === "subagent") && agent.session ? { session: agent.session.id } : undefined
    if (!recipient || !registered(agent.project)) return
    const key = agent.key
    const editspace = agent.project
    setMailLoads((loads) => ({ ...loads, [key]: { state: "loading", messages: [] } }))
    es.mail(editspace, recipient).then(
      (timeline) => {
        const messages = timeline.messages.map((message) => ({ id: message.id, editspace, from: message.from, to: message.to, at: mailSentAt(message), kind: message.kind, text: message.text })).toSorted((a, b) => a.at - b.at)
        setMailLoads((loads) => ({ ...loads, [key]: { state: "ready", messages } }))
        if (selected()?.key === key && messages.length) setSelectedMail(`${editspace}\u0000${messages.at(-1)!.id}`)
      },
      (error) => setMailLoads((loads) => ({ ...loads, [key]: { state: "error", messages: [], error: `Observed mail unavailable: ${String(error)}` } })),
    )
  })
  // Only the selected agent's mail is drawn, so its edges never hide the tree.
  const mail = createMemo(() => { const agent = selected(); return showMail() && agent ? mailLoads()[agent.key]?.messages ?? [] : [] })
  const edges = createMemo(() => mailEdges(layout(), mail()))
  const mailKey = (message: MapMail) => `${message.editspace}\u0000${message.id}`
  const chosenMail = () => mail().find((message) => mailKey(message) === selectedMail())
  const partyKey = (editspace: string, party: string) => mailParty(agents(), editspace, party)
  const name = (editspace: string, party: string) => { const key = partyKey(editspace, party); return (key && index().get(key)?.name) || party }

  let panel: HTMLElement | undefined
  onMount(() => {
    const media = matchMedia("(prefers-reduced-motion: reduce)")
    setSystemReduced(media.matches)
    const motion = () => setSystemReduced(media.matches)
    media.addEventListener("change", motion)
    const observer = new ResizeObserver(() => setCanvasWidth(panel?.clientWidth ?? 0))
    if (panel) observer.observe(panel)
    const readDirection = () => setDirection(getComputedStyle(document.documentElement).direction === "rtl" ? "rtl" : "ltr")
    readDirection()
    const dirObserver = new MutationObserver(readDirection)
    dirObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["dir"] })
    onCleanup(() => { media.removeEventListener("change", motion); observer.disconnect(); dirObserver.disconnect() })
  })

  const Node = (props: { agent: MapAgent }) => {
    let dot: HTMLElement | undefined
    // Ring a node's dot when it newly needs input or fails, like the sidebar.
    ringOnChange(() => dot, () => props.agent.tone === "input" ? "pending" : props.agent.tone)
    return <button class="map-node-box" data-kind={props.agent.kind} data-tone={props.agent.tone} aria-pressed={selected()?.key === props.agent.key} onClick={() => select(props.agent.key)}>
    <span class="map-node-name"><bdi dir="auto">{props.agent.name}</bdi><span class="map-runtime" title={props.agent.runtime === "cloud" ? "Wingman cloud" : "Local"}>{props.agent.runtime === "cloud" ? "W" : "L"}</span></span>
    <span class="map-node-state"><i ref={(node) => dot = node} />{props.agent.state}<Show when={props.agent.laneNode?.predecessors.length}>{(count) => <span class="map-handoffs" title={`${count()} past owner${count() === 1 ? "" : "s"} (handoff history)`}>↺{count()}</span>}</Show></span>
  </button>
  }
  const Route = (props: { message: MapMail }) => <span class="map-route">
    <Party editspace={props.message.editspace} name={props.message.from} /><span class="map-arrow" aria-label="to">→</span><Party editspace={props.message.editspace} name={props.message.to} />
  </span>
  const Party = (props: { editspace: string; name: string }) => <Show when={partyKey(props.editspace, props.name)} fallback={<bdi dir="auto">{props.name}</bdi>}>{(key) =>
    <button class="map-link" onClick={() => select(key())}><bdi dir="auto">{name(props.editspace, props.name)}</bdi></button>}</Show>
  const time = (at: number) => Number.isFinite(at) ? new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "?"
  const title = (cluster: ClusterBox) => `${cluster.project.toUpperCase()}${cluster.cloud ? " · CLOUD" : ""} · ${cluster.count} AGENT${cluster.count === 1 ? "" : "S"}`

  return <main class="attention-home agent-map-page" data-still={still() ? "true" : "false"}>
    <AppHeader><h1>Agent map</h1><span class="home-muted">{project() ?? "All projects"}</span></AppHeader>
    <Show when={dashboard.stateError()}><div class="home-warning">{dashboard.stateError()} Lanes may be incomplete.</div></Show>
    <Show when={dashboard.handoffsError()}><div class="home-warning">{dashboard.handoffsError()} Handoff chains may be incomplete.</div></Show>
    <Show when={dashboard.sessionsError()}><div class="home-warning">{dashboard.sessionsError()}</div></Show>
    <Show when={provenance()?.failed.length}><div class="home-warning">Lane provenance unavailable for {provenance()!.failed.join(", ")}; delegation and spawn edges may be missing.</div></Show>
    <p class="map-summary"><bdi dir="auto">{visible().length} of {agents().length} agents · local + Wingman cloud{hidden() ? ` · ${hidden()} hidden (idle over 24h, unpinned)` : ""}</bdi></p>
    <div class="map-toolbar">
      <label>Project<select aria-label="Project" value={projectFilter()} onChange={(event) => setProjectFilter(event.currentTarget.value)}><option value="all">{project() ? "This project" : "All projects"}</option><For each={clusters().map((cluster) => cluster.project)}>{(value) => <option value={value}>{value}</option>}</For></select></label>
      <label>Runtime<select aria-label="Runtime" value={runtime()} onChange={(event) => setRuntime(event.currentTarget.value)}><option value="all">Local + Wingman</option><option value="local">Local</option><option value="cloud">Wingman cloud</option></select></label>
      <label>Agents<select aria-label="Agents" value={scope()} onChange={(event) => setSearch({ agents: event.currentTarget.value === "all" ? "all" : undefined, show: undefined }, { replace: true })}><option value="active">Active</option><option value="all">All</option></select></label>
      <label>Events<select aria-label="Events" value={layer()} onChange={(event) => setLayer(event.currentTarget.value)}><For each={LAYERS}>{([value, label]) => <option value={value}>{label}</option>}</For></select></label>
      <label class="map-mail-toggle"><input type="checkbox" checked={showMail()} onChange={(event) => setShowMail(event.currentTarget.checked)} />Mail for selected agent</label>
      <div class="map-motion">
        <button onClick={() => setPaused(!paused())}>{paused() ? "Resume motion" : "Pause motion"}</button>
        <label><input type="checkbox" checked={reduced()} onChange={(event) => setReduced(event.currentTarget.checked)} />Reduce motion</label>
        <Show when={still()}><span>{systemReduced() ? "OS reduced motion · static" : "Static"}</span></Show>
      </div>
    </div>
    <div class="map-body">
      <section class="map-main" ref={panel} aria-label="Project map">
        <div class="map-view-heading">
          <h2>Project map</h2>
          <div class="map-view-controls">
            <div class="map-zoom">
              <button aria-label="Zoom out" onClick={() => setZoom(Math.max(0.4, Math.round((scale() - 0.25) * 4) / 4))}>−</button>
              <output aria-label="Zoom">{Math.round(scale() * 100)}%</output>
              <button aria-label="Zoom in" onClick={() => setZoom(Math.min(1.75, Math.round((scale() + 0.25) * 4) / 4))}>+</button>
              <button onClick={() => setZoom("fit")}>Fit</button>
            </div>
          </div>
        </div>
        <div class="map-canvas" dir="ltr">
            <Show when={visible().length} fallback={<p class="home-empty">{dashboard.state.loading ? "Loading agents…" : "No agents in this scope."}</p>}>
              <svg viewBox={`0 0 ${layout().width} ${layout().height}`} width={layout().width * scale()} height={layout().height * scale()} role="group" aria-label="Agent network">
                <defs><marker id="map-org-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#8a90a4" /></marker><marker id="map-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="context-stroke" /></marker></defs>
                <For each={layout().clusters}>{(cluster) => <>
                  <rect class="map-cluster-box" x={cluster.x} y={cluster.y} width={cluster.width} height={cluster.height} rx="26" />
                  <Show when={cluster.divider}>{(y) => <text class="map-divider-title" x={cluster.x + 22} y={y() + 4}>not owning a lane</text>}</Show>
                </>}</For>
                <For each={layout().hierarchy}>{(edge) => <path class="map-hierarchy" data-kind={edge.kind} data-cross={edge.cross ? "true" : undefined} data-earlier={edge.earlier ? "true" : undefined} d={edge.path} marker-end={edge.kind === "subagent" ? undefined : "url(#map-org-arrow)"} />}</For>
                <For each={edges()}>{(edge, position) => <g class="map-mail-edge" classList={{ emphasized: edge.messages.some((message) => mailKey(message) === selectedMail()) }} data-from={edge.from} data-to={edge.to}>
                  <path d={edge.path} marker-end="url(#map-arrow)" />
                  <path class="map-edge-hit" d={edge.path} onClick={() => setSelectedMail(mailKey(edge.messages.at(-1)!))}><title>{edge.messages.length} observed message{edge.messages.length === 1 ? "" : "s"}: {name(edge.messages[0]!.editspace, edge.messages[0]!.from)} → {name(edge.messages[0]!.editspace, edge.messages[0]!.to)}</title></path>
                  <circle r="2.5" class="map-packet" style={{ "offset-path": `path('${edge.path}')`, "animation-delay": `${position() * -1.3}s` }} />
                </g>}</For>
                <For each={layout().clusters}>{(cluster) => <g role="region" aria-label={`Project ${cluster.project}${cluster.cloud ? " cloud" : ""}`}>
                  <text class="map-cluster-title" x={cluster.x + 20} y={cluster.y + cluster.height + 22}>{title(cluster)}</text>
                  <For each={layout().agents.filter((agent) => agent.project === cluster.project && (agent.runtime === "cloud") === cluster.cloud)}>{(agent) =>
                    <foreignObject x={agent.x} y={agent.y} width={NODE.width} height={NODE.height}><div class="map-node-host" dir={direction()}><Node agent={agent} /></div></foreignObject>}</For>
                </g>}</For>
              </svg>
            </Show>
        </div>
        <div class="map-legend"><span><i data-tone="working" />working</span><span><i data-tone="input" />needs input</span><span><i data-tone="failed" />failed</span><span><i data-tone="quiet" />idle / unknown</span><span>L local · W Wingman</span><span>solid → = delegated / spawned lane (long dash: by a past owner) · dashed = subagent · ↺ handoff history · faint → = mail (selected agent)</span></div>
        <section class="map-events" aria-label="State boundaries">
          <h3>State boundaries</h3>
          <Show when={events().length} fallback={<p class="map-empty">No state events in this filter. Agent states remain visible.</p>}>
            <For each={events()}>{(event) => <div class="map-event"><span class="map-event-level" data-level={event.level}>{event.level}</span><time>{event.at ? ago(event.at) : "now"}</time><button class="map-link" onClick={() => select(event.agent)}><bdi dir="auto">{index().get(event.agent)?.name}</bdi></button><bdi dir="auto">{event.text}</bdi></div>}</For>
          </Show>
        </section>
        <Show when={showMail()}>
          <section class="map-mail-list" aria-label="Directed mail">
            <h3>Directed mail <span>{mail().length} observed message{mail().length === 1 ? "" : "s"} for the selected agent</span></h3>
            <Show when={mail().length} fallback={<p class="map-empty">{selected() && mailLoads()[selected()!.key]?.state === "loading" ? "Loading observed mail…" : "No observed mail for the selected agent."}</p>}>
              <For each={mail().toReversed()}>{(message) => <div class="map-mail-row" role="button" tabIndex={0} aria-pressed={mailKey(message) === selectedMail()} onClick={() => setSelectedMail(mailKey(message))} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setSelectedMail(mailKey(message)) } }}>
                <time dateTime={Number.isFinite(message.at) ? new Date(message.at).toISOString() : undefined}>{time(message.at)}</time>
                <Route message={message} />
                <em>{message.kind ?? "message"}</em>
                <bdi dir="auto">{message.text.length > 160 ? `${message.text.slice(0, 160)}…` : message.text}</bdi>
              </div>}</For>
            </Show>
          </section>
        </Show>
      </section>
      <aside class="map-detail" aria-label="Selected agent">
        <div class="map-eyebrow">SELECTED AGENT</div>
        {/* Remount per selected identity so TODO reads never carry over to another agent. */}
        <Show when={selectedKey()} keyed fallback={<p class="home-muted">Select an agent to see its relations.</p>}>{(key) => <Show when={index().get(key)} fallback={<p class="home-muted">The selected agent is not in this scope or filter.</p>}>{(agent) =>
          <Detail agent={agent()} select={select} lookup={(key) => index().get(key)} hidden={!visible().some((item) => item.key === agent().key)} mailOn={showMail()} mail={mailLoads()[agent().key]} />}</Show>}</Show>
        <Show when={showMail()}>
          <h3>Selected mail</h3>
          <Show when={chosenMail()} fallback={<p class="home-muted">Select a mail edge or row.</p>}>{(message) => <>
            <p class="map-message-route"><Route message={message()} /></p>
            <div class="map-message"><span>{message().kind ?? "message"} · {Number.isFinite(message().at) ? ago(message().at) : "time unknown"}</span><p dir="auto">{message().text}</p></div>
            <p class="map-muted">Observed record. Not proof of delivery or execution.</p>
          </>}</Show>
        </Show>
        <h3>Fleet roster</h3>
        <For each={visible().filter((agent) => agent.kind !== "subagent")}>{(agent) => <button class="map-roster" aria-pressed={selected()?.key === agent.key} onClick={() => select(agent.key)}><bdi dir="auto">{agent.name}</bdi><span>{agent.state}</span></button>}</For>
      </aside>
    </div>
  </main>
}

const Detail = (props: { agent: MapAgent; select: (key: string) => void; lookup: (key: string) => MapAgent | undefined; hidden: boolean; mailOn: boolean; mail?: MailLoad }) => {
  const dashboard = useDashboard()
  const registered = () => !!dashboard.editspaces()?.editspaces.some((item) => item.name === props.agent.project)
  const session = () => props.agent.session
  // One TODO read and one current-turn read for the selected session only.
  createEffect(() => { const value = session(); if (value?.directory) onCleanup(dashboard.activity.todos.watch(value.id, value.directory)) })
  const turn = createMemo(() => { const value = session(); return value?.directory ? turnOf(currentWork(value.id, value.directory)()) : { status: "unknown" as const } })
  const role = () => ({ lane: "Lane · current owner session", session: "Session not owning a lane", subagent: "Subagent · spawned by its parent session", cloud: "Wingman cloud lane" })[props.agent.kind]
  const source = () => ({ lane: "Lane record + session index", session: "Session index", subagent: "Session parent", cloud: "Cloud lane record" })[props.agent.kind]
  const updated = () => session() && dashboard.activity.session(session()!.id)?.time.updated
  const report = () => props.agent.laneNode?.report
  const parent = () => session() && dashboard.activity.session(session()!.id)?.parentID
  return <div class="map-detail-body">
    <h2><bdi dir="auto">{props.agent.name}</bdi></h2>
    <p>{role()}</p>
    <span class="map-status" data-tone={props.agent.tone}>{props.agent.state}</span>
    <dl class="map-facts">
      <dt>Project</dt><dd><bdi dir="auto">{props.agent.project}</bdi></dd>
      <dt>Runtime</dt><dd>{props.agent.runtime === "cloud" ? "Wingman · cloud" : "Local"}</dd>
      <dt>Source</dt><dd>{source()}</dd>
      <dt>Freshness</dt><dd>{report()?.at ? `Report ${ago(report()!.at)}` : updated() ? `Session updated ${ago(updated()!)}` : "Unknown"}</dd>
      <Show when={props.agent.laneNode}>{(lane) => <>
        <dt>Owner</dt><dd><bdi dir="ltr" class="mono">{lane().owner}</bdi> · from lane record</dd>
        <Show when={lane().laneStatus}><dt>Lane</dt><dd>{lane().laneStatus}</dd></Show>
        <Show when={lane().issue}><dt>Issue</dt><dd><bdi dir="auto">{lane().issue}</bdi></dd></Show>
        <Show when={lane().predecessors.length || lane().chainBroken}><dt>Lineage</dt><dd>{lane().predecessors.length} verified handoff{lane().predecessors.length === 1 ? "" : "s"}{lane().chainBroken ? " · earlier lineage ambiguous" : ""}</dd></Show>
      </>}</Show>
      <Show when={session()}>{(value) => <>
        <dt>Session</dt><dd><Show when={value().known}><bdi dir="auto">{value().title}</bdi> · </Show><bdi dir="ltr" class="mono">{value().id}</bdi>{value().known ? "" : " · not in local session index"}</dd>
        <Show when={value().subagents.length}><dt>Subagents</dt><dd>{value().subagents.length} by session parent</dd></Show>
        <Show when={parent()}>{(id) => <><dt>Parent</dt><dd><button class="map-link" onClick={() => props.select(JSON.stringify(["session", id()]))}><bdi dir="auto">{dashboard.activity.session(id())?.title ?? id()}</bdi></button></dd></>}</Show>
      </>}</Show>
      <Show when={props.agent.kind === "lane"}><dt>Started by</dt><dd><Show when={props.agent.origin} fallback={<span class="home-muted">No delegation or spawn record</span>}>{(origin) => <>
        <Show when={origin().from ? props.lookup(origin().from!) : undefined} fallback={<bdi dir="ltr" class="mono">{origin().by}</bdi>}>{(from) =>
          <button class="map-link" onClick={() => props.select(from().key)}><bdi dir="auto">{from().name}</bdi></button>}</Show>
        {` · ${origin().kind === "delegated" ? `delegation${origin().status ? ` (${origin().status})` : ""}` : "first spawn"}${origin().earlier ? " · by an earlier owner" : ""}`}
      </>}</Show></dd></Show>
      <Show when={props.agent.cloud}>{(cloud) => <><dt>Owner</dt><dd><bdi dir="ltr" class="mono">{cloud().owner}</bdi> · cloud workflow</dd></>}</Show>
    </dl>
    <h3>Current activity</h3>
    <Show when={report() || props.agent.cloud?.report} fallback={<Show when={!session()?.directory}><p class="home-muted">No activity reported.</p></Show>}><p dir="auto">{report()?.text ?? props.agent.cloud?.report}</p></Show>
    <Show when={session()?.directory}><TodoLine session={{ id: session()!.id, directory: session()!.directory! }} turn={turn()} /></Show>
    <Show when={props.hidden}><p class="map-hidden">Selected agent is outside the current filter.</p></Show>
    <div class="home-actions">
      <Show when={session()?.directory}><A href={sessionHref(session()!.id, session()!.directory)}>Open session</A></Show>
      <Show when={props.agent.kind === "lane" && session() && !session()!.known}><span class="home-muted">Owner session is not in the local index; it cannot be opened here.</span></Show>
      <Show when={props.agent.cloud}>{(cloud) => <A href={cloudHref({ editspace: cloud().editspace, lane: cloud().lane, owner: cloud().owner })}>Open cloud agent</A>}</Show>
    </div>
    <Show when={props.agent.laneNode?.predecessors.length}>
      <h3>Handoff lineage</h3>
      <ol class="map-chain" aria-label={`Handoff lineage for ${props.agent.name}`}>
        <For each={props.agent.laneNode!.predecessors}>{(item: SessionRef) => <li><button class="map-link" onClick={() => props.select(JSON.stringify(["session", item.id]))}><bdi dir="auto">{item.title}</bdi></button><span class="home-muted"> handed off</span></li>}</For>
        <li class="home-muted">current owner</li>
      </ol>
    </Show>
    <Show when={props.mailOn}><p class="map-muted" data-mail={props.mail?.state ?? "none"}>{props.agent.kind === "cloud" ? "No mail source for this agent." : !registered() ? "Not in a registered project; no mail source." : props.mail?.state === "error" ? props.mail.error : props.mail?.state === "ready" ? `${props.mail.messages.length} observed message${props.mail.messages.length === 1 ? "" : "s"}${props.agent.kind === "lane" ? " for this lane across handoffs" : ""}.` : "Loading observed mail…"}</p></Show>
  </div>
}
