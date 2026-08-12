/* Conversation view: live transcript (session-ui renderer over an SSE-fed
 * store), prompt input, and inline permission/question replies. */
import { createEffect, createMemo, createResource, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { A, useNavigate, useParams, useSearchParams } from "@solidjs/router"
import { DataProvider } from "@opencode-ai/session-ui/context"
import { Message } from "@opencode-ai/session-ui/message-part"
import { oc } from "../api"
import { createLiveSession } from "../live-session"
import FakeCaret from "../components/fake-caret"
import SessionInfo from "../components/session-info"
import { TicketTip, wrapTicketRefs } from "../ticket-refs"
import { sessionHref, useDashboard } from "../state"
import { rightOpen, startDrag } from "../ui"
import { createVim } from "../vim"

function PermissionBanner(props: { p: any; directory: string; onDone: () => void }) {
  const act = async (reply: "once" | "always" | "reject") => {
    try {
      await oc.permissionReply(props.p.id, props.directory, reply)
      props.onDone()
    } catch (e) {
      alert(String(e))
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
      <div class="banner-head">
        permission: <b>{props.p.action ?? "?"}</b>
      </div>
      <Show when={props.p.resources?.length}>
        <div class="banner-body mono">{props.p.resources.join("\n")}</div>
      </Show>
      <Show when={meta().length}>
        <div class="banner-body mono">
          <For each={meta()}>
            {([k, v]) => (
              <div>
                <span class="dim">{k}:</span> {String(v).slice(0, 500)}
              </div>
            )}
          </For>
        </div>
      </Show>
      <div class="banner-actions">
        <button onClick={() => act("once")}>allow once</button>
        <button onClick={() => act("always")}>always</button>
        <button class="danger" onClick={() => act("reject")}>
          reject
        </button>
      </div>
    </div>
  )
}

function QuestionBanner(props: { q: any; directory: string; onDone: () => void }) {
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
    const final = answers().map((a, i) => (custom()[i]?.trim() ? [...a, custom()[i]!.trim()] : a))
    if (final.some((a) => a.length === 0)) {
      alert("answer every question (pick an option or type a custom answer)")
      return
    }
    try {
      await oc.questionReply(props.q.id, props.directory, final)
      props.onDone()
    } catch (e) {
      alert(String(e))
    }
  }

  const reject = async () => {
    try {
      await oc.questionReject(props.q.id, props.directory)
      props.onDone()
    } catch (e) {
      alert(String(e))
    }
  }

  return (
    <div class="banner question">
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
        <button onClick={submit}>answer</button>
        <button class="danger" onClick={reject}>
          dismiss
        </button>
      </div>
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

  const live = createLiveSession(sessionID, directory, (event) => {
    if (event.type.startsWith("permission.") || event.type.startsWith("question.")) {
      refetchPending()
    }
  })
  // stamp data-tool onto rendered tool wrappers (session-ui doesn't expose
  // the tool name in the DOM) so CSS can color tool types
  const stampTools = () => {
    if (!transcriptEl) return
    const byId = new Map<string, string>()
    for (const parts of Object.values(live.data.part)) {
      for (const p of parts as any[]) if (p.type === "tool") byId.set(p.id, p.tool)
    }
    for (const el of transcriptEl.querySelectorAll("[data-timeline-part-id]:not([data-tool])")) {
      const tool = byId.get(el.getAttribute("data-timeline-part-id") ?? "")
      if (tool) el.setAttribute("data-tool", tool)
    }
  }
  onMount(() => {
    // rAF-debounced: streaming produces mutation bursts, and wrapTicketRefs
    // itself mutates the DOM (idempotent, so the observer converges)
    let frame: number | undefined
    const mo = new MutationObserver(() => {
      if (frame !== undefined) return
      frame = requestAnimationFrame(() => {
        frame = undefined
        stampTools()
        if (transcriptEl) wrapTicketRefs(transcriptEl)
      })
    })
    if (transcriptEl) mo.observe(transcriptEl, { childList: true, subtree: true })
    onCleanup(() => {
      mo.disconnect()
      if (frame !== undefined) cancelAnimationFrame(frame)
    })
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
      .catch((e) => setError(String(e)))
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

  const [pending, { refetch: refetchPending }] = createResource(async () => {
    const [permissions, questions] = await Promise.all([
      oc.permissions(directory).catch(() => []),
      oc.questions(directory).catch(() => []),
    ])
    return {
      permissions: permissions.filter((p: any) => p.sessionID === sessionID),
      questions: questions.filter((q: any) => q.sessionID === sessionID),
    }
  })

  const session = () => live.data.session[0]
  const status = () => live.data.session_status[sessionID]?.type ?? "idle"
  const messages = createMemo(() => live.data.message[sessionID] ?? [])

  // viewing the session clears its unread state, including as new content
  // streams in while the page is open
  const { markViewed, refetchArchived } = useDashboard()
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
    if ((pending()?.permissions.length ?? 0) + (pending()?.questions.length ?? 0) > 0) return "pending"
    if (status() === "busy" || status() === "retry") return "busy"
    return "idle"
  }

  const busy = () => status() === "busy" || status() === "retry"

  // --- abort / fork ------------------------------------------------------

  // fire-and-forget: the status SSE flips busy->idle, no local state to sync
  const [aborting, setAborting] = createSignal(false)
  const abort = async () => {
    if (aborting() || !busy()) return
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

  const [draft, setDraft] = createSignal("")
  const [sending, setSending] = createSignal(false)
  const [images, setImages] = createSignal<{ id: string; mime: string; url: string; filename: string }[]>([])
  // optimistic echo: shown greyed-out from click until the daemon registers
  // the user message (cleared by the effect below watching messages)
  const [pendingMsg, setPendingMsg] = createSignal<{ text: string; images: number; at: number } | null>(null)
  createEffect(() => {
    const p = pendingMsg()
    if (!p) return
    const msgs = messages() as any[]
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i]
      if (m.role === "user" && (m.time?.created ?? 0) >= p.at) {
        setPendingMsg(null)
        return
      }
    }
  })

  const addImageFiles = (files: File[]) => {
    for (const f of files) {
      const reader = new FileReader()
      reader.onload = () => {
        const url = typeof reader.result === "string" ? reader.result : ""
        if (!url) return
        setImages((prev) => [
          ...prev,
          {
            id: Math.random().toString(36).slice(2),
            mime: f.type,
            url,
            filename: f.name || `pasted-${prev.length + 1}.${(f.type.split("/")[1] ?? "png").split("+")[0]}`,
          },
        ])
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
  const [modelChoice, setModelChoice] = createSignal<{ providerID: string; modelID: string } | null>(null)
  const lastTurnModel = createMemo(() => {
    for (let i = messages().length - 1; i >= 0; i--) {
      const m = messages()[i] as any
      if (m.role === "assistant" && m.modelID) return { providerID: m.providerID, modelID: m.modelID }
    }
    const s = session() as any
    return s?.model ? { providerID: s.model.providerID, modelID: s.model.id } : null
  })
  const nextModel = () => modelChoice() ?? lastTurnModel()

  const send = async () => {
    const text = draft().trim()
    const s = session()
    if ((!text && !images().length) || !s) return
    setSending(true)
    // echo immediately — the round-trip to the daemon is perceptible
    setPendingMsg({ text, images: images().length, at: Date.now() - 2000 })
    stick = true
    queueMicrotask(pin)
    try {
      await oc.prompt(s, directory, text, { model: nextModel() ?? undefined, images: images() })
      setDraft("")
      setImages([])
      setFloating(false)
      vim.setMode("normal")
      queueMicrotask(() => vim.refresh(promptEl))
      pin()
    } catch (e) {
      setPendingMsg(null)
      alert(String(e))
    } finally {
      setSending(false)
    }
  }

  let transcriptEl: HTMLDivElement | undefined
  let inner: HTMLDivElement | undefined
  let promptEl: HTMLTextAreaElement | undefined
  let floatEl: HTMLTextAreaElement | undefined

  // --- vim-like modal input + navigation --------------------------------

  const navigate = useNavigate()
  const { state: dashState, archivedIds } = useDashboard()
  const switchSession = (back: boolean) => {
    // skip archived sessions, matching the sidebar's main list
    const list = (dashState()?.threads ?? [])
      .filter((t: any) => t.kind === "session" && t.sessions[0] && !archivedIds().has(t.sessions[0].id))
      .map((t: any) => t.sessions[0])
    if (!list.length) return
    const i = list.findIndex((s: any) => s.id === sessionID)
    const next = list[(i + (back ? -1 : 1) + list.length) % list.length]
    if (next && next.id !== sessionID) navigate(sessionHref(next.id, next.directory ?? directory))
  }

  const [caret, setCaret] = createSignal<{ el: HTMLTextAreaElement; pos: number; hasChar: boolean } | null>(null)
  const vim = createVim({
    value: draft,
    setValue: setDraft,
    onTab: switchSession,
    onEnter: () => send(),
    onCursor: setCaret,
  })

  const focusInsert = () => vim.setMode("insert")

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
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      send()
      return
    }
    if (e.key === "Escape" && vim.mode() === "normal") escTap()
    if (navKeys(e)) return
    vim.handleKeyDown(e)
  }

  // global keys when focus is outside the prompt: nav + mode entry
  onMount(() => {
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement
      if (target.tagName === "TEXTAREA" || target.tagName === "INPUT" || target.tagName === "SELECT") return
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
      setFloating(true)
      queueMicrotask(() => {
        floatEl?.focus()
        vim.refresh(floatEl)
      })
    }
  })
  const closeFloat = () => {
    floatDismissed = true
    setFloating(false)
    promptEl?.focus()
    vim.refresh(promptEl)
  }
  const toggleFloat = () => {
    if (floating()) {
      closeFloat()
      return
    }
    floatDismissed = false
    setFloating(true)
    queueMicrotask(() => {
      floatEl?.focus()
      vim.refresh(floatEl)
    })
  }

  return (
    <main class="session-page">
      <div class="session-main">
        <header class="topbar">
          <span class={`dot ${headerDot()}`} />
          <h1>{session()?.title ?? sessionID}</h1>
          <span class="dim">{status()}</span>
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
          <button title="fork this session at its tip" disabled={forking()} onClick={() => fork()}>
            {forking() ? "forking…" : "fork"}
          </button>
          <Show when={!(session() as any)?.time?.archived} fallback={<span class="archived-chip">archived</span>}>
            <button title="archive this session (hides it from lists)" onClick={archive}>
              archive
            </button>
          </Show>
          <button class="danger" title="delete this session permanently" onClick={remove}>
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
            <button class="stop" title="abort this session (esc esc)" disabled={aborting()} onClick={abort}>
              ■ stop <span class="hint">esc esc</span>
            </button>
          </Show>
        </header>

        <Show when={error()}>
          <div class="err">{error()}</div>
        </Show>

        <For each={pending()?.permissions ?? []}>
          {(p: any) => <PermissionBanner p={p} directory={directory} onDone={refetchPending} />}
        </For>
        <For each={pending()?.questions ?? []}>
          {(q: any) => <QuestionBanner q={q} directory={directory} onDone={refetchPending} />}
        </For>

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
                        disabled={forking()}
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
            <Show when={pendingMsg()}>
              {(p) => (
                <div class="pending-msg">
                  <div class="pending-bubble">
                    {p().text || ""}
                    <Show when={p().images > 0}>
                      <span class="dim"> [{p().images} image{p().images > 1 ? "s" : ""}]</span>
                    </Show>
                  </div>
                  <span class="pending-hint dim">sending…</span>
                </div>
              )}
            </Show>
          </div>
        </div>

        <div class="prompt-box">
          <Show when={images().length}>
            <div class="attachments">
              <For each={images()}>
                {(img) => (
                  <span class="attachment-chip" title={img.filename}>
                    <img src={img.url} alt={img.filename} />
                    {img.filename.slice(0, 24)}
                    <button onClick={() => setImages((prev) => prev.filter((i) => i.id !== img.id))}>×</button>
                  </span>
                )}
              </For>
            </div>
          </Show>
          <div class="prompt-row">
            <div class="ta-wrap">
              <textarea
                ref={promptEl}
                classList={{ "vim-normal": vim.mode() === "normal", "vim-insert": vim.mode() === "insert" }}
                placeholder={status() === "busy" ? "session is busy — message will queue" : "reply to this session…"}
                value={draft()}
                onInput={(e) => setDraft(e.currentTarget.value)}
                onPaste={pasteImages}
                onDrop={dropImages}
                onDragOver={(e) => e.preventDefault()}
                onKeyDown={promptKeyDown}
                onFocus={focusInsert}
                onClick={focusInsert}
                onBlur={(e) => vim.refresh(e.currentTarget)}
              />
              <FakeCaret target={promptEl} caret={caret()} mode={vim.mode()} />
            </div>
            <div class="prompt-side">
              <span class="send-hint dim">{sending() ? "sending…" : "⌘⏎ to send"}</span>
              <select
                class="model-select"
                title="model for the next turn (defaults to the previous turn's)"
                value={nextModel() ? `${nextModel()!.providerID}\u0000${nextModel()!.modelID}` : ""}
                onChange={(e) => {
                  const [providerID, modelID] = e.currentTarget.value.split("\u0000")
                  setModelChoice(providerID && modelID ? { providerID, modelID } : null)
                }}
              >
                <For each={providers()?.providers ?? []}>
                  {(prov: any) => (
                    <optgroup label={prov.id}>
                      <For each={Object.keys(prov.models ?? {})}>
                        {(mid) => <option value={`${prov.id}\u0000${mid}`}>{mid}</option>}
                      </For>
                    </optgroup>
                  )}
                </For>
              </select>
              <Show when={contextUsage()}>
                {(u) => (
                  <span
                    class="context-pct"
                    classList={{ warn: (u().percent ?? 0) >= 70, high: (u().percent ?? 0) >= 90 }}
                    title="context of the last completed turn (input + output + reasoning + cache)"
                  >
                    ctx {Math.round(u().tokens / 1000)}k{u().percent != null ? ` (${u().percent}%)` : ""}
                  </span>
                )}
              </Show>
            </div>
          </div>
        </div>
      </div>

      <Show when={floating()}>
        <div class="float-editor">
          <div class="float-head">
            <span class="dim">composing — ⌘⏎ sends · ^e collapses</span>
            <span style="flex:1" />
            <button onClick={closeFloat}>⤡ collapse</button>
          </div>
          <div class="ta-wrap">
            <textarea
              ref={floatEl}
              classList={{ "vim-normal": vim.mode() === "normal", "vim-insert": vim.mode() === "insert" }}
              value={draft()}
              onInput={(e) => setDraft(e.currentTarget.value)}
              onPaste={pasteImages}
              onDrop={dropImages}
              onDragOver={(e) => e.preventDefault()}
              onKeyDown={promptKeyDown}
              onFocus={focusInsert}
              onClick={focusInsert}
            />
            <FakeCaret target={floatEl} caret={caret()} mode={vim.mode()} />
          </div>
        </div>
      </Show>

      <Show when={rightOpen()}>
        <div class="drag-handle" onMouseDown={(e) => startDrag("right", e)} />
      </Show>
      <SessionInfo sessionID={sessionID} session={session()} parts={live.data.part} />
      <TicketTip container={() => transcriptEl} />
    </main>
  )
}
