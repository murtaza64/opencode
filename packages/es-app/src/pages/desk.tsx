/* Front desk: one conversation across connected projects, a read-only queue of
 * existing requests, and an evidence canvas only while an item is selected.
 * The chat is the ordinary session view; selection changes never remount it. */
import { createEffect, createMemo, createResource, createSignal, For, on, onCleanup, onMount, Show } from "solid-js"
import { A, Navigate, useSearchParams } from "@solidjs/router"
import { ago, sessionHref, useDashboard } from "../state"
import { nativeHeader, NativeHeader } from "../components/native-header"
import { ModeSwitch } from "../components/mode-switch"
import { ProjectSelect } from "../components/sidebar"
import type { createAttention, AttentionRecord } from "../attention"
import { requestLive, type createHomeRequests } from "../home-requests"
import { AttentionDecision, useRequestAgent, type AttentionView } from "../components/attention-decision"
import { HomePermission, type HomeReplyReceipt } from "../components/home-permission"
import { FailureRetry } from "../components/session-failure"
import type { IgnoredFailure } from "../failure-ignores"
import { useDeskQueue } from "../desk-queue"
import { failureAge, failureLabel, failureWhen, OLD_FAILURE_MS } from "../session-failures"
import type { SessionFailure } from "@opencode-ai/sdk/v2"
import { attentionItem, briefBinding, briefPacket, briefSends, deskSources, detailRequest, type DeskItem, type DeskSource, SOURCE_TAIL } from "../desk"
import { answeredJob, createDeskSession, createMemory, readConversation, type BriefJob } from "../desk-session"
import { anchorHref } from "../message-anchor"
import { MoreDetail, PreparedBrief, useCompleteBrief, useCompleteJob } from "../components/attention-brief"
import { RecordConversation } from "../components/desk-conversation"
import { useBriefs } from "../desk-briefs"
import { oc } from "../api"
import { peekLiveSession } from "../live-session-cache"
import { flash } from "../motion"
import type { MemoryEntry, MemoryRevision } from "../desk-memory"
import { SessionView } from "./session"
import { Icon } from "@opencode-ai/ui/icon"
import { Glyph, HostGlyph } from "../components/icons"
import { hostDecisionHref } from "../host-feed"
import { getComposer } from "../composer"
import { dictation } from "../dictation"
import type { ContextPart } from "../api"
import { DeliverableList, SurfaceList, SurfaceView } from "../components/desk-surfaces"
import { surfaceFromKey, surfaceKey } from "../surfaces"
import { leftWidth } from "../ui"
import { TodayCost } from "../components/today-cost"
import "./home.css"

/** Delay before the desk reads its chat's latest turn for memory changes. */
const MEMORY_ABSORB_DELAY_MS = 1500
import "./desk.css"

const receiptText = (item: HomeReplyReceipt) => item.result === "applied" ? (item.reply === "once" ? "Allowed once" : item.reply === "always" ? "Always allowed" : "Rejected") : item.result === "not-applied" ? "Not applied" : "Outcome uncertain"
const stateLabel = (job: BriefJob) => ({ starting: "starting", unconfirmed: "start unconfirmed", running: "preparing", ready: "ready", failed: "failed", unknown: "stopped" })[job.state.state]
// Queue rows show a brief only while it is in progress or needs a retry; a ready brief is visible on selection.
const rowBrief = (job?: BriefJob) => job && job.state.state !== "ready" ? (job.state.state === "running" || job.state.state === "starting" ? "preparing brief" : `brief ${stateLabel(job)}`) : undefined
const STALE_MS = 45_000
// An answered decision its agent has not resolved within this long is shown as stalled.
const WAITING_STALE_MS = 4 * 3600_000
const WAITING_DELIVERY: Record<string, string> = { handled: "agent read it", presented: "delivered", admitted: "delivered", queued: "sending", pending: "sending" }

