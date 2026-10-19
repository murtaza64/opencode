import { createMemo, createSignal, For, Show } from "solid-js"
import { A } from "@solidjs/router"
import { ago, sessionHref, useDashboard, type SessionRow } from "../state"
import { AppHeader } from "../components/native-header"
import { CurrentWorkView } from "../current-work"
import { attentionPath, createAttention, decisionLabel, type AttentionRecord } from "../attention"
import { createHomeRequests, requestKey, type HomeRequest } from "../home-requests"
import HomeActivity from "../home-activity"
import "./home.css"

const PinnedAgent = (props: { session: SessionRow }) => {
  const dashboard = useDashboard()
  return <div class="home-agent">
    <div><A class="home-name" href={sessionHref(props.session.id, props.session.directory)}><bdi dir="auto">{props.session.title || props.session.id}</bdi></A><div class="home-muted"><bdi dir="auto">{props.session.project || dashboard.editspace() || "project"}</bdi></div><button onClick={() => dashboard.togglePin(props.session)}>Unpin</button></div>
    <div><div class="home-source">Read-only turn telemetry · generated summary cache</div><CurrentWorkView id={props.session.id} directory={props.session.directory} compact /></div>
  </div>
}

export default function Home() {
  const dashboard = useDashboard()
  const project = () => dashboard.allProjects() ? undefined : dashboard.editspace() ?? dashboard.editspaces()?.default ?? undefined
  const attention = createAttention(project)
  const [view, setView] = createSignal("open")
  const [confirm, setConfirm] = createSignal<{ record: AttentionRecord; choice: string }>()
  const [history, setHistory] = createSignal<Record<string, { events?: unknown[]; error?: string }>>({})
  const sourcePointers = createMemo<HomeRequest[]>(() => {
    const projectFor = (directory: string) => dashboard.editspaces()?.editspaces.find(item => {
      const root = item.root.replace(/\/+$/, "").replace(/\/\.editspace$/, "")
      return directory === root || directory.startsWith(`${root}/`)
    })?.name
    const direct = dashboard.activity.requests().map(item => ({ kind: item.kind, id: item.request.id, session: item.request.sessionID, directory: item.directory, project: projectFor(item.directory), title: dashboard.activity.session(item.request.sessionID)?.title ?? item.request.sessionID }))
    const hints = dashboard.notifications().filter(item => item.kind !== "idle").map(item => ({ ...item, project: item.editspace || projectFor(item.directory), kind: item.kind as "permission" | "question", id: item.id.startsWith(`${item.kind}:`) ? item.id.slice(item.kind.length + 1) : item.id }))
    return [...new Map([...hints, ...direct].map(item => [requestKey(item), item])).values()]
  })
  const requests = createHomeRequests(sourcePointers)
  const requestRows = () => requests.rows().filter(item => !project() || !item.project || item.project === project())
  const pendingRequests = () => requestRows().filter(item => item.state === "pending")
  const uncertainRequests = () => requestRows().filter(item => item.state !== "pending")
  const records = () => attention.snapshot()?.value.records ?? []
  const visible = () => records().filter(record => view() === "history" ? ["resolved", "withdrawn"].includes(record.status) : view() === "recorded" ? record.status === "decided" : record.status === view())
  const count = (tab: string) => records().filter(record => tab === "history" ? ["resolved", "withdrawn"].includes(record.status) : record.status === (tab === "recorded" ? "decided" : tab)).length + (tab === "open" ? pendingRequests().length : 0)
  const canWrite = (record: AttentionRecord) => attention.operator() && !attention.stale() && !attention.pending() && !attention.writing() && attention.snapshot()?.value.projects.find(item => item.editspace === record.editspace)?.available !== false
  const loadHistory = async (record: AttentionRecord) => {
    try {
      const response = await fetch(attentionPath(`/${encodeURIComponent(record.id)}`, record.editspace), { credentials: "include" })
      if (!response.ok) throw Error("History unavailable")
      const result = await response.json()
      setHistory(previous => ({ ...previous, [record.id]: { events: result.events } }))
    } catch { setHistory(previous => ({ ...previous, [record.id]: { error: "History unavailable. The record has not changed." } })) }
  }
  const Decision = (props: { record: AttentionRecord }) => {
    const [choice, setChoice] = createSignal("")
    return <article class="home-decision" data-attention-id={props.record.id}>
      <div class="home-eyebrow"><span>{props.record.kind}</span><bdi dir="auto">{props.record.editspace}</bdi><time dateTime={new Date(props.record.created_at).toISOString()}>{ago(props.record.created_at)}</time><span>revision {props.record.revision}</span></div>
      <h3><bdi dir="auto">{props.record.title}</bdi></h3><p dir="auto">{props.record.context}</p>
      <div class="home-source">Explicit agent request · <A href={sessionHref(props.record.source_ref.session_id, props.record.source_ref.directory)}>Open source thread</A></div>
      <Show when={props.record.status === "open"}>
        <Show when={props.record.recommendation}><p class="home-muted">Agent recommends: <bdi dir="auto">{props.record.options.find(option => option.id === props.record.recommendation)?.label ?? props.record.recommendation}</bdi></p></Show>
        <fieldset disabled={!canWrite(props.record)}><legend>Your choice</legend><For each={props.record.options}>{option => <label><input type="radio" name={props.record.id} checked={choice() === option.id} onChange={() => setChoice(option.id)} /><bdi dir="auto">{option.label}</bdi></label>}</For></fieldset>
        <div class="home-actions"><button class="home-primary" disabled={!canWrite(props.record) || !props.record.options.some(option => option.id === choice())} onClick={() => setConfirm({ record: props.record, choice: choice() })}>Review choice</button><button disabled={!canWrite(props.record)} onClick={() => attention.act(props.record, { action: "snooze", snoozed_until: Date.now() + 3600_000 })}>Snooze 1h</button><button disabled={!canWrite(props.record)} onClick={() => attention.act(props.record, { action: "resolve", reason: "Human marked no longer needed" })}>No longer needed</button></div>
      </Show>
      <Show when={props.record.status === "decided"}><p class="home-recorded">Saved: <bdi dir="auto">{decisionLabel(props.record)}</bdi> · not sent</p><p class="home-muted">No agent was resumed. This is not tool permission or approval to publish.</p><div class="home-actions"><A href={sessionHref(props.record.source_ref.session_id, props.record.source_ref.directory)}>Open agent thread</A><button disabled={!canWrite(props.record)} onClick={() => attention.act(props.record, { action: "resolve", reason: "Human marked resolved" })}>Mark resolved</button></div></Show>
      <Show when={props.record.status === "snoozed"}><p class="home-muted">Snoozed until {props.record.snoozed_until ? new Date(props.record.snoozed_until).toLocaleString() : "unknown"}</p><button disabled={!canWrite(props.record)} onClick={() => attention.act(props.record, { action: "wake" })}>Return to Needs you</button></Show>
      <Show when={["resolved", "withdrawn"].includes(props.record.status)}><p class="home-muted">{props.record.status} · retained in history</p></Show>
      <details onToggle={event => { if (event.currentTarget.open && !history()[props.record.id]) void loadHistory(props.record) }}><summary>Record &amp; history</summary><div class="home-source"><bdi dir="ltr">{props.record.id} · {props.record.gate_key}</bdi></div><Show when={history()[props.record.id]} fallback={<p>Loading history…</p>}>{item => <Show when={!item().error} fallback={<p>{item().error}</p>}><pre dir="ltr">{JSON.stringify(item().events, null, 2)}</pre></Show>}</Show></details>
    </article>
  }
  return <main class="attention-home">
    <AppHeader><h1>Home</h1><span class="home-muted">{project() ?? "All projects"}</span><span class="home-header-end home-muted">{attention.snapshot() ? `Ledger checked ${Math.max(0, Math.floor((attention.now() - attention.snapshot()!.checked) / 1000))}s ago${attention.stale() ? " · stale" : ""}` : "Ledger not checked"}</span><button disabled={attention.loading()} onClick={() => { void attention.refresh(); void requests.refresh(); void attention.checkOperator().catch(() => undefined) }}>Refresh</button></AppHeader>
    <Show when={attention.error()}><div class="home-warning" role="alert">{attention.error()} Last-known records are retained; actions are disabled.</div></Show>
    <Show when={attention.snapshot()?.value.partial}><div class="home-warning">Some projects are unavailable. This is not an empty inbox.<For each={attention.snapshot()?.value.projects.filter(item => !item.available)}>{item => <div><bdi dir="auto">{item.editspace}</bdi>: {item.error || "unavailable"}</div>}</For></div></Show>
    <Show when={attention.snapshot()?.value.truncated}><div class="home-warning">History exceeds this view's limit. Counts may be incomplete; use the attention CLI to inspect further records.</div></Show>
    <Show when={dashboard.sessionsError()}><div class="home-warning">Live request sources may be incomplete. {dashboard.sessionsError()}</div></Show>
    <Show when={attention.notice()}><div class="home-notice" role="status">{attention.notice()}<Show when={attention.pending()}><button disabled={attention.writing()} onClick={() => attention.retry()}>Retry same action</button></Show></div></Show>
    <section aria-label="Needs you"><div class="home-section"><h2>Needs you <span>{count("open")}</span></h2><span class="home-muted">Decisions, not completion receipts</span></div>
      <Show when={!attention.operator()}><div class="home-login home-muted">Read-only · operator connection unavailable. This UI origin must be allowed by the attention server. <button onClick={() => attention.checkOperator().catch(() => undefined)}>Reconnect operator</button></div></Show>
      <div class="home-tabs" role="group" aria-label="Attention status"><For each={[["open", "Open"], ["recorded", "Recorded / not sent"], ["snoozed", "Snoozed"], ["history", "History"]]}>{([tab, label]) => <button aria-pressed={view() === tab} onClick={() => setView(tab)}>{label} <span>{count(tab)}</span></button>}</For></div>
      <Show when={view() === "open"}><For each={pendingRequests()}>{item => <div class="home-request"><div><span class="home-eyebrow">{item.kind} · source request</span><h3><bdi dir="auto">{item.title}</bdi></h3><div class="home-source">Exact request <bdi dir="ltr">{item.id}</bdi> · source checked {ago(item.checked)}{requests.now() - item.checked > 45_000 ? " · stale" : ""}</div></div><A href={sessionHref(item.session, item.directory)}>Open request</A><p class="home-muted">Reply using the original session controls. No permission is granted here.</p></div>}</For></Show>
      <For each={visible()}>{record => <Decision record={record} />}</For>
      <Show when={!visible().length && (view() !== "open" || !pendingRequests().length)}><div class="home-empty">{attention.loading() && !attention.snapshot() ? "Checking attention ledger…" : attention.stale() || attention.snapshot()?.value.partial ? "Attention is not fully checked. Do not assume nothing is waiting." : view() === "open" ? "Nothing needs a choice." : "No records in this view."}</div></Show>
      <Show when={uncertainRequests().length}><details class="home-unknown"><summary>Source requests with unknown outcome ({uncertainRequests().length})</summary><For each={uncertainRequests()}>{item => <div class="home-source"><bdi dir="auto">{item.title}</bdi> · {item.kind} · {item.state === "unavailable" ? "source unavailable" : "no longer pending; outcome unknown"} · <A href={sessionHref(item.session, item.directory)}>Open original thread</A></div>}</For></details></Show>
    </section>
    <section aria-label="Pinned agents"><div class="home-section"><h2>Pinned agents <span>{dashboard.pinnedSessions().length}</span></h2><span class="home-muted">Only agents you pin</span></div><For each={dashboard.pinnedSessions()} fallback={<p class="home-muted">Pin an agent from session navigation to keep it here.</p>}>{session => <PinnedAgent session={session} />}</For><details class="home-workers"><summary>Other sessions ({dashboard.unpinnedSessions().length})</summary><For each={dashboard.unpinnedSessions()}>{session => <div class="home-other"><A href={sessionHref(session.id, session.directory)}><bdi dir="auto">{session.title || session.id}</bdi></A><button onClick={() => dashboard.togglePin(session)}>Pin</button></div>}</For></details></section>
    <HomeActivity />
    <Show when={confirm()}>{draft => <dialog class="home-confirm" ref={element => queueMicrotask(() => element.showModal())} onCancel={() => setConfirm(undefined)} aria-labelledby="home-choice-title"><h2 id="home-choice-title">Record this choice?</h2><p><bdi dir="auto">{draft().record.options.find(option => option.id === draft().choice)?.label}</bdi></p><p>Save only. No prompt is sent, no agent is resumed, and no tool permission is granted.</p><div class="home-actions"><button class="home-primary" disabled={!canWrite(draft().record)} onClick={async () => { const selected = draft(); setConfirm(undefined); if (await attention.act(selected.record, { action: "choose", choice_id: selected.choice })) setView("recorded") }}>Record choice only</button><button onClick={() => setConfirm(undefined)}>Cancel</button></div></dialog>}</Show>
  </main>
}
