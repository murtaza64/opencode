import { createSignal, For, onCleanup, Show } from "solid-js"
import { backendIssues, backendStatus } from "../backend-status"
import "./backend-status.css"

const ago = (since: number) => {
  const seconds = Math.max(0, Math.round((Date.now() - since) / 1000))
  return seconds < 60 ? `${seconds}s` : `${Math.round(seconds / 60)}m`
}

/** Fixed-size header slot: empty when healthy, a static dot while background reads fail. */
export const BackendStatus = () => {
  const [open, setOpen] = createSignal(false)
  const label = () => backendStatus() === "problem" ? "Some data could not be read" : "Updating — showing last known data"
  let root: HTMLSpanElement | undefined
  const close = (event: PointerEvent) => { if (root && !root.contains(event.target as Node)) setOpen(false) }
  document.addEventListener("pointerdown", close)
  onCleanup(() => document.removeEventListener("pointerdown", close))
  return (
    <span class="backend-status" ref={root} data-state={backendStatus() || "ok"}>
      <Show when={backendStatus()}>
        <button class="backend-status-button" aria-label={label()} title={label()} aria-expanded={open()}
          onClick={() => setOpen(!open())}>
          <span class="backend-status-dot" aria-hidden="true" />
        </button>
        <Show when={open()}>
          <div class="backend-status-panel" role="dialog" aria-label="Diagnostics">
            <p>{label()}</p>
            <ul>
              <For each={backendIssues()}>{(issue) =>
                <li data-transient={issue.transient ? "true" : "false"}>
                  <span>{issue.source}</span><span class="dim">{issue.detail} · {ago(issue.since)}</span>
                </li>
              }</For>
            </ul>
          </div>
        </Show>
      </Show>
    </span>
  )
}
