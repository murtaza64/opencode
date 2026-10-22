/* Front desk: one conversation across connected projects, a read-only queue of
 * existing requests, and an evidence canvas only while an item is selected.
 * The chat is the ordinary session view; selection changes never remount it. */
import { createEffect, createMemo, createSignal, For, on, onCleanup, Show } from "solid-js"
import { A } from "@solidjs/router"
import { ago, sessionHref, useDashboard } from "../state"
import { AppHeader } from "../components/native-header"
import { createAttention } from "../attention"
import { createHomeRequests, requestPointers } from "../home-requests"
import { AttentionDecision } from "../components/attention-decision"
import { HomePermission, type HomeReplyReceipt } from "../components/home-permission"
import { FailureRetry } from "../components/session-failure"
import { briefBinding, deskItems, deskSources, type BriefResult, type DeskItem, type EvidenceRef } from "../desk"
import { createBriefs, createDeskSession, type BriefJob } from "../desk-session"
import { SessionView } from "./session"
import "./home.css"
import "./desk.css"

const stateLabel = (job: BriefJob) => ({ starting: "starting", unconfirmed: "start unconfirmed", running: "checking", ready: "ready", failed: "failed", unknown: "outcome unknown" })[job.state.state]

export default function Desk() {
  const dashboard = useDashboard()
  const project = () => dashboard.allProjects() ? undefined : dashboard.editspace() ?? dashboard.editspaces()?.default ?? undefined
  const attention = createAttention(project)
  const requests = createHomeRequests(createMemo(() => requestPointers(dashboard)), item => dashboard.activity.requestSettled(item.kind, item.directory, item.id))
  const desk = createDeskSession()
  // Defined below; read lazily when a brief starts.
  const briefs = createBriefs(() => desk.status() === "ready" ? desk.pointer() : undefined, key => items().find(item => item.key === key))
  const [selectedKey, setSelectedKey] = createSignal<string>()
  const [receipts, setReceipts] = createSignal<HomeReplyReceipt[]>([])
  const [now, setNow] = createSignal(Date.now())
  const clock = setInterval(() => setNow(Date.now()), 5000)
  onCleanup(() => clearInterval(clock))

  const projectFor = (directory: string) => dashboard.editspaces()?.editspaces.find(item => {
    const root = item.root.replace(/\/+$/, "").replace(/\/\.editspace$/, "")
    return directory === root || directory.startsWith(`${root}/`)
  })?.name
  const briefSessions = createMemo(() => new Set(briefs.jobs().map(job => job.id).filter(Boolean)))
  const items = createMemo(() => deskItems({
    records: attention.snapshot()?.value.records ?? [],
    attentionChecked: attention.snapshot()?.checked ?? 0,
    requests: requests.rows().filter(item => !project() || !item.project || item.project === project()),
    // The desk's own brief passes are not work waiting on the human.
    failures: dashboard.scopedFailures().filter(failure => !briefSessions().has(failure.sessionID)),
    failuresChecked: dashboard.failures.checked() ?? 0,
    title: id => dashboard.activity.session(id)?.title,
    project: projectFor,
  }))
  const sources = createMemo(() => deskSources({
    now: now(),
    attention: {
      checked: attention.snapshot()?.checked,
      error: attention.error(),
      unavailable: attention.snapshot()?.value.projects.filter(item => !item.available) ?? [],
      truncated: !!attention.snapshot()?.value.truncated,
      operator: attention.operator(),
    },
    requests: { rows: requests.rows(), error: dashboard.sessionsError() },
    failures: { supported: dashboard.failures.supported(), error: dashboard.failures.error(), checked: dashboard.failures.checked() },
    dashboard: { stateError: dashboard.stateError() },
  }))
  // Keep the last-seen item so an answered request does not vanish from under the reader.
  const lastSeen = new Map<string, DeskItem>()
  const selected = createMemo(() => {
    const key = selectedKey()
    if (!key) return
    const live = items().find(item => item.key === key)
    if (live) lastSeen.set(key, live)
    return { item: live ?? lastSeen.get(key)!, live: !!live }
  })
  const select = (key?: string) => setSelectedKey(key)
  const deskDirectory = () => {
    const name = dashboard.editspace() ?? dashboard.editspaces()?.default
    return dashboard.editspaces()?.editspaces.find(item => item.name === name)?.root
  }
  // Shared session events end an active brief sooner than its poll would.
  createEffect(on(() => briefs.jobs().filter(job => job.state.state === "running").map(job => `${job.id}:${dashboard.activity.status(job.id) ?? ""}`).join(","),
    (now, before) => { if (before !== undefined && now !== before) void briefs.refresh() }))
  const jobsFor = (key: string) => briefs.jobs().filter(job => job.meta.source === key)
  const context = () => desk.context({
    now: Date.now(),
    scope: project(),
    sources: sources(),
    items: items(),
    selected: selected()?.live ? selected()!.item : undefined,
    briefs: briefs.jobs().filter(job => briefBinding(job.meta, items()).current)
      .flatMap(job => job.state.state === "starting" || job.state.state === "unconfirmed" ? [] : [{ meta: job.meta, state: job.state }]),
  })

  return <main class="desk" classList={{ "desk-has-selection": !!selected() }}>
    <AppHeader><h1>Front desk</h1><span class="home-muted">{project() ?? "All connected projects"}</span><A href="/">Home</A>
      <span class="home-header-end" /><button class="desk-button" disabled={attention.loading()} onClick={() => { void attention.refresh(); void requests.refresh(); void dashboard.failures.refresh(); void briefs.refresh(true) }}>Refresh sources</button></AppHeader>
    <div class="desk-grid">
      <aside class="desk-queue" aria-label="Desk queue">
        <button class="desk-chat-tab" aria-pressed={!selected()} onClick={() => select()}>Front desk chat</button>
        <h2>Needs you <span>{items().length}</span></h2>
        <ul class="desk-items">
          <For each={items()} fallback={<li class="home-muted desk-empty">{sources().some(source => source.state !== "current") ? "Nothing listed, but some sources are not current. Do not assume nothing is waiting." : "Nothing is waiting in connected sources."}</li>}>{item => {
            const job = () => jobsFor(item.key).find(candidate => candidate.meta.revision === item.revision)
            return <li><button class="desk-item" aria-pressed={selectedKey() === item.key} data-desk-item={item.key} onClick={() => select(item.key)}>
              <span class="desk-item-kind" data-kind={item.kind}>{item.kind}</span>
              <bdi dir="auto" class="desk-item-title">{item.title}</bdi>
              <span class="home-source"><bdi dir="auto">{item.project ?? "unknown project"}</bdi> · checked {ago(item.checked) || "never"}<Show when={job()}>{current => <> · brief {stateLabel(current())}</>}</Show></span>
            </button></li>
          }}</For>
        </ul>
        <section class="desk-sources" aria-label="Connected sources">
          <h2>Sources</h2>
          <For each={sources()}>{source => <div class="desk-source" data-state={source.state}>
            <span>{source.name}</span><span class="desk-source-state">{source.state}{source.checked ? ` · ${ago(source.checked)}` : ""}</span>
            <Show when={source.detail}><div class="home-source"><bdi dir="auto">{source.detail}</bdi></div></Show>
          </div>}</For>
          <p class="home-source">Not included: cloud agents, mail.</p>
        </section>
      </aside>

      <Show when={selected()}>{current => <section class="desk-evidence attention-home" aria-label="Evidence">
        <div class="desk-evidence-head">
          <h2>Evidence</h2>
          <button class="desk-button" onClick={() => select()}>Expand chat</button>
        </div>
        <Show when={!current().live}><div class="home-warning" role="status">No longer pending in its source. The outcome is not inferred here; open the source thread.</div></Show>
        <Canonical item={current().item} live={current().live} attention={attention} requests={requests} onReceipt={receipt => setReceipts(previous => [receipt, ...previous].slice(0, 5))} />
        <Show when={receipts().length}><ul class="home-receipts"><For each={receipts()}>{receipt => <li data-result={receipt.result}>{receipt.result === "applied" ? "Reply applied" : receipt.result === "not-applied" ? "Not applied" : "Outcome uncertain"} · <bdi dir="ltr">{receipt.permission}</bdi> · {ago(receipt.at)}</li>}</For></ul></Show>
        <BriefPanel item={current().item} live={current().live} jobs={jobsFor(current().item.key)} canStart={desk.status() === "ready" && !briefs.pending() && !briefs.preparing()} confirming={desk.status() !== "ready" || briefs.jobs().some(job => job.state.state === "starting")} start={() => void briefs.start(current().item)} confirm={() => void briefs.confirm()} />
      </section>}</Show>

      <section class="desk-chat" aria-label="Front desk conversation">
        <Show when={briefs.jobs().length || briefs.error()}>
          <div class="desk-background" aria-label="Background checks">
            <Show when={briefs.error()}><div class="home-source">{briefs.error()}</div></Show>
            <For each={briefs.jobs().slice(0, 4)}>{job => {
              const binding = () => briefBinding(job.meta, items())
              return <div class="desk-job" data-state={job.state.state} data-current={binding().current ? "true" : "false"}>
                <span>Brief · <bdi dir="auto">{job.meta.title}</bdi> · rev {job.meta.revision} · {binding().current ? stateLabel(job) : "not current"}</span>
                <Show when={binding().current} fallback={<span class="home-source">{binding().reason}</span>}>
                  <button class="desk-button" onClick={() => select(job.meta.source)}>Show</button>
                </Show>
              </div>
            }}</For>
          </div>
        </Show>
        <Show when={desk.error()}><div class="home-warning" role="alert">{desk.error()}</div></Show>
        <Show when={desk.status() === "ready" ? desk.pointer() : undefined} keyed fallback={<DeskStart desk={desk} directory={deskDirectory()} />}>
          {target => <SessionView sessionID={target.session} directory={target.directory} embedded context={context} onSent={desk.sent} />}
        </Show>
      </section>
    </div>
  </main>
}

