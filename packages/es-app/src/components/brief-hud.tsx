/* A brief as the glasses would show it: one 576x288 page at a time, one green, monospace (brief-view hudPages).
 * A preview only: it reaches no device, and paging is reading, never an answer. */
import { createSignal, For, Show } from "solid-js"
import { HUD, type HudPage } from "../brief-view"

export const BriefHud = (props: { pages: HudPage[] }) => {
  const [index, setIndex] = createSignal(0)
  const page = () => props.pages[Math.min(index(), props.pages.length - 1)]!
  return <figure class="brief-hud" aria-label="Glasses preview">
    <div class="brief-hud-frame" dir="ltr" role="img" aria-label={`Page ${page().index} of ${page().total}: ${[page().title, ...page().lines.map(line => line.text)].join(". ")}`}
      style={{ "aspect-ratio": `${HUD.width} / ${HUD.height}` }}>
      <div class="brief-hud-title">{page().title}</div>
      <For each={page().lines}>{line => <div class="brief-hud-line" data-node={line.node}>{line.text}</div>}</For>
      <div class="brief-hud-pager">{page().pager}</div>
    </div>
    <figcaption class="home-source">Glasses preview, {HUD.width}×{HUD.height}; not connected to a device.
      <Show when={props.pages.length > 1}> <button type="button" class="desk-link-button" disabled={index() === 0} onClick={() => setIndex(index() - 1)}>Previous</button>
        {" "}<button type="button" class="desk-link-button" disabled={index() >= props.pages.length - 1} onClick={() => setIndex(index() + 1)}>Next</button></Show>
    </figcaption>
  </figure>
}
