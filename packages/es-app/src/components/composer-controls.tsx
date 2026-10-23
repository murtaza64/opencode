import { Show } from "solid-js"
import { Markdown } from "@opencode-ai/session-ui/markdown"
import type { Composer } from "../composer"
import { ComposerImages } from "./composer-images"

export const ComposerResults = (props: { composer: Composer; connected: boolean }) => {
  // Outgoing inputs and their delivery state render as bubbles in the transcript
  // (components/outgoing.tsx); only the Aside answer lives here.
  const state = props.composer.state
  return (
    <div class="composer-results" data-composer-controls>
      <Show when={state.asideRequest}>
        {(aside) => (
          <section class="aside-result" aria-label="Aside result">
            <div class="composer-actions">
              <b>Aside</b>
              <span role="status" class="dim">
                {aside().status}
              </span>
              <Show when={aside().status === "running" || aside().status === "unknown"}>
                <button onClick={() => props.composer.cancelAside()}>Cancel aside</button>
              </Show>
              <button onClick={() => props.composer.closeAside()}>Close aside</button>
            </div>
            <p class="aside-question" dir="auto">
              {aside().question}
            </p>
            <ComposerImages images={aside().images} />
            <Show when={aside().snapshot}>
              {(snapshot) => (
                <div class="dim aside-snapshot">
                  Snapshot {new Date(snapshot().capturedAt).toLocaleString()} · {snapshot().activity.status}
                  <span>
                    Through <bdi>{snapshot().throughMessageID ?? "start of conversation"}</bdi>;{" "}
                    {snapshot().excludedMessageCount} messages excluded
                  </span>
                </div>
              )}
            </Show>
            <Show when={aside().error}>
              <div role="alert" class="err">
                {aside().error}
              </div>
            </Show>
            <Show when={aside().text}>
              <div class="aside-answer" dir="auto" tabIndex={0}>
                <Markdown text={aside().text!} cacheKey={`aside:${aside().requestID}`} />
              </div>
            </Show>
          </section>
        )}
      </Show>
    </div>
  )
}
