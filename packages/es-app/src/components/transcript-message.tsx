import { createMemo, createSignal, For, Index, Show, type ComponentProps, type JSX } from "solid-js"
import { Message } from "@opencode-ai/session-ui/message-part"
import { errorText } from "../live-session"
import type { MailDelivery, MailMessage } from "../api"
import { mailActionableStatus, mailActivityLabel, mailChipWake, mailSentAt, mailWake, mailWakeLabel } from "../mail-timeline"
import { MailWakeEvidence } from "./mail-wake-evidence"
import { ChatImages } from "./chat-images"
import type { Segment } from "../transcript-groups"
import type { MailNamer } from "../mail-names"
import { MailOriginDetail, MailRoute, MailSender, MailSummary, mailPurpose, originOf, senderText } from "./mail-summary"
import { iconEligible, ToolChip } from "./tool-run"
import { iconChips } from "../chip-preview"

type MailSource = { type: "editspace-mail"; id: string; sender: string; recipient: string; senderSession?: string }
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
  const mail: MailSource = { type: "editspace-mail", id: source.id, sender: source.sender, recipient: source.recipient,
    ...("senderSession" in source && typeof source.senderSession === "string" ? { senderSession: source.senderSession } : {}) }
  const kind = "kind" in source && typeof source.kind === "string" ? source.kind : undefined
  const label = mailActivityLabel(kind)
  const delivery = "delivery" in message && (message.delivery === "queue" || message.delivery === "steer") ? message.delivery : undefined
  const state = "state" in message &&
    (message.state === "pending" || message.state === "promoted" || message.state === "cancelled") ? message.state : undefined
  return { mail, delivery, state, label, kind }
}

