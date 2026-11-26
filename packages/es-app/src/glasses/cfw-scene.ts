import { clear, eyeShift, PANEL, rect, text, type Draw } from "./cfw"
import { textWidth } from "./lens-font"
import { lensLines, replyLines, replyPages, sanitizeLensText, toolVerb, type HudState } from "./live-hud"

const layers = { far: -2, base: 0, raised: 1, card: 2, focus: 3 }
export const DEFAULT_DEPTH = { distance: 0, spread: 8 }
export const CENTER_X = PANEL.width / 2
export const CENTER_Y = PANEL.height / 2
export const layerDepth = (layer: keyof typeof layers, depth = DEFAULT_DEPTH) =>
  Math.max(-62, Math.min(62, Math.round((depth.distance + layers[layer] * depth.spread) / 2) * 2))

export const buildScene = (state: HudState, now: number) => {
  const calls: Draw[] = [clear()]
  const at = (layer: keyof typeof layers) => layerDepth(layer, state.depth)
  const label = (value: string, x: number, y: number, layer: keyof typeof layers, brightness = 15) =>
    calls.push(text({ x, y, value: sanitizeLensText(value), depth: at(layer), brightness }))
  // Centred by the firmware font's real advance widths, so it sits on the same axis as the shapes around it.
  const center = (value: string, y: number, layer: keyof typeof layers, brightness = 15) => {
    const clean = sanitizeLensText(value)
    label(clean, Math.max(0, Math.round(CENTER_X - textWidth(clean) / 2)), y, layer, brightness)
  }
  const block = (value: string, y: number, count: number, layer: keyof typeof layers, brightness = 15) =>
    lensLines(value).slice(0, count).forEach((line, i) => label(line, 76, y + i * 30, layer, brightness))
  const card = (title: string, aside = "") => {
    calls.push(rect({ x: 48, y: 88, w: 544, h: 304, r: 16, depth: at("card") }))
    label(title, 76, 106, "focus")
    if (aside) label(aside, 564 - Math.round(textWidth(aside)), 106, "card", 7)
    calls.push(rect({ x: 76, y: 140, w: 488, h: 2, fill: 6, border: 16, depth: at("card") }))
  }
  const dots = (y: number) => [286, 320, 354].forEach((x, i) => {
    const active = i === Math.floor(now / 350) % 3
    // One layer for the whole row: per-dot depth would shift dots by different amounts per lens and break centering.
    calls.push(rect({ x: x - 10, y, w: 20, h: 20, r: 10, fill: active ? 15 : 3, border: active ? 15 : 5, depth: at("raised") }))
  })
  if (state.mode === "ambient") {
    center(state.queueKnown ? "All clear" : "Needs you unavailable", 222, "far", 9)
    center("Double-tap to talk", 292, "far", 6)
  }
  if (state.mode === "thinking") {
    dots(214)
    center(toolVerb(state.tool), 256, "far", 9)
  }
  if (state.mode === "needs" && state.needs) {
    card("NEEDS YOU", state.needsCount > 1 ? `${state.needsIndex + 1} of ${state.needsCount}` : "")
    block(state.needs.title, 156, 2, "focus")
    block(state.needs.context, 222, 2, "card", 8)
    label(state.needsCount > 1 ? "Answer on the Mac    Swipe for next" : "Answer on the Mac", 76, 344, "raised", 6)
  }
  if (state.mode === "reply") {
    label(`Porter   ${state.page + 1}/${replyPages(state.reply)}`, 76, 76, "far", 8)
    replyLines(state.reply, state.page).forEach((line, i) => label(line, 76, 112 + i * 30, "base"))
    label("Swipe to turn page    Tap to dismiss", 76, 372, "raised", 6)
  }
  if (state.mode === "ask" && state.ask) {
    card(state.ask.kind === "permission" ? "PORTER WANTS TO" : "PORTER ASKS")
    block(state.ask.title, 156, 1, "focus")
    block(state.ask.detail, 190, 2, "card", 9)
    if (state.ask.answerable) state.ask.options.forEach((option, i) => {
      const selected = i === state.askSelected
      const y = 250 + i * 36
      if (selected) calls.push(rect({ x: 68, y: y - 6, w: 504, h: 34, r: 8, fill: 3, border: state.askArmed ? 15 : 16, depth: at("focus") }))
      label(option, 84, y, selected ? "focus" : "card", selected ? 15 : 8)
    })
    label(!state.ask.answerable ? "Answer on the Mac" : state.askArmed ? "Tap again to confirm" : "Swipe to choose    Tap to select", 76, 362, "raised", 6)
  }
  if (state.mode === "voice") {
    const voice = state.voice
    if (voice.phase === "confirm") {
      card("SEND THIS?")
      block(voice.transcript ?? "", 156, 4, "raised")
      label("Tap to send    Swipe to cancel", 76, 344, "focus", 10)
    }
    if (voice.phase === "recording") {
      const pulse = [24, 30, 36, 30][Math.floor(now / 350) % 4]!
      // Ring and dot share a layer so the dot stays centered in the ring on both lenses.
      calls.push(rect({ x: 272, y: 144, w: 96, h: 96, r: 48, depth: at("focus") }), rect({ x: 320 - pulse / 2, y: 192 - pulse / 2, w: pulse, h: pulse, r: pulse / 2, fill: 15, depth: at("focus") }))
      center("Listening", 266, "raised")
      center("Release or double-tap when done", 306, "base", 7)
    }
    if (voice.phase === "transcribing" || voice.phase === "sending") {
      dots(220)
      center(voice.phase === "sending" ? "Sending" : "Transcribing", 262, "base", 9)
    }
    if (voice.phase === "error") {
      lensLines(voice.error ?? "Try again").slice(0, 3).forEach((line, i) => center(line, 190 + i * 30, "base"))
      center("Tap to dismiss", 300, "base", 7)
    }
  }
  if (state.mode === "align") {
    // Every layer gets a ring and a label on the panel centre; at the right settings they fuse into one target.
    const order = ["far", "base", "raised", "card", "focus"] as const
    order.forEach((layer, i) => {
      const size = 200 - i * 36
      calls.push(rect({ x: CENTER_X - size / 2, y: CENTER_Y - size / 2, w: size, h: size, r: size / 2, border: 6 + i * 2, depth: at(layer) }))
    })
    calls.push(rect({ x: CENTER_X - 1, y: 60, w: 2, h: 360, fill: 4, border: 16, depth: at("base") }))
    calls.push(rect({ x: 60, y: CENTER_Y - 1, w: 520, h: 2, fill: 4, border: 16, depth: at("base") }))
    center("Centered?", 384, "focus")
  }
  return calls
}

