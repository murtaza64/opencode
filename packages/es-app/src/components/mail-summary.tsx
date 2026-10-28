import { Show, type JSX } from "solid-js"
import type { MailWakeState } from "../api"
import type { MailDirection } from "../mail-timeline"
import { Glyph } from "./icons"
import { iconChips } from "../chip-preview"
import { MailParty } from "./mail-party"
import type { MailNamer } from "../mail-names"
import { mailOrigin, originLabel, squadronSender, type MailOrigin, type SquadronMeta } from "../mail-origin"

export const originOf = (from: string, squadron: SquadronMeta | undefined, name?: MailNamer) =>
  mailOrigin(from, squadron, (party) => name?.local?.(party) ?? false)

export const OriginChip = (props: { origin: MailOrigin }) => {
  const title = () => props.origin.kind === "squadron"
    ? `Squadron (external)${props.origin.workspace ? ` · workspace ${props.origin.workspace}` : ""} · via the local bridge`
    : "Electric Sheep (local agents)"
  // Narrow rows show the short form; the full name stays the accessible text.
  return <span class="mail-origin" data-origin={props.origin.kind} title={title()}>
    <span class="mail-origin-full">{originLabel(props.origin)}</span>
    <span class="mail-origin-short" aria-hidden="true">{props.origin.kind === "squadron" ? "SQ" : "ES"}</span>
  </span>
}

/** A mail sender. A Squadron sender is the workspace author, never the bridge that carried it. */
export const MailSender = (props: { from: string; evidence?: string | null; name?: MailNamer; origin?: MailOrigin }) => <>
  <Show when={props.origin?.kind === "squadron" ? props.origin : undefined}>{(origin) => <OriginChip origin={origin()} />}</Show>
  <Show when={props.origin?.kind === "squadron" ? props.origin : undefined} fallback={
    <MailParty party={props.from} evidence={props.evidence} name={props.name} />}>{(origin) =>
    <bdi dir="auto" class="mail-party" data-external="true" data-lane={props.from}
      title={`${origin().actors.join(", ") || "Squadron workspace"} · via ${props.from}`}>{squadronSender(origin())}</bdi>}
  </Show>
</>

/** The sender's display text, for accessible labels. */
export const senderText = (from: string, evidence: string | null | undefined, name: MailNamer | undefined, origin: MailOrigin | undefined) =>
  origin?.kind === "squadron" ? squadronSender(origin) : name?.(from, evidence)?.label ?? from

/** Sender and recipient. */
export const MailRoute = (props: { from: string; fromEvidence?: string | null; to: string; toEvidence?: string | null; name?: MailNamer; origin?: MailOrigin }) =>
  <span class="mail-route mail-activity-route">
    <MailSender from={props.from} evidence={props.fromEvidence} name={props.name} origin={props.origin} />
    {" "}<span class="mail-activity-arrow" aria-hidden="true">→</span>{" "}
    <MailParty party={props.to} evidence={props.toEvidence} name={props.name} />
  </span>

/** One-line mail chip: glyph, the other party, purpose, and a status only when the person may need to act.
 * Incoming sits on the person's side, outgoing on the agent's; timestamps and delivery detail live in the expansion.
 * Wake is a wordless cue: only a caused wake draws attention; its words live in the tooltip and accessible label. */
export const MailSummary = (props: {
  direction: MailDirection; party: JSX.Element; partyText: string; purpose: string; status?: string; sentAt?: number
  wake?: { state: MailWakeState; label: string }
}) => {
  const preposition = () => props.direction === "out" ? " to" : props.direction === "in" ? " from" : ""
  // Icon-chip preview: a settled mail is one content-width line, glyph first, party and kind always visible. A status
  // the person may need to act on, an unknown direction or an unknown wake keeps the full-width row.
  const compact = () => iconChips && !props.status && props.direction !== "unknown" && props.wake?.state !== "unknown"
  const line = () => <>
    <span class="mail-activity-party">{props.party}</span>
    <span class="mail-activity-sep" aria-hidden="true">·</span>
    <span class="mail-activity-purpose" dir="auto">{props.purpose}</span>
  </>
  return <summary class="mail-activity-summary" data-wake={props.wake?.state} data-compact={compact() ? "true" : undefined}
    title={[relativeTime(props.sentAt), props.wake?.label].filter(Boolean).join(" · ") || undefined}
    aria-label={`Mail${preposition()} ${props.partyText}: ${props.purpose}${props.status ? `, ${props.status}` : ""}${props.wake ? `, ${props.wake.label}` : ""}`}>
    <span class="mail-activity-kind" data-direction={props.direction} aria-hidden="true">
      <Glyph name={props.direction === "out" ? "paper-airplane" : "inbox"} />
    </span>
    <Show when={props.wake?.state === "caused" || props.wake?.state === "unknown" ? props.wake.state : undefined}>{(state) =>
      <span class="mail-activity-wake" data-wake={state()} aria-hidden="true">
        <Glyph name={state() === "caused" ? "zap-fill" : "dot"} size={12} />
      </span>}
    </Show>
    {/* The preview slot keeps compact mail's line together; otherwise party and purpose are direct children, as before. */}
    <Show when={compact()} fallback={line()}><span class="mail-activity-preview">{line()}</span></Show>
    <Show when={props.status}>{(status) => <>
      <span class="mail-activity-sep" aria-hidden="true">·</span>
      <span class="mail-activity-status" data-status={status()}>{status()}</span>
    </>}</Show>
  </summary>
}

/** Purpose of a chip: an agent-activity tag (Nudge, Resume, ...) or the mail kind. */
export const mailPurpose = (tag: string | undefined, kind: string | undefined) =>
  tag && tag !== "Mail" ? tag : kind ? kind[0]!.toUpperCase() + kind.slice(1) : "Mail"

const relativeTime = (at: number | undefined) => {
  if (at === undefined || !Number.isFinite(at)) return undefined
  const seconds = Math.round((at - Date.now()) / 1000)
  const [value, unit] = Math.abs(seconds) < 60 ? [seconds, "second"] as const
    : Math.abs(seconds) < 3600 ? [Math.round(seconds / 60), "minute"] as const
    : Math.abs(seconds) < 86_400 ? [Math.round(seconds / 3600), "hour"] as const
    : [Math.round(seconds / 86_400), "day"] as const
  return new Intl.RelativeTimeFormat(undefined, { numeric: "auto" }).format(value, unit)
}

/** Where the mail came from and where a reply goes, for the expanded details. */
export const MailOriginDetail = (props: { origin?: MailOrigin; id: string }) =>
  <Show when={props.origin} fallback={<div>Origin: unknown (no structured source)</div>}>{(origin) =>
    <Show when={origin().kind === "squadron" ? origin() as Extract<MailOrigin, { kind: "squadron" }> : undefined} fallback={
      <div class="mail-origin-detail">Origin: Electric Sheep · reply here with <bdi dir="ltr">es mail send --reply-to {props.id}</bdi></div>}>{(external) =>
      <div class="mail-origin-detail">Origin: Squadron
        <Show when={external().workspace}> · workspace <bdi dir="auto">{external().workspace}</bdi></Show>
        <Show when={external().actors.length}> · from <bdi dir="auto">{external().actors.join(", ")}</bdi></Show>
        {" · carried by the local bridge. Reply in the Squadron workspace"}
        <Show when={external().workspaceID}> (<bdi dir="ltr">es squadron post {external().workspaceID}</bdi>)</Show>
        <Show when={external().url}>{(url) => <> · <a href={url()} target="_blank" rel="noreferrer">Open workspace</a></>}</Show>
      </div>}
    </Show>}
  </Show>
