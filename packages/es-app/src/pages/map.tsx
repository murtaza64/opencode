/* Agent map: project topology from observed lane owners, verified handoffs,
 * subagent parentage and cloud lane records, plus observed mail for one
 * selected agent. Read-only; no new fleet-wide reads. */
import { createEffect, createMemo, createResource, createSignal, For, onCleanup, Show, type JSX } from "solid-js"
import { A, useSearchParams } from "@solidjs/router"
import { es, type MailMessage } from "../api"
import { buildAgentMap, sessionOwner, type AgentStatus, type CloudNode, type LaneNode, type MapCluster, type SessionRef, type StandaloneNode } from "../agent-map"
import { cloudHref } from "../cloud-agents"
import { AppHeader } from "../components/native-header"
import { TodoLine, turnOf } from "../components/todo-line"
import { currentWork } from "../current-work"
import { ago, sessionHref, useDashboard } from "../state"
import "./home.css"
import "./map.css"

type Selected = { kind: "lane"; node: LaneNode } | { kind: "session"; node: StandaloneNode | { key: string; project: string; session: SessionRef } } | { kind: "cloud"; node: CloudNode }

export default function AgentMap() {
  const dashboard = useDashboard()
  const [search, setSearch] = useSearchParams()
  const [filter, setFilter] = createSignal<"active" | "all">(search.show === "all" ? "all" : "active")
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
    filter: filter(),
    now: Date.now(),
  }).filter((cluster) => !project() || cluster.project === project()))
  // Index exactly the subtree rendered below (the builder bounds its depth).
  const sessionEntries = (session: SessionRef, project: string): (readonly [string, Selected])[] => [
    [JSON.stringify(["session", session.id]), { kind: "session", node: { key: JSON.stringify(["session", session.id]), project, session } }],
    ...session.subagents.flatMap((child) => sessionEntries(child, project)),
  ]
  const subagentEntries = (session: SessionRef | undefined, project: string) => session?.subagents.flatMap((child) => sessionEntries(child, project)) ?? []
  const nodes = createMemo(() => new Map<string, Selected>(clusters().flatMap((cluster) => [
    // A lane owner's session identity selects its lane, where its relations are shown.
    ...cluster.lanes.flatMap((node) => [
      [node.key, { kind: "lane" as const, node }] as const,
      ...(node.ownerSession ? [[JSON.stringify(["session", node.ownerSession.id]), { kind: "lane" as const, node }] as const] : []),
      ...node.predecessors.flatMap((session) => sessionEntries(session, cluster.project)),
      ...subagentEntries(node.ownerSession, cluster.project),
    ]),
    ...cluster.standalone.flatMap((node) => [[node.key, { kind: "session" as const, node }] as const, ...subagentEntries(node.session, cluster.project)]),
    ...cluster.cloud.map((node) => [node.key, { kind: "cloud" as const, node }] as const),
  ])))
  // Canonicalize aliases (a lane owner's session key) so the selected card is highlighted.
  const select = (key: string) => setSearch({ select: nodes().get(key)?.node.key ?? key }, { replace: true })
  const total = () => clusters().reduce((sum, cluster) => sum + cluster.lanes.length + cluster.standalone.length + cluster.cloud.length, 0)
  const hidden = () => clusters().reduce((sum, cluster) => sum + cluster.hidden, 0)
  const setShow = (value: "active" | "all") => { setFilter(value); setSearch({ show: value === "all" ? "all" : undefined }, { replace: true }) }

  const Dot = (props: { status: AgentStatus | string | undefined }) => <span class="map-dot" data-status={props.status ?? "unknown"} role="img" aria-label={props.status ?? "unknown"} />
  const SessionButton = (props: { session: SessionRef; project: string; edge: string; children?: JSX.Element }) => {
    const key = JSON.stringify(["session", props.session.id])
    return <button class="map-session" aria-pressed={search.select === key} onClick={() => select(key)} data-edge={props.edge}>
      <Dot status={props.session.status} /><span class="map-edge">{props.edge}</span><bdi dir="auto">{props.session.title}</bdi>{props.children}
    </button>
  }
  const Subagents = (props: { session?: SessionRef; project: string }) => <Show when={props.session?.subagents.length}>
    <ul class="map-subagents" aria-label="Subagents">
      <For each={props.session!.subagents}>{(child) => <li><SessionButton session={child} project={props.project} edge="subagent" /><Subagents session={child} project={props.project} /></li>}</For>
    </ul>
  </Show>
  const Lane = (props: { node: LaneNode }) => <article class="map-node map-lane" data-selected={search.select === props.node.key ? "true" : undefined}>
    <button class="map-node-head" aria-pressed={search.select === props.node.key} onClick={() => select(props.node.key)}>
      <Dot status={props.node.ownerSession?.status ?? "unknown"} /><span class="map-kind">lane</span><bdi dir="auto" class="map-name">{props.node.lane}</bdi>
      <Show when={props.node.laneStatus}><span class="map-lane-status">{props.node.laneStatus}</span></Show>
    </button>
    <div class="map-owner"><span class="map-edge">owner</span><Show when={props.node.ownerSession} fallback={<bdi dir="ltr" class="mono">{props.node.owner}</bdi>}>{(owner) => <bdi dir="auto">{owner().known ? owner().title : `${owner().id} · not in local session index`}</bdi>}</Show></div>
    <Show when={props.node.report}>{(report) => <div class="map-report home-muted"><bdi dir="auto">{report().text}</bdi><span>report{report().at ? ` ${ago(report().at)}` : ""}</span></div>}</Show>
    <Show when={props.node.predecessors.length || props.node.chainBroken}>
      <ol class="map-chain" aria-label={`Handoff lineage for ${props.node.lane}`}>
        <Show when={props.node.chainBroken}><li class="home-muted">earlier lineage ambiguous</li></Show>
        <For each={props.node.predecessors}>{(session) => <li><SessionButton session={session} project={props.node.editspace} edge="handed off" /></li>}</For>
        <li class="map-chain-owner home-muted">current owner</li>
      </ol>
    </Show>
    <Subagents session={props.node.ownerSession} project={props.node.editspace} />
  </article>

  return <main class="attention-home agent-map-page">
    <AppHeader><h1>Agent map</h1><span class="home-muted">{project() ?? "All projects"}</span><A class="home-header-end" href="/">Home</A></AppHeader>
    <Show when={dashboard.stateError()}><div class="home-warning">{dashboard.stateError()} Lanes may be incomplete.</div></Show>
    <Show when={dashboard.handoffsError()}><div class="home-warning">{dashboard.handoffsError()} Handoff chains may be incomplete.</div></Show>
    <Show when={dashboard.sessionsError()}><div class="home-warning">{dashboard.sessionsError()}</div></Show>
    <div class="map-toolbar">
      <div class="home-tabs" role="group" aria-label="Map scope">
        <button aria-pressed={filter() === "active"} onClick={() => setShow("active")}>Active</button>
        <button aria-pressed={filter() === "all"} onClick={() => setShow("all")}>All</button>
      </div>
      <bdi class="home-muted" dir="auto">{total()} shown{hidden() ? ` · ${hidden()} hidden (idle over 24h, unpinned)` : ""}</bdi>
      <Show when={dashboard.allProjects()}><p class="home-muted map-scope">Lanes come from the selected project's dashboard and the lineage already loaded for other projects; an unmatched session may still own a lane not loaded here.</p></Show>
      <ul class="map-legend home-muted" aria-label="Legend">
        <li><b>owner</b> current lane owner (lane record)</li><li><b>handed off</b> verified lineage</li><li><b>subagent</b> session parent</li><li><b>mail</b> observed, selected agent only</li>
      </ul>
    </div>
    <div class="map-body">
      <div class="map-clusters">
        <For each={clusters()} fallback={<p class="home-empty">{dashboard.state.loading ? "Loading agents…" : "No agents in this scope."}</p>}>{(cluster) => <section class="map-cluster" aria-label={`Project ${cluster.project}`}>
          <h2><bdi dir="auto">{cluster.project}</bdi> <span>{cluster.lanes.length + cluster.standalone.length + cluster.cloud.length}</span></h2>
          <Show when={cluster.hidden}><p class="home-muted"><bdi dir="auto">{cluster.hidden} more hidden by Active</bdi></p></Show>
          <For each={cluster.lanes}>{(node) => <Lane node={node} />}</For>
          <Show when={cluster.standalone.length}><h3 class="map-group">Sessions not matched to a loaded lane</h3></Show>
          <For each={cluster.standalone}>{(node) => <article class="map-node" data-selected={search.select === node.key ? "true" : undefined}>
            <SessionButton session={node.session} project={cluster.project} edge="session" />
            <Subagents session={node.session} project={cluster.project} />
          </article>}</For>
          <Show when={cluster.cloud.length}><h3 class="map-group">Cloud</h3></Show>
          <For each={cluster.cloud}>{(node) => <article class="map-node" data-selected={search.select === node.key ? "true" : undefined}>
            <button class="map-node-head" aria-pressed={search.select === node.key} onClick={() => select(node.key)}><Dot status={node.status === "processing" ? "busy" : node.status === "waiting" ? "pending" : node.status ? "idle" : "unknown"} /><span class="map-kind">cloud</span><bdi dir="auto" class="map-name">{node.lane}</bdi><span class="map-lane-status">{node.status ?? "status unknown"}</span></button>
            <Show when={node.report}><div class="map-report home-muted"><bdi dir="auto">{node.report}</bdi><span>report</span></div></Show>
          </article>}</For>
        </section>}</For>
      </div>
      <aside class="map-detail" aria-label="Selected agent">
        {/* Remount per selected identity so mail and TODO reads never carry over to another agent. */}
        <Show when={typeof search.select === "string" ? search.select : undefined} keyed fallback={<p class="home-muted">Select an agent to see its relations and observed mail.</p>}>{(key) => <Show when={nodes().get(key)} fallback={<p class="home-muted">The selected agent is not in this scope or filter.</p>}>{(item) => <Detail item={item()} select={select} lanes={lanes()} />}</Show>}</Show>
      </aside>
    </div>
  </main>
}