export const paintEye = (canvas: HTMLCanvasElement, calls: Draw[], right: boolean) => {
  const ctx = canvas.getContext("2d")
  if (!ctx) return
  const green = (level: number) => `rgba(120, 255, 150, ${Math.max(0, Math.min(15, level)) / 15})`
  ctx.fillStyle = "#000"
  ctx.fillRect(0, 0, PANEL.width, PANEL.height)
  for (const call of calls) {
    const draw = call.meta
    if (draw.kind === "clear") continue
    const x = draw.x + eyeShift(draw.depth, right)
    if (draw.kind === "rect") {
      ctx.beginPath()
      ctx.roundRect(x, draw.y, draw.w, draw.h, draw.r)
      if (draw.fill) { ctx.fillStyle = green(draw.fill); ctx.fill() }
      if (draw.border <= 15) { ctx.strokeStyle = green(draw.border); ctx.lineWidth = 2; ctx.stroke() }
      continue
    }
    ctx.fillStyle = green(draw.brightness)
    ctx.font = "20px system-ui, sans-serif"
    ctx.textBaseline = "top"
    // Squeeze the browser font to the firmware font's width so the preview shows real centring and wrapping.
    const ratio = textWidth(draw.value) / Math.max(1, ctx.measureText(draw.value).width)
    ctx.save()
    ctx.translate(x, draw.y)
    ctx.scale(ratio, 1)
    ctx.fillText(draw.value, 0, 0)
    ctx.restore()
  }
}
