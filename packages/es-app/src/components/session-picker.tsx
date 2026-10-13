import { For, Show } from "solid-js"
import { ago, type SessionRow } from "../state"

export const SessionPicker = (props: { rows: SessionRow[]; selected: number; select: (index: number) => void; insert: (row: SessionRow) => void }) => (
  <div class="session-picker" role="listbox" aria-label="Sessions">
    <div class="session-picker-head">Sessions</div>
    <Show when={props.rows.length} fallback={<div class="session-picker-empty">No matches</div>}>
      <For each={props.rows}>{(row, index) => (
        <div role="option" aria-selected={index() === props.selected} class="session-picker-row"
          onMouseDown={(event) => { event.preventDefault(); props.insert(row) }}
          onMouseEnter={() => props.select(index())}>
          <div dir="auto"><Show when={row.live === "busy" || row.live === "retry"}><span class="session-picker-live" /></Show>{row.title || row.id}</div>
          <div class="session-picker-meta" dir="auto">{row.project || row.directory.split("/").filter(Boolean).at(-1) || row.directory} · {ago(row.updated)}</div>
        </div>
      )}</For>
    </Show>
  </div>
)
