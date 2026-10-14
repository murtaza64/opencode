import { For, Show } from "solid-js"
import type { MailMessage } from "../api"

const timestamp = (value: string | number | null) => {
  if (value == null) return ""
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString()
}

export const MailRow = (props: { message: MailMessage; ids: Set<string>; anchor?: string }) => {
  const anchor = () => props.anchor ?? "mail"
  const references = () => [
    { label: "Reply to", id: props.message.in_reply_to },
    { label: "Supersedes", id: props.message.supersedes },
  ].filter((item): item is { label: string; id: string } => !!item.id)
  return <details class="mail-activity" id={`${anchor()}-${props.message.id}`} data-mail-id={props.message.id}>
    <summary class="mail-activity-summary">
       <span class="mail-activity-kind">Mail · {props.message.direction === "sent" ? "Outbound" : "Inbound"}</span>
      <span class="mail-activity-route"><bdi dir="auto">{props.message.from}</bdi> → <bdi dir="auto">{props.message.to}</bdi></span>
      <span class="mail-activity-state">{props.message.kind} · {timestamp(props.message.ts)}
         <For each={props.message.deliveries}>{(delivery) => <span>{delivery.state}</span>}</For>
      </span>
      <span class="mail-activity-disclosure" aria-hidden="true">›</span>
    </summary>
    <div class="mail-activity-details">
      <div>Mail ID: <bdi dir="auto">{props.message.id}</bdi></div>
      <Show when={props.message.sender_session}><div>Sender session: <bdi dir="auto">{props.message.sender_session}</bdi></div></Show>
      <Show when={props.message.origin_run}><div>Origin run: <bdi dir="auto">{props.message.origin_run}</bdi></div></Show>
      <Show when={props.message.relationship}><div>Relationship: <bdi dir="auto">{props.message.relationship}</bdi></div></Show>
      <For each={references()}>{(ref) => <div>{ref.label}: <Show when={props.ids.has(ref.id)} fallback={<bdi dir="auto">{ref.id}</bdi>}>
        <a href={`#${anchor()}-${ref.id}`}><bdi dir="auto">{ref.id}</bdi></a>
      </Show></div>}</For>
      <div class="mail-activity-body" dir="auto">{props.message.text}</div>
       <For each={props.message.deliveries}>{(delivery) => <div class="mail-delivery">
        <div>To <bdi dir="auto">{delivery.recipient}</bdi> · {delivery.mode ?? "delivery"} · {delivery.state}</div>
        <Show when={delivery.session}><div>Session: <bdi dir="auto">{delivery.session}</bdi></div></Show>
        <Show when={delivery.request_id}><div>Request: <bdi dir="auto">{delivery.request_id}</bdi></div></Show>
        <Show when={delivery.presented_at}><div>Presented: {timestamp(delivery.presented_at)}</div></Show>
        <Show when={delivery.handled_at}><div>Handled: {timestamp(delivery.handled_at)}</div></Show>
        <Show when={delivery.error}><div class="err" role="alert">{delivery.error}</div></Show>
      </div>}</For>
    </div>
  </details>
}
