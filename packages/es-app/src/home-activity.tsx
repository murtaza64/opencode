import { createMemo, createResource, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { es } from "./api"
import { ago, linkUrl, sessionHref, useDashboard } from "./state"
import { mailActivity, prActivity, type HomeActivityRow } from "./home-activity-data"

export default function HomeActivity(props: { cloud?: HomeActivityRow[] }) {
  const dashboard = useDashboard()
  const [open, setOpen] = createSignal(false)
  const [filter, setFilter] = createSignal("all")
  const [now, setNow] = createSignal(Date.now())
  onMount(() => { const interval = setInterval(() => setNow(Date.now()), 30_000); onCleanup(() => clearInterval(interval)) })
  const age = (time: number) => { now(); return ago(time) }
  const targets = createMemo(() => dashboard.pinnedSessions().slice(0, 4).flatMap(session => {
    const project = dashboard.editspaces()?.editspaces.find(item => {
      const root = item.root.replace(/\/+$/, "").replace(/\/\.editspace$/, "")
      return session.directory === root || session.directory.startsWith(`${root}/`)
    })?.name
    return project ? [{ project, session: session.id, directory: session.directory }] : []
  }))
  const [mail, { refetch }] = createResource(() => open() ? { targets: targets(), revision: dashboard.mailRevision() } : false, async source => {
    const result = await Promise.all(source.targets.map(async target => {
      try {
        const result = await es.mail(target.project, { session: target.session })
        return { messages: result.messages.slice(-40).map(message => ({ ...mailActivity(message, target.project, Date.now()), href: sessionHref(target.session, target.directory) })), error: "" }
      } catch { return { messages: [] as HomeActivityRow[], error: `${target.project}: mail unavailable` } }
    }))
    return { rows: [...new Map(result.flatMap(item => item.messages).map(item => [item.id, item])).values()], errors: [...new Set(result.map(item => item.error).filter(Boolean))] }
  })
  const prs = createMemo(() => {
    const snapshot = dashboard.state() as { editspace?: string; prs_at?: number; prs_error?: string; threads?: { prs?: unknown[] }[]; unattached_prs?: unknown[] } | undefined
    return [...(snapshot?.threads ?? []).flatMap(thread => thread.prs ?? []), ...(snapshot?.unattached_prs ?? [])].flatMap(pr => prActivity(pr, (snapshot?.prs_at ?? 0) * 1000, snapshot?.editspace ?? "selected project"))
  })
  const rows = createMemo(() => [...new Map([...prs(), ...(mail()?.rows ?? []), ...(props.cloud ?? [])].map(item => [item.id, item])).values()]
    .filter(item => filter() === "all" || (filter() === "mail" ? item.kind === "mail" : item.level === filter()))
    .sort((a, b) => (Number.isFinite(b.time) ? b.time : 0) - (Number.isFinite(a.time) ? a.time : 0)).slice(0, 30))
  return <details class="home-activity" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>Activity</summary>
    <Show when={open()}><div class="home-activity-bar"><div class="home-tabs" role="group" aria-label="Activity filter"><For each={[["all", "All"], ["major", "Major"], ["minor", "Minor"], ["mail", "Mail"]]}>{([value, label]) => <button aria-pressed={filter() === value} onClick={() => setFilter(value)}>{label}</button>}</For></div><button disabled={mail.loading} onClick={() => refetch()}>Refresh mail</button></div>
      <p class="home-source">Up to 30 recent entries. Mail samples {targets().length} pinned agent{targets().length === 1 ? "" : "s"} (max 4); PRs use the already-loaded project cache. Activity never adds a decision.</p>
      <Show when={mail()?.errors.length}><p class="home-source">{mail()?.errors.join(" · ")}</p></Show>
      <For each={rows()} fallback={<p class="home-muted">{mail.loading ? "Loading…" : "No activity in these sources and filters."}</p>}>{item => <div class="home-activity-row"><span class={`home-activity-level ${item.level}`}>{item.level} · {item.kind}</span><div><Show when={item.href} fallback={<span dir="auto">{item.text}</span>}>{href => <a href={linkUrl(href())}><bdi dir="auto">{item.text}</bdi></a>}</Show><div class="home-source">{item.source} · {item.sourceAt ? `checked ${age(item.sourceAt)}` : "freshness unknown"} · {item.time ? `${item.timeLabel} ${age(item.time)}` : "time unknown"}</div></div></div>}</For>
    </Show>
  </details>
}
