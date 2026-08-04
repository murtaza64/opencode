/* Review brief: the AI-generated "what to check before landing" for a
 * review-gated ticket. Rendered on the thread card (replacing the digest)
 * and expanded under the queue's review item. Same visual budget as the
 * digest box. */
import { For, Show } from "solid-js"
import { ago, linkUrl } from "../state"

export default function BriefBox(props: {
  brief: any
  onRegen?: () => void
  regenerating?: boolean
}) {
  const result = () => props.brief?.result ?? {}
  return (
    <div class="digest brief">
      {result().what_was_done}
      <Show when={result().verify_steps?.length}>
        <ul class="verify">
          <For each={result().verify_steps}>{(s: string) => <li>{s}</li>}</For>
        </ul>
      </Show>
      <Show when={result().prs?.length}>
        <ul class="brief-prs">
          <For each={result().prs}>{(p: string) => <li>{p}</li>}</For>
        </ul>
      </Show>
      <Show when={result().risks?.length}>
        <ul class="risks">
          <For each={result().risks}>{(r: string) => <li>{r}</li>}</For>
        </ul>
      </Show>
      <Show when={result().links?.length}>
        <div class="brief-links">
          <For each={result().links}>
            {(url: string) => (
              <a href={linkUrl(url)} target="_blank" title={url}>
                {url.replace(/^https?:\/\//, "").slice(0, 60)}
              </a>
            )}
          </For>
        </div>
      </Show>
      <div class="meta">
        brief · {ago(props.brief.generated_at * 1000)} · {props.brief.model}
        <Show when={props.onRegen}>
          {" "}
          <button onClick={props.onRegen} disabled={props.regenerating}>
            {props.regenerating ? "…" : "regenerate"}
          </button>
        </Show>
      </div>
    </div>
  )
}