export default function Desk() {
  const dashboard = useDashboard()
  // The queue is app-wide state, so the Agents mode badge counts the same items this page lists.
  const queue = useDeskQueue()
  const project = queue.project
  const attention = queue.attention
  const requests = queue.requests
  onMount(() => attention.activate())
  const desk = createDeskSession()
  // Defined below; read lazily when a brief starts.
  // Briefs are shared app-wide; the desk adds its other queue items for manual preparation.
  const prepared = useBriefs()
  const briefs = prepared.briefs
  // `/?item=<key>` opens one item and `/?surface=<id>` one agent-owned surface. `/?view=agents`
  // predates the Agents mode and redirects there.
  const [params, setParams] = useSearchParams()
  const [selectedKey, setSelectedKey] = createSignal<string | undefined>(typeof params.surface === "string" ? surfaceKey(params.surface) : typeof params.item === "string" ? params.item : undefined)
  const surfaces = queue.surfaces
  const [receipts, setReceipts] = createSignal<HomeReplyReceipt[]>([])
  const [now, setNow] = createSignal(Date.now())
  const clock = setInterval(() => setNow(Date.now()), 5000)
  onCleanup(() => clearInterval(clock))

  const ignores = queue.ignores
  const failures = queue.failures
  const ignoredFailures = createMemo(() => failures().filter(failure => ignores.ignored(failure)))
  const unignore = (failure: SessionFailure) => {
    const entry = ignores.entries().find((item: IgnoredFailure) => item.sessionID === failure.sessionID && item.messageID === failure.messageID)
    if (entry) return ignores.unignore(entry)
  }
  const items = queue.items
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
  // Other Work view hosts' open decisions, listed after this host's items. Each opens on its own
  // host's Front desk (its tab, operator session and answer route); an unreachable host's last-known
  // decisions stay listed, marked, with opening disabled, and the count says it may be incomplete.
  const hostDecisions = createMemo(() => dashboard.work.feeds().flatMap(feed => feed.state().decisions.map(record => ({ feed, record }))))
  const hostsBehind = createMemo(() => dashboard.work.feeds().filter(feed => feed.state().status === "unavailable" || feed.state().decisionsStale).map(feed => feed.host.label))
  const timeOfDay = (time: number) => new Date(time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
  const [historyView, setHistoryView] = createSignal<Exclude<AttentionView, "open"> | "ignored">("answered")
  const inView = (record: AttentionRecord, view: AttentionView) => view === "history" ? ["resolved", "withdrawn"].includes(record.status) : view === "recorded" ? record.status === "decided" : record.status === view
  const historyCount = (view: AttentionView | "ignored") => view === "ignored" ? ignoredFailures().length : records().filter(record => inView(record, view)).length
  const blockedDeliveries = () => records().filter(record => record.status === "answered" && record.delivery_state === "blocked").length
  // An answer is not an outcome: until its agent resolves the record, it still needs follow-through.
  // Blocked deliveries already surface in History; oldest first, so a stalled answer stays on top.
  const waiting = () => records().filter(record => record.status === "answered" && record.delivery_state !== "blocked")
    .sort((a, b) => (a.answer?.answered_at ?? a.updated_at) - (b.answer?.answered_at ?? b.updated_at))
  const stalled = (record: AttentionRecord) => now() - (record.answer?.answered_at ?? record.updated_at) > WAITING_STALE_MS
  // Unsent or blocked answers open the history once; the reader closes it, nothing auto-closes it.
  const [historyOpen, setHistoryOpen] = createSignal(false)
  createEffect(on(() => historyCount("recorded") + blockedDeliveries() > 0, unsent => { if (unsent) setHistoryOpen(true) }))
  const uncertainRequests = () => requests.rows().filter(item => item.state !== "pending" && (!project() || !item.project || item.project === project()))
  // Keep the last-seen item so an answered request does not vanish from under the reader.
  // An answered decision keeps its key and stays selected with its delivery status.
  const lastSeen = new Map<string, DeskItem>()
  const selected = createMemo((): { surface: string } | { item: DeskItem; live: boolean } | { record: AttentionRecord } | undefined => {
    const key = selectedKey()
    if (!key) return
    const surface = surfaceFromKey(key)
    if (surface) return { surface }
    const live = items().find(item => item.key === key)
    if (live) lastSeen.set(key, live)
    if (live) return { item: live, live: true }
    const record = records().find(candidate => recordKey(candidate) === key)
    if (record) return { record }
    const seen = lastSeen.get(key)
    return seen ? { item: seen, live: false } : undefined
  })
  const selectedItem = () => { const current = selected(); return current && "item" in current ? current : undefined }
  const selectedSurface = () => { const current = selected(); return current && "surface" in current ? current.surface : undefined }
  // The selection lives in the URL, so switching modes and coming back reopens the same item.
  const select = (key?: string) => {
    setSelectedKey(key)
    const surface = surfaceFromKey(key)
    setParams({ surface, item: surface ? undefined : key }, { replace: true })
  }
  const [evidence, setEvidence] = createSignal<HTMLElement>()
  // A brief sits below its request and may be off screen, already selected or stacked below the
  // queue on narrow windows; selection alone can look like nothing happened, so bring it into view.
  const showBrief = (key: string) => {
    select(key)
    requestAnimationFrame(() => {
      const brief = evidence()?.querySelector<HTMLElement>(".desk-brief")
      if (!brief) return
      brief.scrollIntoView({ block: "start" })
      brief.focus({ preventScroll: true })
      flash(brief)
    })
  }
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
    // Not urgent: once the desk chat's own view has loaded, read its latest messages from there
    // instead of fetching the same page again; fetch only if that view never loaded.
    const absorb = () => {
      const live = peekLiveSession(target.session, target.directory)
      if (live?.loaded()) {
        const messages = (live.data.message[target.session] ?? []).slice(-20)
        memory.absorb(messages.map(info => ({ info, parts: live.data.part[info.id] ?? [] })) as Parameters<typeof memory.absorb>[0])
        return
      }
      void oc.messagesTail(target.session, target.directory, 20).then(messages => memory.absorb(messages)).catch(() => undefined)
    }
    const timer = setTimeout(absorb, MEMORY_ABSORB_DELAY_MS)
    onCleanup(() => clearTimeout(timer))
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
    surface: (() => { const id = selectedSurface(); const surface = surfaces.list().find(item => item.id === id); return surface && { id: surface.id, title: surface.title, owner: surface.owner } })(),
  })

  // "More detail" on a selected item: fresh bounded evidence from its source thread, sent to the desk chat.
  const askDetail = async (item: DeskItem, question: string) => {
    const [tail, conversation] = await Promise.all([oc.messagesTail(item.source.session, item.source.directory, SOURCE_TAIL).catch(() => []), item.record ? readConversation(item.record) : undefined])
    const thread = sessionHref(item.source.session, item.source.directory)
    const request = detailRequest(item, question, briefPacket(item, tail, conversation?.threads ?? [], conversation?.documents ?? []),
      ref => ref.url ?? (ref.messageID ? anchorHref(item.source.session, item.source.directory, ref.messageID) : thread))
    const note = context()
    const error = await desk.detail(request.text, [...note, request.context], deskDirectory())
    if (error) return error
    if (note.length) desk.sent(note, true)
    document.querySelector(".desk-chat")?.scrollIntoView({ block: "nearest", behavior: "smooth" })
  }

  if (params.view === "agents") return <Navigate href="/agents" />
  const refresh = () => { void attention.refresh(); void requests.refresh(); void dashboard.failures.refresh(); void briefs.refresh(true); dashboard.activity.todos.reload(); void attention.checkOperator().catch(() => undefined) }
  // No page header: the queue is this mode's sidebar, and the chat or selected item fills the rest.
  return <main class="desk" classList={{ "desk-has-selection": !!selected() }}>
    <Show when={nativeHeader}><NativeHeader><ProjectSelect /></NativeHeader></Show>
    {/* Same width as the Agents sidebar, so the mode switch stays put across modes. */}
    <div class="desk-grid" style={{ "--queue-width": `${leftWidth()}px` }}>
      <aside class="desk-queue" aria-label="Desk queue">
        <h1 class="sr-only">Front desk</h1>
        <Show when={!nativeHeader}><div class="sidebar-top"><ProjectSelect /><TodayCost /></div></Show>
        <ModeSwitch />
        <Show when={!attention.operator()}><div class="home-login home-muted">Read-only: answers are off <button class="desk-button" title="This UI origin must be allowed by the attention server" onClick={() => attention.checkOperator().catch(() => undefined)}>Reconnect</button></div></Show>
        <Show when={attention.notice()}><div class="home-notice" role="status">{attention.notice()}<Show when={attention.pending()}><button class="desk-button" disabled={attention.writing()} onClick={() => void attention.retry()}>Retry same action</button></Show></div></Show>
        <Show when={briefs.error()}><div class="home-muted desk-background" role="status" title={briefs.detail()}>{briefs.error()}</div></Show>
        <Show when={ignores.notice()}><div class={ignores.quiet() ? "home-muted desk-background" : "home-warning desk-background"} role="status" title={ignores.quiet()}>{ignores.notice()}</div></Show>
        <SurfaceList surfaces={surfaces} selected={selectedKey()} onSelect={select} />
        <DeliverableList surfaces={surfaces} selected={selectedKey()} onSelect={select} />
        <h2>Needs you <span title={hostsBehind().length ? `${hostsBehind().join(", ")}: not current` : undefined}>{items().length + hostDecisions().length}{hostsBehind().length ? "+" : ""}</span></h2>
        <ul class="desk-items">
          <For each={items()} fallback={<Show when={!hostDecisions().length}><li class="home-muted desk-empty">{problems().length || hostsBehind().length ? "Nothing listed, but some sources could not be checked." : "Nothing needs you."}</li></Show>}>{item => {
            const job = () => jobsFor(item.key).find(candidate => candidate.meta.revision === item.revision)
            return <li><button class="desk-item" aria-pressed={selectedKey() === item.key} data-desk-item={item.key} onClick={() => select(item.key)}>
              <bdi dir="auto" class="desk-item-title">{item.title}</bdi>
              <span class="home-source" classList={{ "desk-item-old": !!item.failure && !(now() - item.failure.time < OLD_FAILURE_MS) }}><span class="desk-item-kind" data-kind={item.kind}>{item.kind}</span>
                <Show when={item.failure} fallback={<><Show when={item.record}>{record => <> · <RowAgent record={record()} /></>}</Show><Show when={item.project}> · <bdi dir="auto">{item.project}</bdi></Show>
                  <Show when={now() - item.checked > STALE_MS}> · <span class="home-blocked">checked {ago(item.checked) || "never"}</span></Show></>}>
                  {failure => <> · {failureLabel(failure())} · <span data-failure-age>{failureAge(failure().time, now())}</span></>}</Show>
                <Show when={rowBrief(job())}>{label => <> · {label()}</>}</Show></span>
            </button></li>
          }}</For>
          <For each={hostDecisions()}>{entry => {
            const label = entry.feed.host.label
            const down = () => entry.feed.state().status === "unavailable"
            const behind = () => down() ? `unreachable since ${timeOfDay(entry.feed.state().since ?? Date.now())}` : entry.feed.state().decisionsStale ? "not current" : ""
            return <li class="desk-host-item" classList={{ unavailable: down() }}>
              <a class="desk-item" href={hostDecisionHref(entry.feed.host, entry.record)} data-host-key={`${entry.feed.host.id}~${entry.record.editspace}:${entry.record.id}`}
                aria-label={`${entry.record.title}, on ${label}${behind() ? `, ${behind()}` : ""}`} aria-disabled={down() || undefined}
                title={down() ? `${label} is unreachable; answer it there when it is back` : `Answer on ${label}`} onClick={event => { if (down()) event.preventDefault() }}>
                <bdi dir="auto" class="desk-item-title"><HostGlyph host={entry.feed.host.id} size={12} />{entry.record.title}</bdi>
                <span class="home-source"><span class="desk-item-kind" data-kind={entry.record.kind}>{entry.record.kind}</span> · <bdi dir="auto">{entry.record.editspace}</bdi> · on {label}
                  <Show when={behind()}> · <span class="home-blocked">{behind()}</span></Show></span>
              </a>
            </li>
          }}</For>
        </ul>
        <Show when={uncertainRequests().length}><details class="home-unknown"><summary>Unknown outcome ({uncertainRequests().length})</summary><For each={uncertainRequests()}>{item => <div class="home-source"><bdi dir="auto">{item.title}</bdi> · {item.state === "unavailable" ? "source unavailable" : "no longer pending; outcome unknown"} · <A href={sessionHref(item.session, item.directory)}>Open thread</A></div>}</For></details></Show>
        <Show when={waiting().length}>
          <details class="desk-waiting">
            <summary>Waiting on agents <span class="home-muted">{waiting().length}</span><Show when={waiting().filter(stalled).length}>{count => <span class="home-blocked"> · {count()} stalled</span>}</Show></summary>
            <ul class="desk-items" aria-label="Answered, waiting on agents"><For each={waiting()}>{record =>
              <li><button class="desk-item" aria-pressed={selectedKey() === recordKey(record)} data-desk-waiting={recordKey(record)} onClick={() => select(recordKey(record))}>
                <bdi dir="auto" class="desk-item-title">{record.title}</bdi>
                <span class="home-source"><RowAgent record={record} /> · <span classList={{ "home-blocked": stalled(record) }}>answered {ago(record.answer?.answered_at ?? record.updated_at)}</span> · {WAITING_DELIVERY[record.delivery_state] ?? record.delivery_state}</span>
              </button></li>}</For></ul>
          </details>
        </Show>
        <details class="desk-history" open={historyOpen()} onToggle={event => setHistoryOpen(event.currentTarget.open)}>
          <summary>History <span class="home-muted">{historyCount("answered")}</span><Show when={historyCount("recorded")}> <span class="home-blocked">· {historyCount("recorded")} not sent</span></Show><Show when={blockedDeliveries()}> <span class="home-blocked">· {blockedDeliveries()} blocked</span></Show><Show when={historyCount("ignored")}> <span class="home-muted">· Ignored {historyCount("ignored")}</span></Show></summary>
          <div class="home-tabs" role="group" aria-label="Attention status"><For each={[["answered", "Answered"], ["recorded", "Not sent"], ["snoozed", "Snoozed"], ["history", "Resolved"], ["ignored", "Ignored"]] as const}>{([view, label]) => <button aria-pressed={historyView() === view} data-empty={historyCount(view) === 0 ? "" : undefined} onClick={() => setHistoryView(view)}>{label} <span>{historyCount(view)}</span></button>}</For></div>
          <Show when={historyView() === "ignored"}><ul class="desk-items" aria-label="Ignored failures"><For each={ignoredFailures()} fallback={<li class="home-muted desk-empty">None.</li>}>{failure =>
            <li class="desk-ignored" data-ignored={failure.messageID}><div class="desk-item">
              <bdi dir="auto" class="desk-item-title">{dashboard.activity.session(failure.sessionID)?.title ?? failure.sessionID}</bdi>
              <span class="home-source"><span class="desk-item-kind" data-kind="failure">failure</span> · {failureLabel(failure)} · {failureAge(failure.time, now())}</span>
              <span class="desk-ignored-actions"><button class="desk-button" disabled={ignores.busy(failure)} onClick={() => void unignore(failure)}>Unignore</button><A href={sessionHref(failure.sessionID, failure.directory)}>Open thread</A></span>
            </div></li>}</For></ul></Show>
          <Show when={historyView() !== "ignored" ? historyView() as AttentionView : undefined}>{view => <ul class="desk-items"><For each={records().filter(record => inView(record, view()))} fallback={<li class="home-muted desk-empty">None.</li>}>{record =>
            <li><button class="desk-item" aria-pressed={selectedKey() === recordKey(record)} onClick={() => select(recordKey(record))}>
              <bdi dir="auto" class="desk-item-title">{record.title}</bdi>
              {/* What was decided and when, before where it came from: History is scanned by outcome. */}
              <Show when={record.answer}>{answer => <span class="desk-item-answer"><bdi dir="auto">{record.options.find(option => option.id === answer().choice_id)?.label ?? (answer().text ? `“${answer().text.length > 60 ? `${answer().text.slice(0, 60).replace(/\s+\S*$/, "")}…` : answer().text}”` : "Answered")}</bdi> · {ago(answer().answered_at)}</span>}</Show>
              <span class="home-source"><span class="desk-item-kind" data-kind={record.kind}>{record.kind}</span> · <RowAgent record={record} /> · <bdi dir="auto">{record.editspace}</bdi><Show when={record.status === "answered"}> · <span classList={{ "home-blocked": record.delivery_state === "blocked" }}>{record.delivery_state}</span></Show></span>
            </button></li>}</For></ul>}</Show>
        </details>
        <button class="desk-chat-tab" aria-expanded={memoryOpen()} title="Personal notes the desk reads; never used as permission. ~/.local/share/opencode/front-desk/memory.json" onClick={() => setMemoryOpen(!memoryOpen())}>Memory <span class="home-muted" title="Notes">{memory.document().entries.length}</span></button>
        <Show when={memoryOpen()}><MemoryPanel memory={memory} /></Show>
        {/* A source that is not current shows as one compact row (name and state); its error
            detail is the row's tooltip and the shared status's diagnostics, never stacked text. */}
        <section class="desk-sources" aria-label="Connected sources">
          <For each={problems()}>{source => <Source source={source} compact />}</For>
          <div class="desk-sources-bar">
            <details class="desk-sources-all"><summary>{problems().length ? "All sources" : "Sources up to date"}</summary>
            <For each={sources().filter(source => source.state === "current")}>{source => <Source source={source} />}</For>
            <p class="home-source">Not included: cloud agents, mail.</p>
            <Show when={briefs.jobs().length}><div class="desk-jobs" aria-label="Briefs">
              <For each={briefs.jobs()}>{job => {
                const binding = () => briefBinding(job.meta, items())
                return <div class="desk-job home-source" data-state={job.state.state} data-current={binding().current ? "true" : "false"}>
                  <span>Brief · <bdi dir="auto">{job.meta.title}</bdi> · rev {job.meta.revision} · {binding().current ? stateLabel(job) : "not current"}</span>
                  <Show when={binding().current} fallback={<span>{binding().reason}</span>}>
                    <button class="desk-button" aria-label={`Show brief: ${job.meta.title}`} onClick={() => showBrief(job.meta.source)}>Show</button>
                  </Show>
                </div>
              }}</For>
            </div></Show>
            </details>
            <button class="desk-button" disabled={attention.loading()} onClick={refresh}>Refresh</button>
          </div>
          <label class="desk-auto home-muted" title="Prepare a brief for each new item in the background"><input type="checkbox" checked={prepared.auto()} onChange={event => prepared.setAuto(event.currentTarget.checked)} /> Auto briefs</label>
        </section>
      </aside>

      {/* Remount per selection so one item's reply outcome or draft never carries into the next. */}
      <Show when={selectedSurface()} keyed>{id => <SurfaceView id={id} surface={surfaces.list().find(item => item.id === id)} checked={surfaces.checked()} onOpen={surface => void surfaces.markSeen(surface)} onRetry={() => void surfaces.refresh()} onClose={() => select()} />}</Show>
      <Show when={selected() && !selectedSurface() ? selectedKey() : undefined} keyed>{_key => <Show when={selected()}>{current => <section ref={setEvidence} class="desk-evidence attention-home" aria-label="Selected item">
        <div class="desk-evidence-head">
          <button class="desk-button" aria-label="Close and return to chat" onClick={() => select()}>Close</button>
        </div>
        <Show when={"record" in current() ? current() as { record: AttentionRecord } : undefined}>{entry => <Answered record={entry().record} attention={attention} onView={view => view !== "open" && setHistoryView(view)} />}</Show>
        <Show when={selectedItem()}>{entry => <>
          {/* Permission cards state their own verified status; other items only know they left the queue. */}
          <Show when={!entry().live && entry().item.request?.kind !== "permission"}><div class="home-warning" role="status">No longer waiting for you. <A href={sessionHref(entry().item.source.session, entry().item.source.directory)}>Open the thread</A> to see what happened.</div></Show>
          <Canonical item={entry().item} live={entry().live} attention={attention} requests={requests} now={now()} ignoring={!!entry().item.failure && ignores.busy(entry().item.failure!)} detail={question => askDetail(entry().item, question)}
            onIgnore={failure => void ignores.ignore(failure, failureLabel(failure)).then(() => { if (ignores.ignored(failure)) select() })} onReceipt={receipt => setReceipts(previous => [receipt, ...previous.filter(old => old.key !== receipt.key || old.at !== receipt.at)].slice(0, 5))} />
          <Show when={receipts().length}><ul class="home-receipts" aria-label="Replies from the Front desk"><For each={receipts()}>{receipt => <li data-result={receipt.result}><b>{receiptText(receipt)}</b> · <bdi dir="ltr">{receipt.permission}</bdi> · <bdi dir="auto">{receipt.title}</bdi> · {ago(receipt.at)}{receipt.result === "uncertain" ? " · not confirmed" : receipt.result === "not-applied" ? " · no longer pending" : ""} · <A href={sessionHref(receipt.session, receipt.directory)}>Open thread</A></li>}</For></ul></Show>
          <Show when={!entry().item.record}><PreparedBrief item={entry().item} live={entry().live} /><MoreDetail ask={question => askDetail(entry().item, question)} /></Show>
        </>}</Show>
      </section>}</Show>}</Show>

      <DeskChat desk={desk} directory={deskDirectory()} context={context} beside={!!selected()} />
    </div>
  </main>
}

