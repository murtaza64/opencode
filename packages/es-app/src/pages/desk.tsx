/* Front desk: one conversation across connected projects, a read-only queue of
 * existing requests, and an evidence canvas only while an item is selected.
 * The chat is the ordinary session view; selection changes never remount it. */
import { createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show } from "solid-js"
import { A, useSearchParams } from "@solidjs/router"
import { ago, sessionHref, useDashboard } from "../state"
import { AppHeader } from "../components/native-header"
import { createAttention, type AttentionRecord } from "../attention"
import { createHomeRequests, requestPointers } from "../home-requests"
import { AttentionDecision, type AttentionView } from "../components/attention-decision"
import { DeskAgents } from "../components/desk-agents"
import { HomePermission, type HomeReplyReceipt } from "../components/home-permission"
import { FailureRetry } from "../components/session-failure"
import { briefBinding, briefPacket, deskItems, deskSources, detailRequest, type DeskItem, type DeskSource } from "../desk"
import { createDeskSession, createMemory, type BriefJob } from "../desk-session"
import { MoreDetail, PreparedBrief, useCompleteBrief } from "../components/attention-brief"
import { useBriefs } from "../desk-briefs"
import { oc } from "../api"
import type { MemoryEntry, MemoryRevision } from "../desk-memory"
import { SessionView } from "./session"
import "./home.css"
import "./desk.css"

const AGENTS = "agents"
const receiptText = (item: HomeReplyReceipt) => item.result === "applied" ? (item.reply === "once" ? "Allowed once" : item.reply === "always" ? "Always allowed" : "Rejected") : item.result === "not-applied" ? "Not applied" : "Outcome uncertain"
const stateLabel = (job: BriefJob) => ({ starting: "starting", unconfirmed: "start unconfirmed", running: "preparing", ready: "ready", failed: "failed", unknown: "stopped" })[job.state.state]
// Queue rows show a brief only while it is in progress or needs a retry; a ready brief is visible on selection.
const rowBrief = (job?: BriefJob) => job && job.state.state !== "ready" ? (job.state.state === "running" || job.state.state === "starting" ? "preparing brief" : `brief ${stateLabel(job)}`) : undefined
const STALE_MS = 45_000