export const TranscriptMessage = (props: ComponentProps<typeof Message> & {
  mailRecord?: MailMessage
  mailDeliveries?: MailDelivery[]
  mailIDs?: Set<string>
  mailName?: MailNamer
  // Assistant parts split around compact tool runs; a run renders at its first member.
  segments?: Segment[]
  renderRun?: (key: string) => JSX.Element
}) => {
  const messageError = createMemo(() => props.message.role === "assistant" && props.message.error?.name !== "MessageAbortedError"
    ? props.message.error : undefined)
  const mail = createMemo(() => mailMetadata(props.message))
  // The record carries the bridge's structured Squadron metadata; the input source alone names only the sender.
  const origin = () => { const value = mail(); return value ? originOf(value.mail.sender, props.mailRecord?.squadron, props.mailName) : undefined }
  const mailText = createMemo(() => props.parts.flatMap(part => part.type === "text" && !part.ignored ? [part.text] : []).join("\n\n"))
  const generated = createMemo(() => {
    if (props.message.role !== "user" || !props.parts.length ||
      !props.parts.every(part => part.type === "text" && part.synthetic === true)) return ""
    return props.parts.flatMap(part => part.type === "text" && !part.ignored && part.text.trim() ? [part.text] : []).join("\n\n")
  })
  // Attached user images render through ChatImages, the same component as the outgoing bubble.
  const imagePart = (part: ComponentProps<typeof Message>["parts"][number]) => props.message.role === "user" &&
    part.type === "file" && part.mime.startsWith("image/") && part.url.startsWith("data:") && part.source?.text?.start === undefined
  const images = createMemo(() => props.parts.flatMap(part => imagePart(part) && part.type === "file"
    ? [{ url: part.url, mime: part.mime, ...(part.filename ? { filename: part.filename } : {}) }] : []),
  [], { equals: (a, b) => a.length === b.length && a.every((image, index) => image.url === b[index]!.url && image.filename === b[index]!.filename) })
  const rest = createMemo(() => props.parts.filter(part => !imagePart(part)))
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
    <Show when={props.message.role === "assistant" && props.segments} fallback={<>
      <ChatImages images={images()} lazy />
      <Message {...props} parts={images().length ? rest() : props.parts} activityRows />
    </>}>{(segments) =>
      <Index each={segments()}>{(segment) => {
        const parts = createMemo(() => { const value = segment(); return value.kind === "parts" ? value.parts : [] })
        return <Show when={(() => { const value = segment(); return value.kind === "run" ? value.key : undefined })()} keyed
          fallback={<Parts {...props} parts={parts()} />}>{(key) => props.renderRun?.(key)}</Show>
      }}</Index>
    }</Show>
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
    {(metadata) => <details class="mail-activity" id={`mail-${metadata().mail.id}`} data-mail-message-id={props.message.id} data-direction="in">
      {/* Mail that reached this session as input is incoming, whoever sent it. */}
      <MailSummary direction="in"
        party={<MailSender from={metadata().mail.sender} evidence={props.mailRecord?.sender_session ?? metadata().mail.senderSession}
          name={props.mailName} origin={origin()} />}
        partyText={senderText(metadata().mail.sender, props.mailRecord?.sender_session ?? metadata().mail.senderSession, props.mailName, origin())}
        purpose={mailPurpose(metadata().label, metadata().kind)} sentAt={props.mailRecord ? mailSentAt(props.mailRecord) : undefined}
        wake={(() => {
          const state = mailChipWake(props.mailDeliveries ?? [], "in", props.message.sessionID)
          return state && { state, label: mailWakeLabel(state, "this agent") }
        })()}
        status={mailActionableStatus({ deliveries: props.mailDeliveries ?? [], kind: metadata().kind, direction: "in" })} />
      <div class="mail-activity-details">
        <Show when={props.parts.every(part => part.type === "text" || part.type === "file")}
          fallback={<Message {...props} activityRows />}>
          <Show when={mailText()}><div class="mail-activity-body" dir="auto">{mailText()}</div></Show>
          <For each={props.parts.filter(part => part.type === "file")}>{(part) =>
            <div class="mail-activity-attachment" dir="auto">Attachment: {part.type === "file" ? part.filename : ""}</div>
          }</For>
        </Show>
        <div>Mail ID: <bdi dir="auto">{metadata().mail.id}</bdi></div>
        <div><MailRoute from={metadata().mail.sender} fromEvidence={props.mailRecord?.sender_session ?? metadata().mail.senderSession}
          // This transcript's session received the mail.
          to={metadata().mail.recipient} toEvidence={props.message.sessionID} name={props.mailName} origin={origin()} /></div>
        <Show when={[metadata().delivery, metadata().state].filter(Boolean).join(" · ")}>{(input) => <div>Input: {input()}</div>}</Show>
        <Show when={!props.mailDeliveries?.length}><div>{mailWake()}</div></Show>
        <MailOriginDetail origin={origin()} id={metadata().mail.id} />
        <Show when={props.mailRecord}>{(record) => <>
          <div>Sent: {mailTime(mailSentAt(record()))}</div>
          <For each={[
            { label: "Reply to", id: record().in_reply_to },
            { label: "Supersedes", id: record().supersedes },
          ].filter((item): item is { label: string; id: string } => !!item.id)}>{(ref) => <div>{ref.label}: <Show when={props.mailIDs?.has(ref.id)} fallback={<bdi dir="auto">{ref.id}</bdi>}>
            <a href={`#mail-${ref.id}`}><bdi dir="auto">{ref.id}</bdi></a>
          </Show></div>}</For>
        </>}</Show>
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

// In the icon-chip preview each tool call renders icon-first (ToolChip states failures and running calls in words);
// text and other parts render as before, in order. Splitting is per part, so nothing regroups while a turn runs.
const Parts = (props: ComponentProps<typeof Message>) => {
  const groups = createMemo(() => {
    if (!iconChips) return [{ key: "all", parts: props.parts }]
    return props.parts.reduce<{ key: string; parts: typeof props.parts; tool?: true }[]>((all, part) => {
      if (iconEligible(part, props.renderTools)) return [...all, { key: part.id, parts: [part], tool: true }]
      const last = all.at(-1)
      if (last && !last.tool) return [...all.slice(0, -1), { ...last, parts: [...last.parts, part] }]
      return [...all, { key: part.id, parts: [part] }]
    }, [])
  })
  return <For each={groups().map((group) => group.key)}>{(key) => {
    const group = createMemo(() => groups().find((item) => item.key === key))
    return <Show when={group()}>{(value) => value().tool
      ? <ToolChip message={props.message} part={value().parts[0] as Parameters<typeof ToolChip>[0]["part"]} renderTools={props.renderTools} />
      : <Message {...props} parts={value().parts} activityRows />}</Show>
  }}</For>
}
