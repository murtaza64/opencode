/* The reserved BuildingHub slot of a Surface header (Laptop2649): a named link to the deployed BuildingHub version,
 * only from a recorded deploy receipt; it says whether that version is this revision ("current") or an older one. */
import { Show } from "solid-js"
import { buildinghubLink, type Surface } from "../surfaces"

export const BuildingHubSlot = (props: { surface?: Pick<Surface, "buildinghub"> }) => {
  const link = () => props.surface ? buildinghubLink(props.surface) : undefined
  return <span class="surface-head-slot" data-slot="buildinghub" hidden={!link()}>
    <Show when={link()}>{value => {
      const state = () => value().current === true ? "current" : value().current === false ? "older" : "unknown"
      const note = () => state() === "current" ? "this revision" : state() === "older" ? "an older revision" : "revision not compared"
      return <a class="surface-head-link surface-buildinghub" href={value().url} target="_blank" rel="noopener noreferrer" data-current={state()}
        title={`BuildingHub version${value().version ? ` ${value().version}` : ""}: ${note()}`}>
        BuildingHub version{value().version ? ` ${value().version}` : ""}<Show when={state() === "older"}> (older)</Show>
      </a>
    }}</Show>
  </span>
}
