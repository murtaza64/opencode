import { createSignal, Show, type JSX } from "solid-js"
import { citedRevision } from "../surface-ref"

/**
 * A cited revision (`&rev=N` on a Surface ref) that is not the one the host serves now: the reader says so and shows
 * the current revision only when the human asks, so an older citation never silently becomes another copy (DD #740).
 * The same revision, or no citation, shows the Surface as usual.
 */
export const CitedRevisionGate = (props: { cited?: number; current?: number; children: JSX.Element }) => {
  const [accepted, setAccepted] = createSignal(false)
  const notice = () => citedRevision(props.cited, props.current)
  return <Show when={notice() && !accepted() ? notice() : undefined} fallback={props.children}>{value =>
    <div class="desk-surface-state" role="status" data-cited-revision={value().kind}>
      <p>{value().text}</p>
      <button class="desk-button" onClick={() => setAccepted(true)}>Open rev {props.current} (current)</button>
    </div>}</Show>
}
