/* What a prompt was looking at (transcript): one quiet line per attached context part, so an answer in the transcript
 * keeps the thing it was about. The agent's own text is unchanged; this reads only the part's reference metadata. */
import { createMemo, For, Show, type JSX } from "solid-js"
import type { Part } from "@opencode-ai/sdk/v2"
import { CONTEXT_MENTION_SOURCE } from "../context-mention"

/** Shown lines before the rest fold into "+N more". */
const VISIBLE = 2

type Mention = { key: string; reader: boolean; label: string; revision?: number; href?: string; asOf?: string }

const mention = (part: Part): Mention | undefined => {
  if (part.type !== "text" || part.metadata?.source !== CONTEXT_MENTION_SOURCE) return
  const metadata = part.metadata as { key?: unknown; origin?: unknown; label?: unknown; revision?: unknown; href?: unknown; asOf?: unknown }
  if (typeof metadata.key !== "string" || typeof metadata.label !== "string") return
  return {
    key: metadata.key,
    // An older part has no origin; it was an @ chip, which is the only path that predates the field.
    reader: metadata.origin === "reader", label: metadata.label,
    revision: typeof metadata.revision === "number" ? metadata.revision : undefined,
    href: typeof metadata.href === "string" ? metadata.href : undefined,
    asOf: typeof metadata.asOf === "string" ? metadata.asOf : undefined,
  }
}

export const ContextLine = (props: { part: Part }) => {
  const value = () => mention(props.part)
  // The hover and accessible name carry the capture time; the line itself stays short.
  const when = () => value()?.asOf && value()!.asOf !== "unknown" ? `At ${value()!.asOf}` : "Capture time not recorded"
  return <Show when={value()}>{item => <p class="msg-context" dir="auto" data-context-key={item().key}>
    <Show when={item().href} fallback={<span title={when()}><span class="msg-context-lead">{item().reader ? "While looking at" : "About"}</span> <bdi dir="auto">{item().label}</bdi><Show when={item().revision !== undefined}> · <span class="msg-context-rev">r{item().revision}</span></Show></span>}>
      {href => <a href={href()} title={when()} aria-label={`${item().reader ? "While looking at" : "About"} ${item().label}${item().revision !== undefined ? `, revision ${item().revision}` : ""}. ${when()}. Open in the reader`}>
        <span class="msg-context-lead">{item().reader ? "While looking at" : "About"}</span> <bdi dir="auto">{item().label}</bdi><Show when={item().revision !== undefined}> · <span class="msg-context-rev">r{item().revision}</span></Show>
        <span class="msg-context-go" aria-hidden="true">↗</span>
      </a>}
    </Show>
  </p>}</Show>
}

/** Under a user bubble: at most VISIBLE lines, then "+N more". `tick` (the message's delivery mark) shares the last
 * row, so the context never adds a row of its own below the bubble; without any context the tick keeps its own row. */
export const ContextLines = (props: { parts: Part[]; tick?: () => JSX.Element }) => {
  const items = createMemo(() => props.parts.flatMap(part => mention(part) ?? []))
  const shown = () => items().slice(0, VISIBLE)
  const hidden = () => items().length - shown().length
  const partFor = (key: string) => props.parts.find(part => mention(part)?.key === key)!
  return <Show when={items().length} fallback={<Show when={props.tick}><div class="msg-tick-row">{props.tick!()}</div></Show>}>
    <div class="msg-context-lines">
      <For each={shown()}>{(item, index) => !hidden() && props.tick && index() === shown().length - 1
        ? <div class="msg-context-row"><ContextLine part={partFor(item.key)} /><span class="msg-context-tick">{props.tick!()}</span></div>
        : <ContextLine part={partFor(item.key)} />}</For>
      <Show when={hidden() > 0}>
        <div class="msg-context-row">
          <p class="msg-context msg-context-more" dir="auto">+{hidden()} more</p>
          <Show when={props.tick}>{tick => <span class="msg-context-tick">{tick()()}</span>}</Show>
        </div>
      </Show>
    </div>
  </Show>
}
