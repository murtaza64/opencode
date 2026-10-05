/* Context visuals shared by the sidebar hover card (donut) and the right
 * info panel (stacked bar). The ring length is the exact latest-turn usage;
 * the colour segments inside it are the estimated composition. Each visual
 * carries a text alternative so the numbers are never only colour. */
import { For, Show } from "solid-js"
import { compactTokens, usageLevel } from "../context-usage"
import { describeSlices, type CompositionSlice } from "../context-composition"

const R = 22
const CIRCUMFERENCE = 2 * Math.PI * R

export function ContextDonut(props: {
  percent: number | null
  tokens: number | null
  slices: CompositionSlice[]
  size?: number
}) {
  const size = () => props.size ?? 56
  const filled = () => props.percent == null ? 1 : Math.min(1, Math.max(0, props.percent / 100))
  const level = () => usageLevel(props.percent)
  const segments = () => {
    const total = props.slices.reduce((sum, s) => sum + s.tokens, 0)
    if (!total) return []
    let offset = 0
    return props.slices.filter((s) => s.tokens > 0).map((s) => {
      const length = (s.tokens / total) * filled() * CIRCUMFERENCE
      const seg = { color: s.color, length, offset }
      offset += length
      return seg
    })
  }
  const label = () => {
    const usage = props.percent == null
      ? props.tokens == null ? "context usage unknown" : `context ${compactTokens(props.tokens)} tokens, limit unknown`
      : `context ${props.percent}% of limit`
    const parts = describeSlices(props.slices)
    return parts ? `${usage}; estimated composition ${parts}` : usage
  }
  return (
    <div class="ctx-donut" classList={{ unknown: props.percent == null, warn: level() === "warn", high: level() === "high" }}
      role="img" aria-label={label()} title={label()}>
      <svg width={size()} height={size()} viewBox="0 0 56 56" aria-hidden="true">
        <circle class="ctx-donut-track" cx="28" cy="28" r={R} />
        <Show when={segments().length} fallback={
          <Show when={props.percent != null}>
            <circle class="ctx-donut-fill" cx="28" cy="28" r={R}
              stroke-dasharray={`${filled() * CIRCUMFERENCE} ${CIRCUMFERENCE}`} />
          </Show>
        }>
          <For each={segments()}>{(seg) => (
            <circle class="ctx-donut-seg" cx="28" cy="28" r={R} style={{ stroke: seg.color }}
              stroke-dasharray={`${Math.max(0, seg.length - 1.5)} ${CIRCUMFERENCE}`}
              stroke-dashoffset={-seg.offset} />
          )}</For>
        </Show>
      </svg>
      <span class="ctx-donut-label">{props.percent == null ? "?" : `${props.percent}%`}</span>
    </div>
  )
}

export function CompositionBar(props: { slices: CompositionSlice[]; caption?: string }) {
  const visible = () => props.slices.filter((s) => s.tokens > 0)
  return (
    <Show when={visible().length}>
      <div class="ctx-bar" role="img" aria-label={`estimated context composition: ${describeSlices(props.slices)}`}>
        <For each={visible()}>{(s) => (
          <span class="ctx-bar-seg" style={{ "flex-grow": String(Math.max(s.share, 0.01)), background: s.color }} />
        )}</For>
      </div>
      <ul class="ctx-legend" aria-label="estimated context composition">
        <For each={props.slices}>{(s) => (
          <li>
            <span class="ctx-swatch" style={{ background: s.color }} aria-hidden="true" />
            <span class="ctx-legend-label">{s.label}</span>
            <span class="ctx-legend-num mono">{compactTokens(s.tokens)}</span>
            <span class="ctx-legend-pct mono">{Math.round(s.share * 100)}%</span>
          </li>
        )}</For>
      </ul>
      <Show when={props.caption}><div class="ctx-caption">{props.caption}</div></Show>
    </Show>
  )
}

export function CompositionDots(props: { slices: CompositionSlice[] }) {
  return (
    <ul class="ctx-dots" aria-label="estimated context composition">
      <For each={props.slices.filter((s) => s.tokens > 0)}>{(s) => (
        <li title={`${s.label}: ~${compactTokens(s.tokens)} tokens (${Math.round(s.share * 100)}%)`}>
          <span class="ctx-swatch" style={{ background: s.color }} aria-hidden="true" />
          <span>{s.short}</span>
          <span class="mono">{Math.round(s.share * 100)}%</span>
        </li>
      )}</For>
    </ul>
  )
}
