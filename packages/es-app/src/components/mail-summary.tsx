/* One summary layout for every mail row: direction glyph, an optional tag
 * (agent resume/kickoff), origin, sender → recipient, state. Each piece has a
 * fixed place in the same grid, so adjacent rows align and nothing wraps into
 * the glyph column; full names and routing live in the details. */
import { Show, type JSX } from "solid-js"
import { Glyph } from "./icons"
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

/** Sender and recipient. A Squadron sender is the workspace author, never the bridge that carried it. */
export const MailRoute = (props: { from: string; fromEvidence?: string | null; to: string; toEvidence?: string | null; name?: MailNamer; origin?: MailOrigin }) =>
  <span class="mail-route mail-activity-route">
    <Show when={props.origin}>{(origin) => <OriginChip origin={origin()} />}</Show>
    <Show when={props.origin?.kind === "squadron" ? props.origin : undefined} fallback={
      <MailParty party={props.from} evidence={props.fromEvidence} name={props.name} />}>{(origin) =>
      <bdi dir="auto" class="mail-party" data-external="true" data-lane={props.from}
        title={`${origin().actors.join(", ") || "Squadron workspace"} · via ${props.from}`}>{squadronSender(origin())}</bdi>}
    </Show>
    {" "}<span class="mail-activity-arrow" aria-hidden="true">→</span>{" "}
    <MailParty party={props.to} evidence={props.toEvidence} name={props.name} />
  </span>

export const MailSummary = (props: { direction: "in" | "out"; tag?: string; route: JSX.Element; state: JSX.Element }) =>
  <summary class="mail-activity-summary">
    {/* The glyph carries direction at a glance; the words stay for assistive technology. */}
    <span class="mail-activity-kind" data-direction={props.direction} title={props.direction === "out" ? "Outbound mail" : "Inbound mail"}>
      <Glyph name={props.direction === "out" ? "paper-airplane" : "inbox"} />
      <span class="sr-only">{props.tag ?? "Mail"} · {props.direction === "out" ? "Outbound" : "Inbound"}</span>
    </span>
    <span class="mail-activity-line">
      <Show when={props.tag}><span class="mail-tag" aria-hidden="true">{props.tag}</span></Show>
      {props.route}
    </span>
    <span class="mail-activity-state">{props.state}</span>
    <span class="mail-activity-disclosure" aria-hidden="true">›</span>
  </summary>

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
