/* What a Surface is, as one small composite glyph (NAV-19): the author's form (document, dashboard, prototype) as
 * the base, with static corner accents: interactive (a pointer, bottom corner) and live (a pulse line, top corner).
 * Untagged Surfaces get a neutral window outline: nothing is inferred from the URL, path or purpose. Accents are not dots,
 * so they never read as unread/busy status. */
import { For, Show } from "solid-js"
import { surfaceTags, type Accent, type Form } from "../surface-tags"

const BASE: Record<Form, string[]> = {
  // A page with a folded corner and two lines of text.
  document: ["M3.5 1.75h5.75l3.25 3.25v9.25h-9z", "M9.25 1.75v3.25h3.25", "M5.5 8h5M5.5 10.5h3.5"],
  // A panel with three rising bars.
  dashboard: ["M1.75 2.75h12.5v10.5h-12.5z", "M4.75 10.5v-2M8 10.5v-4.5M11.25 10.5v-6"],
  // A device frame with two placeholder blocks.
  prototype: ["M2.25 2.25h11.5v11.5h-11.5z", "M2.25 5h11.5", "M4.5 7.25h3v4h-3zM9.25 7.25h2.25M9.25 9.5h2.25"],
}
// Each accent sits in its own corner over a knockout, so both can show and the base stays legible.
const ACCENT: Record<Accent, { d: string; box: { x: number; y: number } }> = {
  interactive: { d: "M10.25 9.25l4.5 2.25-1.9.65-.65 1.9z", box: { x: 8.75, y: 8.75 } },
  live: { d: "M9.5 4h1.25l.9-2.25 1.25 3.5 1-2.25h1.1", box: { x: 8.75, y: 0 } },
}

export const SurfaceGlyph = (props: { surface: object }) => {
  const tags = () => surfaceTags(props.surface)
  // Untagged: a plain window outline. It says "a surface" and nothing about its form; an empty square read as a
  // checkbox or a missing image at row size.
  return <Show when={tags().form} fallback={
    <svg class="nav-kind surface-glyph surface-glyph-generic" viewBox="0 0 16 16" aria-hidden="true">
      <g fill="none" stroke="currentColor" stroke-width="1.25" stroke-linejoin="round" stroke-linecap="round">
        <rect x="2.25" y="3" width="11.5" height="10" rx="1.5" /><path d="M2.25 6h11.5" /><path d="M4 4.5h.01M5.5 4.5h.01" />
      </g>
    </svg>}>{form =>
    <svg class="nav-kind surface-glyph" viewBox="0 0 16 16" aria-hidden="true" data-form={form()} data-accents={tags().accents.join(" ") || undefined}>
      <g fill="none" stroke="currentColor" stroke-width="1.25" stroke-linejoin="round" stroke-linecap="round">
        <For each={BASE[form()]}>{d => <path d={d} />}</For>
      </g>
      <For each={tags().accents}>{accent => <>
        <rect class="surface-glyph-knockout" x={ACCENT[accent].box.x} y={ACCENT[accent].box.y} width="7.25" height="7.25" rx="1.5" />
        <path class="surface-glyph-accent" data-accent={accent} d={ACCENT[accent].d} fill="none" stroke-width="1.25" stroke-linejoin="round" stroke-linecap="round" />
      </>}</For>
    </svg>}
  </Show>
}