export default function Desk() {
  const dashboard = useDashboard()
  const project = () => dashboard.allProjects() ? undefined : dashboard.editspace() ?? dashboard.editspaces()?.default ?? undefined
  const attention = createAttention(project)
  const requests = createHomeRequests(createMemo(() => requestPointers(dashboard)), item => dashboard.activity.requestSettled(item.kind, item.directory, item.id))
  const desk = createDeskSession()
  // Defined below; read lazily when a brief starts.
  // Briefs are shared app-wide; the desk adds its other queue items for manual preparation.
  const prepared = useBriefs()
  const briefs = prepared.briefs
  // `/?view=agents` opens the Agents pane directly (what the old Home page showed); `/?item=<key>` opens one item.
  const [params] = useSearchParams()
  const [selectedKey, setSelectedKey] = createSignal<string | undefined>(params.view === "agents" ? AGENTS : typeof params.item === "string" ? params.item : undefined)
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
  prepared.track(items)
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
  const problems = () => sources().filter(source => source.state !== "current")
  const records = () => attention.snapshot()?.value.records ?? []
  const recordKey = (record: AttentionRecord) => `attention:${record.editspace}:${record.id}`
  const [historyView, setHistoryView] = createSignal<Exclude<AttentionView, "open">>("answered")
  const inView = (record: AttentionRecord, view: AttentionView) => view === "history" ? ["resolved", "withdrawn"].includes(record.status) : view === "recorded" ? record.status === "decided" : record.status === view
  const historyCount = (view: AttentionView) => records().filter(record => inView(record, view)).length
  const blockedDeliveries = () => records().filter(record => record.status === "answered" && record.delivery_state === "blocked").length
  // Unsent or blocked answers open the history once; the reader closes it, nothing auto-closes it.
  const [historyOpen, setHistoryOpen] = createSignal(false)
  createEffect(on(() => historyCount("recorded") + blockedDeliveries() > 0, unsent => { if (unsent) setHistoryOpen(true) }))
  const uncertainRequests = () => requests.rows().filter(item => item.state !== "pending" && (!project() || !item.project || item.project === project()))
  // Keep the last-seen item so an answered request does not vanish from under the reader.
  // An answered decision keeps its key and stays selected with its delivery status.
  const lastSeen = new Map<string, DeskItem>()
  const selected = createMemo((): { agents: true } | { item: DeskItem; live: boolean } | { record: AttentionRecord } | undefined => {
    const key = selectedKey()
    if (!key) return
    if (key === AGENTS) return { agents: true }
    const live = items().find(item => item.key === key)
    if (live) lastSeen.set(key, live)
    if (live) return { item: live, live: true }
    const record = records().find(candidate => recordKey(candidate) === key)
    if (record) return { record }
    const seen = lastSeen.get(key)
    return seen ? { item: seen, live: false } : undefined
  })
  const selectedItem = () => { const current = selected(); return current && "item" in current ? current : undefined }
  const select = (key?: string) => setSelectedKey(key)
  const deskDirectory = () => {
    const name = dashboard.editspace() ?? dashboard.editspaces()?.default
    return dashboard.editspaces()?.editspaces.find(item => item.name === name)?.root
  }
  // Shared session events end an active brief sooner than its poll would.
  createEffect(on(() => briefs.jobs().filter(job => job.state.state === "running").map(job => `${job.id}:${dashboard.activity.status(job.id) ?? ""}`).join(","),
    (now, before) => { if (before !== undefined && now !== before) void briefs.refresh() }))
  const memory = createMemory()
  const [memoryOpen, setMemoryOpen] = createSignal(false)
  // Read memory once the desk is known, then pick up changes the desk wrote whenever its turn ends.
  onMount(() => void memory.load())
  createEffect(on(() => {
    const target = desk.status() === "ready" ? desk.pointer() : undefined
    return target ? `${target.session}:${dashboard.activity.status(target.session) ?? ""}` : ""
  }, key => {
    const target = desk.pointer()
    if (!key || !target || ["busy", "retry"].includes(dashboard.activity.status(target.session) ?? "")) return
    void oc.messagesTail(target.session, target.directory, 20).then(messages => memory.absorb(messages)).catch(() => undefined)
  }))
  const jobsFor = (key: string) => briefs.jobs().filter(job => job.meta.source === key)
  const context = () => desk.context({
    now: Date.now(),
    scope: project(),
    sources: sources(),
    items: items(),
    selected: selectedItem()?.live ? selectedItem()!.item : undefined,
    briefs: briefs.jobs().filter(job => briefBinding(job.meta, items()).current)
      .flatMap(job => job.state.state === "starting" || job.state.state === "unconfirmed" ? [] : [{ meta: job.meta, state: job.state }]),
    memory: memory.document(),
  })

  // "More detail" on a selected item: fresh bounded evidence from its source thread, sent to the desk chat.
  const askDetail = async (item: DeskItem, question: string) => {
    const tail = await oc.messagesTail(item.source.session, item.source.directory, 10).catch(() => [])
    const thread = sessionHref(item.source.session, item.source.directory)
    const request = detailRequest(item, question, briefPacket(item, tail), ref => ref.messageID ? `${thread}&message=${encodeURIComponent(ref.messageID)}` : thread)
    const note = context()
    const error = await desk.detail(request.text, [...note, request.context], deskDirectory())
    if (error) return error
    if (note.length) desk.sent(note, true)
    document.querySelector(".desk-chat")?.scrollIntoView({ block: "nearest", behavior: "smooth" })
  }

  return <main class="desk" classList={{ "desk-has-selection": !!selected() }}>
    <AppHeader><h1>Front desk</h1><span class="home-muted">{project() ?? "All projects"}</span>
      <span class="home-header-end" /><label class="desk-auto home-muted" title="Prepare a brief for each new item in the background"><input type="checkbox" checked={prepared.auto()} onChange={event => prepared.setAuto(event.currentTarget.checked)} /> Auto briefs</label><button class="desk-button" disabled={attention.loading()} onClick={() => { void attention.refresh(); void requests.refresh(); void dashboard.failures.refresh(); void briefs.refresh(true); dashboard.activity.todos.reload(); void attention.checkOperator().catch(() => undefined) }}>Refresh</button></AppHeader>
    <div class="desk-grid">
      <aside class="desk-queue" aria-label="Desk queue">
        <Show when={!attention.operator()}><div class="home-login home-muted">Read-only: answers are off <button class="desk-button" title="This UI origin must be allowed by the attention server" onClick={() => attention.checkOperator().catch(() => undefined)}>Reconnect</button></div></Show>
        <Show when={attention.notice()}><div class="home-notice" role="status">{attention.notice()}<Show when={attention.pending()}><button class="desk-button" disabled={attention.writing()} onClick={() => void attention.retry()}>Retry same action</button></Show></div></Show>
        <Show when={briefs.error()}><div class="home-warning desk-background" role="status">{briefs.error()}</div></Show>
        <h2>Needs you <span>{items().length}</span></h2>
        <ul class="desk-items">
          <For each={items()} fallback={<li class="home-muted desk-empty">{problems().length ? "Nothing listed, but some sources could not be checked." : "Nothing needs you."}</li>}>{item => {
            const job = () => jobsFor(item.key).find(candidate => candidate.meta.revision === item.revision)
            return <li><button class="desk-item" aria-pressed={selectedKey() === item.key} data-desk-item={item.key} onClick={() => select(item.key)}>
              <bdi dir="auto" class="desk-item-title">{item.title}</bdi>
              <span class="home-source"><span class="desk-item-kind" data-kind={item.kind}>{item.kind}</span><Show when={item.project}> · <bdi dir="auto">{item.project}</bdi></Show>
                <Show when={now() - item.checked > STALE_MS}> · <span class="home-blocked">checked {ago(item.checked) || "never"}</span></Show>
                <Show when={rowBrief(job())}>{label => <> · {label()}</>}</Show></span>
            </button></li>
          }}</For>
        </ul>
        <Show when={uncertainRequests().length}><details class="home-unknown"><summary>Unknown outcome ({uncertainRequests().length})</summary><For each={uncertainRequests()}>{item => <div class="home-source"><bdi dir="auto">{item.title}</bdi> · {item.state === "unavailable" ? "source unavailable" : "no longer pending; outcome unknown"} · <A href={sessionHref(item.session, item.directory)}>Open thread</A></div>}</For></details></Show>
        <button class="desk-chat-tab" aria-pressed={selectedKey() === AGENTS} onClick={() => select(AGENTS)}>Agents <span class="home-muted" title="Pinned agents">{dashboard.pinnedSessions().length}</span></button>
        <details class="desk-history" open={historyOpen()} onToggle={event => setHistoryOpen(event.currentTarget.open)}>
          <summary>History <span class="home-muted">{historyCount("answered")}</span><Show when={historyCount("recorded")}> <span class="home-blocked">· {historyCount("recorded")} not sent</span></Show><Show when={blockedDeliveries()}> <span class="home-blocked">· {blockedDeliveries()} blocked</span></Show></summary>
          <div class="home-tabs" role="group" aria-label="Attention status"><For each={[["answered", "Answered"], ["recorded", "Not sent"], ["snoozed", "Snoozed"], ["history", "Resolved"]] as const}>{([view, label]) => <button aria-pressed={historyView() === view} data-empty={historyCount(view) === 0 ? "" : undefined} onClick={() => setHistoryView(view)}>{label} <span>{historyCount(view)}</span></button>}</For></div>
          <ul class="desk-items"><For each={records().filter(record => inView(record, historyView()))} fallback={<li class="home-muted desk-empty">None.</li>}>{record =>
            <li><button class="desk-item" aria-pressed={selectedKey() === recordKey(record)} onClick={() => select(recordKey(record))}>
              <bdi dir="auto" class="desk-item-title">{record.title}</bdi>
              <span class="home-source"><span class="desk-item-kind" data-kind={record.kind}>{record.kind}</span> · <bdi dir="auto">{record.editspace}</bdi><Show when={record.status === "answered"}> · <span classList={{ "home-blocked": record.delivery_state === "blocked" }}>{record.delivery_state}</span></Show></span>
            </button></li>}</For></ul>
        </details>
        <button class="desk-chat-tab" aria-expanded={memoryOpen()} title="Personal notes the desk reads; never used as permission. ~/.local/share/opencode/front-desk/memory.json" onClick={() => setMemoryOpen(!memoryOpen())}>Memory <span class="home-muted" title="Notes">{memory.document().entries.length}</span></button>
        <Show when={memoryOpen()}><MemoryPanel memory={memory} /></Show>
        {/* Healthy sources stay folded; one that is not current is listed in the open. */}
        <section class="desk-sources" aria-label="Connected sources">
          <For each={problems()}>{source => <Source source={source} />}</For>
          <details class="desk-sources-all"><summary>{problems().length ? "All sources" : "Sources up to date"}</summary>
            <For each={sources().filter(source => source.state === "current")}>{source => <Source source={source} />}</For>
            <p class="home-source">Not included: cloud agents, mail.</p>
            <Show when={briefs.jobs().length}><div class="desk-jobs" aria-label="Briefs">
              <For each={briefs.jobs()}>{job => {
                const binding = () => briefBinding(job.meta, items())
                return <div class="desk-job home-source" data-state={job.state.state} data-current={binding().current ? "true" : "false"}>
                  <span>Brief · <bdi dir="auto">{job.meta.title}</bdi> · rev {job.meta.revision} · {binding().current ? stateLabel(job) : "not current"}</span>
                  <Show when={binding().current} fallback={<span>{binding().reason}</span>}>
                    <button class="desk-button" onClick={() => select(job.meta.source)}>Show</button>
                  </Show>
                </div>
              }}</For>
            </div></Show>
          </details>
        </section>
      </aside>

      {/* Remount per selection so one item's reply outcome or draft never carries into the next. */}
      <Show when={selected() ? selectedKey() : undefined} keyed>{_key => <Show when={selected()}>{current => <section class="desk-evidence attention-home" aria-label={"agents" in current() ? "Agents" : "Selected item"}>
        <div class="desk-evidence-head">
          <Show when={"agents" in current()}><h2>Agents</h2></Show>
          <button class="desk-button" aria-label="Close and return to chat" onClick={() => select()}>Close</button>
        </div>
        <Show when={"agents" in current()}><DeskAgents project={project()} /></Show>
        <Show when={"record" in current() ? current() as { record: AttentionRecord } : undefined}>{entry => <AttentionDecision record={entry().record} attention={attention} onView={view => view !== "open" && setHistoryView(view)} />}</Show>
        <Show when={selectedItem()}>{entry => <>
          <Show when={!entry().live}><div class="home-warning" role="status">No longer pending. Check the <A href={sessionHref(entry().item.source.session, entry().item.source.directory)}>thread</A> for the outcome.</div></Show>
          <Canonical item={entry().item} live={entry().live} attention={attention} requests={requests} detail={question => askDetail(entry().item, question)} onReceipt={receipt => setReceipts(previous => [receipt, ...previous.filter(old => old.key !== receipt.key || old.at !== receipt.at)].slice(0, 5))} />
          <Show when={receipts().length}><ul class="home-receipts" aria-label="Replies from the Front desk"><For each={receipts()}>{receipt => <li data-result={receipt.result}><b>{receiptText(receipt)}</b> · <bdi dir="ltr">{receipt.permission}</bdi> · <bdi dir="auto">{receipt.title}</bdi> · {ago(receipt.at)}{receipt.result === "uncertain" ? " · not confirmed" : receipt.result === "not-applied" ? " · no longer pending" : ""} · <A href={sessionHref(receipt.session, receipt.directory)}>Open thread</A></li>}</For></ul></Show>
          <Show when={!entry().item.record}><PreparedBrief item={entry().item} live={entry().live} /><MoreDetail ask={question => askDetail(entry().item, question)} /></Show>
        </>}</Show>
      </section>}</Show>}</Show>

      <section class="desk-chat" aria-label="Front desk conversation">
        <Show when={desk.error()}><div class="home-warning" role="alert">{desk.error()}</div></Show>
        <Show when={desk.status() === "ready" ? desk.pointer() : undefined} keyed fallback={<DeskStart desk={desk} directory={deskDirectory()} />}>
          {target => <SessionView sessionID={target.session} directory={target.directory} embedded context={context} onSent={desk.sent} />}
        </Show>
      </section>
    </div>
  </main>
}