const Detail = (props: { item: Selected; select: (key: string) => void; lanes: { editspace: string; lane: string }[] }) => {
  const dashboard = useDashboard()
  const session = () => props.item.kind === "lane" ? props.item.node.ownerSession : props.item.kind === "session" ? props.item.node.session : undefined
  const editspace = () => props.item.kind === "lane" || props.item.kind === "cloud" ? props.item.node.editspace : props.item.node.project
  const registered = () => dashboard.editspaces()?.editspaces.some((item) => item.name === editspace())
  // One TODO read and one current-turn read for the selected session only.
  createEffect(() => { const value = session(); if (value?.directory) onCleanup(dashboard.activity.todos.watch(value.id, value.directory)) })
  const turn = createMemo(() => { const value = session(); return value?.directory ? turnOf(currentWork(value.id, value.directory)()) : { status: "unknown" as const } })
  const [mailOpen, setMailOpen] = createSignal(false)
  const recipient = () => props.item.kind === "lane" ? { lane: props.item.node.lane } : props.item.kind === "session" ? { session: props.item.node.session.id } : undefined
  const [mail] = createResource(() => mailOpen() && registered() && recipient() ? { name: editspace(), recipient: recipient()! } : undefined,
    async ({ name, recipient }) => {
      try { return { messages: (await es.mail(name, recipient)).messages, error: "" } }
      catch (error) { return { messages: [] as MailMessage[], error: `Observed mail unavailable: ${String(error)}` } }
    })
  const laneKey = (name: string) => props.lanes.some((lane) => lane.editspace === editspace() && lane.lane === name) ? JSON.stringify(["lane", editspace(), name]) : undefined
  const time = (message: MailMessage) => message.created_ms ?? (typeof message.ts === "number" ? message.ts * (message.ts < 1e12 ? 1000 : 1) : Date.parse(message.ts))
  const Party = (props2: { name: string }) => <Show when={laneKey(props2.name)} fallback={<bdi dir="auto">{props2.name}</bdi>}>{(key) => <button class="map-link" onClick={() => props.select(key())}><bdi dir="auto">{props2.name}</bdi></button>}</Show>
  return <div class="map-detail-body">
    <div class="home-eyebrow"><span>{props.item.kind}</span><bdi dir="auto">{editspace()}</bdi></div>
    <h2><bdi dir="auto">{props.item.kind === "lane" ? props.item.node.lane : props.item.kind === "cloud" ? props.item.node.lane : props.item.node.session.title}</bdi></h2>
    <dl class="map-facts">
      <Show when={props.item.kind === "lane"}><dt>Owner</dt><dd><bdi dir="ltr" class="mono">{(props.item.node as LaneNode).owner}</bdi> · from lane record</dd></Show>
      <Show when={props.item.kind === "lane" && (props.item.node as LaneNode).issue}><dt>Issue</dt><dd><bdi dir="auto">{(props.item.node as LaneNode).issue}</bdi></dd></Show>
      <Show when={props.item.kind === "lane" && (props.item.node as LaneNode).predecessors.length}><dt>Lineage</dt><dd>{(props.item.node as LaneNode).predecessors.length} verified handoff{(props.item.node as LaneNode).predecessors.length === 1 ? "" : "s"}{(props.item.node as LaneNode).chainBroken ? " · earlier lineage ambiguous" : ""}</dd></Show>
      <Show when={session()}>{(value) => <>
        <dt>Session</dt><dd><bdi dir="ltr" class="mono">{value().id}</bdi>{value().known ? "" : " · not in local session index"}</dd>
        <dt>Status</dt><dd>{value().status}</dd>
        <Show when={value().subagents.length}><dt>Subagents</dt><dd>{value().subagents.length} by session parent</dd></Show>
        <Show when={dashboard.activity.session(value().id)?.parentID}>{(parent) => <><dt>Parent</dt><dd><button class="map-link" onClick={() => props.select(JSON.stringify(["session", parent()]))}><bdi dir="auto">{dashboard.activity.session(parent())?.title ?? parent()}</bdi></button></dd></>}</Show>
      </>}</Show>
      <Show when={props.item.kind === "cloud"}><dt>Owner</dt><dd><bdi dir="ltr" class="mono">{(props.item.node as CloudNode).owner}</bdi> · cloud workflow</dd><dt>Status</dt><dd>{(props.item.node as CloudNode).status ?? "unknown"}</dd></Show>
    </dl>
    <Show when={session()?.directory}><TodoLine session={{ id: session()!.id, directory: session()!.directory! }} turn={turn()} /></Show>
    <div class="home-actions">
      <Show when={session()?.directory}><A href={sessionHref(session()!.id, session()!.directory)}>Open session</A></Show>
      <Show when={props.item.kind === "lane" && sessionOwner((props.item.node as LaneNode).owner) && !session()?.known}><span class="home-muted">Owner session is not in the local index; it cannot be opened here.</span></Show>
      <Show when={props.item.kind === "cloud"}><A href={cloudHref({ editspace: editspace(), lane: (props.item.node as CloudNode).lane, owner: (props.item.node as CloudNode).owner })}>Open cloud agent</A></Show>
    </div>
    <Show when={props.item.kind !== "cloud"}>
      <section class="map-mail" aria-label="Observed mail">
        <h3>Observed mail</h3>
        <Show when={registered()} fallback={<p class="home-muted">Not in a registered project; no mail source.</p>}>
          <Show when={mailOpen()} fallback={<button onClick={() => setMailOpen(true)}>Load observed mail</button>}>
            <Show when={!mail.loading} fallback={<p class="home-muted">Loading observed mail…</p>}>
              <Show when={!mail()?.error} fallback={<p class="home-warning">{mail()?.error}</p>}>
                <p class="home-muted">Messages recorded for this {props.item.kind === "lane" ? "lane across handoffs" : "session"}, oldest first. Mail is not proof of delivery or execution.</p>
                <ol class="map-timeline">
                  <For each={[...(mail()?.messages ?? [])].sort((a, b) => time(a) - time(b))} fallback={<li class="home-muted">No observed mail.</li>}>{(message) => <li>
                    <time dateTime={new Date(time(message)).toISOString()}>{ago(time(message))}</time>
                    <span class="map-route"><Party name={message.from} /><span class="map-arrow" aria-label="to">→</span><Party name={message.to} /></span>
                    <span class="map-mail-kind">{message.kind ?? "message"}</span>
                    <bdi dir="auto" class="map-mail-text">{message.text.length > 200 ? `${message.text.slice(0, 200)}…` : message.text}</bdi>
                  </li>}</For>
                </ol>
              </Show>
            </Show>
          </Show>
        </Show>
      </section>
    </Show>
  </div>
}
