import { createEffect, onMount } from "solid-js"
import { AppHeader } from "../components/native-header"
import { PANEL } from "../glasses/cfw"
import { paintEye } from "../glasses/cfw-scene"
import { useGlasses } from "../glasses/controller"
import "./glasses.css"

export default function GlassesPage() {
  const glasses = useGlasses()
  let leftCanvas: HTMLCanvasElement | undefined
  let rightCanvas: HTMLCanvasElement | undefined
  let connectButton: HTMLButtonElement | undefined

  createEffect(() => {
    const calls = glasses.scene()
    if (leftCanvas) paintEye(leftCanvas, calls, false)
    if (rightCanvas) paintEye(rightCanvas, calls, true)
  })
  // The title-bar toggle lands here when a connect needs a click on this page.
  createEffect(() => { if (glasses.askFocus()) connectButton?.focus() })
  onMount(() => { if (glasses.askFocus()) connectButton?.focus() })

  const state = glasses.connState
  return (
    <main class="page glasses-page">
      <AppHeader><h1>Glasses</h1></AppHeader>
      <div class="glasses-bar">
        <button
          ref={connectButton}
          type="button"
          class="glasses-connect"
          data-connected={state() === "connected" ? "true" : undefined}
          onClick={() => glasses.toggle()}
        >
          {state() === "disconnected" ? "Connect" : state() === "connecting" ? "Cancel" : "Disconnect"}
        </button>
        <span class="glasses-status" role="status">{glasses.statusLine()}</span>
        <span class="glasses-latency" dir="ltr">
          {glasses.latencyMs() !== undefined ? `lens ${glasses.latencyMs()} ms` : ""}
          {glasses.latencyMs() !== undefined && glasses.transcribeMs() !== undefined ? " · " : ""}
          {glasses.transcribeMs() !== undefined ? `voice ${glasses.transcribeMs()} ms` : ""}
        </span>
      </div>
      <div class="glasses-lenses">
        <figure class="glasses-lens">
          <figcaption>Left lens</figcaption>
          <canvas ref={leftCanvas} width={PANEL.width} height={PANEL.height} />
        </figure>
        <figure class="glasses-lens">
          <figcaption>Right lens</figcaption>
          <canvas ref={rightCanvas} width={PANEL.width} height={PANEL.height} />
        </figure>
      </div>
      <div class="glasses-controls">
        <label class="glasses-slider">
          <span>Distance ({glasses.distance()})</span>
          <input type="range" min={-40} max={40} step={2} value={glasses.distance()} onInput={event => glasses.setDistance(Number(event.currentTarget.value))} />
        </label>
        <label class="glasses-slider">
          <span>Layer spread ({glasses.spread()})</span>
          <input type="range" min={0} max={20} step={2} value={glasses.spread()} onInput={event => glasses.setSpread(Number(event.currentTarget.value))} />
        </label>
      </div>
    </main>
  )
}
