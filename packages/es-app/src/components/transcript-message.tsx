import { createMemo, createSignal, For, Show, type ComponentProps } from "solid-js"
import { Message } from "@opencode-ai/session-ui/message-part"
import { errorText } from "../live-session"
import type { MailDelivery, MailMessage } from "../api"
import { mailSentAt, mailWake } from "../mail-timeline"
import { MailWakeEvidence } from "./mail-wake-evidence"

type MailSource = { type: "editspace-mail"; id: string; sender: string; recipient: string }
const mailTime = (value: string | number | null) => value == null ? "" : new Date(value).toLocaleString()

// The legacy SDK message type has no source field yet. Only structured wire
// metadata can identify mail; message text and synthetic parts cannot.
const mailMetadata = (message: ComponentProps<typeof Message>["message"]) => {
  if (message.role !== "user" || !("source" in message)) return
  const source: unknown = message.source
  if (!source || typeof source !== "object" || !("type" in source) || source.type !== "editspace-mail" ||
    !("id" in source) || typeof source.id !== "string" ||
    !("sender" in source) || typeof source.sender !== "string" ||
    !("recipient" in source) || typeof source.recipient !== "string") return
  const mail: MailSource = { type: "editspace-mail", id: source.id, sender: source.sender, recipient: source.recipient }
  const delivery = "delivery" in message && (message.delivery === "queue" || message.delivery === "steer") ? message.delivery : undefined
  const state = "state" in message &&
    (message.state === "pending" || message.state === "promoted" || message.state === "cancelled") ? message.state : undefined
  return { mail, delivery, state }
}

export const TranscriptMessage = (props: ComponentProps<typeof Message> & {
  mailRecord?: MailMessage
  mailDeliveries?: MailDelivery[]
  mailIDs?: Set<string>
}) => {
  const messageError = createMemo(() => props.message.role === "assistant" && props.message.error?.name !== "MessageAbortedError"
    ? props.message.error : undefined)
  const mail = createMemo(() => mailMetadata(props.message))
  const mailText = createMemo(() => props.parts.flatMap(part => part.type === "text" && !part.ignored ? [part.text] : []).join("\n\n"))
  const generated = createMemo(() => {
    if (props.message.role !== "user" || !props.parts.length ||
      !props.parts.every(part => part.type === "text" && part.synthetic === true)) return ""
    return props.parts.flatMap(part => part.type === "text" && !part.ignored && part.text.trim() ? [part.text] : []).join("\n\n")
  })
  const [open, setOpen] = createSignal(false)
  const [copyState, setCopyState] = createSignal("Copy")
  const copy = async (event: MouseEvent & { currentTarget: HTMLButtonElement }) => {
    const input = document.createElement("textarea")
    input.value = generated()
    input.readOnly = true
    input.tabIndex = -1
    input.style.cssText = "position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;pointer-events:none"
    event.currentTarget.closest("details")!.append(input)
    input.select()
    const copied = document.execCommand("copy")
    input.remove()
    event.currentTarget.focus({ preventScroll: true })
    const result = copied || await navigator.clipboard?.writeText(generated()).then(() => true, () => false)
    setCopyState(result ? "Copied" : "Copy failed")
  }
  return <Show when={mail()} fallback={<Show when={generated()} fallback={<>
    <Message {...props} activityRows />
    <Show when={messageError()}>{(error) =>
      <div class="conversation-error" data-message-error-id={props.message.id} role="note" aria-label="Provider error">{errorText(error())}</div>
    }</Show>
  </>}>
    <details class="generated-input" data-generated-message-id={props.message.id} onToggle={event => setOpen(event.currentTarget.open)}>
      <summary class="activity-row">
        <span class="activity-kind">Generated input</span>
        <span class="activity-description" dir="auto">{generated().replace(/\s+/g, " ").trim().slice(0, 200)}</span>
        <span class="activity-disclosure" aria-hidden="true">›</span>
      </summary>
      <Show when={open()}>
        <div class="activity-details">
          <div class="activity-detail-actions"><button onClick={copy} aria-label="Copy generated input">{copyState()}</button></div>
          <div class="generated-input-body" dir="auto" tabIndex={0} role="region" aria-label="Generated input text">{generated()}</div>
        </div>
      </Show>
    </details>
  </Show>}>
    {(metadata) => <details class="mail-activity" id={`mail-${metadata().mail.id}`} data-mail-message-id={props.message.id}>
      <summary class="mail-activity-summary">
         <span class="mail-activity-kind">Mail<Show when={props.mailRecord}> · {props.mailRecord?.direction === "sent" ? "Outbound" : "Inbound"}</Show></span>
        <span class="mail-activity-route"><bdi dir="auto">{metadata().mail.sender}</bdi> <span class="mail-activity-arrow" aria-hidden="true">→</span> <bdi dir="auto">{metadata().mail.recipient}</bdi></span>
        <span class="mail-activity-state">
          <For each={props.mailDeliveries ?? []}>{(delivery) => <span>{mailWake(delivery)} · {delivery.state}</span>}</For>
          <Show when={!props.mailDeliveries?.length}><span>{mailWake()}</span></Show>
          <Show when={metadata().delivery}>{(delivery) => <span>{delivery()}</span>}</Show>
          <Show when={metadata().state}>{(state) => <span>{state()}</span>}</Show>
        </span>
        <span class="mail-activity-disclosure" aria-hidden="true">›</span>
      </summary>
      <div class="mail-activity-details">
        <div>Mail ID: <bdi dir="auto">{metadata().mail.id}</bdi></div>
        <Show when={props.mailRecord}>{(record) => <>
          <div>Sent: {mailTime(mailSentAt(record()))}</div>
          <For each={[
            { label: "Reply to", id: record().in_reply_to },
            { label: "Supersedes", id: record().supersedes },
          ].filter((item): item is { label: string; id: string } => !!item.id)}>{(ref) => <div>{ref.label}: <Show when={props.mailIDs?.has(ref.id)} fallback={<bdi dir="auto">{ref.id}</bdi>}>
            <a href={`#mail-${ref.id}`}><bdi dir="auto">{ref.id}</bdi></a>
          </Show></div>}</For>
        </>}</Show>
        <Show when={props.parts.every(part => part.type === "text" || part.type === "file")}
          fallback={<Message {...props} activityRows />}>
          <Show when={mailText()}><div class="mail-activity-body" dir="auto">{mailText()}</div></Show>
          <For each={props.parts.filter(part => part.type === "file")}>{(part) =>
            <div class="mail-activity-attachment" dir="auto">Attachment: {part.type === "file" ? part.filename : ""}</div>
          }</For>
        </Show>
        <For each={props.mailDeliveries ?? []}>{(delivery) => <div class="mail-delivery">
          <div>To <bdi dir="auto">{delivery.recipient}</bdi> · {delivery.mode ?? "delivery"} · {delivery.state}</div>
          <MailWakeEvidence delivery={delivery} />
          <Show when={delivery.request_id}><div>Request: <bdi dir="auto">{delivery.request_id}</bdi></div></Show>
          <Show when={delivery.presented_at}><div>Presented: {mailTime(delivery.presented_at)}</div></Show>
          <Show when={delivery.handled_at}><div>Handled: {mailTime(delivery.handled_at)}</div></Show>
          <Show when={delivery.error}><div class="err" role="alert">{delivery.error}</div></Show>
        </div>}</For>
      </div>
    </details>}
  </Show>
}
