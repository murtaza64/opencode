import { For, Show } from "solid-js"
import type { MailCause } from "../mail-timeline"

const clock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
const stamp = (ms: number) => <time dateTime={new Date(ms).toISOString()} title={new Date(ms).toLocaleString()}>{clock(ms)}</time>

// States only what the transcript records: which mail became the next turn's input, and when it was sent and received.
export const MailCauseRow = (props: { cause: MailCause }) => <div class="mail-cause" role="note"
  aria-label={`Turn input: ${props.cause.ids.length} mail${props.cause.ids.length === 1 ? "" : "s"}`}>
  <span class="mail-cause-kind" dir="auto">{props.cause.ids.length === 1 ? "Mail input" : `${props.cause.ids.length} mails, one turn`}</span>
  <span class="mail-cause-what" dir="auto">
    <For each={props.cause.kinds}>{(kind, index) => <>{index() ? ", " : ""}{kind.count > 1 ? `${kind.count} × ` : ""}
      <span class="mail-kind" data-kind={kind.kind}>{kind.human ? "human answer" : kind.kind}</span>{kind.catchUp ? " (handoff catch-up)" : ""}</>}</For>
    {" · from "}
    <For each={props.cause.senders}>{(sender, index) => <>{index() ? ", " : ""}<bdi dir="auto">{sender}</bdi></>}</For>
  </span>
  <span class="mail-cause-time" dir="ltr">
    <Show when={props.cause.sentFrom !== undefined}>
      sent {stamp(props.cause.sentFrom!)}
      <Show when={props.cause.sentTo !== undefined && clock(props.cause.sentTo) !== clock(props.cause.sentFrom!)}>–{stamp(props.cause.sentTo!)}</Show>
      {" · "}
    </Show>
    received {stamp(props.cause.promotedAt)}
  </span>
</div>