const Source = (props: { source: DeskSource; compact?: boolean }) =>
  <div class="desk-source" data-state={props.source.state} title={props.compact ? props.source.detail : undefined}>
    <span>{props.source.name}</span><span class="desk-source-state">{props.source.state}{props.source.checked ? ` · ${ago(props.source.checked)}` : ""}</span>
    <Show when={!props.compact && props.source.detail}><div class="home-source"><bdi dir="auto">{props.source.detail}</bdi></div></Show>
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

// Rows are buttons, so the agent is named without a link; the selected header links it.
const RowAgent = (props: { record: AttentionRecord }) => {
  const agentFor = useRequestAgent()
  const agent = () => agentFor(props.record)
  return <bdi dir="auto" class="desk-item-agent" data-named={agent().named ? "true" : undefined} title={agent().session}>{agent().label}</bdi>
}

const CHAT_HIDDEN = "es-app:front-desk:chat-hidden"
const NARROW = "(max-width: 900px)"

/** The desk conversation. Beside a selected item or surface it can fold to a rail (a bottom bar on
 * narrow windows, which opens it as a sheet). It stays mounted while folded, so the draft, caret,
 * scroll position, pending sends and a dictation target all survive. */
const DeskChat = (props: { desk: ReturnType<typeof createDeskSession>; directory?: string; context: () => ContextPart[]; beside: boolean }) => {
  const dashboard = useDashboard()
  const [hidden, setHidden] = createSignal(localStorage.getItem(CHAT_HIDDEN) === "1")
  const [sheet, setSheet] = createSignal(false)
  const [width, setWidth] = createSignal(0)
  const [replied, setReplied] = createSignal(false)
  // With nothing selected the chat is the page, so the fold applies only beside a selection.
  const folded = () => hidden() && props.beside
  const target = () => props.desk.status() === "ready" ? props.desk.pointer() : undefined
  const status = () => { const current = target(); return current ? dashboard.activity.status(current.session) ?? "" : "" }
  const working = () => ["busy", "retry"].includes(status())
  const draft = () => { const current = target(); if (!current) return false; const task = getComposer(current.session, current.directory).state.task; return !!task.text.trim() || task.images.length > 0 }
  const recording = () => { const current = target(); return !!current && dictation.state.phase !== "idle" && dictation.state.target?.sessionID === current.session && dictation.state.target?.directory === current.directory }
  // A turn that ends while folded is a reply the reader has not seen.
  createEffect(on(working, (now, before) => { if (before && !now && folded()) setReplied(true) }))
  createEffect(on(() => props.beside, beside => { if (!beside) setSheet(false) }))
  let section: HTMLElement | undefined
  let rail: HTMLButtonElement | undefined
  createEffect(() => { if (section) section.inert = folded() && !sheet() })
  const store = (value: boolean) => { setHidden(value); try { localStorage.setItem(CHAT_HIDDEN, value ? "1" : "0") } catch { /* stays for this page */ } }
  const hide = () => {
    if (sheet()) return setSheet(false)
    const focused = !!section?.contains(document.activeElement)
    // Keep the folded chat at its laid-out width so its text does not rewrap and move the scroll anchor.
    setWidth(section?.getBoundingClientRect().width ?? 0)
    setReplied(false)
    store(true)
    if (focused) queueMicrotask(() => rail?.focus())
  }
  const show = () => {
    const fromRail = document.activeElement === rail
    if (matchMedia(NARROW).matches) setSheet(true)
    else store(false)
    setReplied(false)
    if (fromRail) requestAnimationFrame(() => section?.querySelector<HTMLTextAreaElement>(".desk-chat textarea")?.focus())
  }
  return <>
    <section ref={section} class="desk-chat" classList={{ "desk-chat-folded": folded() && !sheet(), "desk-chat-sheet": sheet() }}
      style={folded() && width() ? { "--chat-width": `${width()}px` } : undefined} aria-label="Front desk conversation">
      <Show when={props.desk.error()}><div class="home-warning" role="alert">{props.desk.error()}</div></Show>
      <Show when={target()} keyed fallback={<DeskStart desk={props.desk} directory={props.directory} />}>
        {current => <SessionView sessionID={current.session} directory={current.directory} embedded context={props.context} onSent={props.desk.sent}
          headerStart={<Show when={props.beside}><button class="header-icon desk-chat-hide" aria-label={sheet() ? "Close chat" : "Hide chat"} title={sheet() ? "Close chat" : "Hide chat"}
            onClick={hide}><Icon name="chevron-down" size="small" /></button></Show>} />}
      </Show>
    </section>
    <Show when={folded() && !sheet()}>
      {/* The whole rail expands the chat; the dots say only what is true right now. */}
      <div class="desk-chat-rail" onClick={show}>
        <button ref={rail} class="desk-chat-show" aria-label="Show chat" title="Front desk chat" onClick={event => { event.stopPropagation(); show() }}>
          <Glyph name="comment-discussion" /><span class="desk-chat-rail-label">Chat</span>
        </button>
        <Show when={working()}><span class="desk-chat-dot" data-dot="working" role="img" aria-label="Chat agent working" /></Show>
        <Show when={replied()}><span class="desk-chat-dot" data-dot="reply" role="img" aria-label="New reply" /></Show>
        <Show when={draft()}><span class="desk-chat-dot" data-dot="draft" role="img" aria-label="Unsent draft" /></Show>
        <Show when={recording()}><span class="desk-chat-dot" data-dot="recording" role="img" aria-label="Dictating into this chat" /></Show>
      </div>
    </Show>
  </>
}

