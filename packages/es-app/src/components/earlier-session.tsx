/* One earlier session of a continuous transcript (DD #857/#858): read-only rows from that session's own host, then the
 * thin handoff rule into the next session. No composer, no row actions that write, nothing sent to any model. */
import { For, onMount, Show, type ComponentProps } from "solid-js"
import { A } from "@solidjs/router"
import { DataProvider } from "@opencode-ai/session-ui/context"
import { TranscriptMessage } from "./transcript-message"
import { createLiveSession } from "../live-session"
import { handoffPlumbing, type ChainLink } from "../transcript-chain"
import type { SessionHost } from "../session-host"

/** What the page needs to page this segment: older rows inside it, then the next earlier session. */
export type SegmentControl = { session: string; metadata: () => unknown; title: () => string | undefined; created: () => number | undefined; hasOlder: () => boolean; loadingOlder: () => boolean; older: () => Promise<void>; ready: () => boolean }

export const EarlierSession = (props: {
  link: ChainLink
  directory: string
  host: SessionHost
  href: string
  hostLabel?: string
  renderTools?: ComponentProps<typeof TranscriptMessage>["renderTools"]
  register: (control: SegmentControl) => void
}) => {
  const live = createLiveSession(props.link.session, props.directory, undefined, props.host)
  const messages = () => live.data.message[props.link.session] ?? []
  const info = () => live.data.session[0]
  // Rows belong to this session only when Core returned this exact identity.
  const valid = () => info()?.id === props.link.session
  const failed = () => !live.loading() && !valid() && (!!live.connectionError() || !!live.error() || live.loaded())
  const title = () => (valid() && info()?.title) || props.link.session
  props.register({ session: props.link.session, metadata: () => valid() ? info()?.metadata : undefined,
    title: () => valid() ? info()?.title || undefined : undefined, created: () => valid() ? info()?.time.created : undefined, hasOlder: () => valid() && live.hasOlder(), loadingOlder: live.loadingOlder,
    older: () => live.older(), ready: () => valid() || failed() })
  onMount(() => { void live.load().catch(() => {}) })
  return <section class="earlier-session" data-earlier-session={props.link.session} aria-label={`Earlier session ${title()}`}>
    <Show when={live.loading() && !messages().length}><div class="earlier-session-status" role="status">Loading earlier…</div></Show>
    <Show when={failed()}>
      <div class="earlier-session-status" role="alert">
        {props.hostLabel ? `Earlier session on ${props.hostLabel} unavailable` : "Couldn't load the earlier session"}
        {" · "}<button type="button" onClick={() => void live.retry()}>Retry</button>
        {" · "}<A href={props.href}><bdi dir="ltr">{props.link.session}</bdi></A>
      </div>
    </Show>
    <Show when={valid()}>
      <DataProvider data={live.data} directory={props.directory} sessionID={props.link.session}>
        <For each={messages()}>{(message) => {
          const parts = () => live.data.part[message.id] ?? []
          return <div data-find-message={message.id} data-segment={props.link.session}>
            <Show when={message.role === "user" && handoffPlumbing(parts())} fallback={
              <TranscriptMessage message={message} parts={parts()} renderTools={props.renderTools} />}>
              <details class="earlier-session-plumbing">
                <summary>Handoff brief</summary>
                <TranscriptMessage message={message} parts={parts()} renderTools={props.renderTools} />
              </details>
            </Show>
          </div>
        }}</For>
      </DataProvider>
    </Show>
  </section>
}

/** The thin rule above a session that continued an earlier one. `previous` marks the open session's own rule. */
export const HandoffRule = (props: { predecessor: string; successor: string; label: string; href: string; at?: number; reason?: string;
  skipped?: string; previous?: boolean }) => {
  const at = () => props.at ? new Date(props.at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }) : undefined
  const detail = () => [`${props.predecessor} → ${props.successor}`, props.reason,
    props.skipped ? `Handoff brief not sent because this session was already in use: ${props.skipped}` : undefined].filter(Boolean).join(" · ")
  return <div class="handoff-rule" role="separator" title={detail()} aria-label={props.previous ? "Previous session" : "Handoff"}>
    <span dir="auto">Handoff{at() ? ` · ${at()}` : ""} · <A href={props.href}><bdi dir="auto">{props.label}</bdi></A> continued in a new session</span>
    <span class="sr-only"> · {detail()}</span>
  </div>
}