const Source = (props: { source: DeskSource }) =>
  <div class="desk-source" data-state={props.source.state}>
    <span>{props.source.name}</span><span class="desk-source-state">{props.source.state}{props.source.checked ? ` · ${ago(props.source.checked)}` : ""}</span>
    <Show when={props.source.detail}><div class="home-source"><bdi dir="auto">{props.source.detail}</bdi></div></Show>
  </div>

const DeskStart = (props: { desk: ReturnType<typeof createDeskSession>; directory?: string }) =>
  <div class="desk-start">
    <Show when={props.desk.status() === "checking"}><p class="home-muted">Loading chat…</p></Show>
    <Show when={props.desk.status() === "unavailable"}><p class="home-warning">Could not load the chat. <button class="desk-button" onClick={() => void props.desk.verify()}>Check again</button></p></Show>
    {/* Confirm resends the identical create; Core returns the existing conversation if the first one landed. */}
    <Show when={props.desk.status() === "unconfirmed"}><p class="home-warning">Chat start not confirmed. <button class="desk-button" onClick={() => void props.desk.confirm()}>Confirm start</button></p></Show>
    <Show when={props.desk.status() === "missing"}><p class="home-warning">The saved chat no longer exists. <button class="desk-button" onClick={() => props.desk.forget()}>Clear</button></p></Show>
    <Show when={props.desk.status() === "none" || props.desk.status() === "creating"}>
      <button class="desk-button home-primary" disabled={!props.directory || props.desk.status() === "creating"} onClick={() => props.directory && void props.desk.start(props.directory)}>
        {props.desk.status() === "creating" ? "Starting…" : "Start chat"}</button>
      <p class="home-source">Read-only, in <bdi dir="ltr">{props.directory ?? "unknown"}</bdi></p>
    </Show>
  </div>

