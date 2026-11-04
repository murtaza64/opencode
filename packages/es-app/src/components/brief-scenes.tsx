import { createContext, For, Show, useContext, type Accessor } from "solid-js"
import type { AttentionRecord } from "../attention"
import type { BriefAction, BriefV1 } from "../brief-v1"
import "./brief-scenes.css"

/** The option the figure and consequence line describe: the hovered or focused one, else the recommendation.
 * `replay` counts requests to play the motion again; the figure always rests on its end state. */
export type BriefPlaybackState = {
  focus: Accessor<string | undefined>
  hovered: Accessor<string | undefined>
  replay: Accessor<number>
  parts: Accessor<Record<string, string[]>>
  preview: (id?: string) => void
  again: () => void
}
export const BriefPlayback = createContext<BriefPlaybackState>()
export const useBriefPlayback = () => useContext(BriefPlayback)

type Part = (part: string) => { on: boolean; dim: boolean; rec: boolean; mapped: boolean; label?: string }

// A figure rests on the outcome, so it reads without hover, on touch and with reduced motion. Hovering or focusing an
// option, or tapping the figure, remounts it with `animate` to replay the motion into that same end state.
export const BriefFigure = (props: { brief: BriefV1; record: AttentionRecord }) => {
  const playback = useBriefPlayback()
  const action = () => props.brief.action
  const scene = () => action()?.verb === "post" && action()?.to?.slack ? "slack" : ["plug", "deploy", "open-prs", "restart", "grant"].includes(action()?.verb ?? "") ? action()?.verb : undefined
  const part: Part = name => {
    const parts = playback?.parts() ?? {}
    const hovered = playback?.hovered()
    const owners = props.record.options.filter(option => parts[option.id]?.includes(name))
    return {
      on: !!hovered && !!parts[hovered]?.includes(name),
      dim: !!hovered && !parts[hovered]?.includes(name),
      rec: owners.some(option => option.id === props.record.recommendation),
      mapped: owners.length > 0,
      label: owners.map(option => option.label).join(" · ") || undefined,
    }
  }
  return <Show when={props.brief.metric || scene()}>
    <Show when={{ run: playback?.replay() ?? 0 }} keyed>{replay =>
      <div class="brief-figure-frame" classList={{ animate: replay.run > 0 }} onClick={() => playback?.again()}>
        <Show when={props.brief.metric} fallback={<Show when={scene()}>{name => {
          const state = () => part("action")
          return <div class={`brief-figure brief-act brief-act-${name()}`} classList={{ on: state().on, dim: state().dim, [`go-${playback?.focus() ?? ""}`]: !!playback?.focus() }} role="img" aria-label={`${action()?.verb} ${action()?.to?.slack ?? action()?.repo ?? ""}`}>
            <Scene action={action()!} scene={name()} focus={playback?.focus()} parts={playback?.parts() ?? {}} />
          </div>
        }}</Show>}>{metric => <Threshold metric={metric()} part={part} />}</Show>
      </div>}</Show>
  </Show>
}

