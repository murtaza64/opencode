import { Show } from "solid-js"
import type { FooterContext, FooterCost } from "../composer-meta"

// Composer footer meta (ux-feel contract); values come from composer-meta.ts.
export const ComposerMeta = (props: { context?: FooterContext; cost: FooterCost }) => <>
  <Show when={props.context}>{(context) =>
    <span class="composer-ctx" data-level={context().level || undefined} title={context().title} aria-label={context().title}><bdi>{context().text}</bdi></span>}</Show>
  <span class="composer-cost" data-decade={props.cost.known ? props.cost.decade : undefined} data-unknown={props.cost.known ? undefined : ""}
    title={props.cost.known ? `Session cost, estimate: ${props.cost.text.slice(1)}` : "Session cost unknown: no reply has reported a cost yet."}
    aria-label={props.cost.known ? `Session cost, estimate ${props.cost.text.slice(1)}` : "Session cost unknown"}><bdi>{props.cost.text}</bdi></span>
</>
