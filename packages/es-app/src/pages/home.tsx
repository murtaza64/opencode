import { Glyph } from "../components/icons"
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js"
import { A } from "@solidjs/router"
import { ago, sessionHref, useDashboard, type SessionRow } from "../state"
import { AppHeader } from "../components/native-header"
import { CurrentWorkView, type CurrentWorkSnapshot } from "../current-work"
import { ActivityBriefView } from "../components/activity-brief"
import type { ActivityBriefInput } from "../activity-brief"
import { createAttention, type AttentionRecord } from "../attention"
import { AttentionDecision, type AttentionView } from "../components/attention-decision"
import { PreparedBrief } from "../components/attention-brief"
import { useBriefs } from "../desk-briefs"
import { deskItems, type DeskItem } from "../desk"
import "./desk.css"
import { createHomeRequests, requestKey, requestPointers, type HomeRequest } from "../home-requests"
import HomeActivity from "../home-activity"
import { FailureRetry } from "../components/session-failure"
import { failureLabel } from "../session-failures"
import HomeCloudAgents from "../home-cloud-agents"
import type { HomeActivityRow } from "../home-activity-data"
import { HomePermission, type HomeReplyReceipt } from "../components/home-permission"
import { TodoLine, turnOf } from "../components/todo-line"
import "./home.css"

const PinnedAgent = (props: { session: SessionRow }) => {
  const dashboard = useDashboard()
  const [work, setWork] = createSignal<CurrentWorkSnapshot>({ value: null, checked: 0, error: false, loading: true })
  createEffect(() => onCleanup(dashboard.activity.todos.watch(props.session.id, props.session.directory)))
  const brief = (): ActivityBriefInput => {
    const snapshot = work()
    const status = !snapshot.value || snapshot.error || Date.now() - snapshot.checked > (snapshot.value.turn.status === "busy" ? 15_000 : 45_000) ? "unknown" : snapshot.value.turn.status
    const lane = (dashboard.state()?.threads ?? []).flatMap((thread: { lanes?: { owner: string; activity?: string; activity_at?: string; activity_session?: string }[] }) => thread.lanes ?? [])
      .find((lane: { owner: string }) => lane.owner === props.session.id)
    return {
      sessionID: props.session.id,
      status,
      report: lane?.activity && lane.activity_session && lane.activity_at ? { sessionID: lane.activity_session, owner: lane.owner, text: lane.activity, at: Date.parse(lane.activity_at) } : undefined,
      // This endpoint has safe tool names but no start times. TODOs render separately with their own provenance.
      tools: snapshot.value?.turn.active_tools.map(tool => ({ name: tool.name, status: tool.status, sessionID: props.session.id })),
    }
  }
  const failure = () => dashboard.handedOff(props.session.id) ? undefined : dashboard.failures.failure(props.session.id)
  return <div class="home-agent">
    <div><A class="home-name" href={sessionHref(props.session.id, props.session.directory)}><Show when={failure()}>{item => <span class="dot failed" role="img" aria-label={`Failed: ${failureLabel(item())}`} title={`Failed: ${failureLabel(item())}`} />}</Show><bdi dir="auto">{props.session.title || props.session.id}</bdi></A><Show when={failure()}>{item => <div class="home-failed">{failureLabel(item())} <FailureRetry sessionID={props.session.id} compact /></div>}</Show><div class="home-muted"><bdi dir="auto">{props.session.project || dashboard.editspace() || "project"}</bdi></div><button onClick={() => dashboard.togglePin(props.session)}>Unpin</button></div>
    <div><ActivityBriefView input={brief()} /><TodoLine session={props.session} turn={turnOf(work())} /><details><summary>Turn telemetry</summary><CurrentWorkView id={props.session.id} directory={props.session.directory} compact onSnapshot={setWork} /></details></div>
  </div>
}

