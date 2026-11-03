/* On-surface comments over the Surface reader's frame (DD #519 M1). One floating toolbar: Comment (C) enters pick mode,
 * a click or Enter on an element drops a draft there, Esc leaves. Each thread shows as a corner-peek bubble at its
 * anchor; opening one dims and blurs everything around the anchor and shows the thread with an inline reply. Comments
 * come only from the host's store (surface-comments.ts); the frame learns anchors, never comment text. */
import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { ago } from "../state"
import { initialOf, MAX_BODY, mintCommentId, placement, placementLabel, receiptLabel, threads, type AnchorState, type CommentAnchor, type CommentHost, type SealedComment, type SurfaceComment } from "../surface-comments"
import { Glyph } from "./icons"
import "./surface-comments.css"

type Box = { x: number; y: number; w: number; h: number }
type Outgoing = { sealed: SealedComment; state: "sending" | "failed"; error?: string }
type Open = { key: string; anchor: CommentAnchor; parent?: string }
const NS = "es-comments"
const DRAFT = "__draft"
const POLL_MS = 30_000

export const SurfaceComments = (props: { host: CommentHost; revision: number; frame: () => HTMLIFrameElement | undefined; stage: () => HTMLElement | undefined }) => {
  const [comments, setComments] = createSignal<SurfaceComment[]>([])
  const [unavailable, setUnavailable] = createSignal<string>()
  const [ready, setReady] = createSignal(false)
  // The page declared <meta name="es-comments-anchors" content="off"> (surface-bridge.ts).
  const [off, setOff] = createSignal(false)
  const [picking, setPicking] = createSignal(false)
  const [shown, setShown] = createSignal(true)
  const [open, setOpen] = createSignal<Open>()
  const [rects, setRects] = createSignal<ReadonlyMap<string, { rect: Box | null; state: AnchorState }>>(new Map())
  const [outgoing, setOutgoing] = createSignal<ReadonlyMap<string, Outgoing>>(new Map())
  // Unsent text per thread (DRAFT for a new comment); hiding, closing or a failed send never loses it.
  const [drafts, setDrafts] = createSignal<ReadonlyMap<string, string>>(new Map())
  const [size, setSize] = createSignal({ w: 0, h: 0 })
  const markers = new Map<string, HTMLButtonElement>()
  let toolbarButton: HTMLButtonElement | undefined

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
  const elsewhere = () => list().flatMap((thread) => {
    const state = placement(thread.root, props.revision, rects().get(thread.root.comment_id)?.state)
    return state === "shown" || state === "changed" || state === "locating" ? [] : [{ thread, state }]
  })
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
    setOpen()
    setPicking(true)
    toFrame({ type: "pick", on: true, keyboard })
  }
  const endPick = () => { setPicking(false); toFrame({ type: "pick", on: false }) }
  const close = () => {
    const key = open()?.key
    setOpen()
    queueMicrotask(() => (key && markers.get(key) ? markers.get(key)!.focus() : toolbarButton?.focus()))
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
      if (data.type === "key" && data.key === "Escape" && open()) close()
    }
    const keys = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return
      const typing = event.target instanceof HTMLElement && (event.target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName))
      if (event.key === "Escape" && (picking() || open())) {
        event.preventDefault()
        event.stopPropagation()
        if (picking()) endPick()
        else close()
        return
      }
      // Pick mode follows the keyboard wherever focus is: keys pressed in the app go to the frame's picker.
      if (picking() && ["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "Tab", "Enter", " ", "j", "k"].includes(event.key) && !typing) {
        event.preventDefault()
        toFrame({ type: "pick-key", key: event.key, shift: event.shiftKey })
        return
      }
      if (event.key === "c" && !typing && props.stage()?.isConnected) { event.preventDefault(); startPick(true) }
    }
    addEventListener("message", listen)
    addEventListener("keydown", keys, true)
    const observer = new ResizeObserver(() => { const stage = props.stage(); if (stage) setSize({ w: stage.clientWidth, h: stage.clientHeight }) })
    const stage = props.stage()
    if (stage) observer.observe(stage)
    onCleanup(() => { removeEventListener("message", listen); removeEventListener("keydown", keys, true); observer.disconnect() })
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
    ...here().flatMap((thread) => {
      const found = rects().get(thread.root.comment_id)
      return found?.rect && (found.state === "shown" || found.state === "changed") ? [{ key: thread.root.comment_id, author: thread.root.author.name, count: 1 + thread.replies.length, box: found.rect, changed: found.state === "changed", status: undefined as Outgoing["state"] | undefined }] : []
    }),
    ...pendingRoots().flatMap((item) => {
      const box = boxOf(item.sealed.comment_id)
      return box ? [{ key: item.sealed.comment_id, author: "You", count: 1, box, changed: false, status: item.state }] : []
    }),
  ]

  return <>
    <Show when={shown() && !open()}>
      <div class="sc-markers" aria-label="Comments on this page">
        <For each={markerThreads()}>{(marker) =>
          <button class="sc-peek" ref={(el) => markers.set(marker.key, el)} style={markerAt(marker.box)} data-comment={marker.key} data-status={marker.status} data-changed={marker.changed ? "" : undefined}
            aria-label={`Comment by ${marker.author}${marker.count > 1 ? `, ${marker.count} in thread` : ""}${marker.changed ? ", its target changed" : ""}`}
            onClick={() => setOpen({ key: marker.key, anchor: here().find((thread) => thread.root.comment_id === marker.key)?.root.anchor ?? outgoing().get(marker.key)!.sealed.anchor })}>
            <span class="sc-peek-face">{initialOf(marker.author)}</span>
            <Show when={marker.count > 1}><span class="sc-peek-count">{marker.count}</span></Show>
          </button>}</For>
      </div>
    </Show>
    <Show when={open()}>{(current) => {
      const box = () => boxOf(current().key) ?? { x: size().w / 2 - 100, y: 80, w: 200, h: 0 }
      const pad = 6
      const hole = () => ({ x: Math.max(0, box().x - pad), y: Math.max(0, box().y - pad), r: Math.min(size().w, box().x + box().w + pad), b: Math.min(size().h, box().y + box().h + pad) })
      const thread = () => list().find((item) => item.root.comment_id === current().key)
      const below = () => hole().b + 12 + 260 < size().h || hole().y < 280
      const cardStyle = () => ({ left: `${Math.max(8, Math.min(size().w - 368, box().x))}px`, ...(below() ? { top: `${Math.min(size().h - 120, hole().b + 10)}px` } : { bottom: `${size().h - hole().y + 10}px` }) })
      const sending = () => [...outgoing().values()].filter((item) => item.sealed.comment_id === current().key || item.sealed.parent_id === current().key)
      let input: HTMLTextAreaElement | undefined
      onMount(() => input?.focus())
      const draftKey = () => current().key
      return <div class="sc-focus" role="dialog" aria-modal="true" aria-label={thread() ? "Comment thread" : "New comment"}>
        <div class="sc-dim" style={{ left: 0, top: 0, width: "100%", height: `${hole().y}px` }} onClick={close} />
        <div class="sc-dim" style={{ left: 0, top: `${hole().b}px`, width: "100%", bottom: 0 }} onClick={close} />
        <div class="sc-dim" style={{ left: 0, top: `${hole().y}px`, width: `${hole().x}px`, height: `${hole().b - hole().y}px` }} onClick={close} />
        <div class="sc-dim" style={{ left: `${hole().r}px`, top: `${hole().y}px`, right: 0, height: `${hole().b - hole().y}px` }} onClick={close} />
        <div class="sc-ring" style={{ left: `${hole().x}px`, top: `${hole().y}px`, width: `${hole().r - hole().x}px`, height: `${hole().b - hole().y}px` }} />
        <section class="sc-card" style={cardStyle()} data-below={below() ? "" : undefined}>
          <Show when={thread()}>{(item) => <ol class="sc-thread">
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
                <button type="button" class="sc-text-button" onClick={close}>Close</button>
                <button type="submit" class="sc-send" disabled={!(drafts().get(draftKey()) ?? "").trim()}>{current().key === DRAFT ? "Comment" : "Reply"}</button>
              </div>
            </form>
          </Show>
        </section>
      </div>
    }}</Show>
    <div class="sc-toolbar" data-picking={picking() ? "" : undefined} role="toolbar" aria-label="Comments">
      <Show when={picking()} fallback={<>
        <button class="sc-tool-main" ref={toolbarButton} disabled={!ready() || !!unavailable()} title={unavailable() ?? (off() ? "This page turns comments off" : ready() ? "Comment on a part of this page (C)" : "This page cannot take comments yet")}
          onClick={(event) => startPick(event.detail === 0)}>
          <Glyph name="comment-discussion" size={14} /><span>Comment</span><kbd>C</kbd>
        </button>
        <Show when={list().length}>
          <button class="sc-tool" aria-pressed={!shown()} title={shown() ? "Hide comments" : "Show comments"} onClick={() => setShown(!shown())}>{shown() ? "Hide" : "Show"} {list().length}</button>
        </Show>
        <Show when={elsewhere().length}>
          <span class="sc-tool-note" title={elsewhere().map((item) => `${item.thread.root.author.name}: ${placementLabel(item.state, item.thread.root.revision)}`).join("\n")}>{elsewhere().length} not on this view</span>
        </Show>
      </>}>
        <span class="sc-tool-hint" role="status">Click a part to comment · ↑↓ Enter · Esc</span>
        <button class="sc-tool" onClick={endPick}>Cancel</button>
      </Show>
    </div>
  </>
}