/** A decision no longer waiting: the same explainer the human saw when answering (the brief recorded on the
 * answer, bound to the revision they answered, never a newer one), with their answer and its follow-through. */
const Answered = (props: { record: AttentionRecord; attention: ReturnType<typeof createAttention>; onView: (view: AttentionView) => void }) => {
  const prepared = useBriefs()
  // Reading briefs is otherwise driven by a visible brief; here the answered one is not known until they are read.
  prepared.view()
  // Content cannot change once answered, so the content revision is the one answered (older records: the answered revision).
  const item = () => attentionItem(props.record, 0, String(props.record.content_revision ?? props.record.answer?.revision ?? props.record.revision))
  const pinned = () => answeredJob(prepared.briefs.jobs(), item(), props.record.answer)?.id
  const brief = useCompleteBrief(item, pinned)
  return <Show when={pinned()} keyed fallback={<AttentionDecision record={props.record} attention={props.attention} onView={props.onView} conversation={<RecordConversation record={props.record} />} />}>{job =>
    <AttentionDecision record={props.record} attention={props.attention} onView={props.onView} prepared={brief()} conversation={<RecordConversation record={props.record} />}
      brief={<PreparedBrief item={item()} live={false} part="lead" pinned={job} />} briefVisual={<PreparedBrief item={item()} live={false} part="visual" pinned={job} />}
      briefAfter={<PreparedBrief item={item()} live={false} part="after" pinned={job} />} briefDetails={<PreparedBrief item={item()} live={false} part="details" pinned={job} />} />}</Show>
}

