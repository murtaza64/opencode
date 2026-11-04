/* On-surface comments over the Surface reader's frame. The host owns text and drafts; the frame only receives anchors.
 * A fixed feedback bar opens pick mode or a finder tray; the non-modal card keeps the page interactive. */
import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { ago } from "../state"
import { initialOf, MAX_BODY, mintCommentId, placement, placementLabel, receiptLabel, threads, type AnchorState, type CommentAnchor, type CommentHost, type SealedComment, type SurfaceComment } from "../surface-comments"
import { Glyph } from "./icons"
import { DictationField } from "./dictation-field"
import { useSurfaceOwner } from "./surface-owner"
import type { Surface } from "../surfaces"
import { focusHole, placeCard } from "../../../surface-bridge/src/geometry.js"
import "./surface-comments.css"

type Box = { x: number; y: number; w: number; h: number }
type Outgoing = { sealed: SealedComment; state: "sending" | "failed"; error?: string }
type Open = { key: string; anchor: CommentAnchor; parent?: string }
const NS = "es-comments"
const DRAFT = "__draft"
const POLL_MS = 30_000

export const SurfaceComments = (props: { host: CommentHost; surface: Surface; ownerHost?: { id: string; label: string }; revision: number; frame: () => HTMLIFrameElement | undefined; stage: () => HTMLElement | undefined }) => {
  const author = useSurfaceOwner(() => ({ ...props.surface, revision: props.revision }), props.ownerHost)
  const [saying, setSaying] = createSignal(false)
  const [said, setSaid] = createSignal(false)
  const [sayDraft, setSayDraft] = createSignal("")
  const [sayError, setSayError] = createSignal("")
  const [sendingSay, setSendingSay] = createSignal(false)
  let sayInput: HTMLTextAreaElement | undefined
  const toggleSay = () => { setSaying(!saying()); if (!saying()) return; setTray(false); setTucked(false); setSaid(false); queueMicrotask(() => sayInput?.focus()) }
  const sendSay = async () => {
    const text = sayDraft().trim()
    if (!text || sendingSay() || author.owner()?.state !== "ok") return
    setSendingSay(true)
    setSayError("")
    // A lost ACK may already have admitted this ID. Keep the draft and do not automatically retry it.
    const id = `msg_${crypto.randomUUID().replaceAll("-", "")}`
    try {
      if (await author.send(text, id)) { setSayDraft(""); setSaid(true) }
    } catch { setSayError("Send unconfirmed. Check the owner's chat before trying again.") }
    setSendingSay(false)
  }
  const [comments, setComments] = createSignal<SurfaceComment[]>([])
  const [unavailable, setUnavailable] = createSignal<string>()
  const [ready, setReady] = createSignal(false)
  // The page declared <meta name="es-comments-anchors" content="off"> (surface-bridge.ts).
  const [off, setOff] = createSignal(false)
  const [picking, setPicking] = createSignal(false)
  const [shown, setShown] = createSignal(true)
  const [tucked, setTucked] = createSignal(false)
  const [tray, setTray] = createSignal(false)
  const [query, setQuery] = createSignal("")
  const [view, setView] = createSignal<"open" | "all" | "resolved">("open")
  const [authors, setAuthors] = createSignal<ReadonlySet<string>>(new Set())
  const [cursor, setCursor] = createSignal(0)
  const [open, setOpen] = createSignal<Open>()
  const [rects, setRects] = createSignal<ReadonlyMap<string, { rect: Box | null; state: AnchorState }>>(new Map())
  const [outgoing, setOutgoing] = createSignal<ReadonlyMap<string, Outgoing>>(new Map())
  // Unsent text per thread (DRAFT for a new comment); hiding, closing or a failed send never loses it.
  const [drafts, setDrafts] = createSignal<ReadonlyMap<string, string>>(new Map())
  const [size, setSize] = createSignal({ w: 0, h: 0 })
  const markers = new Map<string, HTMLButtonElement>()
  let toolbarButton: HTMLButtonElement | undefined
  let searchInput: HTMLInputElement | undefined
  // The es-surface-comments/1 host has no marks field or draw/undo operation.
  const marksSupported = false

  const load = async () => {
    const result = await props.host.read()
    if ("unavailable" in result) return setUnavailable(result.unavailable)
    setUnavailable()
    setComments(result.comments)
  }
  onMount(() => {
    void load()
    const timer = setInterval(() => { if (document.visibilityState === "visible") void load() }, POLL_MS)
    onCleanup(() => clearInterval(timer))
  })

  const toFrame = (message: Record<string, unknown>) => props.frame()?.contentWindow?.postMessage({ ns: NS, ...message }, "*")
  const pendingRoots = () => [...outgoing().values()].filter((item) => !item.sealed.parent_id && !comments().some((comment) => comment.comment_id === item.sealed.comment_id))
  const list = createMemo(() => threads(comments()))
  const here = () => list().filter((thread) => thread.root.revision === props.revision)
  const stateOf = (thread: ReturnType<typeof threads>[number]) => placement(thread.root, props.revision, rects().get(thread.root.comment_id)?.state)
  const onView = () => list().filter((thread) => stateOf(thread) === "shown")
    .toSorted((a, b) => {
      const ar = rects().get(a.root.comment_id)?.rect
      const br = rects().get(b.root.comment_id)?.rect
      return (ar?.y ?? 0) - (br?.y ?? 0) || (ar?.x ?? 0) - (br?.x ?? 0)
    })
  const away = () => list().filter((thread) => !["shown", "locating"].includes(stateOf(thread)))
  const sectionOf = (thread: ReturnType<typeof threads>[number]) => thread.root.anchor.id?.split("/")[0] ?? thread.root.anchor.selector?.split(" > ")[0] ?? "Page"
  const filtered = () => {
    const matches = (thread: ReturnType<typeof threads>[number]) =>
      (view() === "all" || (view() === "open" ? thread.root.state !== "resolved" : thread.root.state === "resolved")) &&
      (!authors().size || [thread.root, ...thread.replies].some((comment) => authors().has(comment.author.name))) &&
      (!query() || [sectionOf(thread), ...[thread.root, ...thread.replies].flatMap((comment) => [comment.body, comment.author.name])].some((text) => text.toLowerCase().includes(query().toLowerCase())))
    return { here: onView().filter(matches), away: away().filter(matches) }
  }
  const navigate = (delta: number) => {
    const current = open()?.key
    const group = current && away().some((thread) => thread.root.comment_id === current) ? away() : onView()
    if (!group.length) return
    const index = group.findIndex((thread) => thread.root.comment_id === current)
    reveal(group[(index + delta + group.length) % group.length].root.comment_id)
  }
  const reveal = (key: string) => {
    const thread = list().find((item) => item.root.comment_id === key)
    if (!thread) return
    setTray(false)
    setPicking(false)
    setOpen({ key, anchor: thread.root.anchor })
    if (stateOf(thread) === "shown") toFrame({ type: "reveal", key })
  }
  const toggleTray = () => {
    setTray(!tray())
    setCursor(0)
    if (tray()) { setSaying(false); queueMicrotask(() => searchInput?.focus()) }
  }
  // Everything the frame should locate: this revision's threads, sends in flight and the open draft.
  createEffect(() => {
    if (!ready()) return
    const anchors = [
      ...here().map((thread) => ({ key: thread.root.comment_id, anchor: thread.root.anchor })),
      ...pendingRoots().map((item) => ({ key: item.sealed.comment_id, anchor: item.sealed.anchor })),
      ...(open()?.key === DRAFT ? [{ key: DRAFT, anchor: open()!.anchor }] : []),
    ]
    toFrame({ type: "track", anchors })
  })

  // Keyboard picking keeps focus in the app; its arrow, Tab and Enter keys are forwarded to the frame's picker.
  const startPick = (keyboard: boolean) => {
    if (!ready() || unavailable()) return
    setTray(false)
    setOpen()
    setPicking(true)
    toFrame({ type: "pick", on: true, keyboard })
  }
  const endPick = () => { setPicking(false); toFrame({ type: "pick", on: false }) }
  const close = (restoreFocus = true) => {
    const key = open()?.key
    setOpen()
    if (!restoreFocus) return
    // Markers remount when the card closes; their buttons then stay put across updates (keyed by thread id below).
    queueMicrotask(() => {
      const marker = key ? markers.get(key) : undefined
      if (marker?.isConnected) return marker.focus()
      toolbarButton?.focus()
    })
  }

  onMount(() => {
    const listen = (event: MessageEvent) => {
      const data = event.data as { ns?: string; type?: string; [key: string]: unknown }
      if (!data || data.ns !== NS || event.source !== props.frame()?.contentWindow) return
      if (data.type === "ready") { setOff(data.policy === "off"); setReady(data.policy !== "off") }
      if (data.type === "rects") setRects(new Map((data.items as { key: string; rect: Box | null; state: AnchorState }[]).map((item) => [item.key, { rect: item.rect, state: item.state }])))
      if (data.type === "picked") {
        setPicking(false)
        setShown(true)
        setRects(new Map([...rects(), [DRAFT, { rect: data.rect as Box, state: "shown" as const }]]))
        setOpen({ key: DRAFT, anchor: data.anchor as CommentAnchor })
      }
      if (data.type === "pick-end") setPicking(false)
      if (data.type === "key" && data.key === "c") startPick(true)
      if (data.type === "key" && data.key === "m") toggleSay()
      if (data.type === "key" && data.key === "Escape") {
        if (saying()) setSaying(false)
        else if (tray()) setTray(false)
        else if (picking()) endPick()
        else if (open()) close()
      }
    }
    const keys = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return
      const typing = event.target instanceof HTMLElement && (event.target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName))
      if (event.key === "Escape" && saying()) { event.preventDefault(); event.stopImmediatePropagation(); setSaying(false); return }
      if (event.key === "Escape" && (tray() || picking() || open())) {
        event.preventDefault()
        event.stopPropagation()
        if (tray()) { setTray(false); toolbarButton?.focus() }
        else if (picking()) endPick()
        else close()
        return
      }
      // Pick mode follows the keyboard wherever focus is: keys pressed in the app go to the frame's picker.
      if (picking() && ["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "Tab", "Enter", " ", "j", "k"].includes(event.key) && !typing) {
        event.preventDefault()
        toFrame({ type: "pick-key", key: event.key, shift: event.shiftKey })
        return
      }
      if (typing || !props.stage()?.isConnected) return
      if (event.key.toLowerCase() === "c") { event.preventDefault(); picking() ? endPick() : startPick(true) }
      if (event.key.toLowerCase() === "f") { event.preventDefault(); toggleTray() }
      if (event.key.toLowerCase() === "h") { event.preventDefault(); setShown(!shown()) }
      if (event.key === ".") { event.preventDefault(); setTucked(!tucked()); setTray(false) }
      if (event.key.toLowerCase() === "j") { event.preventDefault(); navigate(1) }
      if (event.key.toLowerCase() === "k") { event.preventDefault(); navigate(-1) }
      if (event.key.toLowerCase() === "m") { event.preventDefault(); toggleSay() }
    }
    const outside = (event: PointerEvent) => {
      if (!(event.target instanceof Node) || !props.stage()?.isConnected) return
      if (event.target instanceof Element && event.target.closest(".sc-card, .sc-toolbar, .sc-tray, .sc-peek, .sc-tab")) return
      if (tray()) setTray(false)
      if (open()) close(false)
    }
    // A click inside the sandboxed frame does not bubble to the host. It moves focus to the frame instead.
    const frameFocus = () => {
      if (document.activeElement !== props.frame()) return
      if (tray()) setTray(false)
      if (open()) close(false)
    }
    const message = (event: Event) => { if ((event as CustomEvent<string>).detail === props.surface.id) { setTray(false); setTucked(false); setSaying(true); setSaid(false); queueMicrotask(() => sayInput?.focus()) } }
    addEventListener("message", listen)
    addEventListener("keydown", keys, true)
    addEventListener("pointerdown", outside, true)
    addEventListener("blur", frameFocus)
    addEventListener("surface-message-author", message)
    const observer = new ResizeObserver(() => { const stage = props.stage(); if (stage) setSize({ w: stage.clientWidth, h: stage.clientHeight }) })
    const stage = props.stage()
    if (stage) observer.observe(stage)
    onCleanup(() => { removeEventListener("message", listen); removeEventListener("keydown", keys, true); removeEventListener("pointerdown", outside, true); removeEventListener("blur", frameFocus); removeEventListener("surface-message-author", message); observer.disconnect() })
  })
  // A remounted frame (new revision, renewed address) starts without a bridge until it says ready again.
  createEffect(() => { props.frame(); setReady(false) })

  const send = async (sealed: SealedComment) => {
    setOutgoing(new Map([...outgoing(), [sealed.comment_id, { sealed, state: "sending" as const }]]))
    // A new comment's card follows it from the draft to its own id, so sending, failure and Retry stay in view.
    if (open()?.key === DRAFT && !sealed.parent_id) {
      setRects(new Map([...rects(), [sealed.comment_id, rects().get(DRAFT)!]]))
      setOpen({ key: sealed.comment_id, anchor: sealed.anchor })
    }
    const result = await props.host.send(sealed)
    if (!result.ok) return setOutgoing(new Map([...outgoing(), [sealed.comment_id, { sealed, state: "failed" as const, error: result.error }]]))
    setComments([...comments().filter((comment) => comment.comment_id !== result.comment.comment_id), result.comment])
    setOutgoing(new Map([...outgoing()].filter(([id]) => id !== sealed.comment_id)))
  }
  const submit = (key: string, anchor: CommentAnchor, parent?: string) => {
    const body = (drafts().get(key) ?? "").trim()
    if (!body) return
    setDrafts(new Map([...drafts()].filter(([item]) => item !== key)))
    void send({ comment_id: mintCommentId(), revision: props.revision, anchor, body, ...(parent ? { parent_id: parent } : {}) })
  }

  const boxOf = (key: string) => rects().get(key)?.rect ?? undefined
  // The bubble's corner sits at the anchor's top-left, pulled inside the stage.
  const markerAt = (box: Box) => ({ left: `${Math.max(4, Math.min(size().w - 34, box.x - 10))}px`, top: `${Math.max(4, Math.min(size().h - 34, box.y - 10))}px` })
  const markerThreads = () => [
    ...onView().flatMap((thread) => {
      const found = rects().get(thread.root.comment_id)
      return found?.rect ? [{ key: thread.root.comment_id, author: thread.root.author.name, count: 1 + thread.replies.length, box: found.rect, changed: false, status: undefined as Outgoing["state"] | undefined }] : []
    }),
    ...pendingRoots().flatMap((item) => {
      const box = boxOf(item.sealed.comment_id)
      return box ? [{ key: item.sealed.comment_id, author: "You", count: 1, box, changed: false, status: item.state }] : []
    }),
  ]

  const markerByKey = createMemo(() => new Map(markerThreads().map((marker) => [marker.key, marker])))
  const markerKeys = createMemo(() => [...markerByKey().keys()], [], { equals: (a, b) => a.length === b.length && a.every((key, i) => key === b[i]) })

  return <>
    <Show when={shown() && !open()}>
      <div class="sc-markers" aria-label="Comments on this page">
        {/* Keyed by thread id, not object: every anchor report (scroll, resize, DOM change) and every reply rebuilds the
          * marker objects, and re-keying by object would replace the button the human's focus is on. */}
        <For each={markerKeys()}>{(key) => <Show when={markerByKey().get(key)}>{(marker) =>
          <button class="sc-peek" ref={(el) => markers.set(marker().key, el)} style={markerAt(marker().box)} data-comment={marker().key} data-status={marker().status} data-changed={marker().changed ? "" : undefined}
            aria-label={`Comment by ${marker().author}${marker().count > 1 ? `, ${marker().count} in thread` : ""}${marker().changed ? ", its target changed" : ""}`}
             onClick={() => marker().status ? setOpen({ key: marker().key, anchor: outgoing().get(marker().key)!.sealed.anchor }) : reveal(marker().key)}>
            <span class="sc-peek-face">{initialOf(marker().author)}</span>
            <Show when={marker().count > 1}><span class="sc-peek-count">{marker().count}</span></Show>
          </button>}</Show>}</For>
      </div>
    </Show>
    <Show when={open()}>{(current) => {
       const box = () => boxOf(current().key) ?? { x: size().w / 2 - 100, y: 80, w: 200, h: 0 }
       const hole = () => focusHole(box(), size())
       const thread = () => list().find((item) => item.root.comment_id === current().key)
       const notHere = () => !!thread() && stateOf(thread()!) !== "shown"
      // The side with room, capped so the reply box and actions stay on screen (surface-bridge geometry).
       const place = () => notHere() ? { below: false, left: Math.max(8, (size().w - Math.min(400, size().w - 16)) / 2), bottom: 70, maxBlockSize: Math.min(460, size().h - 88) } : placeCard(box(), size())
      const below = () => place().below
      const cardStyle = () => {
        const at = place()
        return Object.assign({ left: `${at.left}px`, "max-block-size": `${at.maxBlockSize}px` }, at.top === undefined ? { bottom: `${at.bottom}px` } : { top: `${at.top}px` })
      }
      const sending = () => [...outgoing().values()].filter((item) => item.sealed.comment_id === current().key || item.sealed.parent_id === current().key)
      let input: HTMLTextAreaElement | undefined
      onMount(() => input?.focus())
      const draftKey = () => current().key
       return <div class="sc-focus" aria-label={thread() ? "Comment thread" : "New comment"}>
         <Show when={!notHere() && !!boxOf(current().key)}><div class="sc-veil" aria-hidden="true" style={{ "clip-path": `path(evenodd, "M0 0H${size().w}V${size().h}H0Z M${hole().x} ${hole().y}H${hole().r}V${hole().b}H${hole().x}Z")` }} /></Show>
         <Show when={!notHere() && !!boxOf(current().key)}><div class="sc-ring" style={{ left: `${hole().x}px`, top: `${hole().y}px`, width: `${hole().r - hole().x}px`, height: `${hole().b - hole().y}px` }} /></Show>
         <section class="sc-card" role="region" style={cardStyle()} data-below={below() ? "" : undefined} data-away={notHere() ? "" : undefined}>
           <Show when={thread()}><div class="sc-card-nav"><span>{notHere() ? "Not on this view" : sectionOf(thread()!)}</span><button aria-label="Previous thread (K)" title="Previous thread (K)" onClick={() => navigate(-1)}>‹</button><span>{(() => { const group = notHere() ? away() : onView(); return `${group.findIndex((item) => item.root.comment_id === current().key) + 1}/${group.length}` })()}</span><button aria-label="Next thread (J)" title="Next thread (J)" onClick={() => navigate(1)}>›</button></div></Show>
           <Show when={notHere() && thread()}>{(item) => <div class="sc-away"><span class="sc-away-tag">not on this view</span><span>{placementLabel(stateOf(item()), item().root.revision)}</span><blockquote>On {item().root.anchor.id ?? item().root.anchor.selector ?? (item().root.anchor.rect ? "the recorded page area" : "this Surface")}</blockquote></div>}</Show>
          <Show when={thread()}>{(item) => <ol class="sc-thread" ref={(el) => queueMicrotask(() => { el.scrollTop = el.scrollHeight })}>
            <For each={[item().root, ...item().replies]}>{(comment) => <li class="sc-comment" data-comment-id={comment.comment_id}>
              <span class="sc-face" aria-hidden="true">{initialOf(comment.author.name)}</span>
              <div class="sc-comment-main">
                <div class="sc-comment-head"><b><bdi dir="auto">{comment.author.name}</bdi></b><span class="sc-dim-text">{ago(comment.created_at)}</span></div>
                <p class="sc-body" dir="auto">{comment.body}</p>
              </div>
            </li>}</For>
          </ol>}</Show>
          <Show when={thread() && placement(thread()!.root, props.revision, rects().get(current().key)?.state) === "changed"}>
            <p class="sc-note" role="note">The commented part changed since this was written.</p>
          </Show>
          <For each={sending()}>{(item) => <div class="sc-out" data-state={item.state} role={item.state === "failed" ? "alert" : "status"}>
            <p class="sc-body" dir="auto">{item.sealed.body}</p>
            <Show when={item.state === "failed"} fallback={<span class="sc-dim-text"><Glyph name="clock" size={12} /> Sending…</span>}>
              <span class="sc-failed"><Glyph name="alert" size={12} /> {item.error}</span>
              <button class="sc-text-button" onClick={() => void send(item.sealed)}>Retry</button>
            </Show>
          </div>}</For>
          <Show when={thread()}>{(item) => <p class="sc-receipt" role="status"><Glyph name="check" size={12} /> {receiptLabel([item().root, ...item().replies].at(-1)!)}</p>}</Show>
          <Show when={current().key === DRAFT || thread()}>
            <form class="sc-compose" onSubmit={(event) => { event.preventDefault(); submit(draftKey(), current().anchor, current().key === DRAFT ? undefined : current().key) }}>
              <textarea ref={input} dir="auto" rows={current().key === DRAFT ? 3 : 2} maxLength={MAX_BODY} placeholder={current().key === DRAFT ? "Comment on this part…" : "Reply…"} aria-label={current().key === DRAFT ? "Comment" : "Reply"}
                value={drafts().get(draftKey()) ?? ""} onInput={(event) => setDrafts(new Map([...drafts(), [draftKey(), event.currentTarget.value]]))}
                onKeyDown={(event) => { if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); event.currentTarget.form?.requestSubmit() } }} />
              <div class="sc-compose-row">
                <span class="sc-dim-text">Goes to the Surface's owner · ⌘↵</span>
                 <button type="button" class="sc-text-button" onClick={() => close()}>Close</button>
                <button type="submit" class="sc-send" disabled={!(drafts().get(draftKey()) ?? "").trim()}>{current().key === DRAFT ? "Comment" : "Reply"}</button>
              </div>
            </form>
          </Show>
        </section>
      </div>
    }}</Show>
    <Show when={saying()}><section class="sc-say" role="dialog" aria-label="Message the author" onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setSaying(false) } }}>
      <div class="sc-say-to">To <bdi dir="auto">{author.name()}</bdi> · published this · rev {props.revision} · {props.ownerHost?.label ?? "this host"}
        <Show when={author.href()}>{href => <a href={href()} onClick={event => { event.preventDefault(); author.open() }}>Open chat</a>}</Show>
      </div>
      <Show when={said()} fallback={<form class="sc-compose" onSubmit={event => { event.preventDefault(); void sendSay() }}>
        <textarea ref={sayInput} dir="auto" rows={3} placeholder="Say something about the whole page…" aria-label="Message to author" value={sayDraft()} onInput={event => setSayDraft(event.currentTarget.value)}
          onKeyDown={event => { if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); event.currentTarget.form?.requestSubmit() } }} />
        <div class="sc-compose-row"><DictationField field={`surface-say:${props.ownerHost?.id ?? "local"}:${props.surface.id}`} label="message to author" insert={text => { const el = sayInput; if (!el) return; const start = el.selectionStart; const next = sayDraft().slice(0, start) + text + sayDraft().slice(el.selectionEnd); setSayDraft(next); queueMicrotask(() => { el.focus(); el.setSelectionRange(start + text.length, start + text.length) }) }} />
          <span class="sc-dim-text">⌘↵ · goes to chat, not a comment</span><button class="sc-send" type="submit" title={author.owner()?.state !== "ok" ? (author.owner() as { why?: string } | undefined)?.why ?? "Owner not readable now" : undefined} disabled={!sayDraft().trim() || sendingSay() || author.owner()?.state !== "ok"}>Send</button></div>
        <Show when={author.owner() && author.owner()!.state !== "ok"}><p class="sc-note" role="status">{author.owner()?.state !== "ok" ? (author.owner() as { why: string }).why : ""}</p></Show>
        <Show when={sayError()}><p class="sc-note" role="alert">{sayError()}</p></Show>
      </form>}><p role="status">Sent to {author.name()} · <a href={author.href()} onClick={event => { event.preventDefault(); author.open() }}>open the chat</a></p></Show>
    </section></Show>
    <Show when={tray()}><div class="sc-tray" aria-label="Find a comment">
      <div class="sc-tray-filters"><input ref={searchInput} type="search" placeholder="Find a comment" aria-label="Find a comment" value={query()} onInput={(event) => { setQuery(event.currentTarget.value); setCursor(0) }}
        onKeyDown={(event) => { if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); setCursor(Math.max(0, Math.min(filtered().here.length + filtered().away.length - 1, cursor() + (event.key === "ArrowDown" ? 1 : -1)))) } if (event.key === "Enter") { event.preventDefault(); const item = [...filtered().here, ...filtered().away][cursor()]; if (item) reveal(item.root.comment_id) } }} />
        <div class="sc-segments">{(["open", "all", "resolved"] as const).map((value) => <button aria-pressed={view() === value} onClick={() => { setView(value); setCursor(0) }}>{value}</button>)}</div></div>
      <div class="sc-authors" aria-label="Filter by author"><For each={[...new Set(comments().map((comment) => comment.author.name))]}>{(name) => <button title={name} aria-label={`Filter by ${name}`} aria-pressed={authors().has(name)} onClick={() => { const next = new Set(authors()); next.has(name) ? next.delete(name) : next.add(name); setAuthors(next) }}>{initialOf(name)}</button>}</For></div>
      <div class="sc-tray-list">
        <For each={[...new Set(filtered().here.map(sectionOf))]}>{(section) => <div class="sc-group"><h3>{section}</h3><For each={filtered().here.filter((item) => sectionOf(item) === section)}>{(item) => <button class="sc-tray-row" data-comment={item.root.comment_id} onMouseEnter={() => markers.get(item.root.comment_id)?.classList.add("sc-ping")} onMouseLeave={() => markers.get(item.root.comment_id)?.classList.remove("sc-ping")} onClick={() => reveal(item.root.comment_id)}>{item.root.author.name} · {item.replies.at(-1)?.body ?? item.root.body}</button>}</For></div>}</For>
        <Show when={filtered().away.length}><div class="sc-group"><h3>Not on this view</h3><For each={filtered().away}>{(item) => <button class="sc-tray-row" data-comment={item.root.comment_id} onClick={() => reveal(item.root.comment_id)}>{sectionOf(item)} · {item.replies.at(-1)?.body ?? item.root.body}</button>}</For></div></Show>
        <Show when={!filtered().here.length && !filtered().away.length}><p class="sc-empty">No comments match.</p></Show>
      </div>
    </div></Show>
    <div class="sc-toolbar" data-tucked={tucked() ? "" : undefined} data-picking={picking() ? "" : undefined} role="toolbar" aria-label="Feedback">
      <button type="button" class="sc-tool-say" title={`Tell ${author.name()} (M)`} aria-label={`Tell ${author.name()}`} aria-pressed={saying()} onClick={toggleSay}>
        <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="2" width="6" height="13" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v4m-4 0h8" /></svg>
      </button>
      <button class="sc-tool-main" ref={toolbarButton} aria-label="Comment (C)" aria-pressed={picking()} disabled={!ready() || !!unavailable()} title={unavailable() ?? (off() ? "This page turns comments off" : "Comment (C)")} onClick={(event) => picking() ? endPick() : startPick(event.detail === 0)}><Glyph name="comment-discussion" size={18} /></button>
      <span class="sc-draw" title={marksSupported ? "Draw (D) · hover for shapes" : "Drawing needs host support (marks)"}><button class="sc-tool" aria-label="Draw" title={marksSupported ? "Draw (D) · hover for shapes" : "Drawing needs host support (marks)"} disabled={!marksSupported}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20l4-1 11-11-3-3L5 16z" /></svg></button><span class="sc-fly" aria-hidden={!marksSupported}><For each={["pen", "arrow", "rect", "ellipse"]}>{(shape) => <button disabled={!marksSupported} title={shape} aria-label={shape}><span>{shape === "pen" ? "✎" : shape === "arrow" ? "↗" : shape === "rect" ? "▢" : "◯"}</span></button>}</For></span></span>
      <button class="sc-tool" aria-label="Undo last shape" title={marksSupported ? "Undo last shape" : "Drawing needs host support (marks)"} disabled={!marksSupported}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 7L4 12l5 5M4 12h10a6 6 0 0 1 6 6" /></svg></button><i />
      <button class="sc-tool" aria-label="Previous thread (K)" title="Previous thread (K)" onClick={() => navigate(-1)}>‹</button>
      <button class="sc-count" aria-label="Find a comment (F)" title="Find a comment (F)" aria-expanded={tray()} onClick={toggleTray}>{list().filter((item) => item.root.state !== "resolved").length}<Show when={away().length}><span class="sc-off-count">+{away().length}</span></Show></button>
      <button class="sc-tool" aria-label="Next thread (J)" title="Next thread (J)" onClick={() => navigate(1)}>›</button><i />
      <button class="sc-tool" aria-label="Hide comments (H)" title="Show / hide comments (H)" aria-pressed={shown()} onClick={() => setShown(!shown())}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z" /><circle cx="12" cy="12" r="3" /></svg></button>
      <button class="sc-tool" aria-label="Tuck toolbar (.)" title="Tuck toolbar (.)" onClick={() => { setTucked(true); setTray(false); if (picking()) endPick() }}>⌄</button>
    </div>
    <Show when={tucked()}><button class="sc-tab" aria-label="Restore toolbar (.)" title="Restore toolbar (.)" onClick={() => setTucked(false)}>⌃ {list().filter((item) => item.root.state !== "resolved").length}</button></Show>
  </>
}
