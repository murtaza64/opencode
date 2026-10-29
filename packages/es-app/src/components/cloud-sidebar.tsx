import { createMemo, Show } from "solid-js"
import { waveStart } from "../wave"
import { A, useLocation } from "@solidjs/router"
import { HostGlyph } from "./icons"
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
  // Same status dot as session rows: working = busy, failed/timed out = failed, otherwise idle; a source that
  // cannot be read or an owner it no longer lists is unknown (hollow), never idle.
  const dot = () => {
    if (snapshot()?.error || !record()) return "unknown"
    const chip = wingmanStatus(record()?.["wingman-status"]).chip
    return chip === "busy" ? "busy" : chip === "failing" ? "failed" : "idle"
  }
  const start = createMemo<number | undefined>((previous) => dot() === "busy" ? previous ?? waveStart() : undefined)

  return <div class={props.mini ? "cloud-mini-entry" : "session-entry cloud-nav-entry"} data-cloud-owner={props.pin.owner}>
    <A href={cloudHref(props.pin)} activeClass="" class={props.mini ? "mini-item" : "nav-item cloud-nav"} classList={{ active: active() }} title={`Cloud · ${props.pin.lane} · ${props.pin.editspace} · ${status()}`}>
      <span class={`dot ${dot()}`} style={start() === undefined ? undefined : { "--wave-start": String(start()) }} {...(dot() === "failed" || dot() === "unknown" ? { role: "img", "aria-label": status() } : {})} />
      <span class="cloud-runtime-icon" aria-label="Cloud agent"><HostGlyph host="wingman" size={props.mini ? 12 : 14} /></span>
      <Show when={!props.mini}>
        <span class="nav-title"><bdi dir="auto">{props.pin.lane}</bdi></span><span class="session-project">{props.pin.editspace} · {status()}</span></Show>
    </A>
    <Show when={!props.mini}><button type="button" class="pin-action" disabled={!pinned() && !cloudOwnerKnown(props.pin.owner)} classList={{ pinned: pinned() }} aria-label={`${pinned() ? "Unpin" : "Pin"} cloud agent ${props.pin.lane}`} title={pinned() ? "Unpin cloud agent" : "Pin cloud agent"} onClick={() => cloud.togglePin(props.pin)}>{pinned() ? "\u2665\ufe0e" : "\u2661\ufe0e"}</button></Show>
  </div>
}

/** Shown only when the cloud source cannot be read or a pin failed; there is no cloud header or filter
 * (finished agents are always listed). */
export const CloudSource = () => {
  const cloud = useDashboard().cloud
  const down = () => cloud.scopes().some(name => cloud.snapshots()[name]?.error)
  return <Show when={down() || cloud.pinError()}>
    <div class="dim nav-empty host-status cloud-source unavailable" role="status">
      <HostGlyph host="wingman" />
      <span>{down() ? "Cloud agents: source unavailable; last-known rows kept" : ""}{down() && cloud.pinError() ? " · " : ""}{cloud.pinError() ?? ""}</span>
    </div>
  </Show>
}
