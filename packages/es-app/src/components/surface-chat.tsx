/* A small chat with a Surface's author agent, popped out over the reader (Loupe item 9; Murtaza Nov 4 ~23:00Z).
 * It reads the author's own session through the same live session store and transcript component as the full
 * chat, shows only the messages sent from a reader about this Surface and the agent's replies to them, and sends
 * with the author's prompt path (useSurfaceOwner). Delivery ticks come from the session itself: Sent (accepted, not
 * yet in the session), Seen (the message is in the agent's session), Replied (an assistant message answers it). */
import { createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show } from "solid-js"
import type { AssistantMessage, Message } from "@opencode-ai/sdk/v2"
import { DataProvider } from "@opencode-ai/session-ui/context"
import { createLiveSession } from "../live-session"
import { hostPrefix } from "../host-items"
import type { Surface } from "../surfaces"
import type { useSurfaceOwner } from "./surface-owner"
import { TranscriptMessage } from "./transcript-message"

type Author = ReturnType<typeof useSurfaceOwner>
const RECENT = 10

/** Whether a user message carries this Surface as attached context (the reader's send adds it as a synthetic part). */
const aboutSurface = (parts: { type: string; text?: string; synthetic?: boolean }[], id: string) =>
  parts.some((part) => part.type === "text" && part.synthetic && !!part.text?.includes(`"kind":"surface"`) && part.text.includes(`"id":${JSON.stringify(id)}`))
/** A citable `surface:<id>` reference, at any revision, in prose or in a cite link. */
const refMentions = (text: string | undefined, id: string) =>
  !!text && (text.includes(`surface:${id}`) || text.includes(`surface%3A${id}`) || text.includes(`surface%3a${id}`))
const strings = (part: { type: string; text?: string; tool?: string; state?: unknown }) => {
  const state = (part.state && typeof part.state === "object" ? part.state : {}) as Record<string, unknown>
  const input = (state.input && typeof state.input === "object" ? state.input : {}) as Record<string, unknown>
  return [part.text, part.tool, state.title, state.output, input.command, input.patchText, input.description,
    state.metadata ? JSON.stringify(state.metadata) : undefined, JSON.stringify(input)].filter((value): value is string => typeof value === "string")
}
/** A publish call for this Surface: a surface/publish tool (or shell command) that names its id. */
const publishMentions = (part: { type: string; text?: string; tool?: string; state?: unknown }, id: string) => {
  if (part.type !== "tool") return false
  const all = strings(part).join("\n")
  return /surface/i.test(all) && /publish/i.test(all) && all.includes(id)
}
const announces = (message: { role: string }, parts: { type: string; text?: string; synthetic?: boolean; tool?: string; state?: unknown }[], id: string) =>
  message.role === "assistant" && parts.some((part) =>
    (part.type === "text" && !part.synthetic && refMentions(part.text, id)) || publishMentions(part, id))
const revisionOf = (parts: { type: string; text?: string; synthetic?: boolean }[]) => {
  const text = parts.find((part) => part.type === "text" && part.synthetic && part.text?.includes(`"kind":"surface"`))?.text
  const match = text?.match(/"revision":(\d+)/)
  return match ? Number(match[1]) : undefined
}

