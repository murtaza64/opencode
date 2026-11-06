/* Conversation view: live transcript (session-ui renderer over an SSE-fed
 * store), prompt input, and inline permission/question replies. */
import { pageHidden } from "../page-visible"
import { ResizeHandle } from "../components/resize-handle"
import { createStore } from "solid-js/store"
import { createEffect, createMemo, createResource, createSignal, For, on, onCleanup, onMount, Show, untrack, type JSX } from "solid-js"
import { A, useNavigate, useParams, useSearchParams } from "@solidjs/router"
import { DataProvider } from "@opencode-ai/session-ui/context"
import { renderable, ToolAdornment, type MessagePartProps } from "@opencode-ai/session-ui/message-part"
import type { Part, ToolPart } from "@opencode-ai/sdk/v2"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Icon } from "@opencode-ai/ui/icon"
import { es, ocAt, type ContextPart } from "../api"
import { SessionHostProvider, useOc, useSessionHost, type SessionHost } from "../session-host"
import { hostPrefix, readHostLineage } from "../host-items"
import { createHostActivity } from "../host-activity"
import { hostBase } from "../host-base"
import { readHost } from "../host"
import { errorText } from "../live-session"
import { useLiveSession } from "../live-session-cache"
import FakeCaret from "../components/fake-caret"
import { SessionChips } from "../components/session-chips"
import { ContextChips, ContextPicker } from "../components/context-picker"
import { appendContextLabel, contextGroups, contextKey, contextPart, insertContextLabel, MAX_CONTEXT, type AgentCandidate, type ContextRef } from "../context-mention"
import { useDeskQueue } from "../desk-queue"
import { useDeskChatOptional } from "../desk-companion"
import { DESK } from "../desk-identity"
import { mentionQuery, sessionLane, tokenBefore } from "../session-mention"
import { RelativeLines } from "../components/relative-lines"
import SessionInfo from "../components/session-info"
import { ago, linkUrl, sessionHref, useDashboard } from "../state"
import { companionDocked, rightOpen } from "../ui"
import { createVim } from "../vim"
import { contextLimit, contextUsage, latestCompletedTurn } from "../context-usage"
import { ComposerMeta } from "../components/composer-meta"
import { footerContext, footerCost } from "../composer-meta"
import { primaryAction } from "../primary-action"
import { sendContext } from "../input-context"
import { adoptHostSessionState, getComposer, type ComposerAction } from "../composer"
import { pendingEcho } from "../pending-echo"
import { defaultImageCapability, prepareImageFile } from "../image-fit"
import { ComposerResults } from "../components/composer-controls"
import { OutgoingMessages } from "../components/outgoing"
import { DirectComposer } from "../components/direct-composer"
import { DictationButton } from "../components/dictation"
import { flash } from "../motion"
import { Glyph, HostGlyph } from "../components/icons"
import { SelfHandoffButton, SelfHandoffStatus } from "../components/self-handoff"
import { createSelfHandoff, SELF_HANDOFF_VERSION } from "../self-handoff"
import { createMailReceiptRecords, MailRecords } from "../mail-receipts"
import { DeliveredTick } from "../components/message-tick"
import { ContextLines } from "../components/context-line"
import { chatDot } from "../chat-activity"
import { clockTime, exactTime } from "../local-time"
import { lastAudible, quietTurns } from "../quiet-turns"
import { AppHeader } from "../components/native-header"
import { SessionTitle } from "../components/session-title"
import { SubagentTranscript } from "../components/subagent-transcript"
import { Filament } from "../filament/filament"
import { livingActivity, setLivingActivity } from "../appearance"
import { TranscriptMessage } from "../components/transcript-message"
import { MailCauseRow } from "../components/mail-cause"
import { InlineQuestion } from "../components/inline-question"
import { TodoPart } from "../components/todos"
import { MailRow } from "../components/mail-row"
import { createMailWake, MailWakeBar } from "../components/mail-wake-bar"
import { mailUnread } from "../mail-ticks"
import { useMailNamer } from "../components/mail-party"
import { MailSubscriptions } from "../components/mail-subscriptions"
import { canonicalMail, mailCauses, mailLocation, mailRows, mailSourceID } from "../mail-timeline"
import { handoffChain, handoffNext, pendingHandoffFor, successorFor } from "../handoffs"
import { ComposerImages } from "../components/composer-images"
import { ActivityBriefView } from "../components/activity-brief"
import { activityBrief } from "../activity-brief"
import { FindExcerpt, TranscriptFind } from "../components/transcript-find"
import type { FindHit } from "../transcript-find"
import { ToolSize } from "../components/tool-size"
import { ToolRun } from "../components/tool-run"
import { HeaderMenu } from "../components/header-menu"
import { FailureRetry } from "../components/session-failure"
import { blockTime } from "../recorded-time"
import { completedTurns, groupableTurns, messageSegments, planToolRuns, samePlan, sameSegments } from "../transcript-groups"
import { isUserPrompt, promptPosition, promptTarget } from "../transcript-nav"
import { restartMarkers } from "../restart-marker"
import { wakeMarker, type WakeEvent } from "../wake-marker"
import { anchorNote, anchorRange, parseAnchor, type MessageAnchor } from "../message-anchor"
import { perfEvent, perfReady, perfSpan } from "../perf-telemetry"
import { targetReady } from "../startup"
import { accessState } from "../access-auth"
import { EarlierSession, HandoffRule, type SegmentControl } from "../components/earlier-session"
import { deskChain, laneChain, successionPredecessor, type Chain, type ChainLink } from "../transcript-chain"
import { ariaShortcut, matchShortcut, shortcutLabel } from "../shortcuts"
import { leaveComposer, ownsKey } from "../keyboard"

// The provider catalog per directory, shared by session views for a few minutes so switching
// sessions does not refetch it each time.
const PROVIDERS_TTL_MS = 5 * 60_000
// Keyed by host too: each Work host has its own providers.
const providerCatalog = new Map<string, { at: number; value: ReturnType<ReturnType<typeof ocAt>["providers"]> }>()
const providersCached = (base: string, directory: string) => {
  const key = `${base}\u0000${directory}`
  const hit = providerCatalog.get(key)
  if (hit && Date.now() - hit.at < PROVIDERS_TTL_MS) return hit.value
  const value = ocAt(base).providers(directory).catch(() => {
    providerCatalog.delete(key)
    return { providers: [], default: {} }
  })
  providerCatalog.set(key, { at: Date.now(), value })
  return value
}

/** How long a cold session open waits before showing the transcript skeleton. */
const SKELETON_DELAY_MS = 150

/** Transcript rows mounted when a session opens; the rest mount in idle chunks. */
const INITIAL_ROWS = 16
const ROW_CHUNK = 16

// How long backend trouble must persist before the status slot reports it.
export const STATUS_DELAY_MS = 2000

function PermissionBanner(props: { p: any; directory: string; owner?: string; onDone: () => Promise<void> }) {
  const oc = useOc()
  // A read-only host takes no reply from this page: the request shows, its actions do not.
  const readOnly = !!useSessionHost().readOnly
  const [error, setError] = createSignal("")
  const [sending, setSending] = createSignal(false)
  const act = async (reply: "once" | "always" | "reject") => {
    if (sending()) return
    setSending(true)
    setError("")
    try {
      await oc.permissionReply(props.p.id, props.directory, reply)
      await props.onDone()
    } catch (e) {
      setError(String(e))
    } finally {
      setSending(false)
    }
  }
  // metadata carries the actual request (command, cwd, directories, …) — the
  // action alone ("bash", "external_directory") doesn't tell the human what to
  // judge. Arrays of scalars (directories, patterns) render joined.
  const meta = () => {
    const m = props.p.metadata ?? {}
    return Object.entries(m)
      .map(([k, v]): [string, string] | null => {
        if (v == null) return null
        if (Array.isArray(v)) {
          const scalars = v.filter((x) => x != null && typeof x !== "object")
          return scalars.length ? [k, scalars.map(String).join("\n")] : null
        }
        if (typeof v === "object") return null
        return [k, String(v)]
      })
      .filter((e): e is [string, string] => e != null)
  }
  // one-line gist for the sticky rail: the command, else the patterns, else the first path-like field
  const summary = () => {
    const m = props.p.metadata ?? {}
    if (typeof m.command === "string" && m.command.trim()) return m.command.trim()
    const patterns = (props.p.patterns ?? []).filter((x: unknown) => typeof x === "string" && x)
    if (patterns.length) return patterns.join("  ")
    return meta().find(([k]) => /path|file|dir|cwd|url/i.test(k))?.[1] ?? meta()[0]?.[1] ?? ""
  }
  const label = () => `Permission ${props.p.permission}${props.owner ? ` from subagent ${props.owner}` : ""}`
  return (
    <section class="banner permission" aria-label={label()}>
      {/* actions stay pinned while long details scroll beneath them */}
      <div class="permission-rail">
        <div class="permission-identity">
          <span class="dot pending" aria-hidden="true" />
          <span class="permission-kind">permission: <b>{props.p.permission}</b></span>
          <Show when={props.owner}><span class="dim permission-owner">from subagent: {props.owner}</span></Show>
        </div>
        <Show when={summary()}><bdi class="permission-summary mono" dir="ltr" title={summary()}>{summary()}</bdi></Show>
        <Show when={!readOnly} fallback={<span class="dim" data-read-only-reply>answer on that host</span>}>
          <div class="banner-actions">
            <button disabled={sending()} onClick={() => act("once")}>allow once</button>
            <button disabled={sending()} onClick={() => act("always")}>always</button>
            <button disabled={sending()} class="danger" onClick={() => act("reject")}>reject</button>
          </div>
        </Show>
      </div>
      <Show when={props.p.patterns?.length || meta().length}>
        <details class="permission-details">
          <summary>details</summary>
          <Show when={props.p.patterns?.length}>
            <div class="banner-body mono">{props.p.patterns.join("\n")}</div>
          </Show>
          <Show when={meta().length}>
            <div class="banner-body mono">
              <For each={meta()}>
                {([k, v]) => (
                  <div>
                    <span class="dim">{k}:</span> {String(v)}
                  </div>
                )}
              </For>
            </div>
          </Show>
        </details>
      </Show>
      <Show when={error()}><div class="err" role="alert">{error()}</div></Show>
    </section>
  )
}

export default function SessionPage() {
  const params = useParams()
  const [search] = useSearchParams()
  // the router reuses this component across /session/:id navigations; key the
  // view on id+directory so the live store, SSE feed, and info panel remount
  const key = () => `${params.id}\u0000${(search.directory as string) || ""}\u0000${(search.host as string) || ""}`
  return (
    <Show when={key()} keyed>
      {(k) => {
        const [id, dir] = k.split("\u0000")
        // Another Work host's session (`?host=mini`) opens in the same view, with every read, stream and write
        // on that host (/hosts/<id>/oc through the Local listener). The page's own host id is known first.
        const other = typeof search.host === "string" && search.host && search.host !== "local" ? search.host : undefined
        if (!other) return <SessionView sessionID={id!} directory={dir ?? ""} anchor={() => parseAnchor(search)} />
        const [info] = createResource(() => readHost())
        return <Show when={info()}>{(page) => {
          const base = hostBase(other, page().id)
          if (!base) return <main class="session-page"><p class="err" role="alert">Unknown host.</p></main>
          if (base === "/oc") return <SessionView sessionID={id!} directory={dir ?? ""} anchor={() => parseAnchor(search)} />
          const item = page().work.find((item) => item.id === other)
          return <SessionView sessionID={id!} directory={dir ?? ""} anchor={() => parseAnchor(search)}
            host={{ id: other, label: item?.label ?? other, base, ...(item?.readOnly ? { readOnly: true as const } : {}) }} />
        }}</Show>
      }}
    </Show>
  )
}

