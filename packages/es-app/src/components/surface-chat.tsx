/* A small chat with a Surface's author agent, popped out over the reader (Loupe item 9; Murtaza Nov 4 ~23:00Z).
 * It reads the author's own session through the same live session store and transcript component as the full
 * chat, shows only the messages sent from a reader about this Surface and the agent's replies to them, and sends
 * with the author's prompt path (useSurfaceOwner). Delivery ticks come from the session itself: Sent (accepted, not
 * yet in the session), Seen (the message is in the agent's session), Replied (an assistant message answers it). */
import { createEffect, createMemo, createSignal, For, on, onMount, Show } from "solid-js"
import type { AssistantMessage, Message } from "@opencode-ai/sdk/v2"
import { DataProvider } from "@opencode-ai/session-ui/context"
import { createLiveSession } from "../live-session"
import { hostPrefix } from "../host-items"
import type { Surface } from "../surfaces"
import type { useSurfaceOwner } from "./surface-owner"
import { TranscriptMessage } from "./transcript-message"

type Author = ReturnType<typeof useSurfaceOwner>
const RECENT = 12

/** Whether a user message carries this Surface as attached context (the reader's send adds it as a synthetic part). */
const aboutSurface = (parts: { type: string; text?: string; synthetic?: boolean }[], id: string) =>
  parts.some((part) => part.type === "text" && part.synthetic && !!part.text?.includes(`"kind":"surface"`) && part.text.includes(`"id":${JSON.stringify(id)}`))
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
      <Thread session={value.session} directory={value.directory} surface={props.surface} host={props.host} pending={pending()} onPending={setPending} minimised={props.minimised} onUnread={props.onUnread} />}</Show>
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

const Thread = (props: { session: string; directory: string; surface: Surface; host?: { id: string; label: string }; pending: { id: string; text: string }[]; onPending: (items: { id: string; text: string }[]) => void; minimised: boolean; onUnread: (count: number) => void }) => {
  const live = createLiveSession(props.session, props.directory, undefined, { id: props.host?.id, base: props.host ? `${hostPrefix(props.host.id)}/oc` : "/oc" })
  onMount(() => { void live.load().catch(() => {}) })
  const all = () => (live.data.message[props.session] ?? []) as Message[]
  // Only this Surface's conversation: the reader's messages about it and the agent's replies to those.
  const shown = createMemo(() => {
    const asked = new Set(all().filter((message) => message.role === "user" && aboutSurface(live.data.part[message.id] ?? [], props.surface.id)).map((message) => message.id))
    return all().filter((message) => asked.has(message.id) || (message.role === "assistant" && asked.has((message as AssistantMessage).parentID))).slice(-RECENT)
  })
  const replied = (id: string) => all().some((message) => message.role === "assistant" && (message as AssistantMessage).parentID === id && !!(message as AssistantMessage).time.completed)
  const working = () => live.data.session_status[props.session]?.type === "busy"
  // A pending send is "Sent" until the session holds it.
  createEffect(() => { const ids = new Set(all().map((message) => message.id)); const left = props.pending.filter((item) => !ids.has(item.id)); if (left.length !== props.pending.length) props.onPending(left) })
  // Replies that arrive while minimised count as unread.
  const [seenReplies, setSeenReplies] = createSignal(0)
  const replies = () => shown().filter((message) => message.role === "assistant" && !!(message as AssistantMessage).time.completed).length
  createEffect(on(() => [replies(), props.minimised] as const, ([count, minimised]) => { if (!minimised) setSeenReplies(count); props.onUnread(minimised ? Math.max(0, count - seenReplies()) : 0) }))
  let body: HTMLDivElement | undefined
  createEffect(on(() => [shown().length, props.pending.length, working()], () => queueMicrotask(() => { if (body) body.scrollTop = body.scrollHeight })))
  return <div class="sc-chat-body" ref={body} aria-live="polite">
    <Show when={live.loading() && !all().length}><p class="sc-chat-empty" role="status">Loading the chat…</p></Show>
    {/* The author's session through this host's own route only; when it cannot be read, say so (no stale stand-in). */}
    <Show when={!live.loading() && live.connectionError() && !all().length}><p class="sc-chat-empty" role="alert">The author's chat is unreachable from here now. Replies appear in the full chat ↗ when it is back.</p></Show>
    <Show when={!live.loading() && !shown().length && !props.pending.length}><p class="sc-chat-empty">Ask about this Surface; replies show here.</p></Show>
    <DataProvider data={live.data} directory={props.directory} sessionID={props.session}>
      <For each={shown()}>{(message) => {
        const parts = () => (live.data.part[message.id] ?? []).filter((part) => part.type === "text" && !part.synthetic)
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
}