export const SurfaceChat = (props: {
  surface: Surface
  author: Author
  revision: number
  host?: { id: string; label: string }
  draft: () => string
  setDraft: (text: string) => void
  minimised: boolean
  onMinimise: () => void
  onClose: () => void
  onUnread: (count: number) => void
  recording?: boolean
  ref?: (el: HTMLElement) => void
}) => {
  const [sending, setSending] = createSignal(false)
  const [error, setError] = createSignal("")
  // Messages this reader sent and the session has not shown yet: "Sent".
  const [pending, setPending] = createSignal<{ id: string; text: string }[]>([])
  let input: HTMLTextAreaElement | undefined
  const owner = () => { const value = props.author.owner(); return value?.state === "ok" ? value : undefined }
  const send = async () => {
    const text = props.draft().trim()
    if (!text || sending() || !owner()) return
    setSending(true)
    setError("")
    // A lost ACK may already have admitted this ID: keep the draft and never resend automatically.
    const id = `msg_${crypto.randomUUID().replaceAll("-", "")}`
    try {
      if (await props.author.send(text, id)) { props.setDraft(""); setPending([...pending(), { id, text }]) }
    } catch { setError("Send unconfirmed. Check the full chat before trying again.") }
    setSending(false)
  }
  onMount(() => queueMicrotask(() => input?.focus()))
  return <section class="sc-chat" classList={{ "sc-chat-min": props.minimised }} role="dialog" aria-label={`Chat with ${props.author.name()}`} ref={props.ref}
    onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); props.onMinimise() } }}>
    <header class="sc-chat-head">
      <span class="sc-chat-avatar" aria-hidden="true"><Show when={props.author.avatar()} fallback={props.author.name().charAt(0).toUpperCase()}>{(url) => <img src={url()} alt="" referrerpolicy="no-referrer" />}</Show></span>
      <b class="sc-chat-name"><bdi dir="auto">{props.author.name()}</bdi></b>
      <Show when={props.author.href()}><a class="sc-chat-full" href={props.author.href()} onClick={(event) => { event.preventDefault(); props.author.open() }}>Open full chat ↗</a></Show>
      <button type="button" class="sc-chat-icon" aria-label="Minimise chat" title="Minimise (Esc)" onClick={props.onMinimise}>–</button>
      <button type="button" class="sc-chat-icon" aria-label="Close chat" title="Close" onClick={props.onClose}>×</button>
    </header>
    <Show when={owner()} keyed fallback={<p class="sc-chat-empty" role="status">{props.author.owner.loading ? "Finding the author's chat…" : (props.author.owner() as { why?: string } | undefined)?.why ?? "The author's chat is not reachable now."}</p>}>{(value) =>
      <Thread session={value.session} directory={value.directory} surface={props.surface} host={props.host} pending={pending()} onPending={setPending} minimised={props.minimised} onUnread={props.onUnread} onFull={() => props.author.open()} />}</Show>
    <form class="sc-chat-compose" onSubmit={(event) => { event.preventDefault(); void send() }}>
      <span class="sc-chat-chip" title="Sent with this Surface attached as context">about <bdi dir="auto">{props.surface.title}</bdi> r{props.revision}</span>
      <textarea ref={input} dir="auto" rows={2} placeholder={props.recording ? "Listening…" : `Message ${props.author.name()}…`} aria-label={`Message ${props.author.name()}`} value={props.draft()}
        onInput={(event) => props.setDraft(event.currentTarget.value)}
        onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !event.isComposing) { event.preventDefault(); event.currentTarget.form?.requestSubmit() } }} />
      <div class="sc-chat-row">
        <Show when={error()}><span class="sc-note" role="alert">{error()}</span></Show>
        <button class="sc-chat-send" type="submit" disabled={!props.draft().trim() || sending() || !owner()}>{sending() ? "Sending…" : "Send"}</button>
      </div>
    </form>
  </section>
}