const DeskStart = (props: { desk: ReturnType<typeof createDeskSession>; directory?: string }) =>
  <div class="desk-start">
    <Show when={props.desk.status() === "checking"}><p class="home-muted">Checking the front desk conversation…</p></Show>
    <Show when={props.desk.status() === "unavailable"}><p class="home-warning">The front desk conversation could not be checked. It is kept; nothing was recreated. <button class="desk-button" onClick={() => void props.desk.verify()}>Check again</button></p></Show>
    <Show when={props.desk.status() === "unconfirmed"}><p class="home-warning">Starting the front desk conversation was not confirmed. Confirming resends the identical request; Core returns the same conversation if it exists. <button class="desk-button" onClick={() => void props.desk.confirm()}>Confirm start</button></p></Show>
    <Show when={props.desk.status() === "missing"}><p class="home-warning">The saved front desk conversation no longer exists in Core. <button class="desk-button" onClick={() => props.desk.forget()}>Clear pointer</button></p></Show>
    <Show when={props.desk.status() === "none" || props.desk.status() === "creating"}>
      <button class="desk-button home-primary" disabled={!props.directory || props.desk.status() === "creating"} onClick={() => props.directory && void props.desk.start(props.directory)}>
        {props.desk.status() === "creating" ? "Starting…" : "Start front desk conversation"}</button>
      <p class="home-source">Placed in project root <bdi dir="ltr">{props.directory ?? "unknown"}</bdi>, not a global scratch space. File edits denied.</p>
    </Show>
  </div>

