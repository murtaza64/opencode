import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js"
import { A } from "@solidjs/router"
import { ago, sessionHref, useDashboard, type SessionRow } from "../state"
import { AppHeader } from "../components/native-header"
import { CurrentWorkView, type CurrentWorkSnapshot } from "../current-work"
import { ActivityBriefView } from "../components/activity-brief"
import type { ActivityBriefInput } from "../activity-brief"
import { answerDraftKey, attentionPath, blockedReason, createAttention, decisionLabel, deliveryLabel, type AttentionRecord } from "../attention"
import { createHomeRequests, requestKey, type HomeRequest } from "../home-requests"
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
    <div><ActivityBriefView input={brief()} /><TodoLine session={props.session} turn={turnOf(work())} /><details><summary>Turn telemetry</summary><div class="home-source">Read-only turn telemetry · generated summary cache</div><CurrentWorkView id={props.session.id} directory={props.session.directory} compact onSnapshot={setWork} /></details></div>
  </div>
}

export default function Home() {
  const dashboard = useDashboard()
  const project = () => dashboard.allProjects() ? undefined : dashboard.editspace() ?? dashboard.editspaces()?.default ?? undefined
  const attention = createAttention(project)
  const [view, setView] = createSignal("open")
  const [confirm, setConfirm] = createSignal<{ record: AttentionRecord; choice: string }>()
  const [cloudCount, setCloudCount] = createSignal(0)
  const [cloudActivity, setCloudActivity] = createSignal<HomeActivityRow[]>([])
  const [history, setHistory] = createSignal<Record<string, { version: string; events?: unknown[]; error?: string }>>({})
  const sourcePointers = createMemo<HomeRequest[]>(() => {
    const projectFor = (directory: string) => dashboard.editspaces()?.editspaces.find(item => {
      const root = item.root.replace(/\/+$/, "").replace(/\/\.editspace$/, "")
      return directory === root || directory.startsWith(`${root}/`)
    })?.name
    const direct = dashboard.activity.requests().map(item => ({ kind: item.kind, id: item.request.id, session: item.request.sessionID, directory: item.directory, project: projectFor(item.directory), title: dashboard.activity.session(item.request.sessionID)?.title ?? item.request.sessionID }))
    const hints = dashboard.notifications().filter(item => item.kind !== "idle").map(item => ({ ...item, project: item.editspace || projectFor(item.directory), kind: item.kind as "permission" | "question", id: item.id.startsWith(`${item.kind}:`) ? item.id.slice(item.kind.length + 1) : item.id }))
    return [...new Map([...hints, ...direct].map(item => [requestKey(item), item])).values()]
  })
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
  const optionLabel = (record: AttentionRecord, id?: string | null) => record.options.find(option => option.id === id)?.label
  const canWrite = (record: AttentionRecord) => attention.operator() && !attention.stale() && !attention.pending() && !attention.writing() && attention.snapshot()?.value.projects.find(item => item.editspace === record.editspace)?.available !== false
  // Delivery events append history without a revision bump, so include delivery evidence in the cache key.
  const historyVersion = (record: AttentionRecord) => `${record.revision}:${record.delivery_state}:${record.delivery?.updated_at ?? ""}`
  const historyLoads = new Set<string>()
  const loadHistory = async (record: AttentionRecord) => {
    const key = `${record.editspace}:${record.id}:${historyVersion(record)}`
    if (historyLoads.has(key)) return
    historyLoads.add(key)
    try {
      const response = await fetch(attentionPath(`/${encodeURIComponent(record.id)}`, record.editspace), { credentials: "include" })
      if (!response.ok) throw Error("History unavailable")
      const result = await response.json()
      setHistory(previous => ({ ...previous, [record.id]: { version: historyVersion(record), events: result.events } }))
    } catch { setHistory(previous => ({ ...previous, [record.id]: { version: historyVersion(record), error: "History unavailable. The record has not changed." } })) }
    finally { historyLoads.delete(key) }
  }
  // Every unanswered decision accepts a written answer; an option is optional context for it.
  const Answer = (props: { record: AttentionRecord; choice?: () => string }) => {
    const [text, setText] = createSignal(localStorage.getItem(answerDraftKey(props.record)) ?? "")
    const send = async () => {
      if (!text().trim() || !canWrite(props.record)) return
      const selected = props.choice?.()
      const choice = props.record.options.some(option => option.id === selected) ? selected : undefined
      // The draft is cleared only after the ledger confirms; failures keep it for an exact retry.
      if (await attention.act(props.record, { action: "answer", text: text(), ...(choice ? { choice_id: choice } : {}) })) setView("answered")
    }
    const id = `answer-${props.record.id}`
    const target = () => props.record.lane ? <>the agent that currently owns lane <bdi dir="auto">{props.record.lane}</bdi> through verified handoffs</> : <>the requesting session <bdi dir="ltr">{props.record.source_ref.session_id}</bdi></>
    return <div class="home-answer">
      <label for={id}>Your answer</label>
      <textarea id={id} dir="auto" rows={3} maxLength={8000} value={text()} disabled={!canWrite(props.record)} placeholder="Write what you want the agent to do"
        aria-describedby={`${id}-meaning`}
        onInput={event => { setText(event.currentTarget.value); localStorage.setItem(answerDraftKey(props.record), event.currentTarget.value) }}
        onKeyDown={event => { if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !event.isComposing && event.keyCode !== 229) { event.preventDefault(); void send() } }} />
      <p id={`${id}-meaning`} class="home-muted">Sends this text{props.choice && props.record.options.length ? " and any selected option" : ""} as mail to {target()}. Saved first; unverified ownership stays blocked here and nothing is sent. Grants no tool permission.</p>
      <div class="home-actions"><button class="home-primary" disabled={!canWrite(props.record) || !text().trim()} onClick={() => void send()}>Send answer</button><span class="home-muted">Ctrl/⌘+Enter</span></div>
    </div>
  }
  const Delivery = (props: { record: AttentionRecord }) => {
    const delivery = () => props.record.delivery
    // Link the delivered session only with its own verified directory; the source link stays separate.
    const target = () => delivery()?.session && delivery()?.session_directory ? { session: delivery()!.session!, directory: delivery()!.session_directory! } : undefined
    return <div class="home-delivery" data-delivery-state={props.record.delivery_state}>
      <p class="home-recorded">Your answer<Show when={optionLabel(props.record, props.record.answer?.choice_id)}>{label => <> · option <bdi dir="auto">{label()}</bdi></>}</Show></p>
      <pre class="home-answer-text" dir="auto">{props.record.answer?.text}</pre>
      <p class={props.record.delivery_state === "blocked" ? "home-blocked" : "home-muted"} role="status">{deliveryLabel(props.record)}<Show when={props.record.delivery_state === "blocked" && delivery()?.reason}> — {blockedReason(delivery()?.reason)}</Show></p>
      <Show when={delivery()?.error && !["presented", "handled"].includes(props.record.delivery_state)}><p class="home-muted">Last attempt: <bdi dir="auto">{delivery()?.error}</bdi> · retried automatically with the same request identity</p></Show>
      <Show when={delivery()?.copies?.length}><ul class="home-copies"><For each={delivery()?.copies}>{copy => <li><bdi dir="ltr">{copy.session}</bdi> · {copy.state}{copy.presented_at ? ` · presented ${new Date(copy.presented_at).toLocaleString()}` : ""}{copy.handled_at ? ` · acknowledged ${new Date(copy.handled_at).toLocaleString()}` : ""}</li>}</For></ul></Show>
      <div class="home-actions"><Show when={target()} fallback={<span class="home-muted">Delivered session not yet verified</span>}>{item => <A href={sessionHref(item().session, item().directory)}>Open delivered agent thread</A>}</Show><Show when={["pending", "blocked", "queued"].includes(props.record.delivery_state)}><button disabled={!canWrite(props.record)} onClick={() => attention.retryDelivery(props.record)}>Retry delivery</button></Show><button disabled={!canWrite(props.record)} onClick={() => attention.act(props.record, { action: "resolve", reason: "Human marked resolved" })}>Mark resolved</button></div>
    </div>
  }
  const Decision = (props: { record: AttentionRecord }) => {
    const [choice, setChoice] = createSignal("")
    const [historyOpen, setHistoryOpen] = createSignal(false)
    createEffect(() => { if (historyOpen() && history()[props.record.id]?.version !== historyVersion(props.record)) void loadHistory(props.record) })
    return <article class="home-decision" data-attention-id={props.record.id}>
      <div class="home-eyebrow"><span>{props.record.kind}</span><bdi dir="auto">{props.record.editspace}</bdi><time dateTime={new Date(props.record.created_at).toISOString()}>{ago(props.record.created_at)}</time><span>revision {props.record.revision}</span></div>
      <h3><bdi dir="auto">{props.record.title}</bdi></h3><p dir="auto">{props.record.context}</p>
      <div class="home-source">Explicit agent request · <A href={sessionHref(props.record.source_ref.session_id, props.record.source_ref.directory)}>Open source thread</A></div>
      <Show when={props.record.status === "open"}>
        <Show when={props.record.recommendation}><p class="home-muted">Agent recommends: <bdi dir="auto">{props.record.options.find(option => option.id === props.record.recommendation)?.label ?? props.record.recommendation}</bdi></p></Show>
        <Show when={props.record.options.length}><fieldset disabled={!canWrite(props.record)}><legend>Your choice</legend><For each={props.record.options}>{option => <label><input type="radio" name={props.record.id} checked={choice() === option.id} onChange={() => setChoice(option.id)} /><bdi dir="auto">{option.label}</bdi></label>}</For></fieldset></Show>
        <Answer record={props.record} choice={choice} />
        <div class="home-actions"><Show when={props.record.options.length}><button disabled={!canWrite(props.record) || !props.record.options.some(option => option.id === choice())} onClick={() => setConfirm({ record: props.record, choice: choice() })}>Review choice</button><span class="home-muted">record only · not sent</span></Show><button disabled={!canWrite(props.record)} onClick={() => attention.act(props.record, { action: "snooze", snoozed_until: Date.now() + 3600_000 })}>Snooze 1h</button><button disabled={!canWrite(props.record)} onClick={() => attention.act(props.record, { action: "resolve", reason: "Human marked no longer needed" })}>No longer needed</button></div>
      </Show>
      <Show when={props.record.status === "decided"}><p class="home-recorded">Saved: <bdi dir="auto">{decisionLabel(props.record)}</bdi> · not sent</p><p class="home-muted">No agent was resumed. This is not tool permission or approval to publish.</p>{/* The earlier record-only choice stays history; a written reply here carries text only. */}<Answer record={props.record} /><div class="home-actions"><A href={sessionHref(props.record.source_ref.session_id, props.record.source_ref.directory)}>Open agent thread</A><button disabled={!canWrite(props.record)} onClick={() => attention.act(props.record, { action: "resolve", reason: "Human marked resolved" })}>Mark resolved</button></div></Show>
      <Show when={props.record.status === "answered"}><Delivery record={props.record} /></Show>
      <Show when={props.record.status === "snoozed"}><p class="home-muted">Snoozed until {props.record.snoozed_until ? new Date(props.record.snoozed_until).toLocaleString() : "unknown"}</p><button disabled={!canWrite(props.record)} onClick={() => attention.act(props.record, { action: "wake" })}>Return to Needs you</button></Show>
      <Show when={["resolved", "withdrawn"].includes(props.record.status)}><p class="home-muted">{props.record.status} · retained in history</p><Show when={props.record.answer}><pre class="home-answer-text" dir="auto">{props.record.answer?.text}</pre><p class="home-muted">{deliveryLabel(props.record)}</p></Show></Show>
      <details onToggle={event => setHistoryOpen(event.currentTarget.open)}><summary>Record &amp; history</summary><div class="home-source"><bdi dir="ltr">{props.record.id} · {props.record.gate_key}</bdi></div><Show when={history()[props.record.id]?.version === historyVersion(props.record) ? history()[props.record.id] : undefined} fallback={<p>Loading history…</p>}>{item => <Show when={!item().error} fallback={<p>{item().error}</p>}><pre dir="ltr">{JSON.stringify(item().events, null, 2)}</pre></Show>}</Show></details>
    </article>
  }
  return <main class="attention-home">
    <AppHeader><h1>Home</h1><span class="home-muted">{project() ?? "All projects"}</span><A class="home-map-link" href="/map">Agent map</A><span class="home-header-end home-muted">{attention.snapshot() ? `Ledger checked ${Math.max(0, Math.floor((attention.now() - attention.snapshot()!.checked) / 1000))}s ago${attention.stale() ? " · stale" : ""}` : "Ledger not checked"}</span><button disabled={attention.loading()} onClick={() => { void attention.refresh(); void requests.refresh(); dashboard.activity.todos.reload(); void attention.checkOperator().catch(() => undefined) }}>Refresh</button></AppHeader>
    <Show when={attention.error()}><div class="home-warning" role="alert">{attention.error()} Last-known records are retained; actions are disabled.</div></Show>
    <Show when={attention.snapshot()?.value.partial}><div class="home-warning">Some projects are unavailable. This is not an empty inbox.<For each={attention.snapshot()?.value.projects.filter(item => !item.available)}>{item => <div><bdi dir="auto">{item.editspace}</bdi>: {item.error || "unavailable"}</div>}</For></div></Show>
    <Show when={attention.snapshot()?.value.truncated}><div class="home-warning">History exceeds this view's limit. Counts may be incomplete; use the attention CLI to inspect further records.</div></Show>
    <Show when={dashboard.sessionsError()}><div class="home-warning">Live request sources may be incomplete. {dashboard.sessionsError()}</div></Show>
    <Show when={dashboard.stateError()}><div class="home-warning">{dashboard.stateError()} Cached source values are not a live status.</div></Show>
    <Show when={attention.notice()}><div class="home-notice" role="status">{attention.notice()}<Show when={attention.pending()}><button disabled={attention.writing()} onClick={async () => { const action = attention.pending()?.body.action; if (await attention.retry() && action === "answer") setView("answered") }}>Retry same action</button></Show></div></Show>
    <section aria-label="Needs you"><div class="home-section"><h2>Needs you <span>{count("open")}</span></h2><span class="home-muted">Decisions, not completion receipts</span></div>
      <Show when={!attention.operator()}><div class="home-login home-muted">Read-only · operator connection unavailable. This UI origin must be allowed by the attention server. <button onClick={() => attention.checkOperator().catch(() => undefined)}>Reconnect operator</button></div></Show>
      <div class="home-tabs" role="group" aria-label="Attention status"><For each={[["open", "Open"], ["answered", "Answered"], ["recorded", "Recorded / not sent"], ["snoozed", "Snoozed"], ["history", "History"]]}>{([tab, label]) => <button aria-pressed={view() === tab} onClick={() => setView(tab)}>{label} <span>{count(tab)}</span></button>}</For></div>
      <Show when={view() === "open" && receipts().length}><ul class="home-receipts" aria-label="Replies from Home"><For each={receipts()}>{item => <li data-result={item.result}><b>{receiptText(item)}</b> · <bdi dir="ltr">{item.permission}</bdi> · <bdi dir="auto">{item.title}</bdi> · {ago(item.at)}{item.result === "uncertain" ? " · the server did not confirm; check the thread" : item.result === "not-applied" ? " · request was no longer pending" : ""} · <A href={sessionHref(item.session, item.directory)}>Open thread</A></li>}</For></ul></Show>
      {/* Key request cards by exact identity so source rechecks keep each card's in-flight and outcome state. */}
      <Show when={view() === "open"}><For each={pendingRequests().map(requestKey)}>{key => <Show when={pendingByKey().get(key)}>{row => row().kind === "permission" ? <HomePermission item={row()} live={dashboard.activity.requestState("permission", row().session, row().directory, row().id)} siblings={siblings(row())} owner={subagentOwner(row())} stale={requests.now() - row().checked > 45_000} onReceipt={receipt => setReceipts(previous => [receipt, ...previous.filter(old => old.key !== receipt.key || old.at !== receipt.at)].slice(0, 5))} onRecheck={directory => Promise.all([requests.refresh(), dashboard.activity.refreshDirectory(directory, true)]).then(() => undefined)} /> : <div class="home-request"><div><span class="home-eyebrow">{row().kind} · source request</span><h3><bdi dir="auto">{row().title}</bdi></h3><div class="home-source">Exact request <bdi dir="ltr">{row().id}</bdi> · source checked {ago(row().checked)}{requests.now() - row().checked > 45_000 ? " · stale" : ""}</div></div><A href={sessionHref(row().session, row().directory)}>Open request</A><p class="home-muted">Reply using the original session controls.</p></div> }</Show>}</For></Show>
      {/* Key cards by project+record so polls update props in place and keep textarea focus, caret and draft. */}
      <For each={visible().map(recordKey)}>{key => <Show when={byKey().get(key)}>{record => <Decision record={record()} />}</Show>}</For>
      <Show when={!visible().length && (view() !== "open" || !pendingRequests().length)}><div class="home-empty">{attention.loading() && !attention.snapshot() ? "Checking attention ledger…" : attention.stale() || attention.snapshot()?.value.partial ? "Attention is not fully checked. Do not assume nothing is waiting." : view() === "open" ? "Nothing needs a choice." : "No records in this view."}</div></Show>
      <Show when={uncertainRequests().length}><details class="home-unknown"><summary>Source requests with unknown outcome ({uncertainRequests().length})</summary><For each={uncertainRequests()}>{item => <div class="home-source"><bdi dir="auto">{item.title}</bdi> · {item.kind} · {item.state === "unavailable" ? "source unavailable" : "no longer pending; outcome unknown"} · <A href={sessionHref(item.session, item.directory)}>Open original thread</A></div>}</For></details></Show>
    </section>
    <section aria-label="Pinned agents"><div class="home-section"><h2>Pinned agents <span>{dashboard.pinnedSessions().length + cloudCount()}</span></h2><span class="home-muted">Only agents you pin</span><A href="/map">Open agent map</A></div><For each={dashboard.pinnedSessions()} fallback={<p class="home-muted">Pin an agent from session navigation to keep it here.</p>}>{session => <PinnedAgent session={session} />}</For><HomeCloudAgents project={project()} onCount={setCloudCount} onActivity={setCloudActivity} /><details class="home-workers"><summary>Other sessions ({dashboard.unpinnedSessions().length})</summary><For each={dashboard.unpinnedSessions()}>{session => <div class="home-other"><A href={sessionHref(session.id, session.directory)}><bdi dir="auto">{session.title || session.id}</bdi></A><button onClick={() => dashboard.togglePin(session)}>Pin</button></div>}</For></details></section>
    <HomeActivity cloud={cloudActivity()} />
    <Show when={confirm()}>{draft => <dialog class="home-confirm" ref={element => queueMicrotask(() => element.showModal())} onCancel={() => setConfirm(undefined)} aria-labelledby="home-choice-title"><h2 id="home-choice-title">Record this choice?</h2><p><bdi dir="auto">{draft().record.options.find(option => option.id === draft().choice)?.label}</bdi></p><p>Save only. No prompt is sent, no agent is resumed, and no tool permission is granted.</p><div class="home-actions"><button class="home-primary" disabled={!canWrite(draft().record)} onClick={async () => { const selected = draft(); setConfirm(undefined); if (await attention.act(selected.record, { action: "choose", choice_id: selected.choice })) setView("recorded") }}>Record choice only</button><button onClick={() => setConfirm(undefined)}>Cancel</button></div></dialog>}</Show>
  </main>
}