const Thread = (props: { session: string; directory: string; surface: Surface; host?: { id: string; label: string }; pending: { id: string; text: string }[]; onPending: (items: { id: string; text: string }[]) => void; minimised: boolean; onUnread: (count: number) => void; onFull: () => void }) => {
  const live = createLiveSession(props.session, props.directory, undefined, { id: props.host?.id, base: props.host ? `${hostPrefix(props.host.id)}/oc` : "/oc" })
  onMount(() => { void live.load().catch(() => {}) })
  const all = () => (live.data.message[props.session] ?? []) as Message[]
  // This Surface's conversation in the author's session: the reader's messages about it and the agent's replies,
  // plus the assistant step(s) that published or announced it (a publish call naming the id, or a surface:<id> ref).
  // Real session messages only; sorted by when the session recorded them.
  const asked = createMemo(() => new Set(all().filter((message) => message.role === "user" && aboutSurface(live.data.part[message.id] ?? [], props.surface.id)).map((message) => message.id)))
  const created = (message: Message) => (message as { time?: { created?: number } }).time?.created ?? 0
  const byCreated = (a: Message, b: Message) => created(a) - created(b) || a.id.localeCompare(b.id)
  // One chronological thread: each reader prompt, then the agent steps that answer it (parentID), then the next
  // prompt. A reply never jumps above its prompt because its own created time is early, arrived first, or tied; the
  // publish/announcement steps without a reader prompt are placed by their own recorded time.
  const shown = createMemo(() => {
    const unique = [...new Map(all().map((message) => [message.id, message] as const)).values()]
    const matches = unique.filter((message) => asked().has(message.id) || announces(message, live.data.part[message.id] ?? [], props.surface.id)
      || (message.role === "assistant" && asked().has((message as AssistantMessage).parentID)))
    const users = matches.filter((message) => message.role === "user").toSorted(byCreated)
    const userIDs = new Set(users.map((message) => message.id))
    const replies = new Map<string, Message[]>()
    for (const message of matches) {
      if (message.role !== "assistant" || !message.parentID || !userIDs.has(message.parentID)) continue
      replies.set(message.parentID, [...(replies.get(message.parentID) ?? []), message])
    }
    const groups = users.map((message) => ({ at: created(message), order: 0, rows: [message, ...(replies.get(message.id) ?? []).toSorted(byCreated)] }))
    const loose = matches.filter((message) => message.role === "assistant" && (!message.parentID || !userIDs.has(message.parentID)))
      .map((message) => ({ at: created(message), order: 1, rows: [message] }))
    return [...groups, ...loose].toSorted((a, b) => a.at - b.at || a.order - b.order || a.rows[0]!.id.localeCompare(b.rows[0]!.id))
      .flatMap((group) => group.rows)
  })
  // The newest RECENT rows, never starting on a reply whose reader prompt would be cut off.
  const visible = createMemo(() => {
    const rows = shown()
    if (rows.length <= RECENT) return rows
    const ids = new Set(rows.map((message) => message.id))
    let start = rows.length - RECENT
    while (start > 0) {
      const first = rows[start] as AssistantMessage
      if (first.role !== "assistant" || !first.parentID || !ids.has(first.parentID) || rows.slice(start).some((message) => message.id === first.parentID)) break
      start--
    }
    return rows.slice(start)
  })
  const capped = createMemo(() => shown().length > visible().length)
  const replied = (id: string) => all().some((message) => message.role === "assistant" && (message as AssistantMessage).parentID === id && !!(message as AssistantMessage).time.completed)
  const working = () => live.data.session_status[props.session]?.type === "busy"
  // A pending send is "Sent" until the session holds it.
  createEffect(() => { const ids = new Set(all().map((message) => message.id)); const left = props.pending.filter((item) => !ids.has(item.id)); if (left.length !== props.pending.length) props.onPending(left) })
  // Replies to the reader that arrive while minimised count as unread (the publish announcement is not a reply).
  const [seenReplies, setSeenReplies] = createSignal(0)
  const replies = () => shown().filter((message) => message.role === "assistant" && asked().has((message as AssistantMessage).parentID) && !!(message as AssistantMessage).time.completed).length
  createEffect(on(() => [replies(), props.minimised] as const, ([count, minimised]) => { if (!minimised) setSeenReplies(count); props.onUnread(minimised ? Math.max(0, count - seenReplies()) : 0) }))
  let body: HTMLDivElement | undefined
  // Follow the bottom while the reader is there; opening loads the history and lands at the newest message.
  // Minimising, reconnecting and new messages never pull a reader who scrolled up back down.
  let stick = true
  let userScroll = false
  const atEnd = () => !!body && body.scrollHeight - body.scrollTop - body.clientHeight < 16
  const pin = () => { if (body) body.scrollTop = body.scrollHeight }
  let content: HTMLDivElement | undefined
  onMount(() => {
    queueMicrotask(pin)
    // Markdown and tool chips settle after the first render; follow their height while the reader is at the bottom.
    const observer = new ResizeObserver(() => { if (stick) pin() })
    if (content) observer.observe(content)
    onCleanup(() => observer.disconnect())
  })
  createEffect(on(() => [visible().length, props.pending.length, working()] as const, () => queueMicrotask(() => { if (stick) pin() })))
  // Only a person's scroll can unstick the view: the programmatic pin's scroll event must not.
  return <div class="sc-chat-body" ref={body} aria-live="polite"
    onWheel={() => { userScroll = true }}
    onTouchMove={() => { userScroll = true }}
    onScroll={() => { if (!userScroll) return; stick = atEnd(); userScroll = false }}>
    <Show when={capped()}><button type="button" class="sc-chat-earlier" onClick={props.onFull}>Earlier in full chat ↗</button></Show>
    <Show when={live.loading() && !all().length}><p class="sc-chat-empty" role="status">Loading the chat…</p></Show>
    {/* The author's session through this host's own route only; when it cannot be read, say so (no stale stand-in). */}
    <Show when={!live.loading() && live.connectionError() && !all().length}><p class="sc-chat-empty" role="alert">The author's chat is unreachable from here now. Replies appear in the full chat ↗ when it is back.</p></Show>
    <Show when={live.connectionError() && !!all().length}><p class="sc-chat-empty" role="status">The author's chat is unreachable now; showing what was already loaded.</p></Show>
    <Show when={!live.loading() && !live.connectionError() && !shown().length && !props.pending.length}><p class="sc-chat-empty">Ask about this Surface; replies show here.</p></Show>
    <div class="sc-chat-content" ref={content}>
    <DataProvider data={live.data} directory={props.directory} sessionID={props.session}>
      <For each={visible()}>{(message) => {
        const parts = () => (live.data.part[message.id] ?? []).filter((part) => part.type === "text" && !part.synthetic
          || (message.role === "assistant" && part.type === "tool" && publishMentions(part, props.surface.id)))
        return <div class="sc-chat-msg" data-role={message.role}>
          <TranscriptMessage message={message} parts={parts()} />
          <Show when={message.role === "user"}>
            <span class="sc-chat-meta"><span class="sc-chat-chip">about r{revisionOf(live.data.part[message.id] ?? []) ?? "?"}</span>
              <span class="sc-chat-tick" data-state={replied(message.id) ? "replied" : "seen"} title={replied(message.id) ? "The agent replied" : "In the agent's session; no reply yet"}>{replied(message.id) ? "✓✓ Replied" : "✓✓ Seen"}</span></span>
          </Show>
        </div>
      }}</For>
    </DataProvider>
    <For each={props.pending}>{(item) => <div class="sc-chat-msg sc-chat-pending" data-role="user"><p dir="auto">{item.text}</p>
      <span class="sc-chat-meta"><span class="sc-chat-tick" data-state="sent" title="Accepted; not in the agent's session yet">✓ Sent</span></span></div>}</For>
    <Show when={working()}><p class="sc-chat-working" role="status"><span aria-hidden="true">•••</span> working</p></Show>
    </div>
  </div>
}