const Canonical = (props: { item: DeskItem; live: boolean; detail: (question: string) => Promise<string | undefined>; attention: ReturnType<typeof createAttention>; requests: ReturnType<typeof createHomeRequests>; onReceipt: (receipt: HomeReplyReceipt) => void }) => {
  const dashboard = useDashboard()
  // With a complete brief for this exact revision, the brief leads and the producer's text folds away.
  const brief = useCompleteBrief(() => props.item)
  return <div class="desk-canonical">
    <Show when={props.item.record}>{record => <AttentionDecision record={record()} attention={props.attention} prepared={brief()}
      brief={<PreparedBrief item={props.item} live={props.live} part="lead" />} briefAfter={<PreparedBrief item={props.item} live={props.live} part="after" />}
      briefDetails={<PreparedBrief item={props.item} live={props.live} part="details" />} more={<MoreDetail ask={props.detail} />} />}</Show>
    <Show when={props.item.request?.kind === "permission" ? props.item.request : undefined}>{request =>
      <HomePermission item={request()} live={props.live ? dashboard.activity.requestState("permission", request().session, request().directory, request().id) : "cleared"}
        siblings={dashboard.activity.requests().filter(other => other.kind === "permission" && other.directory === request().directory && other.request.sessionID === request().session && other.request.id !== request().id).length}
        owner={(() => { const root = dashboard.activity.root(request().session); return root && root.id !== request().session ? root.title || root.id : undefined })()}
        stale={props.requests.now() - request().checked > 45_000} onReceipt={props.onReceipt}
        onRecheck={directory => Promise.all([props.requests.refresh(), dashboard.activity.refreshDirectory(directory, true)]).then(() => undefined)} />}</Show>
    <Show when={props.item.request?.kind === "question" ? props.item.request : undefined}>{request =>
      <div class="home-request" data-request-id={request().id}><div><h3><bdi dir="auto">{request().title}</bdi></h3><div class="home-source">Answer it in its thread.</div></div>
        <A href={sessionHref(request().session, request().directory)}>Open thread</A></div>}</Show>
    <Show when={props.item.failure}>{failure =>
      <div class="home-request" data-message-id={failure().messageID}><div><h3><bdi dir="auto">{props.item.title}</bdi></h3></div>
        <A href={sessionHref(failure().sessionID, failure().directory)}>Open thread</A><p class="home-muted"><FailureRetry sessionID={failure().sessionID} /></p></div>}</Show>
  </div>
}

