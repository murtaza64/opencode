/* Conversation view: live transcript (session-ui renderer over an SSE-fed
 * store), prompt input, and inline permission/question replies. */
import { createEffect, createMemo, createResource, createSignal, For, onCleanup, onMount, Show, untrack } from "solid-js"
import { A, useNavigate, useParams, useSearchParams } from "@solidjs/router"
import { DataProvider } from "@opencode-ai/session-ui/context"
import type { MessagePartProps } from "@opencode-ai/session-ui/message-part"
import type { ToolPart } from "@opencode-ai/sdk/v2"
import { useDialog } from "@opencode-ai/ui/context/dialog"
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
import { contextUsage, latestCompletedTurn } from "../context-usage"
import { getComposer, type ComposerAction } from "../composer"
import { pendingEcho } from "../pending-echo"
import { defaultImageCapability, prepareImageFile } from "../image-fit"
import { ComposerResults } from "../components/composer-controls"
import { DirectComposer } from "../components/direct-composer"
import { AppHeader } from "../components/native-header"
import { SubagentTranscript } from "../components/subagent-transcript"
import { TranscriptMessage } from "../components/transcript-message"
import { InlineQuestion } from "../components/inline-question"
import { TodoPart } from "../components/todos"
import { usePulse } from "../pulse"
import { MailRow } from "../components/mail-row"
import { MailSubscriptions } from "../components/mail-subscriptions"
import { mailForSession, mailLocation, mailRows, mailSourceID } from "../mail-timeline"
import { handoffChain, handoffNext, successorFor } from "../handoffs"

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
    laneOwners, refetch, refetchHandoffs, transferPin } = useDashboard()
  const currentEditspace = () => editspace() ?? editspaces()?.default ?? state()?.editspace
  const ownedLane = () => laneOwners().find((lane) => lane.owner === sessionID)
  const predecessor = () => handoffChain(sessionID, handoffs() ?? [])
  const nextHandoff = () => handoffNext(sessionID, handoffs() ?? [])
  const successor = () => successorFor(sessionID, handoffs() ?? [], laneOwners())
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
  const [subscriptionsOpen, setSubscriptionsOpen] = createSignal(false)
  const [laneMailOpen, setLaneMailOpen] = createSignal(false)
  const location = () => mailLocation(directory, editspaces()?.editspaces ?? [], sessionID)
  const [mail] = createResource(
    () => {
      const scope = location()
      if (!scope) return
      return { ...scope, revision: mailRevision() }
    },
    (scope) => es.mail(scope.name, scope.lane !== undefined ? { lane: scope.lane } : { session: scope.session ?? sessionID }).then(
      (result) => ({ ...result, error: "" }),
       (failure: unknown) => ({ editspace: scope.name, lane: scope.lane ?? "", messages: [], error: `Unable to load mail: ${String(failure)}` }),
    ),
  )
  const live = createLiveSession(sessionID, directory, (event) => {
    if (event.type.startsWith("session.input.")) void composer.refreshInputs()
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
  // Predecessor and successor share one lane feed; each transcript shows only its own interval.
  const sessionMail = createMemo(() => {
    const feed = mail()
    if (!feed) return
    const next = nextHandoff()
    return mailForSession(feed.messages, {
      sessionID,
      lane: location()?.lane,
      from: predecessor() ? session()?.time.created : undefined,
      to: next ? activity.session(next.successor)?.time.created : undefined,
    })
  })
  const timeline = createMemo<ReturnType<typeof mailRows>>((previous) => {
    const feed = mail()
    return mailRows(messages(), feed && { ...feed, messages: sessionMail() ?? [] }, previous)
  })
  const mailIDs = createMemo(() => new Set(mail()?.messages.map((message) => message.id) ?? []))
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
  const Thinking = () => {
    const tick = usePulse()
    return <div class="thinking" title="agent is thinking">
      <For each={[0, 1, 2]}>{(index) => <span data-on={tick() % 3 === index ? "true" : undefined} />}</For>
    </div>
  }
  const WorkStatus = () => (
    <div class="session-work-status" role="status" data-state={workState()} title={live.connectionError() || attentionError() || undefined}>
      <Show when={workState() !== "idle"}>
        <Show when={workState() === "working" || workState() === "retry"}><WorkSpinner /></Show>
        <span>{workState() === "working" ? "Working" : workState() === "retry" ? "Retrying" :
           workState() === "waiting" ? "Waiting for your reply" : workState() === "failed" ?
              `Session failed — see error ${inlineError() ? "in conversation" : "above"}` : "Reconnecting — activity unavailable"}</span>
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
  const turnSummaries = createMemo(() => {
    const out = new Map<string, TurnSummary>()
    let turnStart: number | undefined
    let last: any | undefined
    const flush = () => {
      if (last) {
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
    : composer.state.modelSelection?.model ?? composer.state.sessionModel ?? composer.state.task.model
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

  // --- vim-like modal input + navigation --------------------------------

  const navigate = useNavigate()
  const { sessions, sessionRows, archivedIds } = useDashboard()
  const followSuccessor = async (next: string) => {
    const editor = floating() ? floatEl : promptEl
    if (editor) saveSelection(editor)
    if (!await getComposer(next, directory).importHandoffDrafts(composer)) {
      setHandoffError("Could not save the successor draft. Keep this page open and copy your draft before navigating.")
      return
    }
    transferPin(sessionID, next, directory)
    navigate(sessionHref(next, directory))
  }
  createEffect(() => {
    const edge = successor()
    if (!wasOwner() || !edge || handingOff()) return
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

  const jumpUserMessage = (dir: 1 | -1) => {
    if (!transcriptEl) return
    const nodes = [...transcriptEl.querySelectorAll('[data-component="user-message"]')] as HTMLElement[]
    if (!nodes.length) return
    const top = transcriptEl.scrollTop
    const offset = (n: HTMLElement) => {
      // offsetTop relative to the scroll container
      let y = 0
      let el: HTMLElement | null = n
      while (el && el !== transcriptEl) {
        y += el.offsetTop
        el = el.offsetParent as HTMLElement | null
      }
      return y
    }
    const target =
      dir === 1
        ? nodes.find((n) => offset(n) > top + 30)
        : [...nodes].reverse().find((n) => offset(n) < top - 30)
    if (target) {
      stick = false
      userScroll = true
      transcriptEl.scrollTo({ top: offset(target) - 8, behavior: "instant" as ScrollBehavior })
    }
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
            title="context of the last completed turn (input + output + reasoning + cache)">
            ctx {Math.round(u().tokens / 1000)}k{u().percent != null ? ` (${u().percent}%)` : ""}
          </span>
        )}
      </Show>}
      sessionActions={<>
        <Show when={!props.expanded}><button aria-label="Expand editor" title="Expand editor (Ctrl+E)" onClick={toggleFloat}>Expand editor</button></Show>
        <button title="Fork this session at its tip" disabled={forking() || !!nudgePhase()} onClick={() => fork()}>
          {forking() ? "Forking…" : "Fork"}
        </button>
        <Show when={ownedLane()}><button title="Hand off this lane to a new session" disabled={handingOff()} onClick={() => setHandoffOpen(!handoffOpen())}>Hand off</button></Show>
        <Show when={!session()?.time?.archived} fallback={<span class="archived-chip">Archived</span>}>
          <button title="Archive this session (hides it from lists)" disabled={!!nudgePhase()} onClick={archive}>Archive</button>
        </Show>
        <button class="danger" title="Delete this session permanently" disabled={!!nudgePhase()} onClick={remove}>Delete</button>
        <Show when={busy()} fallback={<button onClick={() => { stick = true; pin() }}>↓ Bottom</button>}>
          <button class="stop" aria-label="Stop session" title="Stop the parent session" disabled={aborting() || !!nudgePhase() || sending()} onClick={abort}>
            <span aria-hidden="true">■</span> Stop
          </button>
        </Show>
        <button
          title="Interrupt this session, then send a resume message"
          disabled={!session() || !!nudgePhase() || aborting() || sending()}
          onClick={nudge}
        >
          {nudgePhase() === "stopping" ? "Stopping…" : nudgePhase() === "resuming" ? "Sending resume…" : "Nudge"}
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

  return (
    <main class="session-page">
      <div class="session-main">
        <AppHeader>
          <h1 dir="auto" title={session()?.title ?? sessionID}>{session()?.title ?? sessionID}</h1>
          <span class="dim">{workState() === "working" ? "busy" : workState()}</span>
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
          <Show when={predecessor()}>{(edge) => <span class="handoff-crumb">predecessor ({edge().lane}): <A href={sessionHref(edge().predecessor, directory)}>{edge().predecessor}</A></span>}</Show>
          <Show when={nextHandoff()}>{(edge) => <span class="handoff-crumb">successor ({edge().lane}): <A href={sessionHref(edge().successor, directory)}>{edge().successor}</A></span>}</Show>
        </AppHeader>

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
            <button class="mail-subscriptions-toggle" onClick={() => setSubscriptionsOpen(!subscriptionsOpen())}>
              {subscriptionsOpen() ? "Hide mail subscriptions" : "Mail subscriptions"}
            </button>
            <Show when={subscriptionsOpen()}><MailSubscriptions editspace={scope().name}
              recipient={scope().lane ?? scope().session ?? sessionID} /></Show>
            <Show when={scope().lane !== undefined}>
              <button class="lane-mail-toggle" onClick={() => setLaneMailOpen(!laneMailOpen())}>
                {laneMailOpen() ? "Hide lane mail" : `Lane mail (${mail()?.messages.length ?? 0})`}
              </button>
              <Show when={laneMailOpen()}>
                <section class="lane-mail" aria-label="Lane mail">
                  <div class="banner-head">All mail for lane {scope().lane} across handoffs</div>
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
          <div ref={inner} class="transcript-inner">
            <Show when={live.hasOlder()}>
              <button class="transcript-older" disabled={live.loadingOlder()} onClick={loadEarlier}>
                {live.loadingOlder() ? "Loading…" : "Load earlier messages"}
              </button>
            </Show>
            <DataProvider data={live.data} directory={directory} sessionID={sessionID} onNavigateToSession={inspectSubagent}>
            <For each={timeline()}>
              {(row) => {
                 if (row.type === "mail") return <MailRow message={row.message} ids={mailIDs()} />
                const m = row.message
                return (
                <>
                  <Show when={m.role === "user"} fallback={<TranscriptMessage message={m} parts={live.data.part[m.id] ?? []} renderTools={renderTools} />}>
                    <div class="msg-wrap">
                      <TranscriptMessage message={m} parts={live.data.part[m.id] ?? []}
                        renderTools={renderTools}
                        mailRecord={mailRecords().get(mailSourceID(m) ?? "")}
                        mailDeliveries={mailRecords().get(mailSourceID(m) ?? "")?.deliveries} mailIDs={mailIDs()} />
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
                </>
                )
              }}
            </For>
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
