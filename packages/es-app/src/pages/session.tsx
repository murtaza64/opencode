/* Conversation view: live transcript (session-ui renderer over an SSE-fed
 * store), prompt input, and inline permission/question replies. */
import { createEffect, createMemo, createResource, createSignal, For, onCleanup, onMount, Show, untrack } from "solid-js"
import { A, useNavigate, useParams, useSearchParams } from "@solidjs/router"
import { DataProvider } from "@opencode-ai/session-ui/context"
import { renderable, ToolAdornment, type MessagePartProps } from "@opencode-ai/session-ui/message-part"
import type { Part, ToolPart } from "@opencode-ai/sdk/v2"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Icon } from "@opencode-ai/ui/icon"
import { es, oc } from "../api"
import { createLiveSession, errorText } from "../live-session"
import FakeCaret from "../components/fake-caret"
import { SessionChips } from "../components/session-chips"
import { SessionPicker } from "../components/session-picker"
import { insertMention, mentionQuery, rankSessions, tokenBefore } from "../session-mention"
import { RelativeLines } from "../components/relative-lines"
import SessionInfo from "../components/session-info"
import { sessionHref, useDashboard, type SessionRow } from "../state"
import { rightOpen, startDrag } from "../ui"
import { createVim } from "../vim"
import { contextUsage, latestCompletedTurn, tokenCount } from "../context-usage"
import { getComposer, type ComposerAction } from "../composer"
import { pendingEcho } from "../pending-echo"
import { defaultImageCapability, prepareImageFile } from "../image-fit"
import { ComposerResults } from "../components/composer-controls"
import { DirectComposer } from "../components/direct-composer"
import { flash } from "../motion"
import { Glyph } from "../components/icons"
import { AppHeader } from "../components/native-header"
import { SessionTitle } from "../components/session-title"
import { SubagentTranscript } from "../components/subagent-transcript"
import { TranscriptMessage } from "../components/transcript-message"
import { InlineQuestion } from "../components/inline-question"
import { TodoPart } from "../components/todos"
import { usePulse } from "../pulse"
import { MailRow } from "../components/mail-row"
import { MailSubscriptions } from "../components/mail-subscriptions"
import { mailLocation, mailRows, mailSourceID } from "../mail-timeline"
import { handoffChain, handoffNext, successorFor } from "../handoffs"
import { ComposerImages } from "../components/composer-images"
import { ActivityBriefView } from "../components/activity-brief"
import { FindExcerpt, TranscriptFind } from "../components/transcript-find"
import type { FindHit } from "../transcript-find"
import { ToolSize } from "../components/tool-size"
import { ToolRun } from "../components/tool-run"
import { HeaderMenu } from "../components/header-menu"
import { FailureRetry } from "../components/session-failure"
import { completedTurns, messageSegments, planToolRuns, samePlan, sameSegments } from "../transcript-groups"
import { isUserPrompt, promptPosition, promptTarget } from "../transcript-nav"

function PermissionBanner(props: { p: any; directory: string; owner?: string; onDone: () => Promise<void> }) {
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
        <div class="banner-actions">
          <button disabled={sending()} onClick={() => act("once")}>allow once</button>
          <button disabled={sending()} onClick={() => act("always")}>always</button>
          <button disabled={sending()} class="danger" onClick={() => act("reject")}>reject</button>
        </div>
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
  const key = () => `${params.id}\u0000${(search.directory as string) || ""}`
  return (
    <Show when={key()} keyed>
      {(k) => {
        const [id, dir] = k.split("\u0000")
        return <SessionView sessionID={id!} directory={dir ?? ""} />
      }}
    </Show>
  )
}

