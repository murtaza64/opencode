import { For } from "solid-js"
import type { MailDelivery } from "../api"
import { mailWake, mailWakeObservations } from "../mail-timeline"

export const MailWakeEvidence = (props: { delivery: MailDelivery }) => <div class="mail-wake-evidence">
  <div>{mailWake(props.delivery)} · Scheduling does not prove provider work started.</div>
  <For each={mailWakeObservations(props.delivery)}>{observation =>
    <div>Runtime decision: {observation.outcome} · <time dateTime={new Date(observation.observedAt).toISOString()}>{new Date(observation.observedAt).toLocaleString()}</time></div>
  }</For>
</div>