const Canonical = (props: { item: DeskItem; live: boolean; attention: ReturnType<typeof createAttention>; requests: ReturnType<typeof createHomeRequests>; onReceipt: (receipt: HomeReplyReceipt) => void }) => {
  const dashboard = useDashboard()
  return <div class="desk-canonical">
    <Show when={props.item.record}>{record => <AttentionDecision record={record()} attention={props.attention} />}</Show>
    <Show when={props.item.request?.kind === "permission" ? props.item.request : undefined}>{request =>
      <HomePermission item={request()} live={props.live ? dashboard.activity.requestState("permission", request().session, request().directory, request().id) : "cleared"}
        siblings={dashboard.activity.requests().filter(other => other.kind === "permission" && other.directory === request().directory && other.request.sessionID === request().session && other.request.id !== request().id).length}
        stale={props.requests.now() - request().checked > 45_000} onReceipt={props.onReceipt}
        onRecheck={directory => Promise.all([props.requests.refresh(), dashboard.activity.refreshDirectory(directory, true)]).then(() => undefined)} />}</Show>
    <Show when={props.item.request?.kind === "question" ? props.item.request : undefined}>{request =>
      <div class="home-request"><div><span class="home-eyebrow">question · source request</span><h3><bdi dir="auto">{request().title}</bdi></h3><div class="home-source">Exact request <bdi dir="ltr">{request().id}</bdi> · source checked {ago(request().checked)}</div></div>
        <A href={sessionHref(request().session, request().directory)}>Open request</A><p class="home-muted">Reply using the original session controls.</p></div>}</Show>
    <Show when={props.item.failure}>{failure =>
      <div class="home-request"><div><span class="home-eyebrow">failure · Core record</span><h3><bdi dir="auto">{props.item.title}</bdi></h3><div class="home-source">Failed message <bdi dir="ltr">{failure().messageID}</bdi> · session <bdi dir="ltr">{failure().sessionID}</bdi></div></div>
        <A href={sessionHref(failure().sessionID, failure().directory)}>Open thread</A><p class="home-muted">Retry uses Core's own eligibility check. <FailureRetry sessionID={failure().sessionID} /></p></div>}</Show>
  </div>
}

const Refs = (props: { refs: string[]; known: EvidenceRef[]; item: DeskItem }) =>
  <For each={props.refs}>{id => {
    const ref = () => props.known.find(candidate => candidate.id === id)
    return <Show when={ref()?.messageID} fallback={<span class="desk-ref" title={ref()?.label}>{id}</span>}>
      <A class="desk-ref" title={ref()?.label} href={sessionHref(props.item.source.session, props.item.source.directory)}>{id}</A>
    </Show>
  }}</For>

const BriefPanel = (props: { item: DeskItem; live: boolean; jobs: BriefJob[]; canStart: boolean; confirming: boolean; start: () => void; confirm: () => void }) => {
  const current = () => props.jobs.find(job => job.meta.revision === props.item.revision)
  const discarded = () => props.jobs.filter(job => job.meta.revision !== props.item.revision)
  const ready = () => { const job = current(); return job?.state.state === "ready" ? { job, result: job.state.result as BriefResult, omitted: job.state.omitted } : undefined }
  return <section class="desk-brief" aria-label="Derived evidence brief">
    <div class="desk-brief-head"><h2>Evidence brief</h2><span class="home-source">Derived · not authoritative</span></div>
    <Show when={current()} fallback={<Show when={props.live}>
      <button class="desk-button" disabled={!props.canStart} onClick={props.start}>Prepare evidence brief</button>
      <span class="home-source"> No tools; reads this request and a short excerpt of its thread.{props.canStart ? "" : " Start the desk conversation first."}</span>
    </Show>}>{job => <>
      <Show when={job().state.state === "starting" || job().state.state === "running"}><p class="home-muted" role="status">Checking in the background for revision {job().meta.revision}…</p></Show>
      <Show when={job().state.state === "failed"}><p class="home-warning">Brief failed: {(job().state as { error: string }).error} It was not rerun.</p></Show>
      <Show when={job().state.state === "unknown"}><p class="home-warning">{(job().state as { reason: string }).reason}</p></Show>
      <Show when={job().state.state === "unconfirmed"}><p class="home-warning">Start was not confirmed. Confirming resends the identical request; Core returns the same check if it exists.</p>
        <button class="desk-button" disabled={props.confirming} onClick={props.confirm}>Confirm start</button></Show>
      <Show when={(job().state.state === "failed" || job().state.state === "unknown") && props.live}><button class="desk-button" disabled={!props.canStart} onClick={props.start}>Start a new check</button></Show>
      <Show when={ready()}>{value => <div class="desk-brief-body">
        <p dir="auto">{value().result.summary}</p>
        <Show when={value().result.flow.length}><ol class="desk-flow" aria-label="Flow">{<For each={value().result.flow}>{step => <li><bdi dir="auto">{step}</bdi></li>}</For>}</ol></Show>
        <Show when={value().result.facts.length}><h3>Facts</h3><ul><For each={value().result.facts}>{fact => <li><bdi dir="auto">{fact.text}</bdi> <Refs refs={fact.refs} known={value().job.meta.refs} item={props.item} /></li>}</For></ul></Show>
        <Show when={value().result.timeline.length}><h3>Timeline</h3><ol class="desk-timeline"><For each={value().result.timeline}>{entry => <li><Show when={entry.when}><span class="home-source">{entry.when} · </span></Show><bdi dir="auto">{entry.text}</bdi> <Refs refs={entry.refs} known={value().job.meta.refs} item={props.item} /></li>}</For></ol></Show>
        <Show when={value().result.gaps.length}><h3>Not established by the evidence</h3><ul><For each={value().result.gaps}>{gap => <li><bdi dir="auto">{gap}</bdi></li>}</For></ul></Show>
        <Show when={value().omitted}><p class="home-source">{value().omitted} uncited statement(s) omitted.</p></Show>
      </div>}</Show>
      <p class="home-source">Bound to revision {job().meta.revision} · <A href={sessionHref(job().id, job().directory)}>open background pass</A></p>
    </>}</Show>
    <For each={discarded()}>{job => <p class="home-source">Earlier brief for revision {job.meta.revision} discarded: the source changed.</p>}</For>
  </section>
}