function SessionView(props: { sessionID: string; directory: string }) {
  const sessionID = props.sessionID
  const directory = props.directory
  const composer = getComposer(sessionID, directory)
  const dialog = useDialog()
  let inspecting = false

  const { activity, sessionsError, editspaces, mailRevision, editspace, state, handoffs, handoffsError,
    laneOwners, lineage, lineageOwners, refetch, refetchHandoffs, transferPin } = useDashboard()
  const currentEditspace = () => editspace() ?? editspaces()?.default ?? state()?.editspace
  const ownedLane = () => laneOwners().find((lane) => lane.owner === sessionID)
  const predecessor = () => {
    const edge = handoffChain(sessionID, lineage())
    return edge && activity.session(edge.predecessor) ? edge : undefined
  }
  const nextHandoff = () => {
    const edge = handoffNext(sessionID, lineage())
    return edge && activity.session(edge.successor) ? edge : undefined
  }
  const successor = () => successorFor(sessionID, lineage(), lineageOwners())
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
  const location = () => mailLocation(directory, editspaces()?.editspaces ?? [], sessionID)
  const [mail] = createResource(
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
        results.flatMap(result => result.messages).map(message => [message.id, message]),
      ).values()], error: "" }),
       (failure: unknown) => ({ editspace: scope.name, lane: scope.lane ?? "", messages: [], error: `Unable to load mail: ${String(failure)}` }),
    ),
  )
  const [todoUpdate, setTodoUpdate] = createSignal<{ messageID?: string; at: number }>()
  const findRemovals = new Set<(messageID: string) => void>()
  const live = createLiveSession(sessionID, directory, (event) => {
    if (event.type.startsWith("session.input.")) void composer.refreshInputs()
    if (event.type === "message.removed" && event.properties?.sessionID === sessionID && typeof event.properties.messageID === "string")
      findRemovals.forEach((remove) => remove(event.properties!.messageID))
    if (event.type === "todo.updated" && event.properties?.sessionID === sessionID)
      setTodoUpdate({ messageID: live.data.message[sessionID]?.findLast((message) => message.role === "user")?.id, at: Date.now() })
  })
  const connected = () => !!session() && !live.loading() && !live.connectionError()
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
  onMount(() => {
    const timer = window.setInterval(() => {
      if (connected()) void composer.refreshInputs()
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
      (floating() ? floatEl : promptEl)?.focus({ preventScroll: true })
    }
  })

  // chat stick-to-bottom. Scroll events only ever RE-stick (at bottom) —
  // they must never unstick: programmatic pins deliver their scroll events
  // asynchronously, so content growth between a pin and its event would
  // read as "user scrolled up" and strand the view short of the bottom.
  // Unsticking happens only on explicit intent: wheel-up, touch, ^u, jumps.
  let stick = true
  const atBottom = () =>
    !!transcriptEl && transcriptEl.scrollHeight - transcriptEl.scrollTop - transcriptEl.clientHeight < 4
  const pin = () => {
    if (transcriptEl && !inspecting) transcriptEl.scrollTop = transcriptEl.scrollHeight
  }
  let userScroll = false
  const loadEarlier = async () => {
    if (!transcriptEl || !live.hasOlder() || live.loadingOlder()) return
    stick = false
    userScroll = false
    const height = transcriptEl.scrollHeight
    const top = transcriptEl.scrollTop
    try {
      await live.older()
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
      if (transcriptEl) transcriptEl.scrollTop = top + transcriptEl.scrollHeight - height
    } catch (failure) {
      setError(`Unable to load earlier messages: ${errorText(failure)}`)
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
    void dialog.show(() => <SubagentTranscript sessionID={id} directory={activity.session(id)?.directory || directory}
      onDispose={() => {
        inspecting = false
        queueMicrotask(() => {
          if (focus instanceof HTMLElement && focus.isConnected) focus.focus({ preventScroll: true })
          if (transcriptEl) transcriptEl.scrollTop = scroll
          stick = wasStuck
        })
      }} />)
  }
  onCleanup(() => { if (inspecting) dialog.close() })
  onMount(() => {
    live
      .load()
      .then(() => pin())
      .catch(() => {}) // live.connectionError reports load failures and recovery
    transcriptEl?.addEventListener(
      "scroll",
      () => {
        schedulePromptPosition()
        if (!inspecting && atBottom()) stick = true
        if (userScroll && transcriptEl && transcriptEl.scrollTop <= 200) void loadEarlier()
        userScroll = false
      },
      { passive: true },
    )
    transcriptEl?.addEventListener(
      "wheel",
      (e) => {
        if (e.deltaY < 0) {
          stick = false
          userScroll = true
          if (transcriptEl?.scrollTop === 0) void loadEarlier()
        }
      },
      { passive: true },
    )
    transcriptEl?.addEventListener("touchmove", () => { stick = false; userScroll = true }, { passive: true })
    const observer = new ResizeObserver(() => {
      if (stick) pin()
      schedulePromptPosition()
    })
    if (inner) observer.observe(inner)
    onCleanup(() => observer.disconnect())
  })
  const [error, setError] = createSignal("")

  const pending = createMemo(() => activity.pending(sessionID))
  const pendingQuestions = createMemo(() => pending().flatMap((item) => item.kind === "question" ? [item] : []))
  const subagentsRunning = () => activity.error(sessionID, directory) ? 0 :
    activity.running(sessionID).filter((id) => id !== sessionID).length
  const attentionError = () => sessionsError() || activity.error(sessionID, directory)

  const session = () => live.data.session[0]
  const status = () => live.data.session_status[sessionID]?.type ??
    (!activity.error(sessionID, directory) ? activity.status(sessionID) : undefined) ?? "idle"
  const messages = createMemo(() => live.data.message[sessionID] ?? [])
  const echo = createMemo(() => pendingEcho(composer.state.normalSubmission, messages().map((message) => ({
    id: message.id,
    role: message.role,
    text: message.role === "user"
      ? (live.data.part[message.id] ?? []).filter((part) => part.type === "text").map((part) => part.text).join("")
      : undefined,
  }))))
  createEffect(() => {
    const visible = echo()
    if (visible && stick) queueMicrotask(pin)
    if (!visible && composer.state.normalSubmission?.status === "accepted")
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
  const mailIDs = createMemo(() => new Set(mail()?.messages.map((message) => message.id) ?? []))
  const transcriptMailIDs = createMemo(() => new Set(timeline().flatMap(row => {
    const id = row.type === "mail" ? row.message.id : mailSourceID(row.message)
    return id ? [id] : []
  })))
  const mailRecords = createMemo(() => new Map(mail()?.messages.map((message) => [message.id, message] as const) ?? []))

  // viewing the session clears its unread state, including as new content
  // streams in while the page is open
  const { markViewed, refetchArchived } = useDashboard()
  onMount(() => markViewed(sessionID, true))
  createEffect(() => {
    messages()
    status()
    markViewed(sessionID)
  })

  // busy with nothing visibly moving (no running tool, no streaming part):
  // the model is thinking or the first token hasn't landed — show a pulse
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

  const busy = () => !live.error() && !live.connectionError() && (status() === "busy" || status() === "retry")
  const workState = createMemo(() => {
    if (live.error()) return "failed"
    if (live.connectionError()) return "disconnected"
    if (pending().length) return "waiting"
    if (status() === "retry") return "retry"
    if (busy() || subagentsRunning()) return "working"
    return attentionError() ? "disconnected" : "idle"
  })
  const WorkSpinner = () => {
    const tick = usePulse()
    return <span class="session-work-spinner" data-on={tick() % 2 ? "true" : undefined} aria-hidden="true" />
  }
  const briefInput = createMemo(() => {
    const current = messages().slice(Math.max(0, messages().findLastIndex((message) => message.role === "user")))
    const tools = current.flatMap((message) => message.role !== "assistant" ? [] :
      (live.data.part[message.id] ?? []).flatMap((part) => part.type === "tool" ? [part] : []))
    const todoTool = tools.findLast((part) => part.tool === "todowrite" && part.state.status === "completed")
    // Persisted TODOs outlive prompts. Only a write in this turn makes them current.
    const todoAt = todoUpdate()?.messageID === current[0]?.id ? todoUpdate()?.at :
      todoTool?.state.status === "completed" ? todoTool.state.time.end : undefined
    const lane = (state()?.threads ?? []).flatMap((thread: { lanes?: {
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
  const Thinking = () => {
    const tick = usePulse()
    return <div class="thinking" title="agent is thinking">
      <For each={[0, 1, 2]}>{(index) => <span data-on={tick() % 3 === index ? "true" : undefined} />}</For>
    </div>
  }
  const WorkStatus = () => (
    <div class="session-work-status" role="status" data-state={workState()} title={live.connectionError() || attentionError() || undefined}>
      <Show when={workState() === "working" || workState() === "idle"} fallback={<>
        <Show when={workState() === "retry"}><WorkSpinner /></Show>
        <span>{workState() === "retry" ? "Retrying" : workState() === "waiting" ? "Waiting for your reply" : workState() === "failed" ?
          `Session failed — see error ${inlineError() ? "in conversation" : "above"}` : "Reconnecting — activity unavailable"}</span>
        <Show when={workState() === "failed"}><FailureRetry sessionID={sessionID} /></Show>
      </>}>
        <Show when={workState() === "working" || workState() === "retry"}><WorkSpinner /></Show>
        <ActivityBriefView input={briefInput()} />
      </Show>
      <Show when={live.connectionError() || attentionError()}>
        <button disabled={live.loading()} onClick={() => {
          void live.load().catch(() => {})
          void activity.refreshDirectory(directory, true)
        }}>reconnect</button>
      </Show>
    </div>
  )
  createEffect(() => {
    const running = busy()
    if (!connected()) return
    untrack(() => composer.observeBusy(running))
  })

  // --- abort / fork ------------------------------------------------------

  // fire-and-forget: the status SSE flips busy->idle, no local state to sync
  const [aborting, setAborting] = createSignal(false)
  const [nudgePhase, setNudgePhase] = createSignal<"stopping" | "resuming">()
  const abort = async () => {
    if (aborting() || nudgePhase() || sending() || !busy()) return
    setAborting(true)
    try {
      await oc.abort(sessionID, directory)
    } catch (e) {
      setError(String(e))
    } finally {
      setAborting(false)
    }
  }

  // Esc Esc within 400ms in normal mode aborts; the insert->normal Escape
  // doesn't count (only taps landing while already in normal mode do)
  let lastEsc = 0
  const escTap = () => {
    const now = Date.now()
    if (now - lastEsc < 400) {
      lastEsc = 0
      abort()
      return
    }
    lastEsc = now
  }

  const [forking, setForking] = createSignal(false)
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
  const archive = async () => {
    try {
      await oc.archive(sessionID, directory)
      await live.load()
      refetchArchived() // moves it to the sidebar's archived section immediately
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
  const [parent] = createResource(
    () => (session() as any)?.parentID as string | undefined,
    (pid) => oc.session(pid, directory).catch(() => null),
  )

  // TUI-style turn footer, keyed by the turn's final assistant message id:
  // agent, model, wall-clock (user prompt -> completed), and an interrupted
  // marker for aborted turns. In-flight turns are omitted until they complete
  // or get aborted.
  type TurnSummary = { agent?: string; providerID?: string; modelID?: string; duration?: number; interrupted: boolean }
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
    const flush = () => {
      if (last && turnsDone().has(last.parentID)) {
        const end = last.time?.completed
        out.set(last.id, {
          agent: last.agent ?? last.mode,
          providerID: last.providerID,
          modelID: last.modelID,
          duration: turnStart !== undefined && end ? end - turnStart : undefined,
          interrupted: last.error?.name === "MessageAbortedError",
        })
      }
      last = undefined
    }
    for (const m of messages()) {
      const time = (m as any).time ?? {}
      if (m.role === "user") {
        flush()
        turnStart = time.created
      } else if (time.completed || (m as any).error) {
        last = m
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
  const [providers] = createResource(() => oc.providers(directory).catch(() => ({ providers: [], default: {} })))
  // context usage of the latest completed turn (shared formula with the info
  // panel and sidebar hover card: all token classes vs the model's limit)
  const latestUsage = createMemo(() => contextUsage(latestCompletedTurn(messages()), providers()))

  const [agents, { refetch: refetchAgents }] = createResource(() => oc.agents(directory).then(
    (items) => ({ items: items.filter((agent) => !agent.hidden && agent.mode !== "subagent"), error: "" }),
    (error: unknown) => ({ items: [], error: String(error) }),
  ))
  const activeAgent = () => {
    const previous = messages().findLast((message) => message.role === "user")
    return session()?.agent ?? previous?.agent
  }
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

  const nudge = async () => {
    const s = session()
    if (!s || nudgePhase() || aborting() || sending()) return
    const model = composer.state.sessionModel ?? lastTurnModel() ?? undefined
    setError("")
    setNudgePhase("stopping")
    try {
      await oc.abort(sessionID, directory)
      setNudgePhase("resuming")
      await oc.prompt(s, directory, "Resume where you left off. Reorient briefly and continue the outstanding work.", { model })
      stick = true
      queueMicrotask(pin)
      void live.load().catch(() => {})
      void activity.refreshDirectory(directory, true)
    } catch (e) {
      setError(`${nudgePhase() === "stopping" ? "Could not interrupt session" : "Session interrupted, but resume failed"}: ${String(e)}`)
    } finally {
      setNudgePhase(undefined)
    }
  }

  const send = async (action?: ComposerAction) => {
    const s = session()
    if (!s || !connected() || nudgePhase() || aborting()) return
    const editor = floating() ? floatEl : promptEl
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
    composer.observeBusy(busy())
    stick = true
    queueMicrotask(pin)
    await composer.submitVisible(action ?? (composer.state.busy ? composer.state.keyboardTarget : "steer"), s, nextModel(), messages().at(-1)?.id)
  }

  let transcriptEl: HTMLDivElement | undefined
  let inner: HTMLDivElement | undefined
  let promptEl: HTMLTextAreaElement | undefined
  let floatEl: HTMLTextAreaElement | undefined
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
    findJumped = true
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
  const { sessions, sessionRows, archivedIds } = useDashboard()
  const autoFollowStopped = new Set<string>()
  let following = false
  const followSuccessor = async (next: string) => {
    if (following) return
    following = true
    let prompted = false
    let cancelled = false
    const editor = floating() ? floatEl : promptEl
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
    const editor = floating() ? floatEl : promptEl
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
    const el = floating() ? floatEl : promptEl
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
      const target = floating() ? floatEl : promptEl
      if (!target?.isConnected) return
      target?.setSelectionRange(selection[0], selection[1])
      setCaret(null)
    })
  }

  const focusInsert = () => vim.setMode("insert")
  const cycleMode = (e: KeyboardEvent) => {
    if (e.isComposing || !e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || e.code !== "KeyM") return false
    e.preventDefault()
    e.stopPropagation()
    if (!composer.state.busy) return true
    if (e.repeat) return true
    lastEsc = 0
    const inputMode = vim.mode()
    composer.selectTarget(composer.state.keyboardTarget === "steer" ? "queue" : composer.state.keyboardTarget === "queue" ? "aside" : "steer")
    if (e.target instanceof HTMLSelectElement && e.target.disabled) {
      const editor = floating() ? floatEl : promptEl
      editor?.focus()
      vim.setMode(inputMode)
      editor?.setSelectionRange(...activeDraft().selection)
      vim.refresh(editor)
    }
    return true
  }

  const scrollTranscript = (dir: 1 | -1) => {
    if (!transcriptEl) return
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
    const tops = promptTops()
    const index = promptTarget(tops, dir)
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
      send()
      return
    }
    if (e.key === "Escape" && vim.mode() === "normal" && composer.state.keyboardTarget !== "aside") escTap()
    if (navKeys(e)) return
    vim.handleKeyDown(e)
  }

  // global keys when focus is outside the prompt: nav + mode entry
  onMount(() => {
    const handler = (e: KeyboardEvent) => {
      if (dialog.active || e.defaultPrevented) return
      const target = e.target as HTMLElement
      if (target.closest(".prompt-box, .float-editor") && cycleMode(e)) return
      if (e.isComposing || target.closest("textarea, input, select, button, a, [contenteditable], [data-composer-controls], .generated-input")) return
      if (navKeys(e)) return
      if (e.key === "Tab" && !e.ctrlKey && !e.metaKey && !e.altKey && vim.mode() === "normal") {
        e.preventDefault()
        if (!e.repeat) switchSession(e.shiftKey)
        return
      }
      if (e.key === "Escape") {
        if (vim.mode() === "normal") escTap()
        vim.setMode("normal")
        return
      }
      if (e.key === "i" && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault()
        const t = floating() ? floatEl : promptEl
        t?.focus()
        vim.setMode("insert")
      }
    }
    window.addEventListener("keydown", handler)
    onCleanup(() => window.removeEventListener("keydown", handler))
  })

  // --- floating editor ---------------------------------------------------

  const [floating, setFloating] = createSignal(false)
  let floatDismissed = false
  // "Approaching full": the inline textarea has a fixed visible height, so open once its
  // content fills ~90% of that box, just before it starts scrolling. scrollHeight never
  // drops below clientHeight, so collapse the box briefly to measure the content itself.
  const nearFull = (el: HTMLTextAreaElement) => {
    const box = el.clientHeight
    if (el.scrollHeight > box) return true
    const style = [el.style.height, el.style.minHeight] as const
    const top = el.scrollTop
    el.style.minHeight = "0"
    el.style.height = "0"
    const content = el.scrollHeight
    el.style.height = style[0]
    el.style.minHeight = style[1]
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
    if (floating() || floatDismissed || !promptEl || !nearFull(promptEl)) return
    // This runs inside setDraft from onInput, before the handler saves the new selection,
    // so the stored selection is one keystroke stale; read the live caret instead.
    const source = document.activeElement === promptEl ? promptEl : undefined
    const selection = source ? ([source.selectionStart, source.selectionEnd] as const) : untrack(() => [...activeDraft().selection] as const)
    const inputMode = untrack(vim.mode)
    setFloating(true)
    queueMicrotask(() => {
      if (!floatEl) return
      floatEl.focus()
      vim.setMode(inputMode)
      floatEl.setSelectionRange(selection[0], selection[1])
      saveSelection(floatEl)
      vim.refresh(floatEl)
    })
  })
  const closeFloat = () => {
    const inputMode = vim.mode()
    if (floatEl) saveSelection(floatEl)
    floatDismissed = true
    setFloating(false)
    promptEl?.focus()
    vim.setMode(inputMode)
    promptEl?.setSelectionRange(...activeDraft().selection)
    vim.refresh(promptEl)
  }
  const toggleFloat = () => {
    if (floating()) {
      closeFloat()
      return
    }
    floatDismissed = false
    const inputMode = vim.mode()
    if (promptEl) saveSelection(promptEl)
    setFloating(true)
    queueMicrotask(() => {
      floatEl?.focus()
      vim.setMode(inputMode)
      floatEl?.setSelectionRange(...activeDraft().selection)
      vim.refresh(floatEl)
    })
  }

  const Editor = (props: { expanded?: boolean }) => {
    const [query, setQuery] = createSignal<ReturnType<typeof mentionQuery>>()
    const [selected, setSelected] = createSignal(0)
    let composing = false
    const target = () => props.expanded ? floatEl : promptEl
    const rows = () => query() ? rankSessions(sessionRows().filter((row) => !archivedIds().has(row.id)), query()!.query, sessionID) : []
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
    const insert = (row: SessionRow) => {
      const el = target()
      const active = query()
      if (!el || !active) return
      const next = insertMention(el.value, active.start, el.selectionStart, row.id)
      apply(el, next.text, next.caret)
    }
    const keyDown = (event: KeyboardEvent) => {
      const el = event.currentTarget as HTMLTextAreaElement
      if (event.isComposing || composing || vim.mode() === "normal" || dialog.active) return
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
      const choose = (event.key === "Enter" || event.key === "Tab") && !event.ctrlKey && !event.metaKey && !event.altKey
      if (!down && !up && !choose && event.key !== "Escape") return
      if (event.key === "Escape") setQuery(undefined)
      if (down && count) setSelected((selected() + 1) % count)
      if (up && count) setSelected((selected() + count - 1) % count)
      if (choose && count) insert(rows()[selected()] ?? rows()[0]!)
      event.preventDefault()
      event.stopPropagation()
    }
    return <div class="ta-wrap" classList={{ "numbered-editor": props.expanded }}>
      <textarea ref={(el) => {
        if (props.expanded) floatEl = el
        if (!props.expanded) promptEl = el
        el.addEventListener("keydown", keyDown, true)
        onCleanup(() => el.removeEventListener("keydown", keyDown, true))
      }}
        aria-label="Message" dir="auto" placeholder="Write a message…"
        classList={{ "vim-normal": vim.mode() === "normal", "vim-insert": vim.mode() === "insert" }}
        value={draft()} onInput={(e) => { setDraft(e.currentTarget.value); update(e.currentTarget, e.isComposing) }}
        onPaste={pasteImages} onDrop={dropImages} onDragOver={(e) => e.preventDefault()}
        onKeyDown={promptKeyDown}
        onCompositionStart={() => { composing = true; setQuery(undefined) }}
        onCompositionEnd={() => { composing = false; setQuery(undefined) }}
        onSelect={(e) => { saveSelection(e.currentTarget); if (query() && (e.currentTarget.selectionStart !== e.currentTarget.selectionEnd || !mentionQuery(e.currentTarget.value, e.currentTarget.selectionStart))) setQuery(undefined) }}
        onKeyUp={(e) => { if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) update(e.currentTarget, e.isComposing); else saveSelection(e.currentTarget) }}
        onFocus={focusInsert} onClick={(e) => { focusInsert(); update(e.currentTarget) }}
        onBlur={(e) => { saveSelection(e.currentTarget); setQuery(undefined) }} />
      <SessionChips target={target()} text={draft()} selection={activeDraft().selection} />
      <Show when={query() && vim.mode() !== "normal" && !composing}><SessionPicker rows={rows()} selected={selected()} select={setSelected} insert={insert} /></Show>
      <Show when={props.expanded}><RelativeLines target={floatEl!} value={draft()} /></Show>
      <FakeCaret target={target()} caret={caret()} mode={vim.mode()} />
    </div>
  }
  const Attachments = () => <Show when={images().length}><div class="attachments"><For each={images()}>{(image) => (
    <span class="attachment-chip" data-normalized={image.normalized ? "true" : undefined} title={`${image.filename}${image.normalized ? " · resized to fit" : ""}`}><img src={image.url} alt={image.filename} />{image.filename.slice(0, 24)}
      <button aria-label={`Remove ${image.filename}`} onClick={() => composer.setImages(images().filter((item) => item.id !== image.id), composer.state.visibleBuffer)}>×</button>
    </span>
  )}</For></div></Show>
  const ComposerPanel = (props: { expanded?: boolean }) => (
    <DirectComposer composer={composer} connected={connected() && !nudgePhase() && !aborting()} submit={send} restoreDraft={restoreDraft}
      editor={<Editor expanded={props.expanded} />} attachments={<Attachments />}
      activeAgent={activeAgent()} agents={agents()?.items ?? []} agentError={agents()?.error} retryAgents={() => { void refetchAgents() }}
      sessionMetadata={<Show when={latestUsage()}>
        {(u) => (
          <span class="context-pct"
            classList={{ warn: (u().percent ?? 0) >= 70, high: (u().percent ?? 0) >= 90 }}
            title="Context of the last completed turn: input, output, reasoning and cache tokens">
            {tokenCount(u().tokens)}
          </span>
        )}
      </Show>}
      sessionActions={<>
        <Show when={!props.expanded}><button aria-label="Expand editor" title="Expand editor (Ctrl+E)" onClick={toggleFloat}><Glyph name="screen-full" />Expand editor</button></Show>
        <button title="Fork this session at its tip" disabled={forking() || !!nudgePhase()} onClick={() => fork()}>
          <Glyph name="repo-forked" />{forking() ? "Forking…" : "Fork"}
        </button>
        <Show when={ownedLane()}><button title="Hand off this lane to a new session" disabled={handingOff()} onClick={() => setHandoffOpen(!handoffOpen())}><Glyph name="arrow-switch" />Hand off</button></Show>
        <Show when={!session()?.time?.archived} fallback={<span class="archived-chip">Archived</span>}>
          <button title="Archive this session (hides it from lists)" disabled={!!nudgePhase()} onClick={archive}><Glyph name="archive" />Archive</button>
        </Show>
        <button class="danger" title="Delete this session permanently" disabled={!!nudgePhase()} onClick={remove}><Glyph name="trash" />Delete</button>
        <Show when={busy()} fallback={<button onClick={() => { stick = true; pin() }}>↓ Bottom</button>}>
          <button class="stop" aria-label="Stop session" title="Stop the parent session" disabled={aborting() || !!nudgePhase() || sending()} onClick={abort}>
            <Glyph name="square-fill" />Stop
          </button>
        </Show>
        <button
          title="Interrupt this session, then send a resume message"
          disabled={!session() || !!nudgePhase() || aborting() || sending()}
          onClick={nudge}
        >
          <Glyph name="zap" />{nudgePhase() === "stopping" ? "Stopping…" : nudgePhase() === "resuming" ? "Sending resume…" : "Nudge"}
        </button>
      </>}>
      <label class="direct-setting"><select class="model-select" aria-label={composer.state.visibleBuffer === "aside" ? "Aside model" : "Session model"}
        title={composer.state.visibleBuffer === "aside" ? "Model for this Aside only" : "Session model for future turns, including Steer and Queue"}
        value={modelChoice() ? `${modelChoice()!.providerID}\u0000${modelChoice()!.modelID}` : ""}
        onChange={(e) => {
          const [providerID, modelID] = e.currentTarget.value.split("\u0000")
          const model = providerID && modelID ? { providerID, modelID } : null
          if (composer.state.visibleBuffer === "aside") composer.setVisibleModel(model)
          else if (model) {
            const selected = providers()?.providers.find((provider) => provider.id === providerID)?.models?.[modelID]
            if (composer.state.task.images.length && selected?.capabilities?.input?.image === false) {
              setError("Selected model does not support image input. Images and session model were not changed.")
              return
            }
            void composer.chooseSessionModel(model)
          }
        }}>
        <option value="" disabled={composer.state.visibleBuffer !== "aside"} selected={!modelChoice()}>{composer.state.visibleBuffer === "aside" ? "Use session model" : "Choose session model"}</option>
        <For each={providers()?.providers ?? []}>
          {(prov) => (
            <optgroup label={prov.id}>
              <For each={Object.keys(prov.models ?? {})}>
                {(mid) => <option value={`${prov.id}\u0000${mid}`} selected={modelChoice()?.providerID === prov.id && modelChoice()?.modelID === mid}>{mid}</option>}
              </For>
            </optgroup>
          )}
        </For>
      </select></label>
      <Show when={composer.state.visibleBuffer === "aside" && modelChoice()}><button onClick={() => composer.setVisibleModel(null)}>Use session model</button></Show>
      <Show when={composer.state.visibleBuffer !== "aside" && (busy() || composer.state.busy || composer.state.modelSelection)}><span class="dim">{composer.state.modelSelection ? "Confirming model…" : "Model changes apply to future turns"}</span></Show>
      <Show when={composer.state.modelSelection?.status === "unknown"}><button onClick={() => { void composer.reconcileSessionModel() }}>Check session model</button></Show>
    </DirectComposer>
  )

  // Display-only coalescing of adjacent tool calls in finished turns; see transcript-groups.
  const partVisible = (part: Part) => part.type === "text" || part.type === "reasoning"
    ? /\S/.test(part.text ?? "") : renderable(part, true, renderTools)
  const toolRuns = createMemo(() => planToolRuns(timeline(), {
    parts: (id) => live.data.part[id] ?? [],
    visible: partVisible,
    completed: turnsDone(),
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
  const promptIDs = createMemo(() => new Set(timeline().flatMap((row) =>
    row.type === "transcript" && isUserPrompt(row.message, live.data.part[row.message.id] ?? []) ? [row.message.id] : [])))
  createEffect(() => { promptIDs(); schedulePromptPosition() })
  const renderRun = (key: string) => <Show when={toolRuns().runs.get(key)}>{(run) => {
    const hit = () => findHit() && run().members.some((member) => member.partID === findHit()!.partID) ? findHit() : undefined
    return <ToolRun run={run()} message={(id) => messageByID().get(id)} parts={(id) => live.data.part[id] ?? []}
      open={runOpen(key)} onToggle={(open) => toggleRun(key, open)} renderTools={renderTools}
      selectedPart={hit()?.partID}
      excerpt={<Show when={hit()}>{(selected) => <div class="find-jump" role="region" aria-label="Selected transcript match"><FindExcerpt hit={selected()} /></div>}</Show>} />
  }}</Show>

  return (
    <main class="session-page" classList={{ "finding-transcript": findOpen() }}>
      <div class="session-main">
        <AppHeader>
          <SessionTitle sessionID={sessionID} directory={directory} session={session()} suspendBlurSave={findOpen()} onSaved={(info) => {
            live.apply({ type: "session.updated", properties: { sessionID, info } })
            void refetch()
          }} />
          <span class="dim session-state" data-state={workState()}>{workState() === "working" ? "busy" : workState()}</span>
          <Show when={subagentsRunning()}><span class="dim">{subagentsRunning()} subagent(s) running</span></Show>
          <Show when={(session() as any)?.parentID}>
            {(pid) => (
              <span class="fork-crumb">
                forked from{" "}
                <A href={sessionHref(pid(), directory)} title={pid()}>
                  {parent()?.title ?? pid()}
                </A>
              </span>
            )}
          </Show>
          {/* Icon controls keep the title primary; names, shortcuts and prompt scope stay accessible. */}
          <div class="session-header-tools">
            <span class="sr-only" id={`prompt-scope-${sessionID}`}>{promptScope()}</span>
            <button class="header-icon" aria-label="Find" aria-keyshortcuts="Meta+F Control+F" title="Find in transcript (Cmd/Ctrl+F)"
              onPointerDown={(event) => event.preventDefault()} onClick={openFind}><Icon name="magnifying-glass" size="small" /></button>
            <button class="header-icon" aria-label="Previous prompt" aria-keyshortcuts="Control+P" aria-describedby={`prompt-scope-${sessionID}`}
              title={`Previous prompt (Ctrl+P) · ${promptScope()}`} onPointerDown={(event) => event.preventDefault()}
              disabled={!promptState().previous && !live.hasOlder()} onClick={() => jumpUserMessage(-1)}>
              <span class="header-icon-up"><Icon name="chevron-down" size="small" /></span>
            </button>
            <button class="header-icon" aria-label="Next prompt" aria-keyshortcuts="Control+N" aria-describedby={`prompt-scope-${sessionID}`}
              title={`Next prompt (Ctrl+N) · ${promptScope()}`} onPointerDown={(event) => event.preventDefault()}
              disabled={!promptState().next} onClick={() => jumpUserMessage(1)}><Icon name="chevron-down" size="small" /></button>
            <Show when={location()}>{(scope) =>
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
          <Show when={handoffsError() && (ownedLane() || predecessor())}><div class="err" role="alert">{handoffsError()}</div></Show>
          <Show when={handoffError()}><div class="err" role="alert">{handoffError()}</div></Show>
          <Show when={handoffPending()}><div role="status" class="banner">Handoff is waiting for the current turn to finish. Your draft stays here until ownership transfers.</div></Show>
          <Show when={handoffOpen() && ownedLane()}>
            <div class="banner handoff-form">
              <div class="banner-head">Hand off lane {ownedLane()?.lane}</div>
              <input aria-label="Successor task" placeholder="Successor task" value={handoffTask()} onInput={(e) => setHandoffTask(e.currentTarget.value)} />
              <textarea aria-label="Handoff notes" placeholder="Handoff context for the successor" value={handoffNotes()} onInput={(e) => setHandoffNotes(e.currentTarget.value)} />
              <div class="banner-actions"><button disabled={handingOff() || !handoffTask().trim() || !handoffNotes().trim()} onClick={handoff}>{handingOff() ? "Handing off…" : "Create successor"}</button></div>
            </div>
          </Show>
          <Show when={mail()?.error}><div class="err" role="alert">{mail()?.error}</div></Show>
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
                  <Show when={!mail()?.messages.length}><div class="dim">No lane mail.</div></Show>
                  <For each={mail()?.messages ?? []}>{(message) => <MailRow message={message} ids={mailIDs()} anchor="lane-mail" />}</For>
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

        <div class="transcript" ref={transcriptEl}>
          <div ref={inner} class="transcript-inner" onClick={(event) => {
            // Only a standalone chip's own disclosure counts; action buttons inside it do not.
            const trigger = (event.target as Element).closest("[data-slot='collapsible-trigger']")
            if (!trigger || trigger.closest(".tool-run")) return
            const chip = trigger.closest("[data-component='tool-part-wrapper'], .tool-collapsible[data-timeline-part-ids]")
            if (!chip || chip.querySelector("[data-slot='collapsible-trigger']") !== trigger) return
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
            <Show when={predecessor()}>{(edge) => <div class="banner handoff-history" aria-label="Previous session">
              Previous session: <A href={sessionHref(edge().predecessor, activity.session(edge().predecessor)?.directory)}><bdi dir="auto">{activity.session(edge().predecessor)?.title ?? edge().predecessor}</bdi></A>
              {" · "}<bdi dir="ltr">{edge().predecessor}</bdi>
            </div>}</Show>
            <Show when={live.hasOlder()}>
              <button class="transcript-older" disabled={live.loadingOlder()} onClick={loadEarlier}>
                {live.loadingOlder() ? "Loading…" : "Load earlier messages"}
              </button>
            </Show>
            <DataProvider data={live.data} directory={directory} sessionID={sessionID} onNavigateToSession={inspectSubagent}>
            <ToolAdornment.Provider value={ToolSize}>
            <For each={timeline()}>
              {(row) => {
                 if (row.type === "mail") return <MailRow message={row.message} ids={transcriptMailIDs()} />
                const m = row.message
                const segments = createMemo(() => m.role === "assistant" ? messageSegments(live.data.part[m.id] ?? [], toolRuns()) : [],
                  [], { equals: sameSegments })
                const ownHit = () => findHit()?.messageID === m.id && !toolRuns().byPart.has(findHit()!.partID) ? findHit() : undefined
                return (
                <div data-find-message={m.id} data-find-selected={ownHit() ? "true" : undefined}>
                  <Show when={ownHit()}>{(hit) =>
                    <div class="find-jump" role="region" aria-label="Selected transcript match"><FindExcerpt hit={hit()} /></div>
                  }</Show>
                  <Show when={m.role === "user"} fallback={<TranscriptMessage message={m} parts={live.data.part[m.id] ?? []} renderTools={renderTools}
                    segments={segments()} renderRun={renderRun} />}>
                    <div class="msg-wrap" id={promptIDs().has(m.id) ? `prompt-${m.id}` : undefined} data-user-prompt={promptIDs().has(m.id) ? m.id : undefined}>
                      <TranscriptMessage message={m} parts={live.data.part[m.id] ?? []}
                        renderTools={renderTools}
                        mailRecord={mailRecords().get(mailSourceID(m) ?? "")}
                        mailDeliveries={mailRecords().get(mailSourceID(m) ?? "")?.deliveries} mailIDs={transcriptMailIDs()} />
                      <button
                        class="fork-here"
                        title="fork: new session with the history before this message"
                        disabled={forking() || !!nudgePhase()}
                        onClick={() => fork(m.id)}
                      >
                        fork from here
                      </button>
                    </div>
                  </Show>
                  <Show when={turnSummaries().get(m.id)}>
                    {(s) => (
                      <div class="turn-summary" classList={{ interrupted: s().interrupted }}>
                        <span class="marker">▣</span> <span class="agent">{titlecase(s().agent)}</span>
                        {" · "}
                        {modelName(s().providerID, s().modelID)}
                        <Show when={s().duration}>{(d) => <> · {fmtDuration(d())}</>}</Show>
                        <Show when={s().interrupted}> · interrupted</Show>
                      </div>
                    )}
                  </Show>
                </div>
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
                <Show when={!composer.state.admission?.fence && recoveryTarget()} fallback={<p>Waiting for a confirmed successor or admission outcome. No message will be resent automatically.</p>}>{(next) =>
                  <A href={sessionHref(next(), activity.session(next())?.directory ?? directory)} aria-disabled={recovering()} onClick={(event) => {
                    event.preventDefault()
                    void followSuccessor(next())
                  }}>Open successor and move drafts to its input</A>
                }</Show>
                <p class="dim">Nothing is sent automatically. A copy stays in this session.</p>
                <Show when={recoveryError()}><div class="err" role="alert">{recoveryError()}</div></Show>
              </section>
            </Show>
            <Show when={echo() && composer.state.normalSubmission}>
              {(submission) => (
                <div class="pending-msg" data-status={submission().status}>
                  <div class="pending-bubble" dir="auto">{submission().text}{submission().images ? ` · ${submission().images} image(s)` : ""}</div>
                  <div class="pending-hint">{submission().status === "sending" ? "Sending…" : submission().status === "accepted" ? "Sent — waiting for the daemon…" : "Send not confirmed"}</div>
                </div>
              )}
            </Show>
            <For each={appendedQuestions()}>
              {(item) => {
                const owner = () => item.request.sessionID !== sessionID
                  ? activity.session(item.request.sessionID)?.title ?? item.request.sessionID : undefined
                return <InlineQuestion request={item.request} directory={item.directory} owner={owner()}
                  onDone={() => activity.refreshDirectory(item.directory, true)} />
              }}
            </For>
            </DataProvider>
            <Show when={thinking()}><Thinking /></Show>
          </div>
        </div>

        <Show when={!floating()}><WorkStatus /><ComposerResults composer={composer} connected={connected()} /></Show>
        <div class="prompt-box" inert={floating()}>
          <ComposerPanel />
        </div>
      </div>

      <Show when={floating()}>
        <div class="float-editor">
          <div class="float-head">
            <span class="dim">Expanded editor</span>
            <span style="flex:1" />
            <button onClick={closeFloat}>⤡ collapse <kbd class="composer-key">Ctrl+E</kbd></button>
          </div>
          <WorkStatus />
          <ComposerResults composer={composer} connected={connected()} />
          <ComposerPanel expanded />
        </div>
      </Show>

      <Show when={rightOpen()}>
        <div class="drag-handle" onMouseDown={(e) => startDrag("right", e)} />
      </Show>
      <SessionInfo sessionID={sessionID} session={session()} messages={messages()} parts={live.data.part} providers={providers()} todos={live.data.todo} />
    </main>
  )
}
