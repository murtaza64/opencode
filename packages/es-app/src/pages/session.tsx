/* Conversation view: live transcript (session-ui renderer over an SSE-fed
 * store), prompt input, and inline permission/question replies. */
import { createEffect, createMemo, createResource, createSignal, For, onCleanup, onMount, Show, untrack } from "solid-js"
import { A, useNavigate, useParams, useSearchParams } from "@solidjs/router"
import { DataProvider } from "@opencode-ai/session-ui/context"
import { Message } from "@opencode-ai/session-ui/message-part"
import { oc } from "../api"
import { createLiveSession } from "../live-session"
import FakeCaret from "../components/fake-caret"
import { RelativeLines } from "../components/relative-lines"
import SessionInfo from "../components/session-info"
import { sessionHref, useDashboard } from "../state"
import { rightOpen, startDrag } from "../ui"
import { createVim } from "../vim"
import { getComposer, type ComposerMode } from "../composer"
import { ComposerControls, ComposerResults } from "../components/composer-controls"

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
  return (
    <div class="banner permission">
      <Show when={props.owner}><div class="dim">from subagent: {props.owner}</div></Show>
      <div class="banner-head">
        permission: <b>{props.p.permission}</b>
      </div>
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
      <div class="banner-actions">
        <button disabled={sending()} onClick={() => act("once")}>allow once</button>
        <button disabled={sending()} onClick={() => act("always")}>always</button>
        <button disabled={sending()} class="danger" onClick={() => act("reject")}>
          reject
        </button>
      </div>
      <Show when={error()}><div class="err" role="alert">{error()}</div></Show>
    </div>
  )
}

