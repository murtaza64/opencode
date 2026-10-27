import { For, Show } from "solid-js"
import type { MailMessage } from "../api"
import { mailActionableStatus, mailDirection, mailSentAt } from "../mail-timeline"
import { MailWakeEvidence } from "./mail-wake-evidence"
import { MailParty } from "./mail-party"
import { MailOriginDetail, MailRoute, MailSender, MailSummary, mailPurpose, originOf, senderText } from "./mail-summary"
import { recipientSession, type MailNamer } from "../mail-names"

const timestamp = (value: string | number | null) => {
  if (value == null) return ""
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString()
}

export const MailRow = (props: { message: MailMessage; ids: Set<string>; anchor?: string; name?: MailNamer; session?: string; replied?: boolean }) => {
  const anchor = () => props.anchor ?? "mail"
  const origin = () => originOf(props.message.from, props.message.squadron, props.name)
  const from = (detail?: boolean) => <MailParty party={props.message.from} evidence={props.message.sender_session} name={props.name} detail={detail} />
  const to = (detail?: boolean) => <MailParty party={props.message.to} evidence={recipientSession(props.message.deliveries, props.message.to)} name={props.name} detail={detail} />
  const references = () => [
    { label: "Reply to", id: props.message.in_reply_to },
    { label: "Supersedes", id: props.message.supersedes },
  ].filter((item): item is { label: string; id: string } => !!item.id)
  const direction = () => mailDirection(props.message, props.session)
  const party = () => direction() === "out"
    ? { element: to(), text: props.name?.(props.message.to, recipientSession(props.message.deliveries, props.message.to))?.label ?? props.message.to }
    : direction() === "in"
      ? { element: <MailSender from={props.message.from} evidence={props.message.sender_session} name={props.name} origin={origin()} />,
        text: senderText(props.message.from, props.message.sender_session, props.name, origin()) }
      : { element: <MailRoute from={props.message.from} fromEvidence={props.message.sender_session} to={props.message.to}
          toEvidence={recipientSession(props.message.deliveries, props.message.to)} name={props.name} origin={origin()} />,
        text: `${senderText(props.message.from, props.message.sender_session, props.name, origin())} to ${props.name?.(props.message.to, recipientSession(props.message.deliveries, props.message.to))?.label ?? props.message.to}` }
  return <details class="mail-activity" id={`${anchor()}-${props.message.id}`} data-mail-id={props.message.id} data-direction={direction()}>
    <MailSummary direction={direction()} party={party().element} partyText={party().text}
      purpose={mailPurpose(undefined, props.message.kind)} sentAt={mailSentAt(props.message)}
      status={mailActionableStatus({ deliveries: props.message.deliveries, kind: props.message.kind, direction: direction(), replied: props.replied })} />
    <div class="mail-activity-details">
      <div class="mail-activity-body" dir="auto">{props.message.text}</div>
      <div>Mail ID: <bdi dir="auto">{props.message.id}</bdi></div>
      <Show when={direction() === "unknown"}><div>Direction unknown: no verified session evidence links this mail to this session.</div></Show>
      <div>From: {from(true)}</div>
      <div>To: {to(true)}</div>
      <MailOriginDetail origin={origin()} id={props.message.id} />
      <Show when={props.message.kind}><div>Kind: <bdi dir="auto">{props.message.kind}</bdi></div></Show>
      <div>Sent: {timestamp(mailSentAt(props.message))}</div>
      <Show when={props.message.created_ms === undefined}><div>Source timestamp precision: legacy (may be whole seconds).</div></Show>
      <Show when={props.message.sender_session}><div>Sender session: <bdi dir="auto">{props.message.sender_session}</bdi></div></Show>
      <Show when={props.message.origin_run}><div>Origin run: <bdi dir="auto">{props.message.origin_run}</bdi></div></Show>
      <Show when={props.message.origin_tool_call}><div>Origin tool call: <bdi dir="ltr">{props.message.origin_tool_call}</bdi></div></Show>
      <Show when={props.message.relationship}><div>Relationship: <bdi dir="auto">{props.message.relationship}</bdi></div></Show>
      <For each={references()}>{(ref) => <div>{ref.label}: <Show when={props.ids.has(ref.id)} fallback={<bdi dir="auto">{ref.id}</bdi>}>
        <a href={`#${anchor()}-${ref.id}`}><bdi dir="auto">{ref.id}</bdi></a>
      </Show></div>}</For>
       <For each={props.message.deliveries}>{(delivery) => <div class="mail-delivery">
         <div>To <bdi dir="auto">{delivery.recipient}</bdi> · {delivery.mode ?? "delivery"} · {delivery.state}</div>
         <MailWakeEvidence delivery={delivery} />
        <Show when={delivery.session}><div>Session: <bdi dir="auto">{delivery.session}</bdi></div></Show>
        <Show when={delivery.request_id}><div>Request: <bdi dir="auto">{delivery.request_id}</bdi></div></Show>
        <Show when={delivery.presented_at}><div>Presented: {timestamp(delivery.presented_at)}</div></Show>
        <Show when={delivery.handled_at}><div>Handled: {timestamp(delivery.handled_at)}</div></Show>
        <Show when={delivery.error}><div class="err" role="alert">{delivery.error}</div></Show>
      </div>}</For>
    </div>
  </details>
}