const changeLabel = (revision: MemoryRevision) => {
  const change = revision.change
  const who = change.actor === "assistant" ? "desk" : "you"
  if (change.op === "restore") return `${who} restored r${change.restored}`
  if (change.op === "erase") return `${who} erased ${change.entryID} from history`
  return `${who} ${change.op === "forget" ? "forgot" : "saved"} ${change.entryID}`
}

const MemoryPanel = (props: { memory: ReturnType<typeof createMemory> }) => {
  const [editing, setEditing] = createSignal<string>()
  const [draft, setDraft] = createSignal("")
  const [added, setAdded] = createSignal({ id: "", text: "", kind: "preference" as MemoryEntry["kind"] })
  const [forgotten, setForgotten] = createSignal<string[]>([])
  const busy = () => props.memory.status() === "writing" || !!props.memory.uncertain()
  const save = async (entry: MemoryEntry) => {
    if (await props.memory.write({ op: "upsert", id: entry.id, text: draft(), kind: entry.kind, scope: entry.scope, confidence: "stated" }, "human") === "written") setEditing()
  }
  const forget = async (id: string) => { if (await props.memory.write({ op: "forget", id }, "human") === "written") setForgotten(previous => [...previous, id]) }
  return <section class="desk-memory" aria-label="Front desk memory">
    <Show when={props.memory.notice()}><p class="home-warning" role="status">{props.memory.notice()}</p></Show>
    <Show when={props.memory.uncertain()}><div class="desk-memory-actions"><button class="desk-button" disabled={props.memory.status() === "writing"} onClick={() => void props.memory.load()}>Reload memory</button><button class="desk-button" disabled={props.memory.status() === "writing"} onClick={() => void props.memory.resend()}>Resend identical change</button></div></Show>
    <ul class="desk-memory-list">
      <For each={props.memory.document().entries} fallback={<li class="home-muted">No notes yet.</li>}>{entry => <li data-memory-id={entry.id}>
        <Show when={editing() === entry.id} fallback={<bdi dir="auto">{entry.text}</bdi>}>
          <textarea aria-label={`Edit note ${entry.id}`} dir="auto" rows={2} value={draft()} onInput={event => setDraft(event.currentTarget.value)} />
        </Show>
        <div class="home-source" title={`${entry.kind} · ${entry.scope} · ${entry.confidence}`}>{entry.id} · {entry.source.actor === "assistant" ? "from desk" : "from you"} · {ago(entry.updated)}</div>
        <div class="desk-memory-actions">
          <Show when={editing() === entry.id} fallback={<button class="desk-button" disabled={busy()} onClick={() => { setDraft(entry.text); setEditing(entry.id) }}>Edit</button>}>
            <button class="desk-button home-primary" disabled={busy()} onClick={() => void save(entry)}>Save</button><button class="desk-button" onClick={() => setEditing()}>Cancel</button>
          </Show>
          <button class="desk-button" disabled={busy()} onClick={() => void forget(entry.id)}>Forget</button>
        </div>
      </li>}</For>
    </ul>
    <For each={forgotten().filter(id => !props.memory.document().entries.some(entry => entry.id === id) && props.memory.document().history.some(revision => revision.entries.some(entry => entry.id === id)))}>{id =>
      <p class="home-source">"{id}" is forgotten but kept in history. <button class="desk-button" disabled={busy()} onClick={() => void props.memory.erase(id)}>Erase from history</button></p>}</For>
    <form class="desk-memory-add" onSubmit={async event => {
      event.preventDefault()
      const value = added()
      if (await props.memory.write({ op: "upsert", id: value.id.trim(), text: value.text, kind: value.kind, confidence: "stated" }, "human") === "written") setAdded({ id: "", text: "", kind: value.kind })
    }}>
      <input aria-label="Note ID" placeholder="id" value={added().id} onInput={event => setAdded({ ...added(), id: event.currentTarget.value })} />
      <select aria-label="Note kind" value={added().kind} onChange={event => setAdded({ ...added(), kind: event.currentTarget.value as MemoryEntry["kind"] })}><option value="preference">preference</option><option value="fact">fact</option><option value="lesson">lesson</option></select>
      <textarea aria-label="Note text" dir="auto" rows={2} placeholder="Add a note" value={added().text} onInput={event => setAdded({ ...added(), text: event.currentTarget.value })} />
      <button class="desk-button" type="submit" disabled={busy() || !added().id.trim() || !added().text.trim()}>Add note</button>
    </form>
    <details class="desk-memory-history"><summary>History ({props.memory.document().history.length})</summary>
      <ol reversed>
        <For each={props.memory.document().history.toReversed()}>{revision => <li data-memory-revision={revision.n}>
          r{revision.n} · {changeLabel(revision)} · {ago(revision.at)} · {revision.entries.length} notes
                    <Show when={revision.n !== props.memory.document().revision}> <button class="desk-button" disabled={busy()} onClick={() => void props.memory.write({ op: "restore", revision: revision.n }, "human")}>Restore</button></Show>
        </li>}</For>
      </ol>
    </details>
  </section>
}