/** `embedded` drops the page-level info panel. `headerStart` leads the header, for a host's own pane control. `context` may attach generated parts to an idle send; `onSent` reports whether that send was accepted. `anchor` scrolls to and highlights a linked message or range. `host`: another Work host whose session this is; every read, stream, write and saved draft then belongs to that host. */
export function SessionView(props: { sessionID: string; directory: string; embedded?: boolean; context?: (send: { input: boolean }) => ContextPart[]; onSent?: (context: ContextPart[], accepted: boolean, send: { input: boolean }) => void; anchor?: () => MessageAnchor | undefined; headerStart?: JSX.Element; host?: SessionHost
  /** A context chip to add to this draft once (Ask about this); `onIncoming` acknowledges it. */
  incoming?: () => ContextRef | undefined; onIncoming?: () => void
  /** True while this view is on the page but hidden (a closed Front desk chat). */
  hidden?: () => boolean
  /** Fold turns that end without text into one quiet row, named for this agent (the Front desk chat). */
  quiet?: string }) {
  const sessionID = props.sessionID
  const directory = props.directory
  const sessionHost: SessionHost = props.host ?? { base: "/oc" }
  // This page's dashboard (lanes, mail, handoffs, pins, unread state, failures) describes its own host only, so
  // another host's session shows none of it, and offers no fork, archive or delete (that host exposes no
  // such route to this window). Rename goes to that host (SessionTitle).
  const remote = !!sessionHost.id
  const deskChat = useDeskChatOptional()
  const desk = () => !!deskChat?.desk.isDesk(sessionID, sessionHost.id)
  const oc = ocAt(sessionHost.base)
  const composer = getComposer(sessionID, directory, props.host)
  if (remote) adoptHostSessionState(composer, sessionHost.id!, sessionID)
  const dialog = useDialog()
  let inspecting = false

  const dashboard = useDashboard()
  const { sessionsError, editspaces, mailRevision, editspace, state, handoffs, handoffsError,
    laneOwners, lineage: dashboardLineage, lineageOwners, pendingHandoffs, refetch, refetchHandoffs, transferPin } = dashboard
  const hostActivity = remote ? createHostActivity(sessionHost, sessionID, directory) : undefined
  const activity = hostActivity ?? dashboard.activity
  // Another host's session: that host's lineage for the session's own editspace (read-only routes), so a handoff
  // there shows here; this page's dashboard lineage describes this host only.
  const [hostLineage] = createResource(() => remote ? sessionHost.id : undefined, (host) => readHostLineage(host, directory).catch(() => undefined))
  const lineage = () => remote ? hostLineage()?.edges ?? [] : dashboardLineage()
  const hrefFor = (id: string, dir?: string) => remote ? `${sessionHref(id, dir)}&host=${encodeURIComponent(sessionHost.id!)}` : sessionHref(id, dir)
  const pendingTransfer = () => remote ? undefined : pendingHandoffFor(sessionID, pendingHandoffs())
  const currentEditspace = () => editspace() ?? editspaces()?.default ?? state()?.editspace
  const ownedLane = () => remote ? undefined : laneOwners().find((lane) => lane.owner === sessionID)
  // Self-handoff (CHAT-13): this host's dashboard only; the lane is read once owned, so the status survives the
  // ownership moving to the successor.
  const [handoffLane, setHandoffLane] = createSignal<string>()
  createEffect(() => { const lane = ownedLane()?.lane; if (lane) setHandoffLane(lane) })
  const selfHandoff = createSelfHandoff({ editspace: () => remote ? undefined : currentEditspace() ?? undefined, lane: handoffLane, session: sessionID })
  createEffect(on(() => [currentEditspace(), handoffLane()] as const, () => void selfHandoff.refresh()))
  const selfHandoffGate = () => remote ? "Hand off is available on its own host"
    : dashboard.selfHandoff() !== SELF_HANDOFF_VERSION ? "This host's dashboard does not offer self-handoff yet" : undefined
  const predecessor = () => {
    const edge = handoffChain(sessionID, lineage())
    return edge && (remote || activity.session(edge.predecessor)) ? edge : undefined
  }
  // Draft recovery into a successor is this host's flow; another host's handoff gets a plain link (remoteSuccessor).
  const nextHandoff = () => {
    if (remote) return undefined
    const edge = handoffNext(sessionID, lineage())
    return edge && activity.session(edge.successor) ? edge : undefined
  }
  const successor = () => remote ? undefined : successorFor(sessionID, lineage(), lineageOwners())
  const remoteSuccessor = () => remote ? successorFor(sessionID, lineage(), hostLineage()?.owners ?? []) : undefined
  const hostTitle = (id: string) => dashboard.work.feeds().find((feed) => feed.host.id === sessionHost.id)?.state().rows.find((row) => row.id === id)
  const sessionLabel = (id: string) => (remote ? hostTitle(id)?.title : activity.session(id)?.title) ?? id
  const sessionDir = (id: string) => (remote ? hostTitle(id)?.directory : activity.session(id)?.directory) ?? directory
  const [wasOwner, setWasOwner] = createSignal(false)
  let ownershipChecked = false
  createEffect(() => {
    if (ownershipChecked || !state() || handoffs.loading) return
    ownershipChecked = true
    setWasOwner(!!ownedLane())
  })
  const [handoffTask, setHandoffTask] = createSignal("")
  const [handoffNotes, setHandoffNotes] = createSignal("")
  const [handoffOpen, setHandoffOpen] = createSignal(false)
  const [handingOff, setHandingOff] = createSignal(false)
  const [handoffError, setHandoffError] = createSignal("")
  const [handoffPending, setHandoffPending] = createSignal(false)
  const [recovering, setRecovering] = createSignal(false)
  const [recoveryError, setRecoveryError] = createSignal("")
  const [subscriptionsOpen, setSubscriptionsOpen] = createSignal(false)
  const [laneMailOpen, setLaneMailOpen] = createSignal(false)
  const location = () => remote ? undefined : mailLocation(directory, editspaces()?.editspaces ?? [], sessionID)
  const mailName = useMailNamer(() => location()?.name)
  const [mail, { refetch: refetchMail }] = createResource(
    () => {
      const scope = location()
      if (!scope) return
      return { ...scope, revision: mailRevision() }
    },
    (scope) => Promise.all([
      es.mail(scope.name, { session: sessionID }),
      ...(scope.lane !== undefined ? [es.mail(scope.name, { lane: scope.lane })] : []),
    ]).then(
      (results) => ({ editspace: scope.name, lane: scope.lane ?? "", messages: [...new Map(
        results.flatMap(result => result.messages).map(canonicalMail).map(message => [message.id, message]),
      ).values()], error: "" }),
       (failure: unknown) => ({ editspace: scope.name, lane: scope.lane ?? "", messages: [], error: `Unable to load mail: ${String(failure)}` }),
    ),
  )
  // A failed mail read retries on its own; otherwise one outage would stick until the next mail revision.
  createEffect(() => {
    if (!mail()?.error) return
    const timer = setTimeout(() => void refetchMail(), 5000)
    onCleanup(() => clearTimeout(timer))
  })
  const [todoUpdate, setTodoUpdate] = createSignal<{ messageID?: string; at: number }>()
  const findRemovals = new Set<(messageID: string) => void>()
  const live = useLiveSession(sessionID, directory, (event) => {
    hostActivity?.apply(event)
    if (event.type.startsWith("session.input.")) void composer.refreshInputs()
    if (event.type === "message.removed" && event.properties?.sessionID === sessionID && typeof event.properties.messageID === "string")
      findRemovals.forEach((remove) => remove(event.properties!.messageID))
    if (event.type === "todo.updated" && event.properties?.sessionID === sessionID)
      setTodoUpdate({ messageID: live.data.message[sessionID]?.findLast((message) => message.role === "user")?.id, at: Date.now() })
  }, props.host)
  // The composer is usable once the session record is known. Stream reconnects, snapshot refreshes
  // and slow status reads never disable typing or sending (ux-feel INTERACTION.md: typing never
  // waits; sending never waits on status); sends go through durable /input with a request ID.
  const connected = () => !!session()
  // While the event stream is down the live status may be stale.
  const statusUnknown = () => !!live.connectionError()
  // Journal what opening this session costs: transcript shown, then input usable.
  const opened = perfSpan("session.open", { sessionID, cached: live.loaded() })
  let transcriptMs: number | undefined
  createEffect(() => {
    if (live.loaded() && transcriptMs === undefined) {
      transcriptMs = Math.round(opened.elapsed())
      perfReady("history", { sessionID, openMs: transcriptMs })
    }
    if (connected()) {
      perfReady("target", { sessionID, openMs: Math.round(opened.elapsed()) })
      targetReady()
      opened.end("ok", { transcriptMs })
    }
  })
  onCleanup(() => opened.end("left", { transcriptMs }))
  createEffect(() => {
    const current = session()
    if (current) composer.observeSessionModel(current)
  })
  createEffect(() => {
    if (!connected()) return
    untrack(async () => {
      await composer.loadCapabilities()
      await composer.refreshInputs()
    })
  })
  // A send whose answer was lost is read back at once rather than at the next 5 s tick.
  createEffect(() => {
    const id = composer.state.admission?.payload.requestID
    if (id && composer.state.inputChecks[id] === "checking") untrack(() => void composer.refreshInputs())
  })
  onMount(() => {
    const timer = window.setInterval(() => {
      if (!connected() || pageHidden()) return
      // Capabilities that failed to load (slow daemon) retry here; Steer/Queue stay disabled until then.
      if (composer.state.capabilityError) void composer.loadCapabilities()
      // Only while this composer has an input in flight, pending or set aside; session.input.* events cover the rest.
      const state = composer.state
      if (state.admission || state.recoveries.length || Object.keys(state.inputChecks).length || Object.keys(state.inputEdits).length ||
        (state.normalSubmission && state.normalSubmission.status !== "accepted") ||
        state.receipts.some((receipt) => receipt.state === "pending")) void composer.refreshInputs()
    }, 5000)
    onCleanup(() => window.clearInterval(timer))
  })
  onMount(() => { void activity.refreshDirectory(directory) })
  onMount(() => {
    promptEl?.setSelectionRange(...activeDraft().selection)
    const requested = sessionStorage.getItem("es-app-focus-session") === sessionID
    if (requested) sessionStorage.removeItem("es-app-focus-session")
    const focused = document.activeElement
    if (requested || !(focused instanceof HTMLElement && focused.closest("input, textarea, select, button, [contenteditable]"))) {
      promptEl?.focus({ preventScroll: true })
    }
  })

  // chat stick-to-bottom. Scroll events only ever RE-stick (at bottom) —
  // they must never unstick: programmatic pins deliver their scroll events
  // asynchronously, so content growth between a pin and its event would
  // read as "user scrolled up" and strand the view short of the bottom.
  // Unsticking happens only on explicit intent: wheel-up, touch, ^u, jumps.
  // A linked message opens where it is, not at the bottom.
  let stick = !untrack(() => props.anchor?.())
  // The linked message held in view until the user scrolls or the highlight ends.
  let anchorHold: HTMLElement | undefined
  const atBottom = () =>
    !!transcriptEl && transcriptEl.scrollHeight - transcriptEl.scrollTop - transcriptEl.clientHeight < 4
  const pin = () => {
    if (transcriptEl && !inspecting) transcriptEl.scrollTop = transcriptEl.scrollHeight
  }
  let userScroll = false
  const loadEarlier = async () => {
    if (!transcriptEl || live.loadingOlder()) return
    if (!live.hasOlder()) return loadEarlierSession()
    stick = false
    userScroll = false
    // Measure before mounting held-back rows so the restore below covers them too.
    const height = transcriptEl.scrollHeight
    const top = transcriptEl.scrollTop
    mountAll()
    try {
      await live.older()
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
      if (transcriptEl) transcriptEl.scrollTop = top + transcriptEl.scrollHeight - height
    } catch (failure) {
      setError(`Unable to load earlier messages: ${errorText(failure)}`)
    }
  }
  // Past this session's first message: older rows of the top earlier session, else the next earlier session. The row
  // at the top of the view keeps its place on screen while rows are added above it.
  let earlierLoading = false
  // The anchor hold outlives its load until late layout settles, a new load starts, or the reader scrolls.
  let anchorHoldTimer: ReturnType<typeof setTimeout> | undefined
  let anchorHoldObserver: ResizeObserver | undefined
  const releaseAnchorHold = () => {
    clearTimeout(anchorHoldTimer)
    anchorHoldTimer = undefined
    anchorHoldObserver?.disconnect()
    anchorHoldObserver = undefined
  }
  onCleanup(releaseAnchorHold)
  // Wait for the scroll to settle before loading: the anchor must be the message in view after the
  // gesture, not a transient position while the wheel/scroll is still arriving.
  let earlierTimer: ReturnType<typeof setTimeout> | undefined
  const scheduleEarlier = () => {
    clearTimeout(earlierTimer)
    earlierTimer = setTimeout(() => { earlierTimer = undefined; void loadEarlier() }, 500)
  }
  onCleanup(() => clearTimeout(earlierTimer))
  const loadEarlierSession = async () => {
    if (!transcriptEl || earlierLoading || !live.loaded()) return
    const ids = shownIDs()
    const top = ids.length ? segments[ids[0]!] : undefined
    if (top && !top.ready()) return
    if (!top?.hasOlder() && !earlierLeft()) return
    earlierLoading = true
    releaseAnchorHold()
    stick = false
    userScroll = false
    mountAll()
    const anchor = [...transcriptEl.querySelectorAll<HTMLElement>("[data-find-message]")]
      .find((element) => element.getBoundingClientRect().bottom > transcriptEl!.getBoundingClientRect().top)
    const offset = anchor ? anchor.getBoundingClientRect().top : 0
    const keep = () => { if (anchor && transcriptEl) transcriptEl.scrollTop += anchor.getBoundingClientRect().top - offset }
    // The earlier session's first page can mount long after its segment reads ready (background QoS). Keep
    // the anchor on every content resize until layout has been quiet for a while, then stop.
    const hold = () => {
      clearTimeout(anchorHoldTimer)
      anchorHoldTimer = setTimeout(releaseAnchorHold, 10_000)
    }
    const observer = inner && typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => { keep(); hold() }) : undefined
    if (inner) { observer?.observe(inner); hold() }
    anchorHoldObserver = observer
    try {
      if (top?.hasOlder()) await top.older()
      else {
        setShownEarlier((count) => count + 1)
        const next = shownIDs()[0]!
        // Holds the anchor while the earlier session's first page arrives and renders.
        for (let frame = 0; frame < 600 && !segments[next]?.ready(); frame++) {
          keep()
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
        }
      }
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
      keep()
    } finally {
      earlierLoading = false
      keep()
      if (observer) hold()
      else {
        // No ResizeObserver (older client): fall back to a few frames of manual keeps.
        for (let frame = 0; frame < 60; frame++) {
          keep()
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
        }
      }
    }
  }
  const inspectSubagent = (id: string) => {
    if (inspecting || !/^ses_[A-Za-z0-9]+$/.test(id) || id === sessionID) return
    // Only Task metadata authorizes child inspection, never IDs in prose/output.
    const trusted = messages().some((message) => live.data.part[message.id]?.some((part) =>
      part.type === "tool" && part.tool === "task" && "metadata" in part.state && part.state.metadata?.sessionId === id,
    ))
    if (!trusted) return
    const focus = document.activeElement
    const scroll = transcriptEl?.scrollTop ?? 0
    const wasStuck = stick
    inspecting = true
    void dialog.show(() => <SessionHostProvider value={sessionHost}><SubagentTranscript sessionID={id} directory={activity.session(id)?.directory || directory}
      onDispose={() => {
        inspecting = false
        queueMicrotask(() => {
          if (focus instanceof HTMLElement && focus.isConnected) focus.focus({ preventScroll: true })
          if (transcriptEl) transcriptEl.scrollTop = scroll
          stick = wasStuck
        })
      }} /></SessionHostProvider>)
  }
  onCleanup(() => { if (inspecting) dialog.close() })
  let firstLoad: Promise<void> | undefined
  onMount(() => {
    firstLoad = live.load()
    firstLoad
      .then(() => { if (!props.anchor?.()) pin() })
      .catch(() => {}) // live.connectionError reports load failures and recovery
    transcriptEl?.addEventListener(
      "scroll",
      () => {
        schedulePromptPosition()
        if (!inspecting && atBottom()) stick = true
        if (userScroll) releaseAnchorHold()
        if (userScroll && transcriptEl && transcriptEl.scrollTop <= 200) scheduleEarlier()
        userScroll = false
      },
      { passive: true },
    )
    transcriptEl?.addEventListener(
      "wheel",
      (e) => {
        anchorHold = undefined
        if (e.deltaY < 0) {
          stick = false
          userScroll = true
          if (transcriptEl?.scrollTop === 0) scheduleEarlier()
        }
      },
      { passive: true },
    )
    transcriptEl?.addEventListener("touchmove", () => { stick = false; userScroll = true; anchorHold = undefined; releaseAnchorHold() }, { passive: true })
    const observer = new ResizeObserver(() => {
      if (stick) pin()
      // Late-rendering content (Markdown, images) must not push a linked message out of view.
      else if (anchorHold?.isConnected) anchorHold.scrollIntoView({ block: "start", inline: "nearest" })
      schedulePromptPosition()
    })
    if (inner) observer.observe(inner)
    onCleanup(() => observer.disconnect())
    // The composer growing or shrinking resizes the transcript's viewport, not its content. A view that was at the
    // bottom stays there; a reader scrolled up keeps the same messages in view (scrollTop is unchanged).
    // Both the composer and the outgoing rows can grow in the same frame (a Steer gains its row while the draft
    // image leaves the composer). Measure "was at the bottom" against the sizes from before that frame, or the new
    // content height makes a pinned transcript look scrolled up and the re-pin is skipped.
    let viewportHeight = transcriptEl?.clientHeight ?? 0
    let contentHeight = transcriptEl?.scrollHeight ?? 0
    const viewport = new ResizeObserver(() => {
      if (!transcriptEl) return
      const wasBottom = contentHeight - transcriptEl.scrollTop - viewportHeight < 4
      viewportHeight = transcriptEl.clientHeight
      contentHeight = transcriptEl.scrollHeight
      if (stick && wasBottom) pin()
    })
    if (transcriptEl) viewport.observe(transcriptEl)
    onCleanup(() => viewport.disconnect())
  })
  const [error, setError] = createSignal("")

  const pending = createMemo(() => activity.pending(sessionID))
  const pendingQuestions = createMemo(() => pending().flatMap((item) => item.kind === "question" ? [item] : []))
  const subagentsRunning = () => activity.error(sessionID, directory) ? 0 :
    activity.running(sessionID).filter((id) => id !== sessionID).length
  const attentionError = () => (remote ? "" : sessionsError()) || activity.error(sessionID, directory)

  const session = () => live.data.session[0]
  // One continuous transcript (DD #857/#858): earlier sessions of this one's verified chain load above it on scroll-up,
  // read-only, each from its own host. The desk follows the home pointer; other sessions their lane's handoff edges.
  const [segments, setSegments] = createStore<Record<string, SegmentControl>>({})
  const [shownEarlier, setShownEarlier] = createSignal(0)
  const chain = createMemo((): Chain => {
    if (!desk()) {
      // Another host's chain is that host's own lineage; here an earlier session must also be known to this host.
      const value = laneChain(sessionID, lineage())
      const known = remote ? value.links.length : value.links.findIndex((link) => !activity.session(link.session))
      return known === -1 ? value : { links: value.links.slice(0, known) }
    }
    const earlier = (deskChat?.desk.earlier() ?? []).filter((entry) => entry.from === "home")
      .map((entry) => ({ session: entry.session, directory: entry.directory, ...(entry.host ? { host: entry.host } : {}), ...(entry.until ? { until: entry.until } : {}) }))
    return deskChain(sessionID, earlier, (id) => successionPredecessor(id === sessionID ? live.data.session[0]?.metadata : segments[id]?.metadata()))
  })
  const shownIDs = createMemo(() => chain().links.slice(0, shownEarlier()).map((link) => link.session).reverse(), [],
    { equals: (a, b) => a.length === b.length && a.every((id, index) => id === b[index]) })
  const earlierLeft = () => chain().links.length > shownEarlier()
  const earlierHref = (link: ChainLink) => {
    const dir = link.directory ?? sessionDir(link.session)
    return link.host ? `${sessionHref(link.session, dir)}&host=${encodeURIComponent(link.host.id)}` : hrefFor(link.session, dir)
  }
  const status = () => live.data.session_status[sessionID]?.type ??
    (!activity.error(sessionID, directory) ? activity.status(sessionID) : undefined) ?? "idle"
  const messages = createMemo(() => live.data.message[sessionID] ?? [])
  const echo = createMemo(() => pendingEcho(composer.state.normalSubmission, messages().map((message) => ({
    id: message.id,
    role: message.role,
    text: message.role === "user"
      // Typed text only: attached context arrives as synthetic text parts of the same message.
      ? (live.data.part[message.id] ?? []).flatMap((part) => part.type === "text" && !part.synthetic ? [part.text] : []).join("")
      : undefined,
  }))))
  createEffect(() => {
    const visible = echo()
    if (visible && stick) queueMicrotask(pin)
    // The canonical message settles the send, including an unknown outcome: matched by its message ID,
    // or for a legacy send by text after the send boundary. A legacy send without a boundary could match
    // an older identical message, so its unknown outcome stays until the user dismisses it.
    const submission = composer.state.normalSubmission
    if (visible || !submission) return
    // An unknown send seen in the transcript is confirmed by ID first, which also clears its restored
    // draft if unchanged, so the editor is not left holding a message that was already delivered.
    if (submission.status === "unknown" && submission.messageID) untrack(() => void composer.checkSubmission())
    else if (submission.status === "accepted" || submission.status === "unknown" && submission.after !== undefined)
      untrack(() => composer.dismissNormalSubmission())
  })
  const inlineError = () => {
    const latest = messages().at(-1)
    return latest?.role === "assistant" && latest.error?.name !== "MessageAbortedError" && latest.error
      ? errorText(latest.error) : ""
  }
  const bannerError = () => {
    const value = live.error()
    return error() || (value !== inlineError() ? value : "")
  }
  const transcriptQuestionTools = createMemo(() => new Set(messages().flatMap((message) =>
    (live.data.part[message.id] ?? []).flatMap((part) =>
      part.type === "tool" && part.tool === "question" ? [`${message.id}\u0000${part.callID}`] : [],
    ),
  )))
  const appendedQuestions = createMemo(() => pendingQuestions().filter((item) =>
    !item.request.tool || !transcriptQuestionTools().has(`${item.request.tool.messageID}\u0000${item.request.tool.callID}`),
  ))
  const QuestionPart = (partProps: MessagePartProps) => {
    const part = () => partProps.part as ToolPart
    const item = createMemo(() => pendingQuestions().find((pending) =>
      pending.request.tool?.messageID === partProps.message.id && pending.request.tool.callID === part().callID,
    ))
    const owner = () => {
      const request = item()?.request
      if (!request || request.sessionID === sessionID) return
      return activity.session(request.sessionID)?.title ?? request.sessionID
    }
    return <InlineQuestion part={part()} request={item()?.request} directory={item()?.directory ?? directory} owner={owner()}
      onDone={() => item() ? activity.refreshDirectory(item()!.directory, true) : Promise.resolve()} />
  }
  const renderTools = { question: QuestionPart, todowrite: TodoPart }
  // Every session has a source-time lower bound, including those without a handoff.
  const timeline = createMemo<ReturnType<typeof mailRows>>((previous) => {
    const feed = mail()
    const next = nextHandoff()
    return mailRows(messages(), feed, previous, {
      sessionID,
      lane: location()?.lane,
      from: session()?.time.created ?? Number.POSITIVE_INFINITY,
      to: next ? activity.session(next.successor)?.time.created : undefined,
    })
  })
  // Opening a session mounts only the newest rows on the click path; older rows mount in small
  // idle chunks after the first paint (prepended above, so the bottom-pinned view does not move).
  // Every DOM lookup across the transcript (find, links, prompt jumps) mounts the rest first.
  const [mountedRows, setMountedRows] = createSignal(INITIAL_ROWS)
  const visibleTimeline = createMemo(() => {
    const rows = timeline()
    return rows.length > mountedRows() ? rows.slice(rows.length - mountedRows()) : rows
  })
  const mountAll = () => setMountedRows(Number.POSITIVE_INFINITY)
  // A transcript that arrives within the delay replaces the empty view directly; the skeleton
  // appears only for slower loads. Content that arrives after the skeleton fades in once.
  const [skeletonDue, setSkeletonDue] = createSignal(false)
  const [arrived, setArrived] = createSignal(false)
  onMount(() => {
    if (live.loaded()) return
    const timer = setTimeout(() => setSkeletonDue(true), SKELETON_DELAY_MS)
    onCleanup(() => clearTimeout(timer))
  })
  createEffect(() => { if (skeletonDue() && live.loaded()) setArrived(true) })
  /** Mount rows from the newest back to this message only (find hits, links). */
  const mountThrough = (messageID: string) => {
    const rows = timeline()
    const index = rows.findIndex((row) => row.type !== "mail" && row.message.id === messageID)
    if (index === -1) return mountAll()
    setMountedRows((count) => Math.max(count, rows.length - index))
  }
  // Grows whenever rows exist beyond the mounted window: after the first load, a reconnect
  // snapshot, or older pages, so a transcript never stays partly mounted.
  let growHandle: number | undefined
  const idle = (run: () => void) => typeof requestIdleCallback === "function"
    ? requestIdleCallback(run, { timeout: 500 }) : setTimeout(run, 50) as unknown as number
  const grow = () => {
    growHandle = undefined
    if (mountedRows() >= timeline().length) return
    // Rows mount above the reader. Keep the visible content where it is in the same task (Solid
    // updates the DOM synchronously), so no frame paints shifted content before a later pin.
    const fromBottom = transcriptEl ? transcriptEl.scrollHeight - transcriptEl.scrollTop : 0
    setMountedRows((count) => count + ROW_CHUNK)
    if (transcriptEl && !inspecting) transcriptEl.scrollTop = transcriptEl.scrollHeight - fromBottom
    growHandle = idle(grow)
  }
  createEffect(() => {
    if (growHandle !== undefined || timeline().length <= mountedRows()) return
    // Wait for the newest rows to paint before mounting older ones.
    requestAnimationFrame(() => { if (growHandle === undefined) growHandle = idle(grow) })
  })
  onCleanup(() => {
    if (growHandle === undefined) return
    if (typeof cancelIdleCallback === "function") cancelIdleCallback(growHandle)
    clearTimeout(growHandle)
  })
  const mailIDs = createMemo(() => new Set(mail()?.messages.map((message) => message.id) ?? []))
  const transcriptMailIDs = createMemo(() => new Set(timeline().flatMap(row => {
    const id = row.type === "mail" ? row.message.id : mailSourceID(row.message)
    return id ? [id] : []
  })))
  const mailRecords = createMemo(() => new Map(mail()?.messages.map((message) => [message.id, message] as const) ?? []))
  // Mail tool rows (Laptop2627) read receipts on the session's own host: another Work host's session reads that host's
  // dashboard, and is reread when the session's status changes there; this host's on its mail revision.
  // A host whose dashboard does not answer JSON here (an older or refusing listener) has no receipts to show, not an error.
  const [hostEditspaces] = createResource(() => remote ? sessionHost.id : undefined, (host) => fetch(`${hostPrefix(host)}/es/api/editspaces`, { credentials: "include" })
    .then((response) => response.ok && response.headers.get("content-type")?.includes("application/json")
      ? response.json().then((body: { editspaces?: { name: string; root: string }[] }) => Array.isArray(body?.editspaces) ? body as { editspaces: { name: string; root: string }[] } : undefined, () => undefined)
      : undefined, () => undefined))
  const receiptRecords = createMailReceiptRecords({ prefix: remote ? hostPrefix(sessionHost.id!) : "", host: remote ? sessionHost.id : undefined, directory, session: sessionID,
    editspaces: () => remote ? hostEditspaces()?.editspaces : editspaces()?.editspaces, revision: () => remote ? status() : mailRevision() })
  // Incoming mail this session's agent has not been shown (DD #414): its rows say so, one bar offers Wake now.
  const unreadMail = createMemo(() => mail()?.messages.filter((message) => message.direction === "received" && mailUnread(message.deliveries, sessionID)).length ?? 0)
  const mailWake = createMailWake({ editspace: () => location()?.name, session: sessionID, unread: unreadMail, revision: mailRevision })
  const mailReplied = createMemo(() => new Set(mail()?.messages.flatMap((message) => message.in_reply_to ? [message.in_reply_to] : []) ?? []))
  const mailCauseRows = createMemo(() => mailCauses(timeline(), mailRecords()))

  // viewing the session clears its unread state, including as new content
  // streams in while the page is open
  const { markViewed, refetchArchived } = dashboard


  // busy with nothing visibly moving (no running tool, no streaming part):
  // the model is thinking or the first token hasn't landed — show the busy dot
  const thinking = createMemo(() => {
    if (live.error() || live.connectionError() || error() || pending().length) return false
    const st = status()
    if (st !== "busy" && st !== "retry") return false
    const msgs = messages() as any[]
    const last = msgs[msgs.length - 1]
    if (!last || last.role === "user") return true
    const parts = (live.data.part[last.id] ?? []) as any[]
    const lastPart = parts[parts.length - 1]
    if (!lastPart) return true
    if (lastPart.type === "tool") {
      const s = lastPart.state?.status
      return !(s === "running" || s === "pending")
    }
    // text/reasoning still streaming renders its own motion
    return !!lastPart.time?.end
  })

  const busy = () => !live.error() && (status() === "busy" || status() === "retry")
  // Quiet turns (Front desk chat only): folded, and never unread (quiet-turns.ts). Declared after busy(): the memo
  // runs at creation and reads it.
  const quiet = createMemo(() => props.quiet ? quietTurns(messages(), (id) => live.data.part[id] ?? [], !busy()) : new Map())
  const [quietOpen, setQuietOpen] = createSignal<ReadonlySet<string>>(new Set())
  // Unread state is this page's host's; another host's same session ID must not clear it. A hidden Front desk chat
  // marks itself viewed only while nothing with text is new, so a quiet turn never leaves it unread and a reply does.
  onMount(() => { if (!remote && !props.hidden?.()) markViewed(sessionID, true) })
  let audibleSeen = 0
  createEffect(() => {
    messages()
    status()
    const audible = props.quiet ? lastAudible(messages(), quiet()) : 0
    if (remote) return
    if (!props.hidden?.()) { audibleSeen = audible; return markViewed(sessionID) }
    if (props.quiet && audible <= audibleSeen) markViewed(sessionID)
  })
  // Daemon trouble shares one status slot, shown only once it persists: brief
  // stalls change nothing visible and cannot stack banners. Auxiliary dashboard
  // reads (mail, handoffs) report inside their own panels instead.
  const backendError = () => [live.connectionError(), attentionError()].filter(Boolean).join("\n")
  let wasDisconnected = false
  createEffect(() => {
    const down = !!live.connectionError()
    // Activity otherwise waits for its next poll and would keep the slot red after recovery.
    if (wasDisconnected && !down) void activity.refreshDirectory(directory, true)
    wasDisconnected = down
  })
  const trouble = createMemo(() => backendError() ? "disconnected" : live.loading() ? "waiting-daemon" : "")
  const [shownTrouble, setShownTrouble] = createSignal("")
  createEffect(() => {
    const kind = trouble()
    if (!kind) return setShownTrouble("")
    const timer = setTimeout(() => {
      setShownTrouble(kind)
      perfEvent("session.trouble", { sessionID, trouble: kind, error: backendError().slice(0, 160) })
    }, STATUS_DELAY_MS)
    onCleanup(() => clearTimeout(timer))
  })
  const workState = createMemo(() => {
    if (live.error()) return "failed"
    if (shownTrouble() === "disconnected" && trouble() === "disconnected") return "disconnected"
    if (pending().length) return "waiting"
    if (status() === "retry") return "retry"
    if (busy() || subagentsRunning()) return "working"
    if (shownTrouble() && trouble()) return "stale"
    return "idle"
  })
  // The open session's work line is the view's one animated busy indicator (CSS halo, compositor-only).
  const briefInput = createMemo(() => {
    const current = messages().slice(Math.max(0, messages().findLastIndex((message) => message.role === "user")))
    const tools = current.flatMap((message) => message.role !== "assistant" ? [] :
      (live.data.part[message.id] ?? []).flatMap((part) => part.type === "tool" ? [part] : []))
    const todoTool = tools.findLast((part) => part.tool === "todowrite" && part.state.status === "completed")
    // Persisted TODOs outlive prompts. Only a write in this turn makes them current.
    const todoAt = todoUpdate()?.messageID === current[0]?.id ? todoUpdate()?.at :
      todoTool?.state.status === "completed" ? todoTool.state.time.end : undefined
    const lane = (remote ? [] : state()?.threads ?? []).flatMap((thread: { lanes?: {
      owner: string; activity?: string; activity_at?: string; activity_session?: string
    }[] }) => thread.lanes ?? []).find((lane: { owner: string }) => lane.owner === sessionID)
    return {
      sessionID,
      status: connected() ? busy() || subagentsRunning() ? "busy" as const : "idle" as const : "unknown" as const,
      report: lane?.activity && lane.activity_session && lane.activity_at ? {
        sessionID: lane.activity_session,
        owner: lane.owner,
        text: lane.activity,
        at: Date.parse(lane.activity_at),
      } : undefined,
      todos: busy() && todoAt !== undefined ? live.data.todo : undefined,
      todoAt,
      tools: !busy() ? [] : tools.map((part) => ({
          name: part.tool,
          status: part.state.status,
          sessionID: part.sessionID,
          at: part.state.status === "running" ? part.state.time.start : undefined,
        })),
    }
  })
  // What a waiting steer is waiting on: steers are delivered only once the turn's tool calls finish.
  const runningTool = createMemo(() => {
    const tool = briefInput().tools.findLast((item) => item.status === "running")
    return tool ? { name: tool.name, at: tool.at } : undefined
  }, undefined, { equals: (a, b) => a?.name === b?.name && a?.at === b?.at })
  // The work line already animates while busy, so the transcript tail shows the same dot static.
  const Thinking = () => <div class="thinking" title="waiting for the agent's first output"><span class="busy-dot" data-animate aria-hidden="true" /></div>
  // Status words live in the dot's label; only what the person may act on stays as text (a reply, a failure).
  const WorkStatus = () => (
    <div class="session-work-status" role="status" data-state={workState()} title={backendError() || undefined}>
      <span class={`dot ${chatDot(workState()).dot}`} data-chat-dot={chatDot(workState()).dot} role="img"
        aria-label={chatDot(workState()).label} title={[chatDot(workState()).label, workState() === "stale" || workState() === "disconnected"
          ? live.loaded() ? "showing saved transcript" : "" : ""].filter(Boolean).join(": ")} />
      <Show when={workState() === "working" || workState() === "retry" || workState() === "idle"} fallback={<>
        <Show when={workState() === "waiting" || workState() === "failed"}>
          <span>{workState() === "waiting" ? "Waiting for your reply" : `Session failed — see error ${inlineError() ? "in conversation" : "above"}`}</span>
        </Show>
        <Show when={workState() === "failed" && !remote}><FailureRetry sessionID={sessionID} /></Show>
      </>}>
        <Show when={!["Working", "Idle", "Activity unknown"].includes(activityBrief(briefInput(), Date.now()).text)}><ActivityBriefView input={briefInput()} /></Show>
      </Show>
      <Show when={workState() === "disconnected"}>
        <button disabled={live.loading()} onClick={() => {
          void live.reconnect()?.catch(() => {})
          void activity.refreshDirectory(directory, true)
        }}>reconnect</button>
      </Show>
    </div>
  )
  createEffect(() => {
    // Unknown status routes like busy: a steer through durable /input, never a plain prompt_async.
    const running = busy() || statusUnknown()
    if (!connected()) return
    untrack(() => composer.observeBusy(running))
  })

  // --- abort / fork ------------------------------------------------------

  // fire-and-forget: the status SSE flips busy->idle, no local state to sync
  const [aborting, setAborting] = createSignal(false)
  const [nudgePhase, setNudgePhase] = createSignal<"stopping" | "resuming">()
  const abort = async () => {
    // A read-only host is never stopped from this page (Ctrl+C Ctrl+C included).
    if (sessionHost.readOnly || aborting() || nudgePhase() || sending() || !busy()) return
    setAborting(true)
    try {
      await oc.abort(sessionID, directory)
    } catch (e) {
      setError(String(e))
    } finally {
      setAborting(false)
    }
  }

  // Ctrl+C twice within 400 ms stops the busy turn of this page's session (on its own
  // host). A Ctrl+C with selected text is a copy and resets the count; repeats, IME and
  // other modifiers never count. Esc only leaves modes and closes things.
  let lastEsc = 0
  const stopTap = (e: KeyboardEvent) => {
    if (!matchShortcut(e, "stopTurn") || e.repeat) return false
    // An open modal (What's new, image viewer, shortcut help) owns the keyboard.
    if (document.querySelector("dialog[open], [role='dialog'][aria-modal='true']")) return false
    if (hasSelectedText(e.target)) {
      lastEsc = 0
      return false
    }
    if (!busy() || sessionHost.readOnly) return false
    e.preventDefault()
    const now = Date.now()
    if (now - lastEsc < 400) {
      lastEsc = 0
      abort()
      return true
    }
    lastEsc = now
    return true
  }

  const [forking, setForking] = createSignal(false)
  const [changingModel, setChangingModel] = createSignal(false)
  const fork = async (messageID?: string) => {
    if (forking()) return
    setForking(true)
    try {
      const next = await oc.fork(sessionID, directory, messageID)
      navigate(sessionHref(next.id, directory))
    } catch (e) {
      setError(String(e))
      setForking(false)
    }
  }

  // archive is a soft flag (time.archived); the live store doesn't reduce
  // session.updated events, so reload it to reflect the new state
  const setArchived = async (archived: boolean) => {
    try {
      await (archived ? oc.archive(sessionID, directory) : oc.unarchive(sessionID, directory))
      await live.load()
      refetchArchived() // moves it between the sidebar's sections immediately
    } catch (e) {
      setError(String(e))
    }
  }

  const remove = async () => {
    if (!window.confirm("Delete this session permanently?")) return
    try {
      await oc.remove(sessionID, directory)
      refetchArchived()
      navigate("/")
    } catch (e) {
      setError(String(e))
    }
  }

  // "forked from …" breadcrumb target (child sessions carry parentID)
  // Passive-review wake records (frozen covered mail); refreshed with mail. Without them markers still
  // render from the transcript, only without a mail count.
  const [wakeEvents] = createResource(
    () => { const scope = location(); return scope ? { name: scope.name, revision: mailRevision() } : undefined },
    (scope) => es.wakeEvents(scope.name, sessionID).then((result) => new Map(result.events.map((event): [string, WakeEvent] => [event.id, event])), () => new Map<string, WakeEvent>()),
  )
  const scrollToMail = (id: string) => {
    mountAll()
    requestAnimationFrame(() => document.querySelector(`[data-mail-id="${CSS.escape(id)}"], #${CSS.escape(`mail-${id}`)}`)?.scrollIntoView({ block: "center" }))
  }
  const [parent] = createResource(
    () => (session() as any)?.parentID as string | undefined,
    (pid) => oc.session(pid, directory).catch(() => null),
  )

  // TUI-style turn footer, keyed by the turn's final assistant message id:
  // agent, model, wall-clock (user prompt -> completed), and an interrupted
  // marker for aborted turns. In-flight turns are omitted until they complete
  // or get aborted.
  // Times are kept apart: when the turn's prompt arrived (started), when this final reply began (replied) and when the
  // turn completed or was interrupted (ended). A time Core did not record is omitted, never substituted.
  type TurnState = "completed" | "interrupted" | "error" | "cancelled"
  type TurnSummary = { messageID: string; agent?: string; providerID?: string; modelID?: string; duration?: number; state: TurnState
    started?: number; replied?: number; ended?: number; copyPartID?: string; copyMessageID?: string; copyText?: string; endsInText: boolean }
  // Parent prompt IDs of finished agent turns (see completedTurns). Controls the
  // footer and which tool calls may coalesce, so live turns stay fully visible.
  const turnsDone = createMemo(() => {
    const waiting = new Set(pending().flatMap((item) => item.request.tool
      ? [`${item.request.tool.messageID}\u0000${item.request.tool.callID}`] : []))
    return completedTurns(messages(), {
      parts: (id) => live.data.part[id] ?? [],
      idle: status() === "idle" && !pending().length && !live.connectionError(),
      waiting: (messageID, callID) => waiting.has(`${messageID}\u0000${callID}`),
    })
  }, undefined, { equals: (a, b) => a.size === b.size && [...a].every((id) => b.has(id)) })
  const turnSummaries = createMemo(() => {
    const out = new Map<string, TurnSummary>()
    let turnStart: number | undefined
    let last: any | undefined
    let steps: any[] = []
    // The turn's last text (Copy) and what is visibly last (a text vs a tool/reasoning/no output). Copy is one per
    // turn, on the final message; the footer joins it there when the turn ends in agent text.
    const derive = (message: any) => {
      let copyPartID: string | undefined
      let copyMessageID: string | undefined
      let copyText: string | undefined
      let lastVisible: any | undefined
      for (const step of steps) for (const part of live.data.part[step.id] ?? []) {
        if (part.type === "text" && part.text?.trim()) { copyPartID = part.id; copyMessageID = step.id; copyText = part.text }
        if (renderable(part, true)) lastVisible = part
      }
      const end = message.time?.completed
      const state: TurnState = message.error?.name === "MessageAbortedError" ? "interrupted"
        : message.error || message.finish === "error" ? "error"
        : typeof end === "number" ? "completed"
        : "cancelled"
      out.set(message.id, {
        messageID: message.id,
        agent: message.agent ?? message.mode,
        providerID: message.providerID,
        modelID: message.modelID,
        duration: turnStart !== undefined && end ? end - turnStart : undefined,
        state,
        started: turnStart,
        replied: typeof message.time?.created === "number" ? message.time.created : undefined,
        ended: typeof end === "number" ? end : undefined,
        ...(copyPartID ? { copyPartID } : {}),
        ...(copyMessageID ? { copyMessageID } : {}),
        ...(copyText ? { copyText } : {}),
        endsInText: lastVisible?.type === "text",
      })
    }
    const flush = () => {
      if (last && turnsDone().has(last.parentID)) derive(last)
      last = undefined
      steps = []
    }
    // Message IDs are time-ordered in Core, but a fixture or an imported transcript may not be; sort by the record's
    // own created time so a user prompt always precedes its assistant steps.
    const ordered = [...messages()].sort((a, b) => ((a as any).time?.created ?? 0) - ((b as any).time?.created ?? 0)
      || a.id.localeCompare(b.id))
    for (const m of ordered) {
      const time = (m as any).time ?? {}
      if (m.role === "user") {
        flush()
        turnStart = time.created
      } else {
        // The final assistant step is the turn's footer even when it never completed (a cancelled end).
        last = m
        steps.push(m)
      }
    }
    flush()
    return out
  })

  const modelName = (providerID?: string, modelID?: string) => {
    if (!modelID) return ""
    const prov = (providers()?.providers ?? []).find((p: any) => p.id === providerID)
    return prov?.models?.[modelID]?.name ?? modelID
  }

  const titlecase = (s?: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : "")

  const fmtDuration = (ms: number) => {
    const s = Math.round(ms / 1000)
    if (s < 60) return `${s}s`
    if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`
    return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`
  }

  // One quiet footer per turn: completion time, agent, model, duration, and a state icon only when the turn did not
  // finish cleanly. It rides the Copy row (styled like the user message's hover meta) when the turn ends in agent
  // text; a tool-only or silent end keeps its own always-visible row. No success mark: only interrupted/error/cancelled
  // are marked, with an icon and an accessible label.
  const TurnStateIcon = (props: { state: Exclude<TurnState, "completed"> }) => {
    const icon = () => props.state === "interrupted" ? "stop" : props.state === "error" ? "warning" : "close"
    const label = () => props.state === "interrupted" ? "Interrupted" : props.state === "error" ? "Error" : "Cancelled"
    return <span class="turn-state" data-state={props.state} role="img" aria-label={label()} title={label()}>
      <Icon name={icon()} size="small" />
    </span>
  }
  const TurnFooter = (props: { summary: TurnSummary; copy?: string; standalone?: boolean }) => {
    const [copied, setCopied] = createSignal(false)
    const copy = async () => {
      if (!props.copy) return
      const ok = await navigator.clipboard?.writeText(props.copy).then(() => true, () => false)
      if (!ok) return
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }
    const state = () => props.summary.state
    const endedLabel = () => state() === "interrupted" ? "interrupted" : state() === "error" ? "error" : state() === "cancelled" ? "cancelled" : ""
    const exact = () => [props.summary.started && `Turn started ${exactTime(props.summary.started)}`,
      props.summary.replied && `reply started ${exactTime(props.summary.replied)}`,
      props.summary.ended && `${endedLabel() || "completed"} ${exactTime(props.summary.ended)}`].filter(Boolean).join("; ")
    return <span class="turn-summary" data-state={state()} data-standalone={props.standalone ? "" : undefined}>
      <Show when={state() === "completed" ? undefined : state() as Exclude<TurnState, "completed">}>{value => <TurnStateIcon state={value()} />}</Show>
      <Show when={props.copy}><button type="button" class="turn-copy" aria-label={copied() ? "Copied" : "Copy response"}
        title={copied() ? "Copied" : "Copy response"} onMouseDown={event => event.preventDefault()} onClick={() => void copy()}>
        <Icon name={copied() ? "check" : "copy"} size="small" /></button></Show>
      <span class="turn-meta" dir="auto">
        <Show when={props.summary.ended ?? props.summary.replied}>{(at) =>
          <><time class="turn-time" dateTime={new Date(at()).toISOString()} title={exact()} aria-label={exact()}>
            {props.summary.ended ? `${endedLabel()}${endedLabel() ? " " : ""}` : "replied "}{clockTime(at())} · {ago(at())}</time>{" · "}</>}</Show>
        <span class="agent">{titlecase(props.summary.agent)}</span>
        {" · "}
        {modelName(props.summary.providerID, props.summary.modelID)}
        <Show when={props.summary.duration}>{(d) => <> · {fmtDuration(d())}</>}</Show>
      </span>
    </span>
  }

  const activeDraft = composer.visibleDraft
  const draft = () => activeDraft().text
  const setDraft = composer.setVisibleText
  const images = () => activeDraft().images
  const sending = () => composer.state.sending

  let imageQueue = Promise.resolve()
  const addImageFiles = (files: File[]) => {
    const buffer = composer.state.visibleBuffer
    imageQueue = imageQueue.then(async () => {
      for (const file of files) {
        try {
          const total = composer.state[buffer].images.reduce((sum, image) => {
            const encoded = image.url.slice(image.url.indexOf(",") + 1)
            return sum + (encoded.length / 4) * 3 - (encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0)
          }, 0)
          const prepared = await prepareImageFile(file, composer.state.capabilities?.sessionInput?.images ?? defaultImageCapability, total)
          composer.setImages([
            ...composer.state[buffer].images,
            { id: Math.random().toString(36).slice(2), ...prepared },
          ], buffer)
          composer.setError("")
        } catch (error) {
          composer.setError(error instanceof Error ? error.message : String(error))
        }
      }
    })
  }

  const pasteImages = (e: ClipboardEvent) => {
    const files = [...(e.clipboardData?.items ?? [])]
      .filter((i) => i.kind === "file" && i.type.startsWith("image/"))
      .map((i) => i.getAsFile())
      .filter((f): f is File => !!f)
    if (!files.length) return
    e.preventDefault()
    addImageFiles(files)
  }

  // dropping image files on the composer behaves like paste
  const dropImages = (e: DragEvent) => {
    const files = [...(e.dataTransfer?.files ?? [])].filter((f) => f.type.startsWith("image/"))
    if (!files.length) return
    e.preventDefault()
    addImageFiles(files)
  }

  // Task selections persist on the session; Aside keeps its own draft model.
  const [providers] = createResource(() => providersCached(sessionHost.base, directory))

  const modelChoice = () => composer.state.visibleBuffer === "aside"
    ? composer.state.aside.model
    : composer.state.modelSelection?.model ?? composer.state.task.model ?? composer.state.sessionModel
  const lastTurnModel = createMemo(() => {
    for (let i = messages().length - 1; i >= 0; i--) {
      const m = messages()[i] as any
      if (m.role === "assistant" && m.modelID) return { providerID: m.providerID, modelID: m.modelID }
    }
    const s = session() as any
    return s?.model ? { providerID: s.model.providerID, modelID: s.model.id } : null
  })
  const nextModel = () => composer.state.sessionModel ?? lastTurnModel()
  // The picker opens on the model in use; for an Aside, empty means "use the session model".
  const pickerModel = () => composer.state.visibleBuffer === "aside" ? modelChoice() : modelChoice() ?? nextModel()
  const shownModel = () => modelChoice() ?? nextModel()
  const shownModelName = () => { const model = shownModel(); return model ? modelName(model.providerID, model.modelID) : "Default model" }
  let modelButton: HTMLButtonElement | undefined
  // Closing the picker returns focus to the model button, so the keyboard position is not lost.
  const closeModelPicker = () => {
    setChangingModel(false)
    queueMicrotask(() => modelButton?.focus())
  }
  // Footer meta: context of the latest completed turn against the selected model's window, and the
  // session's estimated cost (the info panel's sources; unknown stays unknown).
  const footerMeta = createMemo(() => {
    const turn = latestCompletedTurn(messages())
    const selected = composer.state.sessionModel ?? nextModel()
    const used = turn ? contextUsage(turn, providers())?.tokens : undefined
    const limit = (selected ? contextLimit(providers(), selected.providerID, selected.modelID) : undefined) ?? (turn && !selected ? contextLimit(providers(), turn.providerID, turn.modelID) : undefined)
    return {
      context: footerContext({ used, limit, selected: selected ? modelName(selected.providerID, selected.modelID) : undefined,
        turnModel: turn ? modelName(turn.providerID, turn.modelID) : undefined }),
      cost: footerCost((session() as { cost?: unknown } | undefined)?.cost, messages().flatMap((message) => message.role === "assistant" ? [message.cost] : [])),
    }
  })

  // Nudge is Core's explicit continuation (POST /session/:id/nudge, capability sessionInput.nudge). Until Core
  // advertises it, Nudge is unavailable everywhere: the old abort + recover + resume-text path is not a nudge.
  const nudgeAvailable = () => false
  const send = async (action?: ComposerAction) => {
    const s = session()
    // While a pending input is open for editing, the composer saves that input and never sends.
    if (!s || !connected() || nudgePhase() || aborting() || composer.editingInput()) return
    const editor = promptEl
    if (editor) saveSelection(editor)
    setError("")
    if (nextHandoff()) {
      // Self-spawn lineage can be committed before a runtime fence exists.
      // Never send more work to a known predecessor, or turn an earlier unknown
      // admission into a definitive rejection.
      setRecoveryError("Message not sent: this session handed off. Open the successor to recover your draft; any earlier unknown send still needs reconciliation.")
      stick = true
      queueMicrotask(pin)
      return
    }
    // Read status again at submission; a mode switch never sends by itself.
    composer.observeBusy(busy() || statusUnknown())
    stick = true
    queueMicrotask(pin)
    // Steer is the one default send; Queue and Aside are chosen explicitly from More send options.
    const chosen = action ?? "steer"
    // Chips always go to the composer: it attaches them or refuses the send with a reason (never sends without
    // them). Generated page context (props.context) rides only where it can be attached and fits (input-context.ts).
    const chips = contextParts()
    const plain = chosen === "steer" && !composer.state.busy
    const context = sendContext({ input: !plain, attaches: composer.contextAttaches(chosen), generated: props.context?.({ input: !plain }) ?? [], chips })
    await composer.submitVisible(chosen, s, nextModel(), messages().at(-1)?.id, context)
    // A plain send is accepted by its message; a steer or queue once its input is admitted (no admission left
    // pending or unknown, and no refusal).
    const accepted = plain ? composer.state.normalSubmission?.status === "accepted" : !composer.state.admission && !composer.state.error
    if (context.length) props.onSent?.(context, accepted, { input: !plain })
    if (chips.length && accepted) setContextRefs([])
  }


  // One resolver for the primary button's label, title, state and Cmd/Ctrl+Enter.
  const primary = () => {
    const draft = composer.visibleDraft()
    return primaryAction({
      hasContent: !!draft.text.trim() || draft.images.length > 0,
      busy: composer.state.busy,
      keyboardTarget: composer.state.keyboardTarget,
      receipts: composer.state.receipts,
      interrupt: !!composer.state.capabilities?.sessionInput?.interrupt,
      delivering: composer.state.delivering,
      nudge: nudgeAvailable(),
      unsettled: !!composer.state.admission || composer.state.normalSubmission?.status === "sending" || composer.state.normalSubmission?.status === "unknown",
      nudging: !!nudgePhase(),
    })
  }
  // Re-resolves at activation, after reading status again, so a race since render cannot pick a stale action.
  const activatePrimary = () => {
    if (!session() || !connected() || aborting() || composer.editingInput()) return
    composer.observeBusy(busy() || statusUnknown())
    const current = primary()
    if (current.disabled) return
    if (current.kind === "send") return void send()
    if (current.kind === "deliver") return void composer.deliverInput(current.requestID)
    // kind "nudge" is disabled until Core's continuation capability exists (see primary()).
  }

  let transcriptEl: HTMLDivElement | undefined
  let pageEl: HTMLElement | undefined
  let inner: HTMLDivElement | undefined
  let promptEl: HTMLTextAreaElement | undefined
  const [findOpen, setFindOpen] = createSignal(false)
  const [findHit, setFindHit] = createSignal<FindHit>()
  let findAnchor: HTMLDivElement | undefined
  let findFocus: Element | null = null
  let findSelection: [number, number, "forward" | "backward" | "none"] | undefined
  let findMode: "normal" | "insert" = "insert"
  let findScroll = 0
  let findStick = false
  let findJumped = false
  const openFind = () => {
    if (findOpen()) {
      document.querySelector<HTMLInputElement>("[data-transcript-find] input")?.focus({ preventScroll: true })
      return
    }
    findFocus = document.activeElement
    lastEsc = 0
    findScroll = transcriptEl?.scrollTop ?? 0
    findStick = stick
    findJumped = false
    stick = false
    findMode = vim.mode()
    findSelection = (findFocus instanceof HTMLTextAreaElement || findFocus instanceof HTMLInputElement) && findFocus.selectionStart !== null
      ? [findFocus.selectionStart ?? 0, findFocus.selectionEnd ?? 0, findFocus.selectionDirection ?? "none"] : undefined
    setFindOpen(true)
  }
  const closeFind = () => {
    lastEsc = 0
    setFindOpen(false)
    setFindHit(undefined)
    if (!findJumped) {
      stick = findStick
      requestAnimationFrame(() => { if (!findOpen() && transcriptEl) transcriptEl.scrollTop = findScroll })
    }
    if (!(findFocus instanceof HTMLElement) || !findFocus.isConnected) return
    findFocus.focus({ preventScroll: true })
    if (findSelection && (findFocus instanceof HTMLTextAreaElement || findFocus instanceof HTMLInputElement))
      findFocus.setSelectionRange(...findSelection)
    vim.setMode(findMode)
  }
  const jumpFind = (hit: FindHit) => {
    mountThrough(hit.messageID)
    findJumped = true
    anchorHold = undefined
    stick = false
    userScroll = false
    // A match inside a compact tool run opens that run so the chip stays visible.
    const run = toolRuns().byPart.get(hit.partID)
    if (run) toggleRun(run, true)
    setFindHit(hit)
    requestAnimationFrame(() => {
      if (!transcriptEl) return
      const member = run ? [...transcriptEl.querySelectorAll<HTMLElement>("[data-tool-run-member]")]
        .find((element) => element.dataset.toolRunMember === hit.partID) : undefined
      const message = member ?? [...transcriptEl.querySelectorAll<HTMLElement>("[data-find-message]")]
        .find((element) => element.dataset.findMessage === hit.messageID)
      // A single exact source excerpt covers historical rows and matches hidden
      // by Markdown or collapsed tools, without mounting all earlier messages.
      const target = message ?? findAnchor
      target?.scrollIntoView({ block: "start", inline: "nearest" })
      flash(target)
    })
  }

  // Linked message anchors: load only the history window that contains the
  // anchor, scroll to it and highlight it briefly. An unknown anchor opens the
  // session normally with a note.
  const [anchored, setAnchored] = createSignal<ReadonlySet<string>>(new Set())
  const [anchorStatus, setAnchorStatus] = createSignal("")
  let anchorRun = 0
  let anchorTimer: ReturnType<typeof setTimeout> | undefined
  onCleanup(() => clearTimeout(anchorTimer))
  const anchorKey = () => {
    const anchor = props.anchor?.()
    return anchor ? `${anchor.message}\u0000${anchor.to ?? ""}` : ""
  }
  createEffect(on(anchorKey, (key) => {
    const anchor = untrack(() => props.anchor?.())
    if (!key || !anchor) return
    const run = ++anchorRun
    stick = false
    userScroll = false
    setAnchorStatus("")
    const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    void (async () => {
      const missing = await (firstLoad ?? live.load())
        .then(() => live.reveal(anchor.to ? [anchor.message, anchor.to] : [anchor.message]))
        .catch(() => undefined)
      if (run !== anchorRun) return
      const range = missing ? anchorRange(messages().map((message) => message.id), anchor, (id) => !missing.includes(id)) : []
      setAnchorStatus(anchorNote(anchor, missing ?? [], !missing))
      if (range[0]) mountThrough(range[0])
      await frame()
      await frame()
      if (run !== anchorRun || !transcriptEl) return
      const target = range[0] ? [...transcriptEl.querySelectorAll<HTMLElement>("[data-find-message]")]
        .find((element) => element.dataset.findMessage === range[0]) : undefined
      if (!target) {
        if (range[0]) setAnchorStatus("Linked message isn't shown in this transcript. Showing the latest messages.")
        stick = true
        pin()
        return
      }
      setAnchored(new Set(range))
      anchorHold = target
      target.scrollIntoView({ block: "start", inline: "nearest" })
      schedulePromptPosition()
      clearTimeout(anchorTimer)
      anchorTimer = setTimeout(() => {
        if (run !== anchorRun) return
        anchorHold = undefined
        setAnchored(new Set<string>())
      }, 3000)
    })()
  }))
  onMount(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.isComposing || dialog.active) return
      if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "f") {
        event.preventDefault()
        event.stopImmediatePropagation()
        openFind()
        return
      }
      if (findOpen() && event.key === "Escape") {
        event.preventDefault()
        event.stopImmediatePropagation()
        closeFind()
      }
    }
    window.addEventListener("keydown", handler, true)
    onCleanup(() => window.removeEventListener("keydown", handler, true))
  })

  // --- vim-like modal input + navigation --------------------------------

  const navigate = useNavigate()
  const { sessions, sessionRows, archivedIds } = dashboard
  const autoFollowStopped = new Set<string>()
  let following = false
  const followSuccessor = async (next: string) => {
    if (following) return
    following = true
    let prompted = false
    let cancelled = false
    const editor = promptEl
    if (editor) saveSelection(editor)
    setRecovering(true)
    setRecoveryError("")
    try {
      // Placement comes from the successor identity, not the lane name or the
      // predecessor's directory (an orchestrator can be anchored outside a lane).
      const knownDirectory = activity.session(next)?.directory
      const target = await oc.session(next, knownDirectory ?? directory)
      if (target.id !== next || !target.directory || (knownDirectory && target.directory !== knownDirectory) || next === sessionID)
        throw new Error("Successor session identity does not match this directory.")
      const destination = getComposer(next, target.directory)
      const copied = await destination.recoverHandoffDrafts(composer, () => {
        const occupied = [destination.state.task, destination.state.aside].some((draft) =>
          !!draft.text || !!draft.images.length || !!draft.model || draft.selection.some(Boolean))
        if (!occupied) return true
        prompted = true
        cancelled = !window.confirm("The successor already has a draft. Replace its task and aside drafts with this session’s drafts? Nothing will be sent. Cancel keeps both drafts unchanged.")
        return !cancelled
      })
      if (!copied) {
        setRecoveryError("Draft transfer cancelled or unavailable. Both sessions’ drafts were kept. Resolve any pending send, model selection or storage error before trying again.")
        return
      }
      transferPin(sessionID, next, directory, target.directory)
      autoFollowStopped.add(next)
      navigate(sessionHref(next, target.directory))
    } catch (error) {
      setRecoveryError(`Could not open the successor: ${errorText(error)}. Both drafts were kept.`)
    } finally {
      // A cancellation (or a failed confirmed overwrite) needs a new explicit
      // click. A pre-confirmation network failure may retry on fresh lineage.
      if (cancelled || prompted) autoFollowStopped.add(next)
      following = false
      setRecovering(false)
    }
  }
  const recoveryTarget = () => {
    if (pendingTransfer()) return
    const tip = successor()
    if (tip) return tip.successor
    // A tagged rejection can supply a missing edge, but cannot override a
    // contradictory or incomplete dashboard chain.
    if (lineage().some((edge) => edge.predecessor === sessionID)) return
    return composer.state.superseded?.state === "committed" ? composer.state.superseded.successor : undefined
  }
  createEffect(() => {
    const edge = successor()
    if (!wasOwner() || !edge || handingOff() || following || composer.state.sending || composer.state.superseded ||
      composer.state.admission || composer.state.normalSubmission?.status === "unknown" || autoFollowStopped.has(edge.successor)) return
    untrack(() => { void followSuccessor(edge.successor) })
  })
  const handoff = async () => {
    const lane = ownedLane()
    const name = currentEditspace()
    if (!lane || !name || !handoffTask().trim() || !handoffNotes().trim() || handingOff()) return
    setHandoffError("")
    setHandoffPending(false)
    setHandingOff(true)
    try {
       const edge = await es.handoff(name, lane.lane, sessionID, handoffTask().trim(), handoffNotes().trim())
       if (!("successor" in edge)) {
         if (edge.status !== "pending") throw new Error("Unrecognized handoff receipt")
         setHandoffPending(true)
         return
       }
      if (edge.lane !== lane.lane || edge.predecessor !== sessionID || !/^ses_[\w-]+$/.test(edge.successor) || edge.successor === sessionID)
        throw new Error("Unrecognized successor confirmation; refresh the lane before retrying.")
      refetch()
      refetchHandoffs()
       await followSuccessor(edge.successor)
    } catch (error) {
      setHandoffError(`Handoff not confirmed: ${String(error)}. Check lane ownership before retrying.`)
    } finally {
      setHandingOff(false)
    }
  }
  const switchSession = (back: boolean) => {
    // skip archived sessions, matching the sidebar's main list
    const list = sessions()
    if (!list.length) return
    const i = list.findIndex((s: any) => s.id === sessionID)
    const next = list[(i + (back ? -1 : 1) + list.length) % list.length]
    if (!next || next.id === sessionID) return
    const editor = promptEl
    if (editor) saveSelection(editor)
    navigate(sessionHref(next.id, next.directory ?? directory))
  }

  const [caret, setCaret] = createSignal<{ el: HTMLTextAreaElement; pos: number; hasChar: boolean } | null>(null)
  const taskVim = createVim({
    value: draft,
    setValue: setDraft,
    onTab: switchSession,
    onEnter: () => send(),
    onCursor: setCaret,
  })
  const asideVim = createVim({ value: draft, setValue: setDraft, onTab: switchSession, onEnter: () => send(), onCursor: setCaret })
  taskVim.setMode("insert")
  asideVim.setMode("insert")
  const activeVim = () => composer.state.visibleBuffer === "aside" ? asideVim : taskVim
  const vim = {
    mode: () => activeVim().mode(),
    setMode: (mode: "normal" | "insert") => activeVim().setMode(mode),
    refresh: (el: HTMLTextAreaElement | undefined) => activeVim().refresh(el),
    handleKeyDown: (event: KeyboardEvent) => activeVim().handleKeyDown(event),
  }
  const saveSelection = (el: HTMLTextAreaElement) => composer.setVisibleSelection(el.selectionStart, el.selectionEnd)
  const restoreDraft = () => {
    lastEsc = 0
    const inputMode = vim.mode()
    const el = promptEl
    if (el) saveSelection(el)
    composer.restoreDraft(composer.state.visibleBuffer === "task" ? "aside" : "task")
    vim.setMode(inputMode)
    const selection = [...activeDraft().selection] as const
    const revision = activeDraft().revision
    const focused = document.activeElement
    const buffer = composer.state.visibleBuffer
    // Restore after the pointer's default selection update, without undoing newer typing.
    requestAnimationFrame(() => {
      if (composer.state.visibleBuffer !== buffer || activeDraft().revision !== revision || document.activeElement !== focused) return
      const target = promptEl
      if (!target?.isConnected) return
      target?.setSelectionRange(selection[0], selection[1])
      setCaret(null)
    })
  }

  const focusInsert = () => vim.setMode("insert")
  const [promptFocused, setPromptFocused] = createSignal(false)
  // Cmd/Ctrl+M opens (or closes) the composer's More send options while the session is
  // busy and focuses its first choice; Esc closes it and returns focus to the composer.
  const cycleMode = (e: KeyboardEvent) => {
    if (!matchShortcut(e, "moreSendOptions")) return false
    e.preventDefault()
    e.stopPropagation()
    if (e.repeat) return true
    const more = document.querySelector<HTMLButtonElement>(".prompt-box:not([inert]) button.direct-more")
    if (!more || more.disabled) return true
    lastEsc = 0
    const opening = more.getAttribute("aria-expanded") !== "true"
    more.click()
    if (!opening) {
      promptEl?.focus()
      return true
    }
    queueMicrotask(() => {
      const menu = document.querySelector<HTMLElement>(".prompt-box:not([inert]) .direct-more-menu")
      menu?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus()
      // The composer closes the menu on Esc; put focus back in the editor afterwards.
      const back = (event: KeyboardEvent) => {
        if (event.key !== "Escape") return
        document.removeEventListener("keydown", back, true)
        // The menu may already be gone (focus fell to body) by the time this listener runs.
        const active = document.activeElement
        if (!active || active === document.body || menu?.contains(active)) queueMicrotask(() => promptEl?.focus())
      }
      document.addEventListener("keydown", back, true)
    })
    return true
  }


  const scrollTranscript = (dir: 1 | -1) => {
    if (!transcriptEl) return
    anchorHold = undefined
    stick = false
    userScroll = true
    transcriptEl.scrollBy({ top: (dir * transcriptEl.clientHeight) / 2, behavior: "instant" as ScrollBehavior })
  }

  // Prompt anchors are rendered only for source-identified human prompts in the
  // loaded transcript. Navigation only scrolls: it never loads history, writes,
  // moves focus, or clears Find.
  const promptTops = () => {
    if (!transcriptEl) return []
    const top = transcriptEl.getBoundingClientRect().top
    return [...transcriptEl.querySelectorAll<HTMLElement>("[data-user-prompt]")].map((element) => element.getBoundingClientRect().top - top)
  }
  const [promptState, setPromptState] = createSignal(promptPosition([]))
  const promptScope = () => {
    const state = promptState()
    const scope = live.hasOlder() ? "loaded history only; load earlier messages for more" : "all history loaded"
    return state.total ? `prompt ${Math.max(state.current + 1, 0)} of ${state.total} · ${scope}` : `no prompts · ${scope}`
  }
  let promptFrame = 0
  const schedulePromptPosition = () => {
    if (promptFrame) return
    promptFrame = requestAnimationFrame(() => {
      promptFrame = 0
      setPromptState(promptPosition(promptTops()))
    })
  }
  onCleanup(() => cancelAnimationFrame(promptFrame))
  const jumpUserMessage = (dir: 1 | -1) => {
    if (!transcriptEl) return
    if (dir === -1 && mountedRows() < timeline().length) {
      // Earlier prompts are still mounting; mount them now and jump on the next frame. Rows mount
      // above the reader, so hold the visible content in place or the jump starts from shifted tops.
      const fromBottom = transcriptEl.scrollHeight - transcriptEl.scrollTop
      mountAll()
      transcriptEl.scrollTop = transcriptEl.scrollHeight - fromBottom
      requestAnimationFrame(() => jumpUserMessage(dir))
      return
    }
    const tops = promptTops()
    const index = promptTarget(tops, dir)
    anchorHold = undefined
    stick = false
    userScroll = false
    if (index < 0) {
      // Earlier prompts may exist in unloaded history; show the explicit loader.
      if (dir === -1 && live.hasOlder()) transcriptEl.scrollTo({ top: 0, behavior: "instant" as ScrollBehavior })
      schedulePromptPosition()
      return
    }
    transcriptEl.scrollTo({ top: transcriptEl.scrollTop + tops[index]! - 8, behavior: "instant" as ScrollBehavior })
    flash(transcriptEl.querySelectorAll<HTMLElement>("[data-user-prompt]")[index]?.querySelector("[data-component='user-message-text'], [data-slot='user-message-text']"))
    schedulePromptPosition()
  }

  // ^u/^d page scroll, ^n/^p user-message jumps, ^e composer — both modes
  const navKeys = (e: KeyboardEvent): boolean => {
    if (!e.ctrlKey || e.metaKey || e.altKey) return false
    switch (e.key) {
      case "d":
        scrollTranscript(1)
        break
      case "u":
        scrollTranscript(-1)
        break
      case "n":
        jumpUserMessage(1)
        break
      case "p":
        jumpUserMessage(-1)
        break
      case "e":
        toggleFloat()
        break
      default:
        return false
    }
    e.preventDefault()
    return true
  }

  const promptKeyDown = (e: KeyboardEvent) => {
    if (e.isComposing || e.defaultPrevented || dialog.active) return
    if (e.key === "Tab") {
      if (e.ctrlKey || e.metaKey || e.altKey) return
      e.preventDefault()
      e.stopPropagation()
      if (!e.repeat) switchSession(e.shiftKey)
      return
    }
    if (cycleMode(e)) return
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      activatePrimary()
      return
    }
    if (composer.state.keyboardTarget !== "aside" && stopTap(e)) return
    // D6: while typing, Ctrl+H/D/U/N/P keep their text-editing meaning (macOS delete,
    // forward delete, line moves). Stop propagation so the window-level panel and
    // nav handlers skip them too; Ctrl+E stays the float-editor key.
    if (vim.mode() === "insert" && e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && TEXT_KEYS.has(e.key)) {
      e.stopPropagation()
      return
    }
    if (navKeys(e)) return
    // Esc ladder: Insert -> Normal -> the transcript, keeping the draft (`i` comes back).
    const leave = e.key === "Escape" && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && vim.mode() === "normal" && !floating()
    vim.handleKeyDown(e)
    if (leave) leaveComposer(pageEl ?? null)
  }

  // global keys when focus is outside the prompt: nav + mode entry
  onMount(() => {
    const handler = (e: KeyboardEvent) => {
      if (dialog.active || e.defaultPrevented) return
      const target = e.target as HTMLElement
      if (target.closest(".prompt-box") && cycleMode(e)) return
      if (!target.closest(".prompt-box") && stopTap(e)) return
      if (e.isComposing || target.closest("textarea, input, select, button, a, [contenteditable], [data-composer-controls], .generated-input")) return
      // Beside Porter two session views listen; only the one holding focus (or the page's own, from nowhere) acts.
      if (!ownsKey(pageEl, target)) return
      if (navKeys(e)) return
      if (e.key === "Tab" && !e.ctrlKey && !e.metaKey && !e.altKey && vim.mode() === "normal") {
        e.preventDefault()
        if (!e.repeat) switchSession(e.shiftKey)
        return
      }
      if (e.key === "Escape") {
        vim.setMode("normal")
        return
      }
      if (e.key === "i" && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault()
        const t = promptEl
        t?.focus()
        vim.setMode("insert")
      }
    }
    window.addEventListener("keydown", handler)
    onCleanup(() => window.removeEventListener("keydown", handler))
  })

  // --- expanded editor ---------------------------------------------------
  // Expanding grows the one composer textarea upward in place: the same element keeps its draft, undo
  // history, caret, focus and IME composition. Long input expands it automatically; the Expand editor
  // button and shortcut toggle it. Both paths only flip this state; CSS animates the height (none with
  // reduced motion) and bounds it to the pane, scrolling inside past that.
  const [floating, setFloating] = createSignal(false)
  let floatDismissed = false
  // "Approaching full": open once the collapsed textarea's content fills ~90% of its box, just before it
  // starts scrolling. scrollHeight never drops below clientHeight, so collapse the box briefly to measure.
  const nearFull = (el: HTMLTextAreaElement) => {
    const box = el.clientHeight
    // A hidden draft (a pending-input edit is open) has no box to fill.
    if (!box) return false
    // A content-sized editor (the Front desk) grows with its wrapped lines to its own max-height and then scrolls
    // inside; its box always equals its content, so it is never "nearly full" and never expands on its own.
    if (getComputedStyle(el).getPropertyValue("field-sizing") === "content") return false
    if (el.scrollHeight > box) return true
    const style = [el.style.height, el.style.minHeight, el.style.transition] as const
    const top = el.scrollTop
    el.style.transition = "none"
    el.style.minHeight = "0"
    el.style.height = "0"
    const content = el.scrollHeight
    el.style.height = style[0]
    el.style.minHeight = style[1]
    el.style.transition = style[2]
    el.scrollTop = top
    return content >= 0.9 * box
  }
  createEffect(() => {
    const d = draft()
    if (!d) {
      floatDismissed = false
      setFloating(false)
      return
    }
    if (untrack(floating) || floatDismissed || !promptEl || !nearFull(promptEl)) return
    setFloating(true)
  })
  // Expanded height: up to 60% of the window, and never more than the pane allows while keeping a strip of
  // transcript (120px) in view; the textarea scrolls inside beyond that. Measured from the pane, so a narrow or
  // short embedded pane bounds it too.
  const [expandedHeight, setExpandedHeight] = createSignal(320)
  // The transcript and the textarea share the pane's free height, so their sum does not depend on how far the
  // editor has grown (or is mid-animation).
  const measureExpanded = () => {
    if (!promptEl || !transcriptEl) return
    const room = transcriptEl.getBoundingClientRect().height + promptEl.getBoundingClientRect().height - 120
    setExpandedHeight(Math.max(120, Math.min(Math.round(window.innerHeight * 0.6), Math.round(room))))
  }
  createEffect(() => {
    if (!floating()) return
    untrack(measureExpanded)
    const pane = transcriptEl?.parentElement
    if (!pane) return
    const observer = new ResizeObserver(measureExpanded)
    observer.observe(pane)
    onCleanup(() => observer.disconnect())
  })
  const closeFloat = () => {
    floatDismissed = true
    setFloating(false)
  }
  const toggleFloat = () => {
    if (floating()) return closeFloat()
    floatDismissed = false
    setFloating(true)
    // Opening from the button leaves focus where the person was typing.
    if (document.activeElement !== promptEl) promptEl?.focus({ preventScroll: true })
  }

  // @ Add context: chips belong to this session's draft and survive reloads until a send carries them.
  const contextStore = remote ? `es-app:context-refs:${sessionHost.id}:${sessionID}` : `es-app:context-refs:${sessionID}`
  const [contextRefs, setContextRefsSignal] = createSignal<ContextRef[]>((() => {
    try { return JSON.parse(localStorage.getItem(contextStore) ?? "[]") as ContextRef[] } catch { return [] }
  })())
  const [contextNote, setContextNote] = createSignal("")
  const setContextRefs = (refs: ContextRef[]) => {
    setContextRefsSignal(refs)
    setContextNote("")
    if (refs.length) localStorage.setItem(contextStore, JSON.stringify(refs))
    else localStorage.removeItem(contextStore)
  }
  const contextHost = window.location.host
  // Agents are this editspace's lanes; without a known editspace name there is no stable agent ID to offer.
  const contextAgents = createMemo(() => {
    const name: string | undefined = state()?.editspace ?? editspace()
    if (!name) return []
    return (state()?.threads ?? []).flatMap((thread: { lanes?: { lane: string; owner?: string; status?: string; activity?: string }[] }) =>
      (thread.lanes ?? []).map((lane): AgentCandidate => {
        const owner = lane.owner ? sessionRows().find((row) => row.id === lane.owner) : undefined
        return { editspace: name, lane: lane.lane, owner: lane.owner, status: lane.status, activity: lane.activity, title: owner?.title, live: owner?.live }
      }))
  })
  // Decisions and surfaces come from the shell's shared desk reads, so the picker adds no requests.
  const deskQueue = useDeskQueue()
  const contextHref = (ref: ContextRef) => {
    if (ref.kind === "session") return sessionHref(ref.id, ref.directory)
    // Same keys the desk opens with `/?item=` and `/?surface=`.
    // Another Work host's decision opens through that host's desk key.
    if (ref.kind === "decision") return `/?item=${encodeURIComponent(`${ref.host !== contextHost ? `${ref.host}~` : ""}attention:${ref.editspace}:${ref.id}`)}`
    if (ref.kind === "surface") return `/?surface=${encodeURIComponent(ref.id)}`
    const owner = sessionRows().find((row) => row.id === ref.owner)
    return owner ? sessionHref(owner.id, owner.directory) : "/"
  }
  // Ask about this (ATTN-17): the chip joins the current draft, its label appended after the text already there, and
  // the caret lands after it. Nothing is sent.
  createEffect(() => {
    const ref = props.incoming?.()
    if (!ref) return
    untrack(() => {
      props.onIncoming?.()
      const known = contextRefs().some((item) => contextKey(item) === contextKey(ref))
      if (!known && contextRefs().length >= MAX_CONTEXT) return setContextNote(`At most ${MAX_CONTEXT} context items per message. Remove one to add another.`)
      if (!known) setContextRefs([...contextRefs(), ref])
      const next = appendContextLabel(draft(), ref.label)
      setDraft(next.text)
      requestAnimationFrame(() => {
        if (!promptEl) return
        promptEl.focus({ preventScroll: true })
        promptEl.setSelectionRange(next.caret, next.caret)
        saveSelection(promptEl)
      })
    })
  })
  // Absolute so the receiving agent can re-fetch from the attaching host.
  const contextParts = () => contextRefs().map((ref) => contextPart(ref, linkUrl(new URL(contextHref(ref), window.location.origin).href), Date.now()))

  const Editor = () => {
    const [query, setQuery] = createSignal<ReturnType<typeof mentionQuery>>()
    const [selected, setSelected] = createSignal(0)
    let composing = false
    const target = () => promptEl
    const groups = createMemo(() => query() ? contextGroups({
      query: query()!.query, host: contextHost, agents: contextAgents(), currentID: sessionID, added: contextRefs(),
      sessions: sessionRows().filter((row) => !archivedIds().has(row.id)), laneOf: (id) => sessionLane(id, lineage(), lineageOwners()),
      decisions: deskQueue.attention.snapshot()?.value.records ?? [], surfaces: deskQueue.surfaces.list(),
    }) : [])
    const rows = () => groups().flatMap((group) => group.items)
    const update = (el: HTMLTextAreaElement, isComposing = false) => {
      saveSelection(el)
      if (composing || isComposing || vim.mode() === "normal" || document.activeElement !== el || el.selectionStart !== el.selectionEnd) return setQuery(undefined)
      const next = mentionQuery(el.value, el.selectionStart)
      setQuery(next)
      setSelected(0)
    }
    const apply = (el: HTMLTextAreaElement, text: string, position: number) => {
      el.value = text
      el.setSelectionRange(position, position)
      setDraft(text)
      saveSelection(el)
      vim.refresh(el)
      setQuery(undefined)
    }
    const insert = (ref: ContextRef) => {
      const el = target()
      const active = query()
      if (!el || !active) return
      if (!contextRefs().some((item) => contextKey(item) === contextKey(ref))) {
        if (contextRefs().length >= MAX_CONTEXT) return setContextNote(`At most ${MAX_CONTEXT} context items per message. Remove one to add another.`)
        setContextRefs([...contextRefs(), ref])
      }
      const next = insertContextLabel(el.value, active.start, el.selectionStart, ref.label)
      apply(el, next.text, next.caret)
    }
    const keyDown = (event: KeyboardEvent) => {
      const el = event.currentTarget as HTMLTextAreaElement
      if (event.isComposing || composing || vim.mode() === "normal" || dialog.active) return
      if (!event.metaKey && !event.altKey && !event.ctrlKey && event.key === "Backspace" && !el.value && contextRefs().length) {
        // Backspace on an empty editor removes the last chip.
        event.preventDefault()
        event.stopPropagation()
        setContextRefs(contextRefs().slice(0, -1))
        return
      }
      if (!event.metaKey && !event.altKey && !event.ctrlKey && event.key === "Backspace" && el.selectionStart === el.selectionEnd) {
        const token = tokenBefore(el.value, el.selectionStart)
        if (token) {
          event.preventDefault()
          event.stopPropagation()
          apply(el, el.value.slice(0, token.start) + el.value.slice(token.end), token.start)
          return
        }
      }
      if (!query()) return
      const count = rows().length
      const down = !event.metaKey && !event.altKey && (event.key === "ArrowDown" && !event.ctrlKey || event.ctrlKey && event.key.toLowerCase() === "n")
      const up = !event.metaKey && !event.altKey && (event.key === "ArrowUp" && !event.ctrlKey || event.ctrlKey && event.key.toLowerCase() === "p")
      const choose = event.key === "Enter" && !event.ctrlKey && !event.metaKey && !event.altKey
      const jump = event.key === "Tab" && !event.ctrlKey && !event.metaKey && !event.altKey
      if (!down && !up && !choose && !jump && event.key !== "Escape") return
      if (event.key === "Escape") setQuery(undefined)
      if (down && count) setSelected((selected() + 1) % count)
      if (up && count) setSelected((selected() + count - 1) % count)
      if (choose && count) insert(rows()[selected()] ?? rows()[0]!)
      if (jump && count) {
        // Tab moves to the first row of the next group (Shift+Tab: previous), wrapping.
        const starts = groups().reduce<number[]>((list, group, index) => [...list, index ? list[index - 1]! + groups()[index - 1]!.items.length : 0], [])
        const at = starts.findLastIndex((start) => start <= selected())
        setSelected(starts[(at + (event.shiftKey ? starts.length - 1 : 1)) % starts.length]!)
      }
      event.preventDefault()
      event.stopPropagation()
    }
    return <div class="ta-wrap" classList={{ "numbered-editor": floating() }}>
      <textarea ref={(el) => {
        promptEl = el
        el.addEventListener("keydown", keyDown, true)
        onCleanup(() => el.removeEventListener("keydown", keyDown, true))
      }}
        aria-label="Message" dir="auto"
        classList={{ "vim-normal": vim.mode() === "normal", "vim-insert": vim.mode() === "insert" }}
        value={draft()} onInput={(e) => { saveSelection(e.currentTarget); setDraft(e.currentTarget.value); update(e.currentTarget, e.isComposing) }}
        onPaste={pasteImages} onDrop={dropImages} onDragOver={(e) => e.preventDefault()}
        onKeyDown={promptKeyDown}
        onCompositionStart={() => { composing = true; setQuery(undefined) }}
        onCompositionEnd={() => { composing = false; setQuery(undefined) }}
        onSelect={(e) => { saveSelection(e.currentTarget); if (query() && (e.currentTarget.selectionStart !== e.currentTarget.selectionEnd || !mentionQuery(e.currentTarget.value, e.currentTarget.selectionStart))) setQuery(undefined) }}
        onKeyUp={(e) => { if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) update(e.currentTarget, e.isComposing); else saveSelection(e.currentTarget) }}
        onFocus={() => { focusInsert(); setPromptFocused(true) }} onClick={(e) => { focusInsert(); update(e.currentTarget) }}
        onBlur={(e) => { saveSelection(e.currentTarget); setQuery(undefined); setPromptFocused(false) }} />
      {/* Which mode the keys go to, while they go here. */}
      <Show when={promptFocused()}><span class="kbd-mode" data-mode={vim.mode()} aria-hidden="true">{vim.mode() === "normal" ? "NORMAL" : "INSERT"}</span></Show>
      <SessionChips target={target()} text={draft()} selection={activeDraft().selection} />
      <Show when={query() && vim.mode() !== "normal" && !composing}><ContextPicker groups={groups()} selected={selected()} select={setSelected} add={insert} /></Show>
      <Show when={floating()}><RelativeLines target={promptEl!} value={draft()} /></Show>
      <FakeCaret target={target()} caret={caret()} mode={vim.mode()} />
    </div>
  }
  const Attachments = () => <Show when={images().length}><div class="attachments"><For each={images()}>{(image) => (
    <span class="attachment-chip" data-normalized={image.normalized ? "true" : undefined} title={`${image.filename}${image.normalized ? " · resized to fit" : ""}`}><img src={image.url} alt={image.filename} />{image.filename.slice(0, 24)}
      <button aria-label={`Remove ${image.filename}`} onClick={() => composer.setImages(images().filter((item) => item.id !== image.id), composer.state.visibleBuffer)}>×</button>
    </span>
  )}</For></div></Show>
  const ComposerPanel = () => (
    <DirectComposer composer={composer} connected={connected() && !nudgePhase() && !aborting()} submit={send} restoreDraft={restoreDraft}
      editor={<Editor />} attachments={<><ContextChips refs={contextRefs()} note={contextNote()}
        remove={(ref) => setContextRefs(contextRefs().filter((item) => contextKey(item) !== contextKey(ref)))} /><Attachments /></>}
      dictation={<DictationButton composer={composer} sessionID={sessionID} directory={directory} host={props.host}
        editor={() => promptEl} normalMode={() => vim.mode() === "normal"}
        focus={(el) => {
          const mode = vim.mode()
          const selection = [el.selectionStart, el.selectionEnd] as const
          el.focus({ preventScroll: true })
          vim.setMode(mode)
          el.setSelectionRange(...selection)
          vim.refresh(el)
        }}
        checkpoint={(el) => activeVim().checkpoint(el)} refresh={(el) => vim.refresh(el)} />}
      sessionMetadata={<ComposerMeta context={footerMeta().context} cost={footerMeta().cost} />}
      primary={primary} activate={activatePrimary} context={contextParts}
      sessionActions={<>
        {/* Every label is a .action-label: a narrow composer shows the icon only, the label stays the accessible name. */}
        <button class="act-expand" aria-expanded={floating()} aria-keyshortcuts={ariaShortcut("expandEditor")}
          title={`${floating() ? "Collapse editor" : "Expand editor"} (${shortcutLabel("expandEditor")})`} onClick={toggleFloat}>
          <Glyph name="screen-full" /><span class="action-label">{floating() ? "Collapse editor" : "Expand editor"}</span></button>
        <Show when={busy()} fallback={<button title="Scroll to the latest message" onClick={() => { stick = true; pin() }}><Glyph name="arrow-down" /><span class="action-label">Bottom</span></button>}>
          <button class="stop" title="Stop session" disabled={aborting() || !!nudgePhase() || sending()} onClick={abort}>
            <Glyph name="square-fill" /><span class="action-label">Stop<span class="sr-only"> session</span></span>
          </button>
        </Show>
        <button
          class="act-nudge" title={nudgeAvailable() ? "Continue the agent from where it stopped" : "Nudge is not available on this agent runtime yet."}
          disabled={!nudgeAvailable() || !session() || !!nudgePhase() || aborting() || sending()}
        >
          <Glyph name="zap" /><span class="action-label">{nudgePhase() === "stopping" ? "Stopping…" : nudgePhase() === "resuming" ? "Sending resume…" : "Nudge"}</span>
        </button>
        {/* A local root session that owns its lane; another host's session shows it disabled with that host named. */}
        <Show when={remote || (ownedLane() && session() && !session()!.parentID)}><SelfHandoffButton handoff={selfHandoff} gate={selfHandoffGate()} /></Show>
      </>}
      moreActions={remote ? undefined : <>
        {/* The Front Desk is one long-lived conversation: it offers no Fork, Archive or Delete (Restore stays). */}
        <Show when={!desk()}><button class="act-fork" title="Fork this session" disabled={forking() || !!nudgePhase()} onClick={() => fork()}>
          <Glyph name="repo-forked" /><span class="action-label">{forking() ? "Forking…" : "Fork"}</span>
        </button></Show>
        <Show when={ownedLane()}><button class="act-handoff" title="Hand off this lane" disabled={handingOff()} onClick={() => setHandoffOpen(!handoffOpen())}>
          <Glyph name="arrow-switch" /><span class="action-label">Hand off</span></button></Show>
        <Show when={!session()?.time?.archived} fallback={<>
          <span class="archived-chip">Archived</span>
          <button title="Restore this session" onClick={() => setArchived(false)}><Glyph name="archive" /><span class="action-label">Restore</span></button>
        </>}>
          <Show when={!desk()}><button title="Archive this session" disabled={!!nudgePhase()} onClick={() => setArchived(true)}><Glyph name="archive" /><span class="action-label">Archive</span></button></Show>
        </Show>
        <Show when={!desk()}><button class="danger" title="Delete this session" disabled={!!nudgePhase()} onClick={remove}><Glyph name="trash" /><span class="action-label">Delete</span></button></Show>
      </>}>
      {/* Changing model mid-conversation is rare and costly, so the picker opens on request. */}
      <Show when={changingModel()} fallback={<>
        {/* The model name is the picker's button; the small glyph marks it as changeable. */}
        {/* A model name is never a ticket key, even when it looks like one. */}
        <button class="direct-change-model composer-model" ref={modelButton} data-ticket-refs="off"
          disabled={!!composer.state.modelSelection && composer.state.modelSelection.status !== "unknown"}
          aria-label={`Change model, current ${shownModelName()}`}
          title={`${composer.state.visibleBuffer === "aside" ? "Aside model" : "Session model"} · ${shownModel() ? `${shownModel()!.providerID} · ${shownModel()!.modelID}` : "default"} · Change model`}
          onClick={() => setChangingModel(true)}>
          <bdi class="direct-model-name">{shownModelName()}</bdi>
          <Glyph name="arrow-switch" size={12} />
        </button>
      </>}>
        <select class="model-select" ref={(el) => queueMicrotask(() => el.focus())}
          aria-label={composer.state.visibleBuffer === "aside" ? "Aside model" : "Session model"}
          title={composer.state.visibleBuffer === "aside" ? "Model for this Aside only" : "Applies to future turns"}
          value={pickerModel() ? `${pickerModel()!.providerID}\u0000${pickerModel()!.modelID}` : ""}
          onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); closeModelPicker() } }}
          onChange={(e) => {
            const [providerID, modelID] = e.currentTarget.value.split("\u0000")
            const model = providerID && modelID ? { providerID, modelID } : null
            closeModelPicker()
            if (composer.state.visibleBuffer === "aside") return composer.setVisibleModel(model)
            if (!model) return
            const selected = providers()?.providers.find((provider) => provider.id === providerID)?.models?.[modelID]
            if (composer.state.task.images.length && selected?.capabilities?.input?.image === false) {
              setError("Selected model does not support image input. Images and session model were not changed.")
              return
            }
            void composer.chooseSessionModel(model)
          }}>
          <option value="" disabled={composer.state.visibleBuffer !== "aside"} selected={!pickerModel()}>{composer.state.visibleBuffer === "aside" ? "Use session model" : "Choose model"}</option>
          <For each={providers()?.providers ?? []}>
            {(prov) => (
              <optgroup label={prov.id}>
                <For each={Object.keys(prov.models ?? {})}>
                  {(mid) => <option value={`${prov.id}\u0000${mid}`} selected={pickerModel()?.providerID === prov.id && pickerModel()?.modelID === mid}>{mid}</option>}
                </For>
              </optgroup>
            )}
          </For>
        </select>
        <button onClick={closeModelPicker}>Cancel</button>
      </Show>
      <Show when={composer.state.visibleBuffer === "aside" && composer.state.aside.model}><button onClick={() => composer.setVisibleModel(null)}>Use session model</button></Show>
      <Show when={composer.state.modelSelection}>{(selection) => <span class="dim" role="status">{selection().status === "unknown" ? "Model change unconfirmed" : "Confirming model…"}</span>}</Show>
      <Show when={composer.state.modelSelection?.status === "unknown"}><button onClick={() => { void composer.reconcileSessionModel() }}>Check session model</button></Show>
    </DirectComposer>
  )

  // Display-only coalescing of adjacent tool calls in finished turns; see transcript-groups.
  const partVisible = (part: Part) => part.type === "text" || part.type === "reasoning"
    ? /\S/.test(part.text ?? "") : renderable(part, true, renderTools)
  // What had finished when the current run began; cleared at idle (see groupableTurns).
  let lastIdle: ReadonlySet<string> | undefined
  let runStart: { before: ReadonlySet<string>; oldest?: string } | undefined
  const groupTurns = createMemo((): ReadonlySet<string> => {
    const done = turnsDone()
    if (status() === "idle" && !pending().length && !live.connectionError()) {
      runStart = undefined
      lastIdle = live.loaded() ? done : undefined
      return done
    }
    // Opened mid-run: whatever had finished once history loaded counts as before the run.
    if (!runStart && !live.loaded()) return done
    runStart ??= { before: lastIdle ?? done, oldest: messages()[0]?.id }
    return groupableTurns(done, runStart)
  }, undefined, { equals: (a, b) => a.size === b.size && [...a].every((id) => b.has(id)) })
  const toolRuns = createMemo(() => planToolRuns(timeline(), {
    parts: (id) => live.data.part[id] ?? [],
    visible: partVisible,
    completed: groupTurns(),
    breakAfter: (message) => turnSummaries().has(message.id),
  }), undefined, { equals: samePlan })
  // Expansion follows member parts, not run keys: prepending history or a
  // streamed call can merge runs and change the key of a run the user opened.
  // A call the user left expanded while still standalone (live turn) opens the
  // run it later joins, so completion never snaps it out of view.
  const [openParts, setOpenParts] = createSignal(new Set<string>())
  const runOpen = (key: string) => !!toolRuns().runs.get(key)?.members.some((member) => openParts().has(member.partID))
  const toggleRun = (key: string, open: boolean) => setOpenParts((current) => {
    const members = toolRuns().runs.get(key)?.members ?? []
    if (open && members.every((member) => current.has(member.partID))) return current
    const next = new Set(current)
    members.forEach((member) => open ? next.add(member.partID) : next.delete(member.partID))
    return next
  })
  const messageByID = createMemo(() => new Map(messages().map((message) => [message.id, message] as const)))
  // A promoted input stays as a Delivered bubble until its user message is in this transcript (DD #343): the bubble
  // would otherwise retire on the receipt alone while a dropped host event leaves the message unrendered. Only inputs
  // this page saw pending count, so older terminal receipts never reappear. After 5 s the message is read by id from
  // the session's own host and applied; if Core has no such message the bubble stays (uncertain, never dropped).
  const seenPending = new Set<string>()
  createEffect(() => composer.state.receipts.forEach((receipt) => { if (receipt.state === "pending") seenPending.add(receipt.requestID) }))
  const inTranscript = (messageID: string) => !!live.data.message[sessionID]?.some((message) => message.id === messageID)
  const deliveredWaiting = createMemo(() => composer.state.receipts.filter((receipt) => {
    const messageID = (receipt as { messageID?: unknown }).messageID
    return receipt.state !== "pending" && receipt.state !== "cancelled" && seenPending.has(receipt.requestID) && receipt.source?.type !== "editspace-mail"
      && typeof messageID === "string" && !inTranscript(messageID)
  }))
  // A delivery row (admission, pending receipt, the normal send, a delivered bubble) lives at the end of the
  // transcript. When one appears while the reader is at the bottom, pin in this render rather than waiting for a
  // ResizeObserver callback: a Steer can add its row and shrink the composer in the same frame, and a frame's gap
  // must not leave the reader short of the newest row.
  let outgoingRows = -1
  createEffect(() => {
    const count = composer.state.receipts.length + composer.state.recoveries.length
      + (composer.state.admission ? 1 : 0) + (composer.state.normalSubmission ? 1 : 0) + deliveredWaiting().length
    if (outgoingRows !== -1 && count !== outgoingRows && stick) pin()
    outgoingRows = count
  })
  const reading = new Set<string>()
  const readTimers = new Set<ReturnType<typeof setTimeout>>()
  onCleanup(() => readTimers.forEach(clearTimeout))
  createEffect(() => deliveredWaiting().forEach((receipt) => {
    const messageID = (receipt as { messageID?: string }).messageID!
    if (reading.has(messageID)) return
    reading.add(messageID)
    const timer = setTimeout(async () => {
      if (inTranscript(messageID)) return
      const found = await oc.message(sessionID, directory, messageID).catch(() => undefined)
      if (!found || inTranscript(messageID)) return
      live.apply({ type: "message.updated", properties: { info: found.info } })
      found.parts.forEach((part) => live.apply({ type: "message.part.updated", properties: { part } }))
    }, 5000)
    readTimers.add(timer)
  }))
  // A promoted input's promotion time, from its receipt (Core keeps the last terminal receipts).
  const promotedAt = (messageID: string) => {
    const receipt = composer.state.receipts.find((item) => "messageID" in item && item.messageID === messageID) as { timePromoted?: unknown } | undefined
    return typeof receipt?.timePromoted === "number" ? receipt.timePromoted : undefined
  }
  // This session's current turn start as Core recorded it (Session.time.turn); undefined from a Core without it.
  const turnStarted = () => { const value = (session()?.time as { turn?: { started?: unknown } } | undefined)?.turn?.started; return typeof value === "number" ? value : undefined }
  const promptIDs = createMemo(() => new Set(timeline().flatMap((row) =>
    row.type === "transcript" && isUserPrompt(row.message, live.data.part[row.message.id] ?? []) ? [row.message.id] : [])))
  createEffect(() => { promptIDs(); schedulePromptPosition() })
  // Hover shows when an agent text block or human message was recorded, as a native tooltip: nothing is
  // drawn until asked, and blocks are stamped on first hover instead of on every render.
  const stampBlock = (event: Event) => {
    const block = (event.target as Element).closest?.<HTMLElement>("[data-component='text-part'], .msg-wrap")
    if (!block || block.dataset.recordedAt !== undefined) return
    const messageID = block.closest<HTMLElement>("[data-find-message]")?.dataset.findMessage
    const partID = block.matches("[data-component='text-part']") ? block.dataset.timelinePartId : undefined
    const time = blockTime(messageID ? messageByID().get(messageID) : undefined,
      partID && messageID ? live.data.part[messageID]?.find((part) => part.id === partID) : undefined)
    block.dataset.recordedAt = time ?? ""
    if (time) block.title = time
  }
  const renderRun = (key: string) => <Show when={toolRuns().runs.get(key)}>{(run) => {
    const hit = () => findHit() && run().members.some((member) => member.partID === findHit()!.partID) ? findHit() : undefined
    return <ToolRun run={run()} message={(id) => messageByID().get(id)} parts={(id) => live.data.part[id] ?? []}
      open={runOpen(key)} onToggle={(open) => toggleRun(key, open)} renderTools={renderTools}
      selectedPart={hit()?.partID} compact
      excerpt={<Show when={hit()}>{(selected) => <div class="find-jump" role="region" aria-label="Selected transcript match"><FindExcerpt hit={selected()} /></div>}</Show>} />
  }}</Show>

  return (
    <SessionHostProvider value={sessionHost}>
    <main ref={pageEl} class="session-page" classList={{ "finding-transcript": findOpen() }} data-host={sessionHost.id}>
      <div class="session-main">
        {/* Embedded beside the desk queue, the chat's title and tools belong to its own pane. */}
        <AppHeader inline={props.embedded}>
          {props.headerStart}
          <SessionTitle sessionID={sessionID} directory={directory} session={session()} knownTitle={activity.session(sessionID)?.title} suspendBlurSave={findOpen()} onSaved={(info) => {
            live.apply({ type: "session.updated", properties: { sessionID, info } })
            void refetch()
          }} />
          <Show when={sessionHost.id}><span class="session-host" title={`On ${sessionHost.label}`}><HostGlyph host={sessionHost.id!} /> <bdi dir="auto">{sessionHost.label}</bdi></span></Show>
          <Show when={sessionHost.readOnly}><span class="dim session-read-only" data-read-only>read only</span></Show>
          {/* The sidebar's round dot; the state word is its label only (chat-activity). */}
          <span class={`session-state dot ${chatDot(workState()).dot}`} data-state={workState()} role="img"
            aria-label={workState() === "working" ? "busy" : workState()} title={workState() === "working" ? "busy" : workState()} />
          <Show when={subagentsRunning()}><span class="dim">{subagentsRunning()} subagent(s) running</span></Show>
          <Show when={(session() as any)?.parentID}>
            {(pid) => (
              <span class="fork-crumb">
                forked from{" "}
                <A href={hrefFor(pid(), directory)} title={pid()}>
                  {parent()?.title ?? pid()}
                </A>
              </span>
            )}
          </Show>
          {/* Icon controls keep the title primary; names, shortcuts and prompt scope stay accessible. */}
          <div class="session-header-tools">
            <button class="header-icon" aria-label="Living activity (Filament)" aria-pressed={livingActivity()}
              title="Living activity (Filament)" onClick={() => setLivingActivity(!livingActivity())}>
              <Icon name="brain" size="small" />
            </button>
            <span class="sr-only" id={`prompt-scope-${sessionID}`}>{promptScope()}</span>
            <button class="header-icon" aria-label="Find" aria-keyshortcuts={ariaShortcut("find")} title={`Find in transcript (${shortcutLabel("find")})`}
              onPointerDown={(event) => event.preventDefault()} onClick={openFind}><Icon name="magnifying-glass" size="small" /></button>
            <button class="header-icon" aria-label="Previous prompt" aria-keyshortcuts={ariaShortcut("previousPrompt")} aria-describedby={`prompt-scope-${sessionID}`}
              title={`Previous prompt (${shortcutLabel("previousPrompt")}) · ${promptScope()}`} onPointerDown={(event) => event.preventDefault()}
              disabled={!promptState().previous && !live.hasOlder()} onClick={() => jumpUserMessage(-1)}>
              <span class="header-icon-up"><Icon name="chevron-down" size="small" /></span>
            </button>
            <button class="header-icon" aria-label="Next prompt" aria-keyshortcuts={ariaShortcut("nextPrompt")} aria-describedby={`prompt-scope-${sessionID}`}
              title={`Next prompt (${shortcutLabel("nextPrompt")}) · ${promptScope()}`} onPointerDown={(event) => event.preventDefault()}
              disabled={!promptState().next} onClick={() => jumpUserMessage(1)}><Icon name="chevron-down" size="small" /></button>
            {/* Mail routing tools are for debugging delivery, not daily use: only with localStorage es-app:debug=1. */}
            <Show when={location() && localStorage.getItem("es-app:debug") === "1" ? location() : undefined}>{(scope) =>
              <HeaderMenu id={`session-mail-menu-${sessionID}`} label="Session mail" title="Mail subscriptions and lane mail"
                icon={<Icon name="dot-grid" size="small" />} items={[
                  { label: subscriptionsOpen() ? "Hide mail subscriptions" : "Mail subscriptions", select: () => setSubscriptionsOpen(!subscriptionsOpen()) },
                  ...(scope().lane !== undefined ? [{
                    label: laneMailOpen() ? "Hide lane mail" : `Lane mail (${mail()?.messages.length ?? 0})`, select: () => setLaneMailOpen(!laneMailOpen()),
                  }] : []),
                ]} />
            }</Show>
          </div>
        </AppHeader>
        <Show when={findOpen()}><TranscriptFind sessionID={sessionID} directory={directory} messages={messages()}
          parts={live.data.part} jump={jumpFind} close={closeFind} clear={() => setFindHit(undefined)}
          subscribeRemoved={(remove) => { findRemovals.add(remove); return () => { findRemovals.delete(remove) } }} /></Show>

        <div class="session-alerts">
          <Show when={bannerError()}><div class="err" role="alert">{bannerError()}</div></Show>
          {/* One line while another host does not answer; nothing is sent anywhere else meanwhile. */}
          <Show when={hostActivity?.reach()}><div class="host-session-offline" role="status">{hostActivity!.error(sessionID)}</div></Show>
          <Show when={anchorStatus()}>
            <div class="anchor-note" role="status"><span>{anchorStatus()}</span>
              <button aria-label="Dismiss linked message note" onClick={() => setAnchorStatus("")}>×</button></div>
          </Show>
          <Show when={handoffError()}><div class="err" role="alert">{handoffError()}</div></Show>
          <Show when={handoffPending()}><div role="status" class="banner">Handoff waits for the current turn to finish.</div></Show>
          <Show when={handoffOpen() && ownedLane()}>
            <div class="banner handoff-form">
              <div class="banner-head">Hand off lane {ownedLane()?.lane}</div>
              <Show when={handoffsError()}><div class="dim" role="status">{handoffsError()}</div></Show>
              <input aria-label="Successor task" placeholder="Successor task" value={handoffTask()} onInput={(e) => setHandoffTask(e.currentTarget.value)} />
              <textarea aria-label="Handoff notes" placeholder="Handoff context for the successor" value={handoffNotes()} onInput={(e) => setHandoffNotes(e.currentTarget.value)} />
              <div class="banner-actions"><button disabled={handingOff() || !handoffTask().trim() || !handoffNotes().trim()} onClick={handoff}>{handingOff() ? "Handing off…" : "Create successor"}</button></div>
            </div>
          </Show>
          <Show when={location()}>{(scope) => <>
            {/* Opened from the header menu; each panel takes space only while open. */}
            <Show when={subscriptionsOpen()}>
              <div class="session-panel-close"><button onClick={() => setSubscriptionsOpen(false)}>Hide mail subscriptions</button></div>
              <MailSubscriptions editspace={scope().name} recipient={scope().lane ?? scope().session ?? sessionID} />
            </Show>
            <Show when={scope().lane !== undefined}>
              <Show when={laneMailOpen()}>
                <section class="lane-mail" aria-label="Lane mail">
                  <div class="banner-head session-panel-head">All mail for lane {scope().lane} across handoffs
                    <button onClick={() => setLaneMailOpen(false)}>Hide lane mail</button></div>
                  <Show when={mail()?.error} fallback={<Show when={!mail()?.messages.length}><div class="dim">No lane mail.</div></Show>}>
                    <div class="dim" role="status">{mail()?.error}</div>
                  </Show>
                  <For each={mail()?.messages ?? []}>{(message) => <MailRow message={message} ids={mailIDs()} anchor="lane-mail" name={mailName} session={sessionID} replied={mailReplied().has(message.id)} />}</For>
                </section>
              </Show>
            </Show>
          </>}</Show>
          <Show when={live.retry()}>{(retry) => <div role="status" class="dim">Retry {retry().attempt}: {retry().message}</div>}</Show>
          <For each={pending().filter((item) => item.kind === "permission")}>
            {(item) => {
              const owner = () => item.request.sessionID !== sessionID
                ? activity.session(item.request.sessionID)?.title ?? item.request.sessionID : undefined
              return <PermissionBanner p={item.request} directory={item.directory} owner={owner()} onDone={() => activity.refreshDirectory(item.directory, true)} />
            }}
          </For>
        </div>

        <Show when={livingActivity()}><Filament messages={messages} parts={(id) => live.data.part[id] ?? []} steps={(id) => live.data.step[id] ?? []} status={status}
          pending={pending} subagents={subagentsRunning} transcript={() => transcriptEl} /></Show>
        <div class="transcript" ref={transcriptEl} tabIndex={-1} role="region" aria-label="Transcript" data-session-host={sessionHost.id ?? undefined}>
          <div ref={inner} class="transcript-inner" classList={{ "transcript-arrive": arrived() }}
            onPointerOver={stampBlock} onFocusIn={stampBlock} onClick={(event) => {
            // Only a standalone chip's own disclosure counts (an icon chip's summary, or a session-ui chip's trigger);
            // action buttons inside it do not.
            const trigger = (event.target as Element).closest(".tool-chip-summary, [data-slot='collapsible-trigger']")
            if (!trigger || trigger.closest(".tool-run")) return
            const chip = trigger.closest(".tool-chip, [data-component='tool-part-wrapper'], .tool-collapsible[data-timeline-part-ids]")
            if (!chip || chip.querySelector(".tool-chip-summary, [data-slot='collapsible-trigger']") !== trigger) return
            const ids = (chip.getAttribute("data-timeline-part-id") ?? chip.getAttribute("data-timeline-part-ids") ?? "").split(",").filter(Boolean)
            // Read the state after the chip's own handler has toggled it.
            queueMicrotask(() => {
              const open = trigger.getAttribute("aria-expanded") === "true"
              if (ids.every((id) => openParts().has(id) === open)) return
              setOpenParts((current) => {
                const next = new Set(current)
                ids.forEach((id) => open ? next.add(id) : next.delete(id))
                return next
              })
            })
          }}>
            <Show when={findHit() && !messages().some((message) => message.id === findHit()?.messageID) ? findHit() : undefined}>{(hit) => <div class="find-jump" ref={findAnchor} role="region" aria-label="Selected transcript match">
              <FindExcerpt hit={hit()} />
              <span class="dim">Exact source excerpt. Earlier history is not added to the reader.</span>
            </div>}</Show>
            <Show when={!earlierLeft() && !segments[shownIDs()[0] ?? ""]?.hasOlder() && chain().broken && !live.hasOlder()}>
              <div class="earlier-session-status" role="note">Earlier history isn't linked</div>
            </Show>
            <Show when={!live.hasOlder() && (earlierLeft() || segments[shownIDs()[0] ?? ""]?.hasOlder())}>
              <button class="transcript-older" disabled={earlierLoading} onClick={() => void loadEarlierSession()}>Load earlier session</button>
            </Show>
            <For each={shownIDs()}>{(id) => {
              const index = () => chain().links.findIndex((item) => item.session === id)
              const link = chain().links[index()]!
              const dir = link.directory ?? sessionDir(id)
              const href = link.host ? `${sessionHref(id, dir)}&host=${encodeURIComponent(link.host.id)}` : hrefFor(id, dir)
              return <>
                <Show when={chain().links[index() + 1]}>{(prior) => <HandoffRule predecessor={prior().session} successor={id}
                  label={segments[prior().session]?.title() ?? sessionLabel(prior().session)} href={earlierHref(prior())} reason={prior().reason}
                  at={segments[id]?.created()} />}</Show>
                <EarlierSession link={link} directory={dir} host={link.host ?? sessionHost} href={href} hostLabel={link.host?.label}
                  renderTools={renderTools} register={(control) => setSegments(id, control)} />
              </>
            }}</For>
            <Show when={chain().links[0]}>{(prior) => <HandoffRule previous predecessor={prior().session} successor={sessionID}
              label={segments[prior().session]?.title() ?? sessionLabel(prior().session)} href={earlierHref(prior())}
              reason={prior().reason ?? predecessor()?.reason} at={session()?.time.created}
              skipped={predecessor()?.kickoff === "skipped" ? predecessor()?.context : undefined} />}</Show>
            <Show when={!chain().links.length && predecessor()}>{(edge) => <div class="banner handoff-history" aria-label="Previous session">
              Previous session: <A href={hrefFor(edge().predecessor, sessionDir(edge().predecessor))}><bdi dir="auto">{sessionLabel(edge().predecessor)}</bdi></A>
              {" · "}<bdi dir="ltr">{edge().predecessor}</bdi>
              <Show when={edge().reason}>{(reason) => <> · <bdi dir="auto">{reason()}</bdi></>}</Show>
              <Show when={edge().kickoff === "skipped" && edge().context}>{(context) => <>
                {" · "}Handoff brief not sent because this session was already in use: <bdi dir="ltr">{context()}</bdi>
              </>}</Show>
            </div>}</Show>
            <Show when={remoteSuccessor()}>{(edge) => <div class="banner handoff-history handoff-next" role="status" aria-label="Session handoff">
              Handed off to <A href={hrefFor(edge().successor, sessionDir(edge().successor))}><bdi dir="auto">{sessionLabel(edge().successor)}</bdi></A>
              {" · "}<bdi dir="ltr">{edge().successor}</bdi> · lane <bdi dir="auto">{edge().lane}</bdi> on <bdi dir="auto">{sessionHost.label}</bdi>
            </div>}</Show>
                        <Show when={pendingTransfer()}>{(transfer) => <div class="banner handoff-progress" role="status" aria-label="Handoff progress">
              {transfer().error ? "Handoff paused. Your draft is saved." : transfer().successor === sessionID
                ? "Loading handoff context. This session is not ready yet."
                : transfer().status === "submitting" ? "Starting the next session. Your draft is saved here."
                : "Preparing the next session. Your draft is saved here."}
              <Show when={transfer().reason}>{(reason) => <> <bdi dir="auto">{reason()}</bdi>.</>}</Show>
            </div>}</Show>
            <Show when={!live.loaded() && !messages().length && skeletonDue()}>
              <div class="transcript-skeleton" aria-busy="true" aria-label="Loading transcript">
                <For each={[0, 1, 2, 3]}>{() => <div class="transcript-skeleton-line" />}</For>
              </div>
            </Show>
            <Show when={live.hasOlder()}>
              <button class="transcript-older" disabled={live.loadingOlder()} onClick={loadEarlier}>
                {live.loadingOlder() ? "Loading…" : "Load earlier messages"}
              </button>
            </Show>
            <DataProvider data={live.data} directory={directory} sessionID={sessionID} onNavigateToSession={inspectSubagent}>
            {/* Tool rows read the mail they sent from these already-loaded records (Laptop2627); no extra request. */}
            <MailRecords.Provider value={receiptRecords}>
            <ToolAdornment.Provider value={ToolSize}>
            <For each={visibleTimeline()}>
              {(row, index) => {
                 if (row.type === "mail") return <MailRow message={row.message} ids={transcriptMailIDs()} name={mailName} session={sessionID} replied={mailReplied().has(row.message.id)} wakeLine={mailWake.line} />
                const m = row.message
                // The final step's footer; a text-ending footer may belong to an earlier step when the last step is empty.
                const final = () => turnSummaries().get(m.id)
                const summary = () => {
                  if (final()?.endsInText) return final()
                  return [...turnSummaries().values()].find(value => value.endsInText && value.copyMessageID === m.id)
                }
                const member = () => quiet().get(m.id)
                const folded = () => { const value = member(); return !!value && !quietOpen().has(value.group) }
                const segments = createMemo(() => m.role === "assistant" ? messageSegments(live.data.part[m.id] ?? [], toolRuns()) : [],
                  [], { equals: sameSegments })
                const ownHit = () => findHit()?.messageID === m.id && !toolRuns().byPart.has(findHit()!.partID) ? findHit() : undefined
                return (<>
                <Show when={member()?.first}>{(_) => {
                  const value = () => member()!
                  return <button type="button" class="quiet-turns" data-quiet-group={value().group} aria-expanded={!folded()}
                    onClick={() => setQuietOpen((open) => { const next = new Set(open); if (!next.delete(value().group)) next.add(value().group); return next })}>
                    <span class="quiet-turns-disclosure" aria-hidden="true">›</span>
                    <span>{props.quiet} handled {value().count} update{value().count === 1 ? "" : "s"}</span>
                  </button>
                }}</Show>
                <Show when={!folded()}>
                <div data-find-message={m.id} data-find-selected={ownHit() ? "true" : undefined}
                  data-anchored={anchored().has(m.id) ? "true" : undefined} data-quiet={member() ? "" : undefined}
                  onPointerUp={(event) => {
                    // Touch has no hover: one tap reveals the turn's Copy row.
                    if (event.pointerType === "touch" && m.role === "assistant") (event.currentTarget as HTMLElement).dataset.touchReveal = ""
                  }}>
                  <Show when={ownHit()}>{(hit) =>
                    <div class="find-jump" role="region" aria-label="Selected transcript match"><FindExcerpt hit={hit()} /></div>
                  }</Show>
                  <Show when={m.role === "user"} fallback={<>
                    {/* Porter's replies start with its avatar, once per turn (the desk conversation only). */}
                    <Show when={desk() && DESK.avatar && (() => { const previous = visibleTimeline()[index() - 1]; return !(previous && previous.type !== "mail" && (previous.message as { role?: string }).role === "assistant") })()}>
                      <img class="desk-reply-avatar" src={DESK.avatar} alt={DESK.name} width="20" height="20" />
                    </Show>
                    <TranscriptMessage message={m} parts={live.data.part[m.id] ?? []} renderTools={renderTools}
                    segments={segments()} renderRun={renderRun}
                    showAssistantCopyPartID={summary()?.endsInText ? summary()?.copyPartID ?? null : null}
                    turnFooter={summary()?.endsInText ? <TurnFooter summary={summary()!} /> : undefined} /></>}>
                    <Show when={wakeMarker(m, messages(), wakeEvents() ?? new Map())}>{(marker) =>
                      <div class="wake-marker" data-state={marker().state} role="note" title={marker().title}>
                        <span>{marker().label}</span>
                        <Show when={marker().covers.length}>
                          <button type="button" class="wake-marker-covers" onClick={() => scrollToMail(marker().covers[0]!)}
                            aria-label={`Show the ${marker().covers.length} mail this review covered`}>show mail</button>
                        </Show>
                      </div>}</Show>
                    <div class="msg-wrap" id={promptIDs().has(m.id) ? `prompt-${m.id}` : undefined} data-user-prompt={promptIDs().has(m.id) ? m.id : undefined}>
                      <TranscriptMessage message={m} parts={live.data.part[m.id] ?? []}
                        renderTools={renderTools}
                        mailRecord={mailRecords().get(mailSourceID(m) ?? "")}
                        mailDeliveries={mailRecords().get(mailSourceID(m) ?? "")?.deliveries} mailIDs={transcriptMailIDs()} mailName={mailName} />
                      {/* What the prompt was looking at or @-referenced, under the bubble (the agent's text is unchanged).
                          DOUBLE-TICK: delivered at promotion (the receipt's time, else the message's), read after a later
                          turn start; with context it shares the last line's row instead of adding one. */}
                      <ContextLines parts={live.data.part[m.id] ?? []} tick={promptIDs().has(m.id) ? () =>
                        <DeliveredTick turnStarted={turnStarted()} promotedAt={promotedAt(m.id) ?? m.time.created} row={false} /> : undefined} />
                      <Show when={!remote}><button
                        class="fork-here"
                        title="fork: new session with the history before this message"
                        disabled={forking() || !!nudgePhase()}
                        onClick={() => fork(m.id)}
                      >
                        fork from here
                      </button></Show>
                    </div>
                    <Show when={mailCauseRows().get(m.id)}>{(cause) => <MailCauseRow cause={cause()} name={mailName} />}</Show>
                  </Show>
                  {/* A tool-only or silent end has no last text to carry the Copy row: the footer stays visible. */}
                  <Show when={final() && !final()!.endsInText ? final() : undefined}>
                    {(s) => <TurnFooter summary={s()} copy={s().copyText} standalone />}
                  </Show>
                  <For each={restartMarkers(m, messages(), status() !== "idle")}>
                    {(marker) => <div class="restart-marker" data-state={marker.state} role="note">{marker.label}</div>}
                  </For>
                </div>
                </Show>
                </>
                )
              }}
            </For>
            </ToolAdornment.Provider>
            <Show when={nextHandoff() || composer.state.superseded || composer.state.admission?.fence}>
              <section class="banner handoff-recovery" aria-label="Session handoff" role={composer.state.superseded ? "alert" : "status"}>
                <Show when={composer.state.superseded} fallback={<p>This session handed off to a successor.</p>}>{(failure) => <>
                  <p>Message not sent: this session was superseded{failure().state === "pending" ? " (handoff pending)" : ""}. Your draft was kept.</p>
                  <div class="pending-bubble" dir="auto">{failure().draft.text}</div>
                  <ComposerImages images={failure().draft.images} />
                </>}</Show>
                <Show when={composer.state.admission?.fence}><div class="err" role="alert">
                  This session was superseded, but admission of this input is unknown. It may already have been accepted; the draft cannot be moved or resent until reconciled.
                  <div dir="auto">{composer.state.admission?.payload.text}</div>
                  <button disabled={composer.state.inputLoading || !connected()} onClick={() => composer.refreshInputs()}>Check admission</button>
                </div></Show>
                <Show when={!composer.state.admission?.fence && recoveryTarget()} fallback={<p>{pendingTransfer()
                  && !composer.state.admission?.fence ? "Handoff is still preparing; your message has not been sent."
                  : "Waiting for a confirmed successor or admission outcome. No message will be resent automatically."}</p>}>{(next) =>
                  <A href={sessionHref(next(), activity.session(next())?.directory ?? directory)} aria-disabled={recovering()} onClick={(event) => {
                    event.preventDefault()
                    void followSuccessor(next())
                  }}>Open successor and move drafts to its input</A>
                }</Show>
                <p class="dim">Nothing is sent automatically. A copy stays in this session.</p>
                <Show when={recoveryError()}><div class="err" role="alert">{recoveryError()}</div></Show>
              </section>
            </Show>
            <OutgoingMessages composer={composer} connected={connected()} session={session()} busy={busy()} running={runningTool()} delivered={deliveredWaiting()} echo={echo() || (composer.state.normalSubmission?.status === "unknown" && !composer.state.normalSubmission.messageID)} />
            <For each={appendedQuestions()}>
              {(item) => {
                const owner = () => item.request.sessionID !== sessionID
                  ? activity.session(item.request.sessionID)?.title ?? item.request.sessionID : undefined
                return <InlineQuestion request={item.request} directory={item.directory} owner={owner()}
                  onDone={() => activity.refreshDirectory(item.directory, true)} />
              }}
            </For>
            </MailRecords.Provider>
            </DataProvider>
            <Show when={thinking()}><Thinking /></Show>
          </div>
        </div>

        <WorkStatus /><ComposerResults composer={composer} connected={connected()} />
        <MailWakeBar unread={unreadMail()} status={mailWake.status()} editspace={location()?.name} session={sessionID}
          onWoke={() => { void mailWake.refetch(); void refetchMail() }} />
        {/* This page's own origin is behind Cloudflare Access and its session expired (DD #897): not offline, not re-pair. */}
        <Show when={accessState() === "sign-in"}>
          <div class="access-sign-in" role="status" aria-live="polite">
            <span>Sign-in expired. Drafts are kept; anything you send waits and goes once you sign in.</span>
            <button type="button" onClick={() => window.location.reload()}>Sign in</button>
          </div>
        </Show>
        {/* A read-only host (pinned-SSH Personal peer) takes no prompt, steer or reply from this page; its listener refuses them. */}
        <Show when={!sessionHost.readOnly} fallback={<p class="dim session-read-only-note" data-read-only-note>Read only: this session is on <bdi dir="auto">{sessionHost.label}</bdi>. Reply from that host.</p>}>
          <div class="prompt-box" classList={{ "prompt-expanded": floating() }} style={{ "--editor-expanded": `${expandedHeight()}px` }}>
            <ComposerPanel />
          </div>
        </Show>
        <SelfHandoffStatus handoff={selfHandoff} successor={(id) => <A href={hrefFor(id, directory)}><bdi dir="auto">{sessionLabel(id)}</bdi></A>} />
      </div>

      <Show when={!props.embedded}>
        {/* One right-hand panel at a time: a docked Front desk chat replaces the info panel until it closes. */}
        <Show when={rightOpen() && !companionDocked()}>
          <ResizeHandle side="right" />
        </Show>
        <Show when={!companionDocked()}><SessionInfo sessionID={sessionID} session={session()} messages={messages()} parts={live.data.part} providers={providers()} todos={live.data.todo} /></Show>
      </Show>
    </main>
    </SessionHostProvider>
  )
}

const TEXT_KEYS = new Set(["h", "d", "u", "n", "p"])

// Text selected in a field or the page: Ctrl+C copies it (Linux, Windows) instead of stopping.
const hasSelectedText = (target: EventTarget | null) => {
  if ((target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement) && target.selectionStart !== null && target.selectionStart !== target.selectionEnd) return true
  return !!window.getSelection()?.toString()
}
