import { For, Show } from "solid-js"
import type { MailDelivery } from "../api"
import { mailWake, mailWakeLabel, mailWakeObservations } from "../mail-timeline"

export const MailWakeEvidence = (props: { delivery: MailDelivery }) => <div class="mail-wake-evidence">
  {/* Typed evidence supersedes the client-side reading of raw observations. */}
  <Show when={props.delivery.wake} fallback={<div>{mailWake(props.delivery)} · Scheduling does not prove provider work started.</div>}>{(state) =>
    <div data-wake={state()}>Wake: {state()} · {mailWakeLabel(state(), props.delivery.recipient)}</div>}
  </Show>
  <For each={mailWakeObservations(props.delivery)}>{observation =>
    <div>Runtime decision: {observation.outcome} · <time dateTime={new Date(observation.observedAt).toISOString()}>{new Date(observation.observedAt).toLocaleString()}</time></div>
  }</For>
</div>
