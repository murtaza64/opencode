import { For, Show } from "solid-js"
import type { InputImage } from "../api"

export const ComposerImages = (props: { images?: readonly InputImage[] }) => (
  <Show when={props.images?.length}>
    <div role="group" aria-label="Attached images">
      <div class="dim">
        {props.images!.length} {props.images!.length === 1 ? "image" : "images"}
      </div>
      <div class="attachments">
        <For each={props.images}>
          {(image, index) => (
            <span class="attachment-chip" title={image.filename || `Image ${index() + 1}`}>
              <Show when={image.url.startsWith(`data:${image.mime};base64,`)}>
                <img
                  src={image.url}
                  alt={image.filename || `Image ${index() + 1}`}
                  loading="lazy"
                  style={{ "max-width": "80px", "object-fit": "contain" }}
                />
              </Show>
              <bdi>{image.filename?.slice(0, 24) || `Image ${index() + 1}`}</bdi>
            </span>
          )}
        </For>
      </div>
    </div>
  </Show>
)