export default function Home() {
  const dashboard = useDashboard()
  const project = () => dashboard.allProjects() ? undefined : dashboard.editspace() ?? dashboard.editspaces()?.default ?? undefined
  const attention = createAttention(project)
  const [view, setView] = createSignal<AttentionView>("open")
  const [cloudCount, setCloudCount] = createSignal(0)
  const [cloudActivity, setCloudActivity] = createSignal<HomeActivityRow[]>([])
  const sourcePointers = createMemo<HomeRequest[]>(() => requestPointers(dashboard))
  const requests = createHomeRequests(sourcePointers, item => dashboard.activity.requestSettled(item.kind, item.directory, item.id))
  const [receipts, setReceipts] = createSignal<HomeReplyReceipt[]>([])
  const receiptText = (item: HomeReplyReceipt) => item.result === "applied" ? `${item.reply === "once" ? "Allowed once" : item.reply === "always" ? "Always allowed" : "Rejected"}` : item.result === "not-applied" ? "Not applied" : "Outcome uncertain"
  const siblings = (item: HomeRequest) => dashboard.activity.requests().filter(other => other.kind === "permission" && other.directory === item.directory && other.request.sessionID === item.session && other.request.id !== item.id).length
  const subagentOwner = (item: HomeRequest) => {
    const root = dashboard.activity.root(item.session)
    return root && root.id !== item.session ? root.title || root.id : undefined
  }
  const requestRows = () => requests.rows().filter(item => !project() || !item.project || item.project === project())
  const pendingRequests = () => requestRows().filter(item => item.state === "pending")
  const uncertainRequests = () => requestRows().filter(item => item.state !== "pending")
  const pendingByKey = createMemo(() => new Map(pendingRequests().map(item => [requestKey(item), item])))
  const records = () => attention.snapshot()?.value.records ?? []
  const visible = () => records().filter(record => view() === "history" ? ["resolved", "withdrawn"].includes(record.status) : view() === "recorded" ? record.status === "decided" : record.status === view())
  const count = (tab: string) => records().filter(record => tab === "history" ? ["resolved", "withdrawn"].includes(record.status) : record.status === (tab === "recorded" ? "decided" : tab)).length + (tab === "open" ? pendingRequests().length : 0)
  const recordKey = (record: AttentionRecord) => `${record.editspace}\u0000${record.id}`
  const byKey = createMemo(() => new Map(records().map(record => [recordKey(record), record])))
  // Briefs are prepared app-wide (desk-briefs); Home only renders them.
  const prepared = useBriefs()
  const openItems = createMemo(() => deskItems({ records: records(), attentionChecked: attention.snapshot()?.checked ?? 0, requests: [], failures: [], failuresChecked: 0, title: () => undefined, project: () => undefined }))
  prepared.track(openItems)
  const itemFor = (record: AttentionRecord) => openItems().find(item => item.record?.id === record.id && item.record.editspace === record.editspace)
  const readyFor = (item?: DeskItem) => !!item && prepared.jobFor(item)?.state.state === "ready"
  const briefFor = (record: AttentionRecord) => {
    const item = itemFor(record)
    return item ? <PreparedBrief item={item} live /> : undefined
  }
  return <main class="attention-home">
    <AppHeader><h1>Home</h1><span class="home-muted">{project() ?? "All projects"}</span><A class="home-map-link" href="/map"><Glyph name="graph" />Agent map</A><A href="/desk">Front desk</A>{/* Freshness speaks only when it changes what you can trust; the button title always has it. */}<span class="home-header-end home-muted" classList={{ "home-blocked": attention.stale() }}>{attention.snapshot() ? (attention.stale() ? `Ledger checked ${Math.max(0, Math.floor((attention.now() - attention.snapshot()!.checked) / 1000))}s ago · stale` : "") : "Ledger not checked"}</span><button title={attention.snapshot() ? `Ledger checked ${Math.max(0, Math.floor((attention.now() - attention.snapshot()!.checked) / 1000))}s ago` : "Ledger not checked"} disabled={attention.loading()} onClick={() => { void attention.refresh(); void requests.refresh(); dashboard.activity.todos.reload(); void attention.checkOperator().catch(() => undefined) }}>Refresh</button></AppHeader>
    <Show when={attention.error()}><div class="home-warning" role="alert">{attention.error()} Last-known records are retained; actions are disabled.</div></Show>
    <Show when={attention.snapshot()?.value.partial}><div class="home-warning">Some projects unavailable; this list may be incomplete.<For each={attention.snapshot()?.value.projects.filter(item => !item.available)}>{item => <div><bdi dir="auto">{item.editspace}</bdi>: {item.error || "unavailable"}</div>}</For></div></Show>
    <Show when={attention.snapshot()?.value.truncated}><div class="home-warning">History truncated; counts may be incomplete.</div></Show>
    <Show when={dashboard.sessionsError()}><div class="home-warning">Live request sources may be incomplete. {dashboard.sessionsError()}</div></Show>
    <Show when={dashboard.stateError()}><div class="home-warning">{dashboard.stateError()} Cached source values are not a live status.</div></Show>
    <Show when={attention.notice()}><div class="home-notice" role="status">{attention.notice()}<Show when={attention.pending()}><button disabled={attention.writing()} onClick={async () => { const action = attention.pending()?.body.action; if (await attention.retry() && action === "answer") setView("answered") }}>Retry same action</button></Show></div></Show>
    <section aria-label="Needs you"><div class="home-section"><h2>Needs you <span>{count("open")}</span></h2></div>
      <Show when={!attention.operator()}><div class="home-login home-muted">Read-only <button title="Operator connection unavailable: this UI origin must be allowed by the attention server" onClick={() => attention.checkOperator().catch(() => undefined)}>Reconnect operator</button></div></Show>
      <div class="home-tabs" role="group" aria-label="Attention status"><For each={[["open", "Open"], ["answered", "Answered"], ["recorded", "Recorded / not sent"], ["snoozed", "Snoozed"], ["history", "History"]]}>{([tab, label]) => <button aria-pressed={view() === tab} data-empty={count(tab) === 0 ? "" : undefined} onClick={() => setView(tab as AttentionView)}>{label} <span>{count(tab)}</span></button>}</For></div>
      <Show when={view() === "open" && receipts().length}><ul class="home-receipts" aria-label="Replies from Home"><For each={receipts()}>{item => <li data-result={item.result}><b>{receiptText(item)}</b> · <bdi dir="ltr">{item.permission}</bdi> · <bdi dir="auto">{item.title}</bdi> · {ago(item.at)}{item.result === "uncertain" ? " · the server did not confirm; check the thread" : item.result === "not-applied" ? " · request was no longer pending" : ""} · <A href={sessionHref(item.session, item.directory)}>Open thread</A></li>}</For></ul></Show>
      {/* Key request cards by exact identity so source rechecks keep each card's in-flight and outcome state. */}
      <Show when={view() === "open"}><For each={pendingRequests().map(requestKey)}>{key => <Show when={pendingByKey().get(key)}>{row => row().kind === "permission" ? <HomePermission item={row()} live={dashboard.activity.requestState("permission", row().session, row().directory, row().id)} siblings={siblings(row())} owner={subagentOwner(row())} stale={requests.now() - row().checked > 45_000} onReceipt={receipt => setReceipts(previous => [receipt, ...previous.filter(old => old.key !== receipt.key || old.at !== receipt.at)].slice(0, 5))} onRecheck={directory => Promise.all([requests.refresh(), dashboard.activity.refreshDirectory(directory, true)]).then(() => undefined)} /> : <div class="home-request"><div><span class="home-eyebrow">{row().kind} · source request</span><h3><bdi dir="auto">{row().title}</bdi></h3><div class="home-source">Exact request <bdi dir="ltr">{row().id}</bdi> · source checked {ago(row().checked)}{requests.now() - row().checked > 45_000 ? " · stale" : ""}</div></div><A href={sessionHref(row().session, row().directory)}>Open request</A></div> }</Show>}</For></Show>
      {/* Key cards by project+record so polls update props in place and keep textarea focus, caret and draft. */}
      <For each={visible().map(recordKey)}>{key => <Show when={byKey().get(key)}>{record => <AttentionDecision record={record()} attention={attention} brief={briefFor(record())} readable={readyFor(itemFor(record()))} onView={setView} />}</Show>}</For>
      <Show when={!visible().length && (view() !== "open" || !pendingRequests().length)}><div class="home-empty">{attention.loading() && !attention.snapshot() ? "Checking attention ledger…" : attention.stale() || attention.snapshot()?.value.partial ? "Not fully checked; something may still be waiting." : view() === "open" ? "Nothing needs a choice." : "No records in this view."}</div></Show>
      <Show when={uncertainRequests().length}><details class="home-unknown"><summary>Source requests with unknown outcome ({uncertainRequests().length})</summary><For each={uncertainRequests()}>{item => <div class="home-source"><bdi dir="auto">{item.title}</bdi> · {item.kind} · {item.state === "unavailable" ? "source unavailable" : "no longer pending; outcome unknown"} · <A href={sessionHref(item.session, item.directory)}>Open thread</A></div>}</For></details></Show>
    </section>
    <section aria-label="Pinned agents"><div class="home-section"><h2>Pinned agents <span>{dashboard.pinnedSessions().length + cloudCount()}</span></h2></div><For each={dashboard.pinnedSessions()} fallback={<p class="home-muted">No pinned agents.</p>}>{session => <PinnedAgent session={session} />}</For><HomeCloudAgents project={project()} onCount={setCloudCount} onActivity={setCloudActivity} /><details class="home-workers"><summary>Other sessions ({dashboard.unpinnedSessions().length})</summary><For each={dashboard.unpinnedSessions()}>{session => <div class="home-other"><A href={sessionHref(session.id, session.directory)}><bdi dir="auto">{session.title || session.id}</bdi></A><button onClick={() => dashboard.togglePin(session)}>Pin</button></div>}</For></details></section>
    <HomeActivity cloud={cloudActivity()} />
  </main>
}
