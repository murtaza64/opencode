/* Where this page's agents run. Each host is its own listener origin; switching loads that
 * host's home page, so nothing on this page (drafts, requests, streams) moves between hosts. */
import { For, onMount, Show } from "solid-js"
import { host, readHost } from "../host"

export const HostSwitch = (props: { compact?: boolean }) => {
  onMount(() => void readHost())
  const hosts = () => host()?.hosts ?? []
  return <Show when={hosts().length > 1}>
    <Show when={!props.compact} fallback={<Show when={host()?.remote}><span class="host-badge compact" title={`Agents on ${host()!.label}`}>{host()!.label.slice(0, 4)}</span></Show>}>
      <label class="host-switch" classList={{ remote: host()?.remote }} title="Where new and listed agents run">
        <span class="sr-only">Host</span>
        <select value={host()?.id} onChange={event => {
          const next = hosts().find(item => item.id === event.currentTarget.value)
          if (next && next.id !== host()?.id) location.assign(`${next.origin}/`)
        }}>
          <For each={hosts()}>{item => <option value={item.id}>{item.label}</option>}</For>
        </select>
      </label>
    </Show>
  </Show>
}
