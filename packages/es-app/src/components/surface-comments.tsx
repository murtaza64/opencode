/* On-surface comments over the Surface reader's frame. The host owns text and drafts; the frame only receives anchors.
 * A fixed feedback bar opens pick mode or a finder tray; the non-modal card keeps the page interactive. */
import { createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show } from "solid-js"
import { ago } from "../state"
import { initialOf, MAX_BODY, mintCommentId, placement, placementLabel, pointMark, pointOf, receiptLabel, threads, type AnchorState, type CommentAnchor, type CommentHost, type CommentPoint, type SealedComment, type SurfaceComment } from "../surface-comments"
import { Glyph } from "./icons"
import { SurfaceChat } from "./surface-chat"
import { dictation, fieldTarget } from "../dictation"
import { useSurfaceOwner } from "./surface-owner"
import type { Surface } from "../surfaces"
import { focusHole, placeCard } from "../../../surface-bridge/src/geometry.js"
import { describeShapes, isValidMark, paintShape, type MarkShape } from "../../../surface-bridge/src/marks.js"
import { lookAnchor, lookKey, lookRequest, looksFor, reportLooks } from "../surface-look"
import "./surface-comments.css"

type Box = { x: number; y: number; w: number; h: number }
type Outgoing = { sealed: SealedComment; state: "sending" | "failed"; error?: string }
type Open = { key: string; anchor: CommentAnchor; parent?: string; point?: CommentPoint; drawing?: boolean }
type Tool = "pen" | "arrow" | "rect" | "ellipse"
type Mode = "element" | "point"
const NS = "es-comments"
const DRAFT = "__draft"
const POLL_MS = 30_000
const MODE_KEY = "es-app:comment-mode"
const SHAPE_KEY = "es-app:draw-shape"
// The whole document as a tracked anchor: the bridge reports its box in frame pixels, so a drawing's points can be
// stored as fractions of the document (anchor frame, ref "surface") and drawn back wherever the page scrolls.
const DOC = "__doc"
const DOC_ANCHOR: CommentAnchor = { rect: { x: 0, y: 0, w: 1, h: 1 } }
const TOOLS: { tool: Tool; label: string; glyph: string }[] = [{ tool: "pen", label: "Pen", glyph: "✎" }, { tool: "arrow", label: "Arrow", glyph: "↗" }, { tool: "rect", label: "Box", glyph: "▢" }, { tool: "ellipse", label: "Circle", glyph: "◯" }]

