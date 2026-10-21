import { Show } from "solid-js"
import type { CurrentWorkSnapshot } from "../current-work"
import { currentTodo, todoProvenance, type TodoTurn } from "../session-todos"
import { ago, useDashboard, type SessionRow } from "../state"
import "./todo-line.css"

export const turnOf = (snapshot: CurrentWorkSnapshot): TodoTurn => {
  const turn = snapshot.value?.turn
  const fresh = turn && !snapshot.error && Date.now() - snapshot.checked <= (turn.status === "busy" ? 15_000 : 45_000)
  return fresh ? { status: turn.status, startedAt: turn.started_at } : { status: "unknown" }
}

// The agent's own todo list, read from the session's todo API and todo.updated events.
export const TodoLine = (props: { session: Pick<SessionRow, "id" | "directory">; turn: TodoTurn }) => {
  const dashboard = useDashboard()
  const entry = () => dashboard.activity.todos.get(props.session.id)
  const todo = () => currentTodo(entry()?.directory === props.session.directory ? entry() : undefined)
  const provenance = () => todoProvenance(todo(), props.turn)
  const outdated = () => entry()?.state === "error" || !!dashboard.activity.error(props.session.id, props.session.directory)
  const count = () => { const value = todo(); return "total" in value ? `${value.done}/${value.total}` : "" }
  const label = () => todo().kind === "active" ? "In-progress TODO" : todo().kind === "next" ? "Next TODO" : "TODO"
  // State only what was observed: a list read, or an update received during this busy turn.
  const basis = () => {
    if (todo().kind !== "active" && todo().kind !== "next") return ""
    if (props.turn.status === "idle") return "agent idle"
    if (props.turn.status === "unknown") return "turn status unknown"
    return provenance() === "observed" ? "update observed this turn" : "no update observed this turn"
  }
  const meta = () => {
    const value = todo()
    return [
      value.kind === "next" ? "none in progress" : "",
      value.kind === "active" && value.more ? `+${value.more} more in progress` : "",
      value.kind === "active" || value.kind === "next" ? count() : "",
      basis(),
      "at" in value && value.at ? `received ${ago(value.at)}` : "",
      outdated() ? "may be outdated" : "",
    ].filter(Boolean).join(" · ")
  }
  return <div class="home-todo" data-todo={todo().kind} data-provenance={todo().kind === "active" || todo().kind === "next" ? provenance() : undefined}>
    <span class="home-todo-label">{label()}</span>
    <Show when={todo().kind === "active" || todo().kind === "next"} fallback={<span class="home-muted">{todo().kind === "loading" ? "Checking TODOs…" : todo().kind === "unavailable" ? "TODOs unavailable" : todo().kind === "none" ? "No TODO list" : `All ${count()} done`}</span>}>
      <bdi class="home-todo-text" dir="auto">{(todo() as { text: string }).text}</bdi>
    </Show>
    <span class="home-muted home-todo-meta">{meta()}</span>
  </div>
}

