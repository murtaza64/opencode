import { ascending } from "@opencode-ai/schema/identifier"
import { createContext, createEffect, createMemo, createSignal, onCleanup, onMount, useContext, type ParentProps } from "solid-js"
import type { PermissionRequest, QuestionRequest } from "@opencode-ai/sdk/v2"
import { ocAt } from "../api"
import { useDeskChat } from "../desk-companion"
import { useDeskQueue } from "../desk-queue"
import { createServerEvents, type ServerEvents } from "../event-source"
import { globalEvent } from "../live-session"
import { CfwSession, type Draw } from "./cfw"
import { buildScene, DEFAULT_DEPTH } from "./cfw-scene"
import { G2, type Device, type Gesture } from "./g2-transport"
import { connectOutcome, hudMode, pickFailure, type ConnState, replyPages, textFrame, type Ask, type HudState, type Voice } from "./live-hud"
import { latestReply, porterAsks } from "./porter"

const REPLY_AWAKE_MS = 25_000
const AMBIENT_AWAKE_MS = 5_000
const LC3_PACKET_BYTES = 205

/** One glasses connection and HUD loop for the whole window, so the Glasses page and the title-bar toggle share it
 * and navigating between tabs keeps the lens running. */
function createGlasses() {
  const chat = useDeskChat()
  const queue = useDeskQueue()

  const [connState, setConnState] = createSignal<ConnState>("disconnected")
  const [statusLine, setStatusLine] = createSignal("Not connected.")
  const [distance, setDistance] = createSignal(DEFAULT_DEPTH.distance)
  const [spread, setSpread] = createSignal(DEFAULT_DEPTH.spread)
  const [latencyMs, setLatencyMs] = createSignal<number | undefined>()
  const [transcribeMs, setTranscribeMs] = createSignal<number | undefined>()

  const [voice, setVoice] = createSignal<Voice>({ phase: "idle" })
  const [tool, setTool] = createSignal("")
  const [thinking, setThinking] = createSignal(false)
  const [reply, setReply] = createSignal<{ id: string; text: string } | undefined>()
  const [dismissedReply, setDismissedReply] = createSignal<string>()
  const [replyPage, setReplyPage] = createSignal(0)
  const [awakeUntil, setAwakeUntil] = createSignal(Date.now() + AMBIENT_AWAKE_MS)
  const [snoozedNeeds, setSnoozedNeeds] = createSignal("")
  const [needsIndex, setNeedsIndex] = createSignal(0)
  const [asks, setAsks] = createSignal<Ask[]>([])
  const [askSelected, setAskSelected] = createSignal(0)
  const [askArmed, setAskArmed] = createSignal(false)
  const [now, setNow] = createSignal(Date.now())
  const [scene, setScene] = createSignal<Draw[]>([])
  const [alignment, setAlignment] = createSignal(false)
  const [askFocus, setAskFocus] = createSignal(0)
  let generation = 0

  let link: G2 | undefined
  let cfw: CfwSession | undefined
  let connectAbort: AbortController | undefined
  let lastFrameKey = ""
  let writingText = false
  let pendingText: string | undefined
  let micPackets: Uint8Array[] = []
  let micListener: ((event: Event) => void) | undefined
  let micSource: "glasses" | "mac" = "mac"
  let recorder: MediaRecorder | undefined
  let recordedChunks: Blob[] = []
  let startedAt = Date.now()
  let lastNeedsKey = ""

  const openNeeds = createMemo(() => {
    const snap = queue.attention.snapshot()
    const records = (snap?.value.records ?? []).filter(record => record.status === "open")
    return { known: !!snap && !queue.attention.error(), records }
  })
  const needsKey = createMemo(() => openNeeds().records.map(record => `${record.id}:${record.revision}`).join(","))

  createEffect(() => {
    const key = needsKey()
    const count = openNeeds().records.length
    if (needsIndex() >= count) setNeedsIndex(Math.max(0, count - 1))
    if (key && key !== lastNeedsKey) {
      setAwakeUntil(Date.now() + AMBIENT_AWAKE_MS)
    }
    lastNeedsKey = key
  })

  const activeNeeds = createMemo(() => {
    const records = openNeeds().records
    if (!records.length || needsKey() === snoozedNeeds()) return undefined
    const record = records[Math.min(needsIndex(), records.length - 1)]
    return record ? { title: record.title, context: record.context } : undefined
  })

  const activeReply = createMemo(() => {
    const current = reply()
    return current && current.id !== dismissedReply() ? current.text : ""
  })

  const hudState = createMemo((): HudState => {
    const currentVoice = voice()
    const currentAsk = asks()[0]
    const needs = activeNeeds()
    const replyText = activeReply()
    const mode = hudMode({
      voice: currentVoice,
      ask: currentAsk,
      needs: !!needs,
      thinking: thinking(),
      reply: !!replyText,
      awakeUntil: awakeUntil(),
    }, now())
    return {
      mode: alignment() ? "align" : mode,
      voice: currentVoice,
      tool: tool(),
      reply: replyText,
      page: replyPage(),
      needs,
      needsIndex: needsIndex(),
      needsCount: openNeeds().records.length,
      ask: currentAsk,
      askSelected: askSelected(),
      askArmed: askArmed(),
      depth: { distance: distance(), spread: spread() },
      queueKnown: openNeeds().known,
    }
  })

  const pushText = (text: string) => {
    if (!link?.connected) return
    if (writingText) { pendingText = text; return }
    writingText = true
    const started = performance.now()
    void link.text(text).then(() => {
      setLatencyMs(Math.round(performance.now() - started))
    }).catch(() => {}).finally(() => {
      writingText = false
      if (pendingText !== undefined) {
        const next = pendingText
        pendingText = undefined
        pushText(next)
      }
    })
  }

  createEffect(() => {
    const state = hudState()
    const timestamp = now()
    const calls = buildScene(state, timestamp)
    setScene(calls)
    if (!link?.connected) return
    if (cfw) {
      const key = JSON.stringify(calls)
      if (key === lastFrameKey) return
      lastFrameKey = key
      const started = performance.now()
      void cfw.show(calls).then(() => setLatencyMs(Math.round(performance.now() - started))).catch(() => {})
      return
    }
    const text = textFrame(state, timestamp).join("\n") || " "
    if (text === lastFrameKey) return
    lastFrameKey = text
    pushText(text)
  })

  // Porter session subscription (new replies only, plus questions/permissions).
  createEffect(() => {
    if (connState() !== "connected") return
    const pointer = chat.desk.pointer()
    if (!pointer) return
    let active = true
    const client = ocAt(pointer.host?.base ?? "/oc")
    const sessionID = pointer.session
    const directory = pointer.directory
    const refreshAsks = async () => {
      const [permissions, questions] = await Promise.all([
        client.permissions(directory).catch((): PermissionRequest[] => []),
        client.questions(directory).catch((): QuestionRequest[] => []),
      ])
      if (!active) return
      const next = porterAsks(sessionID, permissions, questions)
      if (next[0]?.id !== asks()[0]?.id) { setAskSelected(0); setAskArmed(false) }
      setAsks(next)
    }
    const refreshReply = async () => {
      const messages = await client.messagesTail(sessionID, directory, 6).catch(() => [])
      if (!active) return
      const next = latestReply(messages, sessionID, startedAt)
      if (!next || next.id === reply()?.id) return
      setReply(next)
      setReplyPage(0)
      setAwakeUntil(Date.now() + REPLY_AWAKE_MS)
    }
    void refreshAsks()
    const url = pointer.host?.base
      ? `${pointer.host.base}/global/event`
      : `/oc/event?directory=${encodeURIComponent(directory)}`
    const source: ServerEvents = createServerEvents(url, {
      types: ["session.", "message.", "permission.", "question."],
    })
    source.onmessage = (event) => {
      const raw = JSON.parse(event.data) as Record<string, unknown>
      const payload = pointer.host?.base ? globalEvent(raw, directory) : raw
      if (!payload || typeof payload !== "object") return
      const record = payload as { type?: string; properties?: Record<string, unknown> }
      const props = record.properties ?? {}
      const info = props.info as { sessionID?: string; role?: string; time?: { completed?: number } } | undefined
      const part = props.part as { sessionID?: string; type?: string; tool?: string; state?: { status?: string } } | undefined
      const owner = (props.sessionID as string | undefined) ?? info?.sessionID ?? part?.sessionID
      if (owner && owner !== sessionID) return
      if (record.type === "session.status") {
        const status = (props.status as { type?: string } | undefined)?.type
        const busy = status === "busy" || status === "retry"
        setThinking(busy)
        if (!busy) { setTool(""); void refreshReply() }
      }
      if (record.type === "session.idle") { setThinking(false); setTool(""); void refreshReply() }
      if (record.type === "message.part.updated" && part?.type === "tool") setTool(part.tool ?? "")
      if (record.type === "message.updated" && info?.role === "assistant" && info.time?.completed) void refreshReply()
      if (record.type?.startsWith("permission.") || record.type?.startsWith("question.")) void refreshAsks()
    }
    onCleanup(() => { active = false; source.close() })
  })

  const transcribeBlob = async (audio: Blob) => {
    const started = performance.now()
    try {
      const response = await fetch("/__es/voice/glasses", {
        method: "POST",
        headers: { "content-type": audio.type || "application/octet-stream" },
        body: audio,
      })
      const body = await response.json().catch(() => undefined) as { ok?: boolean; text?: string; message?: string } | undefined
      setTranscribeMs(Math.round(performance.now() - started))
      if (!response.ok || !body?.ok || !body.text) {
        setVoice({ phase: "error", error: body?.message ?? "Heard nothing. Tap to dismiss." })
        return
      }
      setVoice({ phase: "confirm", transcript: body.text })
    } catch {
      setVoice({ phase: "error", error: "Transcription failed. Tap to dismiss." })
    }
  }

  const startRecording = async () => {
    const current = voice().phase
    if (current === "recording" || current === "transcribing" || current === "sending") return
    if (link?.micAvailable) {
      try {
        micPackets = []
        micListener = (event: Event) => {
          if (event instanceof CustomEvent && event.detail instanceof Uint8Array) micPackets.push(event.detail)
        }
        link.addEventListener("mic", micListener)
        await link.mic(true)
        micSource = "glasses"
        setVoice({ phase: "recording" })
        return
      } catch {
        if (micListener) link.removeEventListener("mic", micListener)
        micListener = undefined
      }
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } })
      recordedChunks = []
      recorder = new MediaRecorder(stream)
      recorder.ondataavailable = (event) => { if (event.data.size) recordedChunks.push(event.data) }
      recorder.onstop = () => {
        for (const track of stream.getTracks()) track.stop()
        void transcribeBlob(new Blob(recordedChunks, { type: recorder?.mimeType || "audio/webm" }))
      }
      recorder.start()
      micSource = "mac"
      setVoice({ phase: "recording" })
    } catch {
      setVoice({ phase: "error", error: "Microphone unavailable." })
    }
  }

  const stopRecording = () => {
    if (voice().phase !== "recording") return
    setVoice({ phase: "transcribing" })
    if (micSource === "glasses") {
      const currentLink = link
      void (async () => {
        await currentLink?.mic(false).catch(() => {})
        if (currentLink && micListener) currentLink.removeEventListener("mic", micListener)
        micListener = undefined
        const packets = micPackets.filter(packet => packet.length === LC3_PACKET_BYTES)
        micPackets = []
        if (!packets.length) {
          setVoice({ phase: "error", error: "No audio from glasses mic." })
          return
        }
        const total = packets.reduce((sum, packet) => sum + packet.length, 0)
        const merged = new Uint8Array(total)
        let offset = 0
        for (const packet of packets) { merged.set(packet, offset); offset += packet.length }
        await transcribeBlob(new Blob([merged], { type: "application/x-g2-lc3" }))
      })()
      return
    }
    recorder?.stop()
    recorder = undefined
  }

  const sendTranscript = async () => {
    const transcript = voice().transcript
    if (voice().phase !== "confirm" || !transcript) return
    const pointer = chat.desk.pointer()
    const session = chat.desk.session()
    if (!pointer || !session) {
      setVoice({ phase: "error", error: "Porter is not ready." })
      return
    }
    setVoice({ phase: "sending" })
    try {
      await ocAt(pointer.host?.base ?? "/oc").prompt(session, pointer.directory, transcript, { messageID: `msg_${ascending()}` })
      setVoice({ phase: "idle" })
      setAwakeUntil(Date.now() + AMBIENT_AWAKE_MS)
    } catch {
      setVoice({ phase: "error", error: "Could not send to Porter." })
    }
  }

  const answerAsk = async () => {
    const ask = asks()[0]
    const pointer = chat.desk.pointer()
    if (!ask || !pointer) return
    const client = ocAt(pointer.host?.base ?? "/oc")
    const choice = ask.options[askSelected()]
    if (!choice) return
    try {
      if (ask.kind === "question") await client.questionReply(ask.id, pointer.directory, [[choice]])
      else await client.permissionReply(ask.id, pointer.directory, choice === "Allow once" ? "once" : "reject")
      setAsks(prev => prev.filter(item => item.id !== ask.id))
    } catch { /* next event refreshes */ }
    setAskArmed(false)
  }

  const handleGesture = (kind: Gesture) => {
    const current = Date.now()
    if (kind === "long-press") { void startRecording(); return }
    if (kind === "long-release") { stopRecording(); return }
    if (kind === "double-tap") {
      if (voice().phase === "recording") stopRecording()
      else void startRecording()
      return
    }
    const vPhase = voice().phase
    if (vPhase === "confirm") {
      if (kind === "tap") void sendTranscript()
      else if (kind === "swipe-forward" || kind === "swipe-back") setVoice({ phase: "idle" })
      return
    }
    if (vPhase === "error") {
      if (kind === "tap" || kind.startsWith("swipe")) setVoice({ phase: "idle" })
      return
    }
    if (vPhase !== "idle") return
    const ask = asks()[0]
    if (ask?.answerable) {
      if (kind === "swipe-forward" || kind === "swipe-back") {
        const step = kind === "swipe-forward" ? 1 : -1
        setAskSelected(prev => (prev + step + ask.options.length) % ask.options.length)
        setAskArmed(false)
        return
      }
      if (kind === "tap") {
        if (askArmed()) void answerAsk()
        else setAskArmed(true)
        return
      }
    }
    const mode = hudState().mode
    if (mode === "needs") {
      const count = openNeeds().records.length
      if ((kind === "swipe-forward" || kind === "swipe-back") && count > 1) {
        const step = kind === "swipe-forward" ? 1 : -1
        setNeedsIndex(prev => (prev + step + count) % count)
      } else if (kind === "tap") {
        setSnoozedNeeds(needsKey())
        setAwakeUntil(0)
      }
      return
    }
    if (mode === "reply") {
      const pages = replyPages(activeReply())
      if (kind === "swipe-forward" && replyPage() < pages - 1) {
        setReplyPage(prev => prev + 1)
        setAwakeUntil(current + REPLY_AWAKE_MS)
      } else if (kind === "swipe-back" && replyPage() > 0) {
        setReplyPage(prev => prev - 1)
        setAwakeUntil(current + REPLY_AWAKE_MS)
      } else if (kind === "tap" || kind === "swipe-forward") {
        setDismissedReply(reply()?.id)
        setAwakeUntil(0)
      }
      return
    }
    if (mode === "ambient" && kind === "tap") { setAwakeUntil(0); return }
    if (mode === "sleep" && kind === "tap") {
      setAwakeUntil(current + (activeReply() ? REPLY_AWAKE_MS : AMBIENT_AWAKE_MS))
    }
  }

  const disconnect = () => {
    generation++
    connectAbort?.abort()
    connectAbort = undefined
    void cfw?.stop()
    cfw = undefined
    link?.disconnect()
    link = undefined
    lastFrameKey = ""
    setConnState("disconnected")
    setStatusLine("Not connected.")
    setLatencyMs(undefined)
  }

  const fail = (error: unknown) => {
    if (error instanceof DOMException && error.name === "AbortError") return
    setStatusLine(pickFailure(document.documentElement.dataset.glassesPickResult) ?? (error instanceof Error ? error.message : "Connection failed."))
    if (error instanceof DOMException && error.name === "SecurityError") setAskFocus(prev => prev + 1)
  }

  // Left temple GATT + firmware detection; leaves the session partial (right only) when the left is missing.
  const finishLeft = async (g2: G2, left: Device | undefined, signal: AbortSignal, current: () => boolean) => {
    let outcome: "connected" | "not-picked" | "failed" = left ? "connected" : "not-picked"
    if (left) {
      setStatusLine("Connecting left temple…")
      outcome = await g2.connectLeft(signal, left).then(() => "connected" as const, () => "failed" as const)
    }
    if (!current()) return
    const hasFaceclaw = outcome === "connected" && await g2.faceclaw().catch(() => false)
    if (!current()) return
    if (hasFaceclaw) {
      const session = new CfwSession(g2)
      await session.start()
      if (!current()) { void session.stop(); return }
      cfw = session
    }
    const result = connectOutcome({ left: outcome, faceclaw: hasFaceclaw })
    lastFrameKey = ""
    setAwakeUntil(Date.now() + AMBIENT_AWAKE_MS)
    setStatusLine(result.status)
    setConnState(result.state)
  }

  // SPA navigation commits after the click handler. Never start a picker
  // after activation expires or the attempt is cancelled.
  const awaitGlassesPage = async (signal: AbortSignal) => {
    const deadline = performance.now() + 750
    while (location.pathname !== "/glasses" && !signal.aborted && performance.now() < deadline) {
      await new Promise<void>(resolve => setTimeout(resolve, 16))
    }
    if (signal.aborted) throw new DOMException("Connection cancelled", "AbortError")
    if (location.pathname !== "/glasses" || navigator.userActivation?.isActive === false)
      throw new DOMException("Click Connect on the Glasses page to continue.", "SecurityError")
  }

  const connect = async () => {
    if (connState() !== "disconnected") return
    if (!G2.supported) { setStatusLine("Bluetooth is unavailable here."); return }
    const mine = ++generation
    connectAbort = new AbortController()
    const signal = connectAbort.signal
    const current = () => mine === generation
    setConnState("connecting")
    setStatusLine("Looking for your glasses…")
    try {
      await awaitGlassesPage(signal)
      // Pick both temples back to back, before any GATT work: each pick needs the click's activation and the
      // Glasses route, and the handshake that follows can outlast both. A missed left pick leaves it partial.
      const right = await G2.pick("R")
      if (!current()) return
      const pair = G2.pairOf(right)
      const left = await G2.pick("L", pair).catch(() => undefined)
      if (!current()) return
      setStatusLine("Connecting right temple…")
      const g2 = await G2.connect(signal, right)
      if (!current()) { g2.disconnect(); return }
      link = g2
      startedAt = Date.now()
      g2.addEventListener("disconnect", () => {
        if (link !== g2) return
        link = undefined
        cfw = undefined
        setConnState("disconnected")
        setStatusLine("Disconnected.")
      }, { once: true })
      g2.addEventListener("left-disconnect", () => {
        if (link !== g2 || connState() !== "connected") return
        void cfw?.stop()
        cfw = undefined
        lastFrameKey = ""
        setConnState("partial")
        setStatusLine("Left temple disconnected. Click again to reconnect it.")
      })
      g2.addEventListener("gesture", (event) => {
        if (link !== g2 || !(event instanceof CustomEvent)) return
        const kind = event.detail as Gesture
        if (kind === "system-exit" || kind === "abnormal-exit") { disconnect(); return }
        handleGesture(kind)
      })
      await finishLeft(g2, left, signal, current)
    } catch (error) {
      if (!current()) return
      disconnect()
      fail(error)
    }
  }

  // A second click from the partial state: pick and connect only the left temple, keeping the right session.
  const connectLeft = async () => {
    const g2 = link
    if (connState() !== "partial" || !g2) return
    const mine = ++generation
    connectAbort = new AbortController()
    const signal = connectAbort.signal
    const current = () => mine === generation && link === g2
    setConnState("connecting")
    setStatusLine("Looking for the left temple…")
    try {
      await awaitGlassesPage(signal)
      const left = await G2.pick("L", g2.pair)
      if (!current()) return
      await finishLeft(g2, left, signal, current)
    } catch (error) {
      if (!current()) return
      setConnState("partial")
      setStatusLine("Right temple connected.")
      fail(error)
    }
  }

  const toggle = () => {
    const state = connState()
    if (state === "disconnected") return void connect()
    if (state === "partial") return void connectLeft()
    disconnect()
  }

  onMount(() => {
    const timer = setInterval(() => setNow(Date.now()), 350)
    onCleanup(() => { clearInterval(timer); disconnect() })
  })

  return {
    connState, statusLine, latencyMs, transcribeMs, scene, askFocus,
    distance, setDistance, spread, setSpread, alignment, setAlignment,
    connect, connectLeft, disconnect, toggle,
  }
}

export type Glasses = ReturnType<typeof createGlasses>
const Ctx = createContext<Glasses>()

export const GlassesProvider = (props: ParentProps) => <Ctx.Provider value={createGlasses()}>{props.children}</Ctx.Provider>

export const useGlasses = () => {
  const value = useContext(Ctx)
  if (!value) throw new Error("GlassesProvider is missing")
  return value
}

export const useGlassesOptional = () => useContext(Ctx)
