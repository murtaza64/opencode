import { For, Show } from "solid-js"
import { contextBound, contextKey, type ContextGroup, type ContextRef } from "../context-mention"
import { ago } from "../state"

const meta = (ref: ContextRef) => ref.kind === "agent"
  ? ref.live === "busy" || ref.live === "retry" ? "working" : ref.status ?? (ref.owner ? "idle" : "no session")
  : ago(ref.updated)

const busy = (ref: ContextRef) => ref.live === "busy" || ref.live === "retry"

/** Grouped @ picker: rows on the start side, a preview of exactly what will be attached on the end side. */
export const ContextPicker = (props: { groups: ContextGroup[]; selected: number; select: (index: number) => void; add: (ref: ContextRef) => void }) => {
  const flat = () => props.groups.flatMap((group) => group.items)
  const current = () => flat()[props.selected]
  return <div class="context-picker" role="dialog" aria-label="Add context">
    <div class="context-picker-list" role="listbox" aria-label="Context">
      <Show when={flat().length} fallback={<div class="context-picker-empty">No matches</div>}>
        <For each={props.groups}>{(group) => <div role="group" aria-label={group.name}>
          <div class="context-picker-group" aria-hidden="true">{group.name}</div>
          <For each={group.items}>{(ref) => {
            const index = () => flat().indexOf(ref)
            return <div role="option" class="context-picker-row" id={`context-option-${contextKey(ref)}`} aria-selected={index() === props.selected}
              data-kind={ref.kind} onMouseDown={(event) => { event.preventDefault(); props.add(ref) }} onMouseEnter={() => props.select(index())}>
              <span class="context-picker-dot" data-busy={busy(ref) ? "1" : undefined} aria-hidden="true" />
              <bdi class="context-picker-label">{ref.label}</bdi>
              <span class="context-picker-meta">{meta(ref)}</span>
            </div>
          }}</For>
        </div>}</For>
      </Show>
    </div>
    <Show when={current()}>{(ref) => <div class="context-picker-preview" aria-live="polite">
      <bdi class="context-picker-preview-title">{ref().label}</bdi>
      <Show when={ref().kind === "agent" ? ref() as Extract<ContextRef, { kind: "agent" }> : undefined} fallback={
        <div><bdi dir="ltr">{ref().id}</bdi><Show when={(ref() as Extract<ContextRef, { kind: "session" }>).lane}>{(lane) => <> · lane <bdi>{lane()}</bdi></>}</Show></div>}>{(agent) => <>
        <div>Lane <bdi>{agent().lane}</bdi> · <bdi>{agent().editspace}</bdi></div>
        <Show when={agent().activity}>{(activity) => <div class="context-picker-activity" dir="auto">{activity()}</div>}</Show>
      </>}</Show>
      <div class="context-picker-host">Host <bdi dir="ltr">{ref().host}</bdi></div>
      <div class="context-picker-bound">{contextBound(ref())}</div>
    </div>}</Show>
    <div class="context-picker-hint">Enter add · Tab next group · Esc close · nothing is sent until you send the message</div>
  </div>
}

/** Removable context chips above the editor. Each chip names its kind and host; the tooltip repeats the bound. */
export const ContextChips = (props: { refs: readonly ContextRef[]; remove: (ref: ContextRef) => void; note?: string }) =>
  <Show when={props.refs.length}>
    <div class="context-chips" role="list" aria-label="Attached context">
      <For each={props.refs}>{(ref) => <span class="context-chip" role="listitem" data-kind={ref.kind} title={`${contextBound(ref)}\n${ref.kind} ${ref.id} · host ${ref.host}`}>
        <span class="context-chip-kind">{ref.kind === "agent" ? "Agent" : "Session"}</span>
        <bdi class="context-chip-label">{ref.label}</bdi>
        <span class="context-chip-host" dir="ltr">{ref.host}</span>
        <button type="button" class="context-chip-remove" aria-label={`Remove context ${ref.label}`}
          onMouseDown={(event) => event.preventDefault()} onClick={() => props.remove(ref)}>×</button>
      </span>}</For>
      <Show when={props.note}>{(note) => <span class="context-chips-note" role="status">{note()}</span>}</Show>
    </div>
  </Show>