const Scene = (props: { action: BriefAction; scene: string; focus?: string; parts: Record<string, string[]> }) => {
  // A grant rests open only when the option in focus is the grant; its key shows which kind.
  const granted = () => !!props.focus && !!props.parts[props.focus]?.includes("action")
  return <>
    <Show when={props.scene === "slack"}><div class="brief-slack"><div class="brief-slack-side"><b>Slack</b><span class="brief-slack-channel">{props.action.to?.slack}</span></div>
      <div class="brief-slack-main"><b>{props.action.to?.slack}</b><div class="brief-slack-message"><span class="brief-slack-avatar">{props.action.as?.slice(0, 1).toUpperCase() ?? "Y"}</span><span><span class="brief-slack-from"><b>{props.action.as ?? "You"}</b><span class="brief-slack-draft">Draft</span></span><span dir="auto">{props.action.text ?? "Draft message"}</span></span></div></div>
      <div class="brief-envelope" aria-hidden="true">✉</div></div></Show>
    <Show when={props.scene === "plug"}><svg viewBox="0 0 420 160" class="brief-plug" aria-hidden="true"><g class="laptop"><rect x="14" y="40" width="120" height="76" rx="6"/><rect x="4" y="116" width="140" height="8" rx="4"/><text x="74" y="84" text-anchor="middle">{props.action.from ?? "Laptop"}</text></g><path class="cable" d="M134 104 C230 104 250 158 320 158 C345 158 355 162 355 170"/><g class="plughead"><rect x="349" y="138" width="12" height="16" rx="2"/><rect x="351.5" y="132" width="7" height="7" rx="1.5"/></g><g class="phone"><rect x="320" y="4" width="70" height="124" rx="12"/><rect x="326" y="16" width="58" height="96" rx="4" class="screen"/><text x="355" y="58" text-anchor="middle">{props.action.phone ?? "Phone"}</text><g class="install"><rect x="332" y="72" width="46" height="5" rx="2.5"/><rect class="fill" x="332" y="72" width="46" height="5" rx="2.5"/><text x="355" y="90" text-anchor="middle">{props.action.version ?? "installed"}</text></g></g></svg></Show>
    <Show when={props.scene === "deploy"}><svg viewBox="0 0 420 150" class="brief-deploy" aria-hidden="true"><path class="rail" d="M10 112 H410 M10 118 H410"/><g class="platform"><rect x="18" y="118" width="120" height="10" rx="2"/><text x="78" y="142" text-anchor="middle">stage · {props.action.soak ?? "ready"}</text></g><g class="platform"><rect x="282" y="118" width="120" height="10" rx="2"/><text x="342" y="142" text-anchor="middle">production</text></g><g class="gate"><rect x="196" y="58" width="6" height="56"/><rect class="arm" x="202" y="62" width="58" height="7" rx="3"/></g><g class="package"><rect x="48" y="74" width="62" height="38" rx="5"/><text x="79" y="100" text-anchor="middle">{props.action.build ?? "build"}</text></g><text x="402" y="34" text-anchor="end">{props.action.watch ? `watch ${props.action.watch}` : ""}</text></svg></Show>
    <Show when={props.scene === "open-prs"}><svg viewBox="0 0 420 150" class="brief-prs" aria-hidden="true"><path class="tray" d="M250 70 V128 H400 V70"/><text x="325" y="144" text-anchor="middle">{props.action.repo ?? "repository"} · drafts</text><For each={(props.action.prs ?? ["D1", "D2"]).slice(0, 2)}>{(pr, index) => <g class={`sheet sheet-${index()}`}><rect x={30 + index() * 16} y={30 + index() * 10} width="82" height="100" rx="4"/><text x={71 + index() * 16} y={60 + index() * 10} text-anchor="middle">{pr}</text><path d={`M${44 + index() * 16} ${78 + index() * 10} h54 M${44 + index() * 16} ${90 + index() * 10} h40`}/></g>}</For><text class="ci" x="325" y="40" text-anchor="middle">CI · build · test</text><text x="160" y="22" text-anchor="middle">no deploy</text></svg></Show>
    <Show when={props.scene === "restart"}><div class="brief-restart"><div class="brief-restart-window"><div class="brief-restart-bar">● ● ●　{props.action.view ?? "View"}</div><div class="brief-restart-body"><div class="brief-login">Sign in<span/><span/></div><div class="brief-spinner"/></div></div><div class="brief-restart-keeps"><For each={props.action.keeps ?? []}>{item => <span>✓ {item}</span>}</For><Show when={props.action.lose}><span class="brief-lose">↺ {props.action.lose}</span></Show></div></div></Show>
    <Show when={props.scene === "grant"}><div class="brief-grant" classList={{ granted: granted() }}><code>{props.action.cmd ?? "Grant access"}</code><svg viewBox="0 0 60 60" aria-hidden="true"><rect x="10" y="26" width="40" height="30" rx="5"/><path class="shackle" d="M18 26 V18 a12 12 0 0 1 24 0 V26"/></svg><div class="brief-grant-keys"><span class="once">×1 · once</span><span class="always">∞ · this worker</span></div></div></Show>
  </>
}

const Threshold = (props: { metric: NonNullable<BriefV1["metric"]>; part: Part }) => {
  const values = () => [...props.metric.series, ...(props.metric.baseline ?? []), ...(props.metric.limit === undefined ? [] : [props.metric.limit])]
  const min = () => Math.min(...values())
  const range = () => Math.max(...values()) - min() || 1
  const x = (index: number, size: number) => 18 + index * 384 / (size - 1)
  const y = (value: number) => 112 - (value - min()) * 84 / range()
  const line = (series: number[]) => series.map((value, index) => `${index ? "L" : "M"}${x(index, series.length).toFixed(1)} ${y(value).toFixed(1)}`).join(" ")
  const unit = () => props.metric.unit ? `${/^[%°]/.test(props.metric.unit) ? "" : " "}${props.metric.unit}` : ""
  // Labels are HTML over the chart so they keep their CSS size at any width. Each line ends in its option's name;
  // when the two ends are close, the lower one sits beneath its line instead of above it.
  const ends = () => {
    const series = y(props.metric.series.at(-1)!)
    const baseline = props.metric.baseline ? y(props.metric.baseline.at(-1)!) : undefined
    const close = baseline !== undefined && Math.abs(series - baseline) < 24
    return { series: { at: series, below: close && series > baseline! }, baseline: baseline === undefined ? undefined : { at: baseline, below: close && baseline > series } }
  }
  const lines = () => [...(props.metric.baseline ? [{ name: "baseline" as const, values: props.metric.baseline }] : []), { name: "series" as const, values: props.metric.series }]
  const top = (value: number) => `${(value / 130 * 100).toFixed(2)}%`
  return <div class="brief-figure brief-threshold" role="img" aria-label={props.metric.label ?? "Metric over time"}>
    <svg viewBox="0 0 420 130" aria-hidden="true">
      <Show when={props.metric.limit !== undefined}><line class="limit" x1="18" x2="402" y1={y(props.metric.limit!)} y2={y(props.metric.limit!)} /></Show>
      <For each={lines()}>{item => {
        const state = () => props.part(item.name)
        return <g class={`line line-${item.name}`} data-part={item.name} classList={{ on: state().on, dim: state().dim, rec: state().rec, other: state().mapped && !state().rec }}>
          <path d={line(item.values)} pathLength="1" />
        </g>
      }}</For>
    </svg>
    <Show when={props.metric.limit !== undefined}><span class="brief-threshold-label limit-label" style={{ top: top(y(props.metric.limit!)) }}>limit {props.metric.limit}{unit()}</span></Show>
    <For each={lines()}>{item => {
      const state = () => props.part(item.name)
      const end = () => ends()[item.name]!
      return <Show when={state().label}>{label => <span class="brief-threshold-label end" classList={{ below: end().below, dim: state().dim, rec: state().rec }} style={{ top: top(end().at) }} title={label()}><bdi dir="auto">{label()}</bdi></span>}</Show>
    }}</For>
  </div>
}
