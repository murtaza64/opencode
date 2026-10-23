import { For, Show } from "solid-js"
import type { MailCause } from "../mail-timeline"
import type { MailNamer } from "../mail-names"
import { MailParty } from "./mail-party"
import { Glyph } from "./icons"
import { OriginChip, originOf } from "./mail-summary"
import { SQUADRON_BRIDGE, squadronSender } from "../mail-origin"

const clock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
const stamp = (ms: number) => <time dateTime={new Date(ms).toISOString()} title={new Date(ms).toLocaleString()}>{clock(ms)}</time>

// States only what the transcript records: which mail became the next turn's input, and when it was sent and received.
// Same glyph column and party layout as the mail rows it summarizes.
export const MailCauseRow = (props: { cause: MailCause; name?: MailNamer }) => <div class="mail-cause" role="note"
  aria-label={`Turn input: ${props.cause.ids.length} mail${props.cause.ids.length === 1 ? "" : "s"}`}>
  <span class="mail-activity-kind" data-direction="in" aria-hidden="true"><Glyph name="inbox" /></span>
  <span class="mail-cause-kind" dir="auto">{props.cause.ids.length === 1 ? "Mail input" : `${props.cause.ids.length} mails, one turn`}</span>
  <span class="mail-cause-what" dir="auto">
    <For each={props.cause.kinds}>{(kind, index) => <>{index() ? ", " : ""}{kind.count > 1 ? `${kind.count} × ` : ""}
      <span class="mail-kind" data-kind={kind.kind}>{kind.human ? "human answer" : kind.kind}</span>{kind.catchUp ? " (handoff catch-up)" : ""}</>}</For>
    {" · from "}
    <For each={props.cause.senders}>{(sender, index) => {
      const origin = () => originOf(sender, props.cause.squadron?.[sender], props.name)
      return <>{index() ? ", " : ""}<Show when={origin()}>{(value) => <OriginChip origin={value()} />}</Show>
        <Show when={sender === SQUADRON_BRIDGE && origin()?.kind === "squadron" ? origin() as Parameters<typeof squadronSender>[0] : undefined}
          fallback={<MailParty party={sender} evidence={props.cause.senderSessions[sender]} name={props.name} />}>{(external) =>
          <bdi dir="auto" class="mail-party" data-external="true" title={`via ${sender}`}>{squadronSender(external())}</bdi>}</Show></>
    }}</For>
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
