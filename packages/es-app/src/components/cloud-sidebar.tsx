import { For, Show } from "solid-js"
import { A, useLocation } from "@solidjs/router"
import { Icon } from "@opencode-ai/ui/icon"
import { cloudHref, cloudKey, cloudOwnerKnown, type CloudPin } from "../cloud-agents"
import { useDashboard } from "../state"
import { wingmanStatus } from "../wingman"
import "./cloud-sidebar.css"

export const CloudNav = (props: { pin: CloudPin; mini?: boolean }) => {
  const cloud = useDashboard().cloud
  const location = useLocation()
  const snapshot = () => cloud.snapshots()[props.pin.editspace]
  const record = () => cloud.observed().find(item => cloudKey(item) === cloudKey(props.pin))?.record
  const pinned = () => cloud.pins().some(pin => cloudKey(pin) === cloudKey(props.pin))
  const active = () => location.pathname === "/cloud" && new URLSearchParams(location.search).get("es") === props.pin.editspace && new URLSearchParams(location.search).get("lane") === props.pin.lane && new URLSearchParams(location.search).get("owner") === props.pin.owner
  const status = () => snapshot()?.error ? "source unavailable" : !record() ? "owner not observed" : wingmanStatus(record()?.["wingman-status"]).label
  return <div class={props.mini ? "cloud-mini-entry" : "session-entry cloud-nav-entry"} data-cloud-owner={props.pin.owner}>
    <A href={cloudHref(props.pin)} activeClass="" class={props.mini ? "mini-item" : "nav-item cloud-nav"} classList={{ active: active() }} title={`Cloud · ${props.pin.lane} · ${props.pin.editspace} · ${status()}`}>
      <span class="cloud-runtime-icon" aria-label="Cloud agent"><Icon name="cloud-upload" size="small" /></span>
      <Show when={!props.mini}><span class="nav-title"><bdi dir="auto">{props.pin.lane}</bdi></span><span class="session-project">{props.pin.editspace} · {status()}</span></Show>
    </A>
    <Show when={!props.mini}><button type="button" class="pin-action" disabled={!pinned() && !cloudOwnerKnown(props.pin.owner)} classList={{ pinned: pinned() }} aria-label={`${pinned() ? "Unpin" : "Pin"} cloud agent ${props.pin.lane}`} title={pinned() ? "Unpin cloud agent" : "Pin cloud agent"} onClick={() => cloud.togglePin(props.pin)}>{pinned() ? "\u2665\ufe0e" : "\u2661\ufe0e"}</button></Show>
  </div>
}

export const CloudDiscovery = () => {
  const cloud = useDashboard().cloud
  return <details class="cloud-discovery"><summary>Cloud agents <span>({cloud.other().length})</span></summary>
    <label class="cloud-discovery-filter"><input type="checkbox" checked={cloud.includeFinished()} onChange={event => cloud.setIncludeFinished(event.currentTarget.checked)} />Include finished</label>
    <Show when={cloud.pinError()}><p class="cloud-sidebar-source">{cloud.pinError()}</p></Show>
    <Show when={cloud.scopes().some(name => cloud.snapshots()[name]?.error)}><p class="cloud-sidebar-source">Cloud source unavailable; saved pins retained.</p></Show>
    <For each={cloud.other()} fallback={<p class="cloud-sidebar-source">{cloud.loading() ? "Checking cloud source…" : cloud.includeFinished() ? "No known unpinned tasks in checked sources." : "No active tasks."}</p>}>{item => <CloudNav pin={item} />}</For>
  </details>
}
