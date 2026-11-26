import { Show } from "solid-js"
import { ago } from "../state"
import type { AttentionRecord } from "../attention"
import type { BriefV1 } from "../brief-v1"
import { workstreamFor } from "../workstreams"
import { BriefFigure } from "./brief-scenes"

export const BriefDescent = (props: { record: AttentionRecord; brief: BriefV1 }) => {
  const stream = () => workstreamFor(props.record.editspace, props.record.lane)
  return <section class="brief-v1" style={{ "--brief-ws": `var(${stream().colourVar})` }} aria-label="Decision brief">
    <div class="brief-v1-head"><span class="brief-v1-workstream"><span class="brief-v1-glyph" aria-hidden="true">{stream().glyph}</span><bdi dir="auto">{stream().name}</bdi></span>
      <span class="brief-v1-who"><bdi dir="auto">{props.record.lane || props.record.editspace}</bdi> · <time dateTime={new Date(props.record.created_at).toISOString()}>{ago(props.record.created_at)}</time></span></div>
    <div class="brief-v1-levels">
      <Show when={props.brief.thing}><div class="brief-v1-level"><span aria-hidden="true" /><bdi dir="auto">{props.brief.thing}</bdi></div></Show>
      <Show when={props.brief.happened}><div class="brief-v1-level"><span aria-hidden="true" /><bdi dir="auto">{props.brief.happened}</bdi></div></Show>
    </div>
    <Show when={props.brief.key}><p class="brief-v1-key" dir="auto">{props.brief.key}</p></Show>
    <h3 class="brief-v1-question" dir="auto">{props.record.title}</h3>
    <BriefFigure brief={props.brief} record={props.record} />
  </section>
}
