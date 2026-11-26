/* The reader's BuildingHub share line (DD #782, was the reserved slot Laptop2649): only from a recorded deploy receipt.
 * A copy built from this revision gets its verified BuildingHub link and Copy link; an older or different copy is named
 * without a link; otherwise "Not on BuildingHub". Never a Work route dressed as the BuildingHub copy. */
import { createSignal, Show } from "solid-js"
import { buildinghubShare, type Surface } from "../surfaces"

export const BuildingHubSlot = (props: { surface?: Pick<Surface, "buildinghub" | "revision"> }) => {
  const share = () => props.surface ? buildinghubShare(props.surface) : undefined
  const [copied, setCopied] = createSignal(false)
  const copy = async (url: string) => {
    const ok = await navigator.clipboard?.writeText(url).then(() => true, () => false)
    setCopied(!!ok)
    if (ok) setTimeout(() => setCopied(false), 1500)
  }
  return <Show when={share()}>{value =>
    <div class="surface-buildinghub" data-slot="buildinghub" data-copy={value().state}>
      <Show when={value().url} fallback={<span class="surface-buildinghub-note">{value().text}</span>}>{url => <>
        <a class="surface-head-link" href={url()} target="_blank" rel="noopener noreferrer">{value().text}</a>
        <button type="button" class="link-button" onClick={() => void copy(url())}>{copied() ? "Copied" : "Copy link"}</button>
      </>}</Show>
    </div>}</Show>
}
