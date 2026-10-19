/* Session todos (the todowrite tool's list): a compact inline row where each
 * todowrite call happens, and a session sidebar panel for the current list.
 * Glyphs follow the TUI: [✓] completed, [•] in progress, [ ] pending, [-] cancelled. */
import { createMemo, createSignal, For, Show } from "solid-js"
import type { Todo, ToolPart } from "@opencode-ai/sdk/v2"
import type { MessagePartProps } from "@opencode-ai/session-ui/message-part"

const glyph = (status: string) =>
  status === "completed" ? "✓" : status === "in_progress" ? "•" : status === "cancelled" ? "-" : " "

export const todoSummary = (todos: readonly Todo[]) => ({
  done: todos.filter((todo) => todo.status === "completed").length,
  total: todos.length,
  open: todos.some((todo) => todo.status === "pending" || todo.status === "in_progress"),
  active:
    todos.find((todo) => todo.status === "in_progress") ??
    todos.find((todo) => todo.status === "pending") ??
    todos.findLast((todo) => todo.status === "completed"),
})

export function TodoList(props: { todos: readonly Todo[] }) {
  return (
    <ul class="todo-list">
      <For each={props.todos}>
        {(todo) => (
          <li data-status={todo.status} data-priority={todo.priority}>
            <span class="todo-glyph" role="img" aria-label={todo.status.replace("_", " ")}>[{glyph(todo.status)}]</span>
            <span class="todo-content" dir="auto">{todo.content}</span>
          </li>
        )}
      </For>
    </ul>
  )
}

/* Inline transcript row for one todowrite call. Agents rewrite the list often,
 * so rows stay collapsed and render their checklist only when opened. */
export function TodoPart(props: MessagePartProps) {
  const todos = createMemo((): Todo[] => {
    const state = (props.part as ToolPart).state
    const value = ("metadata" in state ? state.metadata?.todos : undefined) ?? state.input?.todos
    return Array.isArray(value) ? value : []
  })
  const summary = createMemo(() => todoSummary(todos()))
  const [open, setOpen] = createSignal(false)
  return (
    <details class="todo-activity" data-tool="todowrite" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary class="activity-row">
        <span class="activity-kind">Todos</span>
        <span class="activity-description" dir="auto">
          <span class="todo-count">{summary().done}/{summary().total}</span>
          <Show when={summary().active}>{(active) => <> · {active().content}</>}</Show>
        </span>
        <span class="activity-disclosure" aria-hidden="true">›</span>
      </summary>
      <Show when={open()}>
        <div class="activity-details"><TodoList todos={todos()} /></div>
      </Show>
    </details>
  )
}

const OPEN_KEY = "es-app-todo-panel-open"
const [panelOpen, setPanelOpen] = createSignal(localStorage.getItem(OPEN_KEY) !== "false")

/* Current list in the session sidebar while any item is still open. */
export function TodoPanel(props: { todos: readonly Todo[] }) {
  const summary = createMemo(() => todoSummary(props.todos))
  const toggle = () => {
    const next = !panelOpen()
    localStorage.setItem(OPEN_KEY, String(next))
    setPanelOpen(next)
  }
  return (
    <Show when={summary().open}>
      <section class="todo-panel" aria-label="Todos" data-open={panelOpen() ? "true" : undefined}>
        <button class="todo-panel-head" aria-expanded={panelOpen()} onClick={toggle}>
          <span class="activity-kind">Todos</span>
          <span class="todo-count">{summary().done}/{summary().total}</span>
          <Show when={!panelOpen() && summary().active}>
            {(active) => <span class="todo-panel-active" dir="auto">{active().content}</span>}
          </Show>
          <span class="activity-disclosure" aria-hidden="true">›</span>
        </button>
        <Show when={panelOpen()}><TodoList todos={props.todos} /></Show>
      </section>
    </Show>
  )
}