export const SurfaceComments = (props: { host: CommentHost; surface: Surface; ownerHost?: { id: string; label: string }; revision: number; frame: () => HTMLIFrameElement | undefined; stage: () => HTMLElement | undefined }) => {
  const author = useSurfaceOwner(() => ({ ...props.surface, revision: props.revision }), props.ownerHost)
  // Chat with the author: a pop-out over the reader (surface-chat.tsx). Esc minimises to a bubble; × closes.
  const [chat, setChat] = createSignal<"closed" | "open" | "min">("closed")
  const [chatDraft, setChatDraft] = createSignal("")
  const [unread, setUnread] = createSignal(0)
  let chatButton: HTMLButtonElement | undefined
  let micButton: HTMLButtonElement | undefined
  const openChat = () => { setChat("open"); setTray(false); setTucked(false) }
  const minimiseChat = () => { setChat("min"); queueMicrotask(() => chatButton?.focus()) }
  const closeChat = () => { setChat("closed"); queueMicrotask(() => chatButton?.focus()) }
  const toggleChat = () => chat() === "open" ? minimiseChat() : openChat()
  // Mic: one click records at once (the same dictation engine as the composer's ⌘⇧Space); a second click stops and
  // the transcript lands in the chat's composer as a draft. Nothing is sent until Enter.
  const voice = dictation
  const micTarget = () => fieldTarget(`surface-chat:${props.ownerHost?.id ?? "local"}:${props.surface.id}`)
  const recording = () => voice.owns(voice.state.target, micTarget()) && ["starting", "recording"].includes(voice.state.phase)
  const transcribing = () => voice.owns(voice.state.target, micTarget()) && voice.state.phase === "transcribing"
  const [clock, setClock] = createSignal(Date.now())
  createEffect(() => { if (!recording()) return; const timer = setInterval(() => setClock(Date.now()), 500); onCleanup(() => clearInterval(timer)) })
  const elapsed = () => { const seconds = Math.max(0, Math.floor((clock() - (voice.state.startedAt || clock())) / 1000)); return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}` }
  const toggleMic = () => { if (!recording()) openChat(); void voice.toggle(micTarget()) }
  onMount(() => {
    if (voice.state.availability === "unknown") void voice.refresh()
    onCleanup(voice.attachField(micTarget().field!, (text) => { setChatDraft(chatDraft() ? `${chatDraft().trimEnd()} ${text}` : text); openChat() }))
  })
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
  // Drawing and pins need a store that keeps marks (it lists "marks" in its capabilities); older hosts keep both off.
  const marksSupported = () => capabilities().includes("marks")
  // A point comment needs the frame's point picks (surface-bridge 1.4.0) and a store that keeps marks.
  const [features, setFeatures] = createSignal<string[]>([])
  const [capabilities, setCapabilities] = createSignal<string[]>([])
  const pointable = () => features().includes("point") && capabilities().includes("marks")
  // Click = the last-used mode; Alt-click flips it for one comment. The fan-out picks and remembers a mode.
  const [mode, setModeRaw] = createSignal<Mode>(localStorage.getItem(MODE_KEY) === "point" ? "point" : "element")
  const setMode = (value: Mode) => { setModeRaw(value); localStorage.setItem(MODE_KEY, value) }
  const [pickMode, setPickMode] = createSignal<Mode>("element")
  const [fan, setFan] = createSignal(false)
  // Draw: one button with the last-used shape; strokes collect into one draft mark until Save, Undo or Esc.
  const [tool, setToolRaw] = createSignal<Tool>(TOOLS.some((item) => item.tool === localStorage.getItem(SHAPE_KEY)) ? localStorage.getItem(SHAPE_KEY) as Tool : "pen")
  const setTool = (value: Tool) => { setToolRaw(value); localStorage.setItem(SHAPE_KEY, value) }
  const [drawing, setDrawing] = createSignal(false)
  const [drawFan, setDrawFan] = createSignal(false)
  const [strokes, setStrokes] = createSignal<MarkShape[]>([])
  const [live, setLive] = createSignal<{ tool: Tool; pts: number[] }>()

  const load = async () => {
    const result = await props.host.read()
    if ("unavailable" in result) return setUnavailable(result.unavailable)
    setUnavailable()
    setComments(result.comments)
    setCapabilities(result.capabilities ?? [])
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
    if (tray()) { if (chat() === "open") setChat("min"); queueMicrotask(() => searchInput?.focus()) }
  }
  // Everything the frame should locate: this revision's threads, sends in flight and the open draft.
  createEffect(() => {
    if (!ready()) return
    const anchors = [
      ...here().map((thread) => ({ key: thread.root.comment_id, anchor: thread.root.anchor })),
      ...pendingRoots().map((item) => ({ key: item.sealed.comment_id, anchor: item.sealed.anchor })),
      // A drawing draft is tracked by its bounding box too, so its card stays placed off the drawing as the page moves.
      ...(open()?.key === DRAFT ? [{ key: DRAFT, anchor: open()!.anchor }] : []),
      ...(marksSupported() ? [{ key: DOC, anchor: DOC_ANCHOR }] : []),
      // The change header's "Look at" places (surface-look.ts), located with the same bridge; revealed only on click.
      ...looksFor(props.surface.id).flatMap((place, index) => { const anchor = lookAnchor(place); return anchor ? [{ key: lookKey(index), anchor }] : [] }),
    ]
    toFrame({ type: "track", anchors })
  })
  createEffect(() => {
    const list = looksFor(props.surface.id)
    if (!list.length) return
    reportLooks(props.surface.id, list.map((place, index) => !lookAnchor(place) ? "unlocated" : off() ? "unavailable" : rects().get(lookKey(index))?.state ?? "missing"))
  })
  const [pulse, setPulse] = createSignal<string>()
  createEffect(on(lookRequest, (asked) => {
    if (!asked || asked.surface !== props.surface.id) return
    const key = lookKey(asked.index)
    const state = rects().get(key)?.state
    if (state !== "shown" && state !== "changed") return
    toFrame({ type: "reveal", key })
    setPulse(key)
    setTimeout(() => setPulse((current) => (current === key ? undefined : current)), 1600)
  }, { defer: true }))

  // Keyboard picking keeps focus in the app; its arrow, Tab and Enter keys are forwarded to the frame's picker.
  const startPick = (keyboard: boolean, as: Mode = mode()) => {
    if (!ready() || unavailable()) return
    const point = as === "point" && pointable()
    setTray(false)
    setFan(false)
    setOpen()
    setPicking(true)
    setPickMode(point ? "point" : "element")
    toFrame({ type: "pick", on: true, keyboard, ...(point ? { point: true } : {}) })
  }
  const flipped = () => (mode() === "point" ? "element" : "point") as Mode

  const doc = () => rects().get(DOC)?.rect ?? undefined
  const round = (value: number) => Math.round(value * 10000) / 10000
  const toDoc = (x: number, y: number) => { const box = doc()!; return [round(Math.min(2, Math.max(-1, (x - box.x) / box.w))), round(Math.min(2, Math.max(-1, (y - box.y) / box.h)))] }
  const toStage = (shape: MarkShape) => { const box = doc(); return box ? { tool: shape.tool, pts: shape.pts.map((value, i) => (i % 2 ? box.y + value * box.h : box.x + value * box.w)) } : undefined }
  const startDraw = (as: Tool = tool()) => {
    if (!marksSupported() || !ready() || unavailable() || !doc()) return
    if (picking()) endPick()
    setTool(as)
    setDrawFan(false)
    setTray(false)
    if (open() && !open()!.drawing) setOpen()
    setDrawing(true)
  }
  const endDraw = () => {
    setDrawing(false)
    setLive()
    setStrokes([])
    if (open()?.drawing) setOpen()
  }
  // The draft card follows the drawing: anchored to its bounding box (document fractions, as the store's rect anchor).
  const openDrawing = (shapes: MarkShape[]) => {
    if (!shapes.length) return setOpen()
    const xs = shapes.flatMap((shape) => shape.pts.filter((_, i) => i % 2 === 0)), ys = shapes.flatMap((shape) => shape.pts.filter((_, i) => i % 2 === 1))
    const clamp = (value: number) => Math.min(1, Math.max(0, value))
    const x = clamp(Math.min(...xs)), y = clamp(Math.min(...ys))
    const rect = { x: round(x), y: round(y), w: round(Math.max(0.0001, clamp(Math.max(...xs)) - x)), h: round(Math.max(0.0001, clamp(Math.max(...ys)) - y)) }
    const box = doc()!
    setRects(new Map([...rects(), [DRAFT, { rect: { x: box.x + rect.x * box.w, y: box.y + rect.y * box.h, w: rect.w * box.w, h: rect.h * box.h }, state: "shown" as const }]]))
    setOpen({ key: DRAFT, anchor: { rect }, drawing: true })
  }
  const undo = () => { const next = strokes().slice(0, -1); setStrokes(next); openDrawing(next) }
  // Pointer drawing on the overlay, in stage pixels; a finished stroke is stored in document fractions.
  const stagePoint = (event: PointerEvent) => { const at = props.stage()!.getBoundingClientRect(); return [event.clientX - at.left, event.clientY - at.top] }
  const strokeStart = (event: PointerEvent) => {
    if (event.button !== 0 || strokes().length >= 20) return
    event.preventDefault()
    ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
    const [x, y] = stagePoint(event)
    setLive({ tool: tool(), pts: [x, y, x, y] })
  }
  const strokeMove = (event: PointerEvent) => {
    const current = live()
    if (!current) return
    const [x, y] = stagePoint(event)
    if (current.tool !== "pen") return setLive({ ...current, pts: [current.pts[0], current.pts[1], x, y] })
    const [lx, ly] = current.pts.slice(-2)
    if (Math.hypot(x - lx, y - ly) >= 3) setLive({ ...current, pts: [...current.pts, x, y] })
  }
  const strokeEnd = () => {
    const current = live()
    setLive()
    if (!current || !doc()) return
    const [x0, y0] = current.pts, [x1, y1] = current.pts.slice(-2)
    if (Math.hypot(x1 - x0, y1 - y0) < 4 && current.pts.length <= 4) return
    // A pen keeps at most 200 points: evenly thinned, always ending where the stroke ended.
    const points = current.tool === "pen" ? thin(current.pts, 200) : current.pts.slice(0, 4)
    const pts = points.flatMap((_, i) => (i % 2 ? [] : toDoc(points[i], points[i + 1])))
    const next = [...strokes(), { tool: current.tool, pts }]
    setStrokes(next)
    openDrawing(next)
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
      if (data.type === "ready") { setOff(data.policy === "off"); setReady(data.policy !== "off"); setFeatures(Array.isArray(data.features) ? data.features.filter((item): item is string => typeof item === "string") : []) }
      if (data.type === "rects") setRects(new Map((data.items as { key: string; rect: Box | null; state: AnchorState }[]).map((item) => [item.key, { rect: item.rect, state: item.state }])))
      if (data.type === "picked") {
        setPicking(false)
        setShown(true)
        setRects(new Map([...rects(), [DRAFT, { rect: data.rect as Box, state: "shown" as const }]]))
        const point = data.point as CommentPoint | undefined
        setOpen({ key: DRAFT, anchor: data.anchor as CommentAnchor, ...(pickMode() === "point" && point ? { point } : {}) })
      }
      if (data.type === "pick-end") setPicking(false)
      if (data.type === "key" && data.key === "c") startPick(true)
      if (data.type === "key" && data.key === "m") toggleChat()
      if (data.type === "key" && data.key === "Escape") {
        if (recording()) void voice.stop()
        else if (chat() === "open") minimiseChat()
        else if (tray()) setTray(false)
        else if (picking()) endPick()
        else if (open()) close()
      }
    }
    const keys = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return
      const typing = event.target instanceof HTMLElement && (event.target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName))
      // Esc stops a recording (the text is kept), else minimises the chat.
      if (event.key === "Escape" && recording()) { event.preventDefault(); event.stopImmediatePropagation(); void voice.stop(); return }
      if (event.key === "Escape" && chat() === "open") { event.preventDefault(); event.stopImmediatePropagation(); minimiseChat(); return }
      if (event.key === "Escape" && (tray() || picking() || open() || drawing())) {
        event.preventDefault()
        event.stopPropagation()
        if (tray()) { setTray(false); toolbarButton?.focus() }
        else if (picking()) endPick()
        else if (drawing()) endDraw()
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
      if (event.key.toLowerCase() === "d" && marksSupported()) { event.preventDefault(); drawing() ? endDraw() : startDraw() }
      if (event.key.toLowerCase() === "f") { event.preventDefault(); toggleTray() }
      if (event.key.toLowerCase() === "h") { event.preventDefault(); setShown(!shown()) }
      if (event.key === ".") { event.preventDefault(); setTucked(!tucked()); setTray(false) }
      if (event.key.toLowerCase() === "j") { event.preventDefault(); navigate(1) }
      if (event.key.toLowerCase() === "k") { event.preventDefault(); navigate(-1) }
      if (event.key.toLowerCase() === "m") { event.preventDefault(); toggleChat() }
    }
    const outside = (event: PointerEvent) => {
      if (!(event.target instanceof Node) || !props.stage()?.isConnected) return
      if (event.target instanceof Element && event.target.closest(".sc-card, .sc-toolbar, .sc-tray, .sc-peek, .sc-tab, .sc-draw-layer")) return
      if (tray()) setTray(false)
      if (open()) close(false)
    }
    // A click inside the sandboxed frame does not bubble to the host. It moves focus to the frame instead.
    const frameFocus = () => {
      if (document.activeElement !== props.frame()) return
      if (tray()) setTray(false)
      if (open()) close(false)
    }
    const message = (event: Event) => { if ((event as CustomEvent<string>).detail === props.surface.id) openChat() }
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
      // A saved drawing leaves draw mode; the sending (or failed, with Retry) card stays on it.
      if (sealed.mark && sealed.mark.shapes.some((shape) => shape.tool !== "pin")) { setDrawing(false); setStrokes([]) }
    }
    const result = await props.host.send(sealed)
    if (!result.ok) return setOutgoing(new Map([...outgoing(), [sealed.comment_id, { sealed, state: "failed" as const, error: result.error }]]))
    setComments([...comments().filter((comment) => comment.comment_id !== result.comment.comment_id), result.comment])
    setOutgoing(new Map([...outgoing()].filter(([id]) => id !== sealed.comment_id)))
  }
  const submit = (key: string, anchor: CommentAnchor, parent?: string, point?: CommentPoint, drawn?: MarkShape[]) => {
    const body = (drafts().get(key) ?? "").trim()
    // A drawing may stand alone; a comment or reply needs text.
    if (!body && !drawn?.length) return
    setDrafts(new Map([...drafts()].filter(([item]) => item !== key)))
    const mark = drawn?.length ? { frame: "anchor" as const, ref: "surface", state: "", s: "", shapes: drawn } : point ? pointMark(anchor, point) : undefined
    void send({ comment_id: mintCommentId(), revision: props.revision, anchor, body, ...(parent ? { parent_id: parent } : {}), ...(mark ? { mark } : {}) })
  }
  // A drawing comment's shapes in stage pixels, while the document is located.
  const drawingOf = (comment: { mark?: SurfaceComment["mark"] }) => {
    const mark = comment.mark
    if (!mark || mark.frame !== "anchor" || mark.ref !== "surface" || !isValidMark(mark) || mark.shapes.every((shape) => shape.tool === "pin")) return
    return mark.shapes.flatMap((shape) => { const at = toStage(shape as MarkShape); return at ? [at] : [] })
  }
  const restDrawings = () => [
    ...onView().map((thread) => ({ key: thread.root.comment_id, shapes: drawingOf(thread.root) })),
    ...pendingRoots().map((item) => ({ key: item.sealed.comment_id, shapes: drawingOf(item.sealed) })),
  ].filter((item): item is { key: string; shapes: MarkShape[] } => !!item.shapes?.length)

  const boxOf = (key: string) => rects().get(key)?.rect ?? undefined
  // The bubble's corner sits at the anchor's top-left, pulled inside the stage.
  // The pip sits just outside the part's top-left corner, so it never covers the part's own text.
  const markerAt = (box: Box) => ({ left: `${Math.max(0, Math.min(size().w - 24, box.x - 24))}px`, top: `${Math.max(0, Math.min(size().h - 24, box.y - 24))}px` })
  // A point comment's pin: its tip on the exact spot, as fractions of the element's current box.
  const spotOf = (box: Box, point: CommentPoint) => ({ x: box.x + point.x * box.w, y: box.y + point.y * box.h })
  const pinAt = (box: Box, point: CommentPoint) => { const spot = spotOf(box, point); return { left: `${Math.max(0, Math.min(size().w - 22, spot.x - 11))}px`, top: `${Math.max(0, Math.min(size().h - 27, spot.y - 27))}px` } }
  const markerThreads = () => [
    ...onView().flatMap((thread) => {
      const found = rects().get(thread.root.comment_id)
      return found?.rect ? [{ key: thread.root.comment_id, author: thread.root.author.name, count: 1 + thread.replies.length, box: found.rect, point: pointOf(thread.root), changed: false, status: undefined as Outgoing["state"] | undefined }] : []
    }),
    ...pendingRoots().flatMap((item) => {
      const box = boxOf(item.sealed.comment_id)
      return box ? [{ key: item.sealed.comment_id, author: "You", count: 1, box, point: pointOf(item.sealed), changed: false, status: item.state }] : []
    }),
  ]

  const markerByKey = createMemo(() => new Map(markerThreads().map((marker) => [marker.key, marker])))
  const markerKeys = createMemo(() => [...markerByKey().keys()], [], { equals: (a, b) => a.length === b.length && a.every((key, i) => key === b[i]) })

  return <>
    {/* Drawings: half strength at rest, full on the open thread; the draft and the stroke in progress on top. */}
    <Show when={shown() || drawing()}><svg class="sc-drawings" aria-hidden="true" width={size().w} height={size().h}>
      <For each={restDrawings()}>{(item) => <g class="sc-drawing" data-comment={item.key} data-open={open()?.key === item.key ? "" : undefined} ref={(el) => createEffect(() => { el.replaceChildren(); item.shapes.forEach((shape) => paintShape(el, shape, "#fab387", open()?.key === item.key ? 3 : 2, false)) })} />}</For>
      <g class="sc-drawing sc-draft" ref={(el) => createEffect(() => { el.replaceChildren(); [...strokes().flatMap((shape) => { const at = toStage(shape); return at ? [at] : [] }), ...(live() && live()!.pts.length >= 4 ? [live()!] : [])].forEach((shape) => paintShape(el, shape as MarkShape, "#fab387", 3, false)) })} />
    </svg></Show>
    <Show when={drawing()}><div class="sc-draw-layer" data-tool={tool()} aria-label={`Drawing: ${TOOLS.find((item) => item.tool === tool())!.label}. Drag on the page; Esc cancels`} role="application"
      onPointerDown={strokeStart} onPointerMove={strokeMove} onPointerUp={strokeEnd} onPointerCancel={() => setLive()} /></Show>
    <Show when={pulse() ? boxOf(pulse()!) : undefined}>{(box) =>
      <div class="sc-look-pulse" aria-hidden="true" style={{ left: `${box().x - 4}px`, top: `${box().y - 4}px`, width: `${box().w + 8}px`, height: `${box().h + 8}px` }} />}</Show>
    <Show when={shown() && !open()}>
      <div class="sc-markers" aria-label="Comments on this page">
        {/* Keyed by thread id, not object: every anchor report (scroll, resize, DOM change) and every reply rebuilds the
          * marker objects, and re-keying by object would replace the button the human's focus is on. */}
        <For each={markerKeys()}>{(key) => <Show when={markerByKey().get(key)}>{(marker) =>
          <><button class="sc-peek" classList={{ "sc-pin": !!marker().point }} ref={(el) => markers.set(marker().key, el)} style={marker().point ? pinAt(marker().box, marker().point!) : markerAt(marker().box)} data-comment={marker().key} data-kind={marker().point ? "point" : "element"} data-status={marker().status} data-changed={marker().changed ? "" : undefined}
            aria-label={`${marker().point ? "Pinned comment" : "Comment"} by ${marker().author}${marker().count > 1 ? `, ${marker().count} in thread` : ""}${marker().changed ? ", its target changed" : ""}`}
             onClick={() => marker().status ? setOpen({ key: marker().key, anchor: outgoing().get(marker().key)!.sealed.anchor }) : reveal(marker().key)}>
            <span class="sc-peek-face">{initialOf(marker().author)}</span>
            <Show when={marker().count > 1}><span class="sc-peek-count">{marker().count}</span></Show>
          </button>
          {/* An element comment's ring shows only while its pip is hovered or focused, or its finder row is. */}
          <Show when={!marker().point}><span class="sc-rest-ring" aria-hidden="true" style={{ left: `${marker().box.x}px`, top: `${marker().box.y}px`, width: `${marker().box.w}px`, height: `${marker().box.h}px` }} /></Show></>}</Show>}</For>
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
         <Show when={!notHere() && !!boxOf(current().key) && !current().drawing && !drawingOf(thread()?.root ?? {})}><div class="sc-veil" aria-hidden="true" style={{ "clip-path": `path(evenodd, "M0 0H${size().w}V${size().h}H0Z M${hole().x} ${hole().y}H${hole().r}V${hole().b}H${hole().x}Z")` }} /></Show>
         <Show when={!notHere() && !!boxOf(current().key) && !current().drawing && !drawingOf(thread()?.root ?? {})}><div class="sc-ring" style={{ left: `${hole().x}px`, top: `${hole().y}px`, width: `${hole().r - hole().x}px`, height: `${hole().b - hole().y}px` }} /></Show>
         <Show when={!notHere() && boxOf(current().key) && (current().point ?? (thread() ? pointOf(thread()!.root) : undefined))}>{(point) => <span class="sc-spot" aria-hidden="true" style={{ left: `${spotOf(box(), point()).x}px`, top: `${spotOf(box(), point()).y}px` }} />}</Show>
         <section class="sc-card" role="region" style={cardStyle()} data-below={below() ? "" : undefined} data-away={notHere() ? "" : undefined}>
           <Show when={thread()}><div class="sc-card-nav"><span>{notHere() ? "Not on this view" : sectionOf(thread()!)}</span><button aria-label="Previous thread (K)" title="Previous thread (K)" onClick={() => navigate(-1)}>‹</button><span>{(() => { const group = notHere() ? away() : onView(); return `${group.findIndex((item) => item.root.comment_id === current().key) + 1}/${group.length}` })()}</span><button aria-label="Next thread (J)" title="Next thread (J)" onClick={() => navigate(1)}>›</button></div></Show>
           <Show when={notHere() && thread()}>{(item) => <div class="sc-away"><span class="sc-away-tag">not on this view</span><span>{placementLabel(stateOf(item()), item().root.revision)}</span><blockquote>On {item().root.anchor.id ?? item().root.anchor.selector ?? (item().root.anchor.rect ? "the recorded page area" : "this Surface")}</blockquote></div>}</Show>
          {/* What a drawing is, in words: "You · box on this page". */}
          <Show when={current().drawing && strokes().length ? describeShapes({ frame: "anchor", ref: "surface", state: "", s: "", shapes: strokes() }) : thread()?.root.mark && drawingOf(thread()!.root) ? describeShapes(thread()!.root.mark! as Parameters<typeof describeShapes>[0]) : undefined}>{(what) =>
            <p class="sc-mark-line"><b>{current().drawing ? "You" : thread()!.root.author.name}</b> · {what()} on {current().anchor.id ?? "this page"}</p>}</Show>
          <Show when={thread()}>{(item) => <ol class="sc-thread" ref={(el) => queueMicrotask(() => { el.scrollTop = el.scrollHeight })}>
            <For each={[item().root, ...item().replies]}>{(comment) => <li class="sc-comment" data-comment-id={comment.comment_id}>
              <span class="sc-face" aria-hidden="true">{initialOf(comment.author.name)}</span>
              <div class="sc-comment-main">
                <div class="sc-comment-head"><b><bdi dir="auto">{comment.author.name}</bdi></b><span class="sc-dim-text">{ago(comment.created_at)}</span></div>
                <Show when={comment.body}><p class="sc-body" dir="auto">{comment.body}</p></Show>
              </div>
            </li>}</For>
          </ol>}</Show>
          <Show when={thread() && placement(thread()!.root, props.revision, rects().get(current().key)?.state) === "changed"}>
            <p class="sc-note" role="note">The commented part changed since this was written.</p>
          </Show>
          <For each={sending()}>{(item) => <div class="sc-out" data-state={item.state} role={item.state === "failed" ? "alert" : "status"}>
            <Show when={item.sealed.body} fallback={<p class="sc-body sc-dim-text">Drawing</p>}><p class="sc-body" dir="auto">{item.sealed.body}</p></Show>
            <Show when={item.state === "failed"} fallback={<span class="sc-dim-text"><Glyph name="clock" size={12} /> Sending…</span>}>
              <span class="sc-failed"><Glyph name="alert" size={12} /> {item.error}</span>
              <button class="sc-text-button" onClick={() => void send(item.sealed)}>Retry</button>
            </Show>
          </div>}</For>
          <Show when={thread()}>{(item) => <p class="sc-receipt" role="status"><Glyph name="check" size={12} /> {receiptLabel([item().root, ...item().replies].at(-1)!)}</p>}</Show>
          <Show when={current().key === DRAFT || thread()}>
            <form class="sc-compose" onSubmit={(event) => { event.preventDefault(); submit(draftKey(), current().anchor, current().key === DRAFT ? undefined : current().key, current().key === DRAFT ? current().point : undefined, current().drawing ? strokes() : undefined) }}>
              <textarea ref={input} dir="auto" rows={current().key === DRAFT ? 3 : 2} maxLength={MAX_BODY} placeholder={current().key === DRAFT ? current().drawing ? "Add a comment (optional)" : current().point ? "Comment on this spot…" : "Comment on this part…" : "Reply…"} aria-label={current().key === DRAFT ? "Comment" : "Reply"}
                value={drafts().get(draftKey()) ?? ""} onInput={(event) => setDrafts(new Map([...drafts(), [draftKey(), event.currentTarget.value]]))}
                onKeyDown={(event) => { if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); event.currentTarget.form?.requestSubmit() } }} />
              <div class="sc-compose-row">
                <span class="sc-dim-text">Goes to the Surface's owner · ⌘↵</span>
                 <button type="button" class="sc-text-button" onClick={() => current().drawing ? endDraw() : close()}>{current().drawing ? "Discard" : "Close"}</button>
                <button type="submit" class="sc-send" disabled={!(drafts().get(draftKey()) ?? "").trim() && !(current().drawing && strokes().length)}>{current().key === DRAFT ? current().drawing ? "Save" : "Comment" : "Reply"}</button>
              </div>
            </form>
          </Show>
        </section>
      </div>
    }}</Show>
    {/* The chat stays mounted while minimised, so its replies keep counting toward the bubble. */}
    <Show when={chat() !== "closed"}>
      <SurfaceChat surface={props.surface} author={author} revision={props.revision} host={props.ownerHost} draft={chatDraft} setDraft={setChatDraft}
        minimised={chat() === "min"} onMinimise={minimiseChat} onClose={closeChat} onUnread={setUnread} recording={recording() || transcribing()} />
      <Show when={chat() === "min"}><button type="button" class="sc-chat-bubble" aria-label={`Open chat with ${author.name()}${unread() ? `, ${unread()} unread` : ""}`} onClick={openChat}>
        <span class="sc-chat-avatar" aria-hidden="true"><Show when={author.avatar()} fallback={author.name().charAt(0).toUpperCase()}>{(url) => <img src={url()} alt="" referrerpolicy="no-referrer" />}</Show></span>
        <Show when={unread()}><span class="sc-chat-unread">{unread()}</span></Show></button></Show>
    </Show>
    <Show when={tray()}><div class="sc-tray" aria-label="Find a comment">
      <div class="sc-tray-filters"><input ref={searchInput} type="search" placeholder="Find a comment" aria-label="Find a comment" value={query()} onInput={(event) => { setQuery(event.currentTarget.value); setCursor(0) }}
        onKeyDown={(event) => { if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); setCursor(Math.max(0, Math.min(filtered().here.length + filtered().away.length - 1, cursor() + (event.key === "ArrowDown" ? 1 : -1)))) } if (event.key === "Enter") { event.preventDefault(); const item = [...filtered().here, ...filtered().away][cursor()]; if (item) reveal(item.root.comment_id) } }} />
        <div class="sc-segments">{(["open", "all", "resolved"] as const).map((value) => <button aria-pressed={view() === value} onClick={() => { setView(value); setCursor(0) }}>{value}</button>)}</div></div>
      <div class="sc-authors" aria-label="Filter by author"><For each={[...new Set(comments().map((comment) => comment.author.name))]}>{(name) => <button title={name} aria-label={`Filter by ${name}`} aria-pressed={authors().has(name)} onClick={() => { const next = new Set(authors()); next.has(name) ? next.delete(name) : next.add(name); setAuthors(next) }}>{initialOf(name)}</button>}</For></div>
      <div class="sc-tray-list">
        <For each={[...new Set(filtered().here.map(sectionOf))]}>{(section) => <div class="sc-group"><h3>{section}</h3><For each={filtered().here.filter((item) => sectionOf(item) === section)}>{(item) => <button class="sc-tray-row" data-comment={item.root.comment_id} onMouseEnter={() => markers.get(item.root.comment_id)?.classList.add("sc-ping")} onMouseLeave={() => markers.get(item.root.comment_id)?.classList.remove("sc-ping")} onClick={() => reveal(item.root.comment_id)}><span class="sc-row-body">{item.root.author.name} · {item.replies.at(-1)?.body ?? item.root.body}</span><Where thread={item} /></button>}</For></div>}</For>
        <Show when={filtered().away.length}><div class="sc-group"><h3>Not on this view</h3><For each={filtered().away}>{(item) => <button class="sc-tray-row" data-comment={item.root.comment_id} onClick={() => reveal(item.root.comment_id)}><span class="sc-row-body">{item.root.author.name} · {item.replies.at(-1)?.body ?? item.root.body}</span><Where thread={item} /></button>}</For></div></Show>
        <Show when={!filtered().here.length && !filtered().away.length}><p class="sc-empty">No comments match.</p></Show>
      </div>
    </div></Show>
    <div class="sc-toolbar" data-tucked={tucked() ? "" : undefined} data-picking={picking() ? "" : undefined} role="toolbar" aria-label="Feedback">
      <button type="button" class="sc-tool-mic" ref={micButton} aria-pressed={recording()} data-state={recording() ? "recording" : transcribing() ? "transcribing" : "idle"}
        disabled={voice.state.availability !== "ready" || (voice.state.phase !== "idle" && !voice.owns(voice.state.target, micTarget())) || transcribing()}
        aria-label={recording() ? `Stop recording (${elapsed()})` : `Dictate to ${author.name()}`}
        title={voice.state.availability === "setup" ? `Dictation unavailable: ${voice.state.setup}` : voice.state.availability !== "ready" ? "Dictation needs the desktop app" : recording() ? "Stop (click or Esc); the text lands in the chat" : `Speak to ${author.name()}: records at once, click again to stop`}
        onClick={toggleMic}>
        <Show when={recording()} fallback={<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="2" width="6" height="13" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v4m-4 0h8" /></svg>}>
          <span class="sc-rec" aria-hidden="true"><i /><svg viewBox="0 0 24 24"><rect x="9" y="2" width="6" height="13" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v4m-4 0h8" /></svg>{elapsed()}</span></Show>
      </button>
      <button type="button" class="sc-tool-chat" ref={chatButton} title={`Chat with ${author.name()} (M)`} aria-label={`Chat with ${author.name()}${unread() ? `, ${unread()} unread` : ""}`} aria-expanded={chat() === "open"} onClick={toggleChat}>
        {/* A conversation: a bubble with three dots (Comment is a bubble with a +). */}
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16v11H9l-5 4z" /><circle cx="8.5" cy="10.5" r=".9" fill="currentColor" /><circle cx="12" cy="10.5" r=".9" fill="currentColor" /><circle cx="15.5" cy="10.5" r=".9" fill="currentColor" /></svg>
        <Show when={unread()}><span class="sc-chat-unread">{unread()}</span></Show>
      </button>
      {/* Comment fans out like Draw: click = the last-used mode, Alt-click flips it once, the fan-out sets it. */}
      <span class="sc-draw sc-comment" data-open={fan() ? "" : undefined} onPointerLeave={() => setFan(false)}>
        <button class="sc-tool-main" ref={toolbarButton} aria-label={`Comment (C) · ${pickLabel(mode(), pointable())}`} aria-pressed={picking()} disabled={!ready() || !!unavailable()} data-mode={mode() === "point" && pointable() ? "point" : "element"}
          title={unavailable() ?? (off() ? "This page turns comments off" : `Comment on ${pickLabel(mode(), pointable()).toLowerCase()} (C) · Alt-click: ${pickLabel(flipped(), pointable()).toLowerCase()}`)}
          onPointerDown={(event) => { if (event.pointerType !== "touch") return; const timer = setTimeout(() => setFan(true), 450); const clear = () => clearTimeout(timer); event.currentTarget.addEventListener("pointerup", clear, { once: true }); event.currentTarget.addEventListener("pointercancel", clear, { once: true }) }}
          onContextMenu={(event) => { if (fan()) event.preventDefault() }}
          onClick={(event) => { if (fan()) return; picking() ? endPick() : startPick(event.detail === 0, event.altKey ? flipped() : mode()) }}>
          <Show when={mode() === "point" && pointable()} fallback={<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16v11H9l-5 4z" /><path d="M12 7.5v6M9 10.5h6" /></svg>}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21s-6-6.2-6-11a6 6 0 0 1 12 0c0 4.8-6 11-6 11z" /><circle cx="12" cy="10" r="2.2" /></svg></Show>
        </button>
        <span class="sc-fly sc-fly-comment" role="group" aria-label="Comment mode">
          <button aria-pressed={mode() === "element" || !pointable()} title="Element: hover rings a part, click anchors to it" onClick={() => { setMode("element"); startPick(false, "element") }}><span>▢</span><b>Element</b></button>
          <button aria-pressed={mode() === "point" && pointable()} disabled={!pointable()} title={pointable() ? "Point: click drops a pin at that exact spot" : "Point needs a newer page bridge and a host that keeps pins"} onClick={() => { setMode("point"); startPick(false, "point") }}><span>⌖</span><b>Point</b></button>
        </span>
      </span>
      {/* Draw: click = draw with the last shape; the fan-out (hover/focus, long-press on touch) picks another. */}
      <span class="sc-draw sc-draw-tool" data-open={drawFan() ? "" : undefined} onPointerLeave={() => setDrawFan(false)}>
        <button class="sc-tool" aria-label={`Draw (D) · ${TOOLS.find((item) => item.tool === tool())!.label}`} aria-pressed={drawing()} disabled={!marksSupported() || !ready() || !!unavailable()} data-tool={tool()}
          title={!marksSupported() ? "Drawing needs a host that keeps marks" : `Draw: ${TOOLS.find((item) => item.tool === tool())!.label.toLowerCase()} (D) · hover for shapes`}
          onPointerDown={(event) => { if (event.pointerType !== "touch") return; const timer = setTimeout(() => setDrawFan(true), 450); const clear = () => clearTimeout(timer); event.currentTarget.addEventListener("pointerup", clear, { once: true }); event.currentTarget.addEventListener("pointercancel", clear, { once: true }) }}
          onContextMenu={(event) => { if (drawFan()) event.preventDefault() }}
          onClick={() => { if (drawFan()) return; drawing() ? endDraw() : startDraw() }}>
          <span class="sc-tool-glyph" aria-hidden="true">{TOOLS.find((item) => item.tool === tool())!.glyph}</span>
        </button>
        <span class="sc-fly sc-fly-draw" role="group" aria-label="Shape" aria-hidden={!marksSupported()}>
          <For each={TOOLS}>{(item) => <button disabled={!marksSupported()} aria-pressed={tool() === item.tool} title={item.label} aria-label={item.label} onClick={() => startDraw(item.tool)}><span>{item.glyph}</span><b>{item.label}</b></button>}</For>
        </span>
      </span>
      <button class="sc-tool" aria-label="Undo last shape" title={marksSupported() ? "Undo last shape" : "Drawing needs a host that keeps marks"} disabled={!drawing() || !strokes().length} onClick={undo}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 7L4 12l5 5M4 12h10a6 6 0 0 1 6 6" /></svg></button><i />
      <button class="sc-tool" aria-label="Previous thread (K)" title="Previous thread (K)" onClick={() => navigate(-1)}>‹</button>
      <button class="sc-count" aria-label="Find a comment (F)" title="Find a comment (F)" aria-expanded={tray()} onClick={toggleTray}>{list().filter((item) => item.root.state !== "resolved").length}<Show when={away().length}><span class="sc-off-count">+{away().length}</span></Show></button>
      <button class="sc-tool" aria-label="Next thread (J)" title="Next thread (J)" onClick={() => navigate(1)}>›</button><i />
      <button class="sc-tool" aria-label="Hide comments (H)" title="Show / hide comments (H)" aria-pressed={shown()} onClick={() => setShown(!shown())}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z" /><circle cx="12" cy="12" r="3" /></svg></button>
      <button class="sc-tool" aria-label="Tuck toolbar (.)" title="Tuck toolbar (.)" onClick={() => { setTucked(true); setTray(false); if (picking()) endPick() }}>⌄</button>
    </div>
    <Show when={tucked()}><button class="sc-tab" aria-label="Restore toolbar (.)" title="Restore toolbar (.)" onClick={() => setTucked(false)}>⌃ {list().filter((item) => item.root.state !== "resolved").length}</button></Show>
  </>
}

/** `pts` (flat x,y pairs) thinned to at most `max` points, keeping the first and last. */
const thin = (pts: number[], max: number) => {
  const count = pts.length / 2
  if (count <= max) return pts
  return Array.from({ length: max }, (_, i) => Math.round(i * (count - 1) / (max - 1))).flatMap((index) => [pts[index * 2], pts[index * 2 + 1]])
}

const pickLabel = (mode: Mode, pointable: boolean) => (mode === "point" && pointable ? "Point" : "Element")

/** The finder row's place: the part a comment is on, and whether it pins a spot in it. */
const Where = (props: { thread: { root: SurfaceComment } }) => {
  const part = () => props.thread.root.anchor.id ?? props.thread.root.anchor.selector?.split(" > ").at(-1) ?? "this page"
  const drawn = () => { const mark = props.thread.root.mark; return mark && mark.ref === "surface" && isValidMark(mark) && mark.shapes.some((shape) => shape.tool !== "pin") ? describeShapes(mark as Parameters<typeof describeShapes>[0]) : undefined }
  return <span class="sc-row-where">on “<bdi dir="auto">{part()}</bdi>”{pointOf(props.thread.root) ? " · point" : drawn() ? ` · ${drawn()}` : ""}</span>
}