function QuestionBanner(props: { q: any; directory: string; owner?: string; onDone: () => Promise<void> }) {
  const [error, setError] = createSignal("")
  const [sending, setSending] = createSignal(false)
  // answers[i] = selected labels for question i (custom text as a single label)
  const [answers, setAnswers] = createSignal<string[][]>(props.q.questions.map(() => []))
  const [custom, setCustom] = createSignal<string[]>(props.q.questions.map(() => ""))

  const toggle = (qi: number, label: string, multiple: boolean | undefined) => {
    setAnswers((prev) => {
      const next = prev.map((a) => [...a])
      const current = next[qi]!
      const has = current.includes(label)
      next[qi] = multiple ? (has ? current.filter((l) => l !== label) : [...current, label]) : has ? [] : [label]
      return next
    })
  }

  const submit = async () => {
    if (sending()) return
    const final = answers().map((a, i) => (custom()[i]?.trim() ? [...a, custom()[i]!.trim()] : a))
    if (final.some((a) => a.length === 0)) {
      setError("Answer every question (pick an option or type a custom answer).")
      return
    }
    setSending(true)
    setError("")
    try {
      await oc.questionReply(props.q.id, props.directory, final)
      await props.onDone()
    } catch (e) {
      setError(String(e))
    } finally {
      setSending(false)
    }
  }

  const reject = async () => {
    if (sending()) return
    setSending(true)
    setError("")
    try {
      await oc.questionReject(props.q.id, props.directory)
      await props.onDone()
    } catch (e) {
      setError(String(e))
    } finally {
      setSending(false)
    }
  }

  return (
    <div class="banner question">
      <Show when={props.owner}><div class="dim">from subagent: {props.owner}</div></Show>
      <For each={props.q.questions}>
        {(question: any, qi) => (
          <div class="banner-body">
            <div class="banner-head">{question.header || "question"}</div>
            <div>{question.question}</div>
            <div class="banner-options">
              <For each={question.options}>
                {(opt: any) => (
                  <button
                    classList={{ selected: answers()[qi()]!.includes(opt.label) }}
                    title={opt.description}
                    onClick={() => toggle(qi(), opt.label, question.multiple)}
                  >
                    {opt.label}
                  </button>
                )}
              </For>
            </div>
            <Show when={question.custom !== false}>
              <input
                placeholder="custom answer…"
                value={custom()[qi()]}
                onInput={(e) => {
                  const next = [...custom()]
                  next[qi()] = e.currentTarget.value
                  setCustom(next)
                }}
              />
            </Show>
          </div>
        )}
      </For>
      <div class="banner-actions">
        <button disabled={sending()} onClick={submit}>answer</button>
        <button disabled={sending()} class="danger" onClick={reject}>
          dismiss
        </button>
      </div>
      <Show when={error()}><div class="err" role="alert">{error()}</div></Show>
    </div>
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

  const { activity, sessionsError } = useDashboard()
  const live = createLiveSession(sessionID, directory, (event) => {
    if (event.type.startsWith("session.input.")) void composer.refreshInputs()
  })
  const connected = () => !!session() && !live.loading() && !live.connectionError()
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
    // paint the normal-mode block caret before any interaction
    vim.refresh(promptEl)
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
    if (transcriptEl) transcriptEl.scrollTop = transcriptEl.scrollHeight
  }
  onMount(() => {
    live
      .load()
      .then(() => pin())
      .catch(() => {}) // live.connectionError reports load failures and recovery
    transcriptEl?.addEventListener(
      "scroll",
      () => {
        if (atBottom()) stick = true
      },
      { passive: true },
    )
    transcriptEl?.addEventListener(
      "wheel",
      (e) => {
        if (e.deltaY < 0) stick = false
      },
      { passive: true },
    )
    transcriptEl?.addEventListener("touchmove", () => (stick = false), { passive: true })
    const observer = new ResizeObserver(() => {
      if (stick) pin()
    })
    if (inner) observer.observe(inner)
    onCleanup(() => observer.disconnect())
  })
  const [error, setError] = createSignal("")

  const pending = createMemo(() => activity.pending(sessionID))
  const subagentsRunning = () => activity.running(sessionID).filter((id) => id !== sessionID).length
  const attentionError = () => sessionsError() || activity.error(sessionID, directory)

  const session = () => live.data.session[0]
  const status = () => live.data.session_status[sessionID]?.type ?? "idle"
  const messages = createMemo(() => live.data.message[sessionID] ?? [])

  // viewing the session clears its unread state, including as new content
  // streams in while the page is open
  const { markViewed, refetchArchived } = useDashboard()
  onMount(() => markViewed(sessionID, true))
  createEffect(() => {
    messages()
    status()
    markViewed(sessionID)
  })

  // context usage of the latest completed turn, TUI formula: all token
  // classes of the last assistant message vs the model's context limit
  const contextUsage = createMemo(() => {
    const msgs = messages() as any[]
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i]
      if (m.role !== "assistant" || !(m.tokens?.output > 0)) continue
      const t = m.tokens
      const tokens = t.input + t.output + t.reasoning + (t.cache?.read ?? 0) + (t.cache?.write ?? 0)
      const model = (providers()?.providers ?? []).find((p: any) => p.id === m.providerID)?.models?.[m.modelID]
      const limit = model?.limit?.context
      return { tokens, percent: limit ? Math.round((tokens / limit) * 100) : null }
    }
    return null
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

  const headerDot = () => {
    if (pending().length > 0) return "pending"
    if (subagentsRunning() || status() === "busy" || status() === "retry") return "busy"
    return "idle"
  }

  const busy = () => status() === "busy" || status() === "retry"
  createEffect(() => {
    const running = busy()
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

  const activeDraft = () => composer.state.mode === "aside" ? composer.state.aside : composer.state.task
  const draft = () => activeDraft().text
  const setDraft = composer.setText
  const images = () => activeDraft().images
  const sending = () => composer.state.sending

  const addImageFiles = (files: File[]) => {
    const buffer = composer.state.mode === "aside" ? "aside" : "task"
    for (const f of files) {
      const reader = new FileReader()
      reader.onload = () => {
        const url = typeof reader.result === "string" ? reader.result : ""
        if (!url) return
        composer.setImages([
          ...composer.state[buffer].images,
          {
            id: Math.random().toString(36).slice(2),
            mime: f.type,
            url,
            filename: f.name || `pasted.${(f.type.split("/")[1] ?? "png").split("+")[0]}`,
          },
        ], buffer)
      }
      reader.readAsDataURL(f)
    }
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

  // model for the next turn: follows the latest agent turn unless the user
  // explicitly picks one from the dropdown
  const [providers] = createResource(() => oc.providers(directory).catch(() => ({ providers: [], default: {} })))
  const [agents, { refetch: refetchAgents }] = createResource(() => oc.agents(directory).then(
    (items) => ({ items: items.filter((agent) => !agent.hidden && agent.mode !== "subagent"), error: "" }),
    (error: unknown) => ({ items: [], error: String(error) }),
  ))
  const activeAgent = () => {
    const previous = messages().findLast((message) => message.role === "user")
    return composer.state.mode === "aside" ? previous?.agent : session()?.agent ?? previous?.agent
  }
  const modelChoice = () => activeDraft().model
  const setModelChoice = composer.setModel
  const lastTurnModel = createMemo(() => {
    for (let i = messages().length - 1; i >= 0; i--) {
      const m = messages()[i] as any
      if (m.role === "assistant" && m.modelID) return { providerID: m.providerID, modelID: m.modelID }
    }
    const s = session() as any
    return s?.model ? { providerID: s.model.providerID, modelID: s.model.id } : null
  })
  const nextModel = () => modelChoice() ?? lastTurnModel()

  const nudge = async () => {
    const s = session()
    if (!s || nudgePhase() || aborting() || sending()) return
    const model = composer.state.task.model ?? lastTurnModel() ?? undefined
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

  const send = async () => {
    const s = session()
    if (!s || !connected() || sending() || nudgePhase() || aborting()) return
    setError("")
    // Read status again at submission; a mode switch never sends by itself.
    composer.observeBusy(busy())
    stick = true
    queueMicrotask(pin)
    await composer.submit(s, nextModel())
  }

  let transcriptEl: HTMLDivElement | undefined
  let inner: HTMLDivElement | undefined
  let promptEl: HTMLTextAreaElement | undefined
  let floatEl: HTMLTextAreaElement | undefined

  // --- vim-like modal input + navigation --------------------------------

  const navigate = useNavigate()
  const { sessions } = useDashboard()
  const switchSession = (back: boolean) => {
    // skip archived sessions, matching the sidebar's main list
    const list = sessions()
    if (!list.length) return
    const i = list.findIndex((s: any) => s.id === sessionID)
    const next = list[(i + (back ? -1 : 1) + list.length) % list.length]
    if (next && next.id !== sessionID) navigate(sessionHref(next.id, next.directory ?? directory))
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
  const activeVim = () => composer.state.mode === "aside" ? asideVim : taskVim
  const vim = {
    mode: () => activeVim().mode(),
    setMode: (mode: "normal" | "insert") => activeVim().setMode(mode),
    refresh: (el: HTMLTextAreaElement | undefined) => activeVim().refresh(el),
    handleKeyDown: (event: KeyboardEvent) => activeVim().handleKeyDown(event),
  }
  const saveSelection = (el: HTMLTextAreaElement) => composer.setSelection(el.selectionStart, el.selectionEnd)
  const selectMode = (mode: ComposerMode) => {
    lastEsc = 0
    const el = floating() ? floatEl : promptEl
    if (el) saveSelection(el)
    composer.selectMode(mode)
    const selection = [...activeDraft().selection] as const
    queueMicrotask(() => {
      const target = floating() ? floatEl : promptEl
      target?.setSelectionRange(selection[0], selection[1])
      setCaret(null)
    })
  }

  const focusInsert = () => vim.setMode("insert")
  const cycleMode = (e: KeyboardEvent) => {
    // macOS Option+M reports a symbol in key, but still reports KeyM in code.
    if (e.isComposing || !e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || e.code !== "KeyM") return false
    e.preventDefault()
    e.stopPropagation()
    if (e.repeat) return true
    const editing = document.activeElement === promptEl || document.activeElement === floatEl
    const inputMode = vim.mode()
    selectMode(composer.state.mode === "aside" ? "queue" : composer.state.mode === "queue" ? "steer" : "aside")
    if (editing) queueMicrotask(() => {
      const target = floating() ? floatEl : promptEl
      target?.focus()
      vim.setMode(inputMode)
      vim.refresh(target)
    })
    const group = (e.target as HTMLElement).closest('[role="radiogroup"]')
    if (group) queueMicrotask(() => group.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus())
    return true
  }

  const scrollTranscript = (dir: 1 | -1) => {
    if (!transcriptEl) return
    stick = false
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
    if (e.isComposing) return
    if (cycleMode(e)) return
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      send()
      return
    }
    if (e.key === "Escape" && vim.mode() === "normal" && composer.state.mode !== "aside") escTap()
    if (navKeys(e)) return
    vim.handleKeyDown(e)
  }

  // global keys when focus is outside the prompt: nav + mode entry
  onMount(() => {
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement
      if (target.closest(".prompt-box, .float-editor") && cycleMode(e)) return
      if (e.isComposing || target.closest("textarea, input, select, button, a, [contenteditable], [data-composer-controls]")) return
      if (navKeys(e)) return
      if (e.key === "Tab" && vim.mode() === "normal") {
        e.preventDefault()
        switchSession(e.shiftKey)
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
  createEffect(() => {
    const d = draft()
    if (!d) {
      floatDismissed = false
      setFloating(false)
      return
    }
    if (!floating() && !floatDismissed && (d.length > 400 || d.split("\n").length > 5)) {
      const selection = untrack(() => [...activeDraft().selection] as const)
      setFloating(true)
      queueMicrotask(() => {
        floatEl?.focus()
        floatEl?.setSelectionRange(selection[0], selection[1])
        vim.refresh(floatEl)
      })
    }
  })
  const closeFloat = () => {
    if (floatEl) saveSelection(floatEl)
    floatDismissed = true
    setFloating(false)
    promptEl?.focus()
    promptEl?.setSelectionRange(...activeDraft().selection)
    vim.refresh(promptEl)
  }
  const toggleFloat = () => {
    if (floating()) {
      closeFloat()
      return
    }
    floatDismissed = false
    if (promptEl) saveSelection(promptEl)
    setFloating(true)
    queueMicrotask(() => {
      floatEl?.focus()
      floatEl?.setSelectionRange(...activeDraft().selection)
      vim.refresh(floatEl)
    })
  }

  const Footer = (props: { expanded?: boolean }) => (
    <ComposerControls composer={composer} connected={connected() && !nudgePhase() && !aborting()} busy={busy()} selectMode={selectMode} submit={send}
      activeAgent={activeAgent()} agents={agents()?.items ?? []} agentError={agents()?.error} retryAgents={() => { void refetchAgents() }}>
      <select class="model-select" aria-label="Model override"
        disabled={composer.state.mode === "queue" || composer.state.mode === "steer"}
        title="model for the next turn (defaults to the previous turn's)"
        value={modelChoice() ? `${modelChoice()!.providerID}\u0000${modelChoice()!.modelID}` : ""}
        onChange={(e) => {
          const [providerID, modelID] = e.currentTarget.value.split("\u0000")
          setModelChoice(providerID && modelID ? { providerID, modelID } : null)
        }}>
        <option value="" selected={!modelChoice()}>Session model</option>
        <For each={providers()?.providers ?? []}>
          {(prov) => (
            <optgroup label={prov.id}>
              <For each={Object.keys(prov.models ?? {})}>
                {(mid) => <option value={`${prov.id}\u0000${mid}`} selected={modelChoice()?.providerID === prov.id && modelChoice()?.modelID === mid}>{mid}</option>}
              </For>
            </optgroup>
          )}
        </For>
      </select>
      <Show when={modelChoice()}><button onClick={() => setModelChoice(null)}>Use session model</button></Show>
      <Show when={!props.expanded}><button aria-label="Expand editor" title="Expand editor (Ctrl+E)" onClick={toggleFloat}>Expand</button></Show>
      <Show when={contextUsage()}>
        {(u) => (
          <span class="context-pct"
            classList={{ warn: (u().percent ?? 0) >= 70, high: (u().percent ?? 0) >= 90 }}
            title="context of the last completed turn (input + output + reasoning + cache)">
            ctx {Math.round(u().tokens / 1000)}k{u().percent != null ? ` (${u().percent}%)` : ""}
          </span>
        )}
      </Show>
    </ComposerControls>
  )

  return (
    <main class="session-page">
      <div class="session-main">
        <header class="topbar">
          <span class={`dot ${headerDot()}`} />
          <h1>{session()?.title ?? sessionID}</h1>
          <span class="dim">{live.connectionError() ? "disconnected" : live.error() ? "failed" : pending().length ? "needs permission or answer" : subagentsRunning() ? "busy" : status()}</span>
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
          <span style="flex:1" />
          <button
            title="Interrupt this session, then send a resume message"
            disabled={!session() || !!nudgePhase() || aborting() || sending()}
            onClick={nudge}
          >
            {nudgePhase() === "stopping" ? "stopping..." : nudgePhase() === "resuming" ? "sending resume..." : "nudge"}
          </button>
          <button title="fork this session at its tip" disabled={forking() || !!nudgePhase()} onClick={() => fork()}>
            {forking() ? "forking…" : "fork"}
          </button>
          <Show when={!(session() as any)?.time?.archived} fallback={<span class="archived-chip">archived</span>}>
            <button title="archive this session (hides it from lists)" disabled={!!nudgePhase()} onClick={archive}>
              archive
            </button>
          </Show>
          <button class="danger" title="delete this session permanently" disabled={!!nudgePhase()} onClick={remove}>
            delete
          </button>
          <Show
            when={busy()}
            fallback={
              <button
                onClick={() => {
                  stick = true
                  pin()
                }}
              >
                ↓ bottom
              </button>
            }
          >
            <button class="stop" title="abort this session (esc esc)" disabled={aborting() || !!nudgePhase() || sending()} onClick={abort}>
              ■ stop <span class="hint">esc esc</span>
            </button>
          </Show>
        </header>

        <div class="session-alerts">
          <Show when={error() || live.error()}><div class="err" role="alert">{error() || live.error()}</div></Show>
          <Show when={live.connectionError()}>
            <div class="err" role="alert">{live.connectionError()}
              <button disabled={live.loading()} onClick={() => { void live.load().catch(() => {}) }}>reconnect</button>
            </div>
          </Show>
          <Show when={live.retry()}>{(retry) => <div role="status" class="dim">Retry {retry().attempt}: {retry().message}</div>}</Show>
          <Show when={attentionError()}><div class="err" role="alert">{attentionError()}</div></Show>
          <For each={pending()}>
            {(item) => {
              const owner = () => item.request.sessionID !== sessionID
                ? activity.session(item.request.sessionID)?.title ?? item.request.sessionID : undefined
              return item.kind === "permission"
                ? <PermissionBanner p={item.request} directory={item.directory} owner={owner()} onDone={() => activity.refreshDirectory(item.directory, true)} />
                : <QuestionBanner q={item.request} directory={item.directory} owner={owner()} onDone={() => activity.refreshDirectory(item.directory, true)} />
            }}
          </For>
        </div>

        <div class="transcript" ref={transcriptEl}>
          <div ref={inner} class="transcript-inner">
            <DataProvider data={live.data} directory={directory}>
            <For each={messages()}>
              {(m) => (
                <>
                  <Show when={m.role === "user"} fallback={<Message message={m} parts={live.data.part[m.id] ?? []} />}>
                    <div class="msg-wrap">
                      <Message message={m} parts={live.data.part[m.id] ?? []} />
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
              )}
            </For>
            </DataProvider>
            <Show when={thinking()}>
              <div class="thinking" title="agent is thinking">
                <span /><span /><span />
              </div>
            </Show>
          </div>
        </div>

        <Show when={!floating()}><ComposerResults composer={composer} connected={connected()} /></Show>
        <div class="prompt-box" inert={floating()}>
          <Show when={images().length}>
            <div class="attachments">
              <For each={images()}>
                {(img) => (
                  <span class="attachment-chip" title={img.filename}>
                    <img src={img.url} alt={img.filename} />
                    {img.filename.slice(0, 24)}
                    <button aria-label={`Remove ${img.filename}`} onClick={() => composer.setImages(images().filter((i) => i.id !== img.id))}>×</button>
                  </span>
                )}
              </For>
            </div>
          </Show>
          <div class="prompt-row">
            <div class="ta-wrap">
              <textarea
                ref={promptEl}
                aria-label={composer.state.mode === "aside" ? "Aside question" : "Task message"}
                dir="auto"
                classList={{ "vim-normal": vim.mode() === "normal", "vim-insert": vim.mode() === "insert" }}
                placeholder={composer.state.mode === "aside" ? "Ask about the current task..." : "Reply to this session..."}
                value={draft()}
                onInput={(e) => { saveSelection(e.currentTarget); setDraft(e.currentTarget.value) }}
                onPaste={pasteImages}
                onDrop={dropImages}
                onDragOver={(e) => e.preventDefault()}
                onKeyDown={promptKeyDown}
                onFocus={focusInsert}
                onClick={focusInsert}
                onBlur={(e) => saveSelection(e.currentTarget)}
              />
              <FakeCaret target={promptEl} caret={caret()} mode={vim.mode()} />
            </div>
          </div>
          <Footer />
        </div>
      </div>

      <Show when={floating()}>
        <div class="float-editor">
          <div class="float-head">
            <span class="dim">composing — ⌘⏎ sends · ^e collapses</span>
            <span style="flex:1" />
            <button onClick={closeFloat}>⤡ collapse</button>
          </div>
          <ComposerResults composer={composer} connected={connected()} />
          <Show when={images().length}>
            <div class="attachments"><For each={images()}>{(image) => (
              <span class="attachment-chip"><img src={image.url} alt={image.filename} />{image.filename.slice(0, 24)}
                <button aria-label={`Remove ${image.filename}`} onClick={() => composer.setImages(images().filter((item) => item.id !== image.id))}>×</button>
              </span>
            )}</For></div>
          </Show>
          <div class="ta-wrap numbered-editor">
            <textarea
              ref={floatEl}
              aria-label={composer.state.mode === "aside" ? "Aside question" : "Task message"}
              dir="auto"
              classList={{ "vim-normal": vim.mode() === "normal", "vim-insert": vim.mode() === "insert" }}
              value={draft()}
              onInput={(e) => { saveSelection(e.currentTarget); setDraft(e.currentTarget.value) }}
              onPaste={pasteImages}
              onDrop={dropImages}
              onDragOver={(e) => e.preventDefault()}
              onKeyDown={promptKeyDown}
              onFocus={focusInsert}
              onClick={focusInsert}
              onBlur={(e) => saveSelection(e.currentTarget)}
            />
            <RelativeLines target={floatEl!} value={draft()} />
            <FakeCaret target={floatEl} caret={caret()} mode={vim.mode()} />
          </div>
          <Footer expanded />
        </div>
      </Show>

      <Show when={rightOpen()}>
        <div class="drag-handle" onMouseDown={(e) => startDrag("right", e)} />
      </Show>
      <SessionInfo sessionID={sessionID} session={session()} parts={live.data.part} />
    </main>
  )
}