const Canonical = (props: { item: DeskItem; live: boolean; detail: (question: string) => Promise<string | undefined>; attention: ReturnType<typeof createAttention>; requests: ReturnType<typeof createHomeRequests>; now: number; ignoring: boolean; onIgnore: (failure: SessionFailure) => void; onReceipt: (receipt: HomeReplyReceipt) => void }) => {
  const dashboard = useDashboard()
  // With a complete brief for this exact revision, the brief leads and the producer's text folds away.
  const brief = useCompleteBrief(() => props.item)
  const job = useCompleteJob(() => props.item)
  // Documents the request names (a draft to send) let the exact text it would publish be shown verbatim.
  const [found] = createResource(() => props.item.record, readConversation)
  // Plain getters, read only when the card needs them: a conditional JSX prop would compile to a memo that
  // re-reads this card's item while it unmounts (after an answer) and aborts that update.
  const briefJob = () => { const value = job(); return value ? { job: value.id, revision: value.meta.revision } : undefined }
  const sends = () => { const value = brief(); return value ? { text: briefSends(value, props.item, found()?.documents), to: value.sendsTo, as: value.sendsAs } : undefined }
  return <div class="desk-canonical">
    <Show when={props.item.record}>{record => <AttentionDecision record={record()} attention={props.attention} prepared={brief()}
      briefJob={briefJob()} sends={sends()} conversation={<RecordConversation record={record()} />}
      brief={<PreparedBrief item={props.item} live={props.live} part="lead" />} briefVisual={<PreparedBrief item={props.item} live={props.live} part="visual" />} briefAfter={<PreparedBrief item={props.item} live={props.live} part="after" />}
      briefDetails={<PreparedBrief item={props.item} live={props.live} part="details" />} more={<MoreDetail ask={props.detail} />} />}</Show>
    <Show when={props.item.request?.kind === "permission" ? props.item.request : undefined}>{request =>
      <HomePermission item={request()} live={requestLive(props.live, request(), props.requests.rows(), dashboard.activity.requestState("permission", request().session, request().directory, request().id))}
        siblings={dashboard.activity.requests().filter(other => other.kind === "permission" && other.directory === request().directory && other.request.sessionID === request().session && other.request.id !== request().id).length}
        owner={(() => { const root = dashboard.activity.root(request().session); return root && root.id !== request().session ? root.title || root.id : undefined })()}
        stale={props.requests.now() - request().checked > 45_000} onReceipt={props.onReceipt}
        onRecheck={directory => Promise.all([props.requests.refresh(), dashboard.activity.refreshDirectory(directory, true)]).then(() => undefined)} />}</Show>
    <Show when={props.item.request?.kind === "question" ? props.item.request : undefined}>{request =>
      <div class="home-request" data-request-id={request().id}><div><h3><bdi dir="auto">{request().title}</bdi></h3><div class="home-source">Answer it in its thread.</div></div>
        <A href={sessionHref(request().session, request().directory)}>Open thread</A></div>}</Show>
    <Show when={props.item.failure}>{failure =>
      <div class="desk-failure" data-message-id={failure().messageID}>
        <h3><bdi dir="auto">{props.item.title}</bdi></h3>
        <div class="home-source">{failureLabel(failure())} · <span data-failure-when>{failureWhen(failure().time, props.now)}</span><Show when={props.item.project}> · <bdi dir="auto">{props.item.project}</bdi></Show></div>
        <div class="desk-failure-actions">
          <FailureRetry sessionID={failure().sessionID} card />
          <Show when={props.live}><button class="desk-button" disabled={props.ignoring} title="Hide this failure from Needs you. The thread is not changed." onClick={() => props.onIgnore(failure())}>{props.ignoring ? "Ignoring…" : "Ignore"}</button></Show>
          <A href={sessionHref(failure().sessionID, failure().directory)}>Open thread</A>
        </div>
        <details class="desk-failure-details"><summary>Error details</summary>
          <dl class="home-source">
            <dt>Error</dt><dd><bdi dir="ltr">{failure().error.name}{failure().error.statusCode ? ` ${failure().error.statusCode}` : ""}</bdi></dd>
            <dt>Session</dt><dd><bdi dir="ltr">{failure().sessionID}</bdi></dd>
            <dt>Failed message</dt><dd><bdi dir="ltr">{failure().messageID}</bdi></dd>
          </dl>
        </details>
      </div>}</Show>
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
