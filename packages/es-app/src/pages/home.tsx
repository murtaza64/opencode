/* Home = the es dashboard: attention queue + thread cards, from :7777. */
import { createMemo, createSignal, For, onMount, Show } from "solid-js"
import { A, useNavigate } from "@solidjs/router"
import { ago, jiraUrl, sessionHref, useDashboard } from "../state"
import { es as esApi } from "../api"
import { PrList } from "../components/pr"
import BriefBox from "../components/brief"
import { SessionIcon, TicketIcon } from "../components/icons"

function TicketRow(props: { tk: any }) {
  return (
    <div class="ticket-row">
      <a class="key" href={jiraUrl(props.tk.key)} target="_blank">
        <TicketIcon />
        {props.tk.key}
      </a>
      <span class="title">{props.tk.summary ?? ""}</span>
      <Show when={props.tk.status}>
        <span class={`chip ${props.tk.status === "In Progress" ? "inprogress" : ""}`}>{props.tk.status}</span>
      </Show>
      <Show when={props.tk.next_action}>
        <span class={`chip ${props.tk.next_action}`}>{props.tk.next_action}</span>
      </Show>
      <Show when={(props.tk.labels ?? []).includes("parked")}>
        <span class="chip parked">parked</span>
      </Show>
    </div>
  )
}

function ThreadCard(props: {
  t: any
  directory: string
  onDigest: (sid: string) => void
  onBrief: (ticket: string) => void
  briefing: string[]
}) {
  const { dotFor } = useDashboard()
  const s0 = () => props.t.sessions[0]
  const digest = () => props.t.digest?.result
  const laneStatuses = () =>
    props.t.lanes
      .filter((l: any) => l.status && !/^active$/.test(l.status))
      .map((l: any) => `${l.lane}: ${l.status}`)
      .join("\n")
  return (
    <div class="card" id={`t-${props.t.key}`}>
      <div class="head">
        <Show
          when={props.t.kind === "session" && s0()}
          fallback={
            <span class="title dim">{props.t.curated ? props.t.title : "no live session"}</span>
          }
        >
          <span class={`dot ${dotFor(s0())}`} />
          <A class="title" href={sessionHref(s0().id, s0().directory ?? props.directory)}>
            <SessionIcon />
            {props.t.title}
          </A>
          <span class="dim">
            {s0().live}
            {s0().updated ? ` · ${ago(s0().updated)}` : ""}
          </span>
          <button
            onClick={() => props.onDigest(s0().id)}
            disabled={s0().live === "busy" || s0().digesting}
          >
            {s0().digesting ? "…" : "digest"}
          </button>
        </Show>
        <Show when={props.t.curated_status}>
          <span class={`chip ${props.t.curated_status}`}>{props.t.curated_status}</span>
        </Show>
      </div>
      <Show when={props.t.description}>
        <div class="thread-desc">{props.t.description}</div>
      </Show>
      {/* curated threads can hold several sessions; s0 is in the head */}
      <Show when={props.t.sessions.length > 1}>
        <div class="more-sessions">
          <For each={props.t.sessions.slice(1)}>
            {(sv: any) => (
              <A href={sessionHref(sv.id, sv.directory ?? props.directory)}>
                <SessionIcon />
                {sv.title || sv.id}
              </A>
            )}
          </For>
        </div>
      </Show>
      <For each={props.t.tickets ?? []}>{(tk) => <TicketRow tk={tk} />}</For>
      <Show when={props.t.lanes.length}>
        <div class="lanes">
          <For each={props.t.lanes}>{(l: any) => <span class="lane-badge" title={l.status}>{l.lane}</span>}</For>
        </div>
      </Show>
      <Show when={laneStatuses()}>
        <div class="status-line">{laneStatuses()}</div>
      </Show>
      {/* a review brief replaces the digest display; the digest stays cached
          underneath for resume */}
      <Show
        when={props.t.brief}
        fallback={
          <Show when={digest()}>
            <div class="digest">
              {digest().digest}
              <Show when={digest().true_status}>
                {" "}
                <span class="chip">{digest().true_status}</span>
              </Show>
              <Show when={digest().needs_from_human?.length}>
                <ul class="needs">
                  <For each={digest().needs_from_human}>{(n: string) => <li>{n}</li>}</For>
                </ul>
              </Show>
              <Show when={digest().gates?.length}>
                <ul class="gates">
                  <For each={digest().gates}>
                    {(g: any) => (
                      <li>
                        {g.kind}: {g.ref} — {g.note}
                      </li>
                    )}
                  </For>
                </ul>
              </Show>
              <div class="meta">
                digested {ago(props.t.digest.generated_at * 1000)} · {props.t.digest.model}
              </div>
            </div>
          </Show>
        }
      >
        <BriefBox
          brief={props.t.brief}
          onRegen={() => props.onBrief(props.t.brief.ticket)}
          regenerating={props.briefing.includes(props.t.brief.ticket)}
        />
      </Show>
      <Show when={props.t.prs.length}>
        <div class="prs">
          <PrList prs={props.t.prs} />
        </div>
      </Show>
    </div>
  )
}

/* --- thread-grouped attention queue -------------------------------------- */

type QueueGroup = { key: string | null; thread: any | null; items: any[]; hottest: number; activity: number }

function QueueGroupHeader(props: { g: QueueGroup; directory: string }) {
  const t = () => props.g.thread
  const tickets = () => t()?.tickets ?? []
  const s0 = () => t()?.sessions?.[0]
  return (
    <div class="queue-head">
      <Show when={t()} fallback={<span class="dim">unassigned</span>}>
        <For each={tickets()}>
          {(tk: any) => (
            <a class="key" href={jiraUrl(tk.key)} target="_blank">
              <TicketIcon />
              {tk.key}
            </a>
          )}
        </For>
        <Show
          when={tickets().length}
          fallback={
            <Show when={s0()} fallback={<span class="title">{t().title}</span>}>
              <A class="title" href={sessionHref(s0().id, s0().directory ?? props.directory)}>
                <SessionIcon />
                {t().title}
              </A>
            </Show>
          }
        >
          <span class="title">{t().curated ? t().title : (tickets()[0].summary ?? t().title)}</span>
        </Show>
        <a class="card-link" href={`#t-${t().key}`}>
          card
        </a>
      </Show>
    </div>
  )
}

function QueueItem(props: {
  item: any
  group: QueueGroup
  directory: string
  briefing: string[]
  onBrief: (ticket: string) => void
  sessionLink: (item: any) => string | undefined
}) {
  const [open, setOpen] = createSignal(false)
  // the review gate's brief, when the group's thread carries one for this ticket
  const brief = () =>
    props.item.type === "review" && props.item.ticket && props.group.thread?.brief?.ticket === props.item.ticket
      ? props.group.thread.brief
      : undefined
  const generating = () => !!props.item.ticket && props.briefing.includes(props.item.ticket)
  return (
    <div class={`att r${props.item.rank}`}>
      <div class="att-line" classList={{ expandable: !!brief() }} onClick={() => brief() && setOpen(!open())}>
        <span class="type">{props.item.type}</span>
        <span class="att-text">
          <Show when={props.sessionLink(props.item)}>
            {(href) => (
              <A href={href()}>
                <SessionIcon />
                {props.group.thread?.sessions?.[0]?.title ?? "session"}{" "}
              </A>
            )}
          </Show>
          {props.item.detail}
          <Show when={props.item.subtitle}>
            <span class="subtitle">{props.item.subtitle}</span>
          </Show>
        </span>
        <Show when={brief()}>
          <span class="dim">{open() ? "▾" : "▸ brief"}</span>
        </Show>
        <Show when={!brief() && generating()}>
          <span class="dim">brief…</span>
        </Show>
      </div>
      <Show when={open() && brief()}>
        <BriefBox brief={brief()} onRegen={() => props.onBrief(props.item.ticket)} regenerating={generating()} />
      </Show>
    </div>
  )
}

function Queue(props: {
  attention: any[]
  threads: any[]
  directory: string
  briefing: string[]
  onBrief: (ticket: string) => void
}) {
  const groups = createMemo<QueueGroup[]>(() => {
    const byKey = new Map<string, any>(props.threads.map((t: any) => [t.key, t]))
    const map = new Map<string | null, QueueGroup>()
    for (const item of props.attention) {
      const key = item.thread ?? null
      let g = map.get(key)
      if (!g) {
        const thread = key ? byKey.get(key) : null
        g = { key, thread, items: [], hottest: 99, activity: thread?.activity ?? 0 }
        map.set(key, g)
      }
      g.items.push(item)
      g.hottest = Math.min(g.hottest, item.rank)
    }
    // hottest item rank first, then thread activity
    return [...map.values()].sort((a, b) => a.hottest - b.hottest || b.activity - a.activity)
  })

  const sessionLink = (item: any) => {
    if (!item.session) return undefined
    const t = props.threads.find((t: any) => t.sessions.some((s: any) => s.id === item.session))
    const s = t?.sessions.find((s: any) => s.id === item.session)
    return s ? sessionHref(s.id, s.directory ?? props.directory) : undefined
  }

  return (
    <div class="attention">
      <Show when={groups().length} fallback={<div class="dim">nothing — go touch grass</div>}>
        <For each={groups()}>
          {(g) => (
            <div class="queue-group" id={g.key ? `q-${g.key}` : undefined}>
              <QueueGroupHeader g={g} directory={props.directory} />
              <For each={g.items}>
                {(item) => (
                  <QueueItem
                    item={item}
                    group={g}
                    directory={props.directory}
                    briefing={props.briefing}
                    onBrief={props.onBrief}
                    sessionLink={sessionLink}
                  />
                )}
              </For>
            </div>
          )}
        </For>
      </Show>
    </div>
  )
}

function AllSessions() {
  // the dashboard collects sessions from every anchor dir (incl. single-repo
  // sidecars' on-disk repo) — richer than any single daemon directory query
  const { state } = useDashboard()
  const sessions = () => (state()?.sessions ?? []) as any[]
  const [open, setOpen] = createSignal(false)
  return (
    <>
      <h2 style="cursor:pointer" onClick={() => setOpen(!open())}>
        All sessions {open() ? "▾" : "▸"} <span class="dim">({sessions().length})</span>
      </h2>
      <Show when={open()}>
        <div class="session-list">
          <For each={sessions()}>
            {(s) => (
              <div class="pr">
                <A href={sessionHref(s.id, s.directory)}>
                  <SessionIcon />
                  {s.title || s.id}
                </A>
                <span class="dim">
                  {s.directory?.split("/").slice(-1)[0]} · {ago(s.updated)}
                </span>
              </div>
            )}
          </For>
        </div>
      </Show>
    </>
  )
}

/* Front desk composer: one ask opens the concierge session (a normal session
 * view). A busy front desk absorbs the ask — we navigate to it either way. */
function FrontDesk() {
  const { editspace } = useDashboard()
  const navigate = useNavigate()
  const [q, setQ] = createSignal("")
  const [busy, setBusy] = createSignal(false)
  const ask = async (e: Event) => {
    e.preventDefault()
    const question = q().trim()
    if (!question || busy()) return
    setBusy(true)
    try {
      const res = await esApi.frontdesk(question, editspace())
      navigate(sessionHref(res.session, res.directory))
    } catch (err) {
      alert(String(err))
    } finally {
      setBusy(false)
    }
  }
  return (
    <form class="frontdesk" onSubmit={ask}>
      <input
        value={q()}
        onInput={(e) => setQ(e.currentTarget.value)}
        placeholder="ask the front desk — who/what/why about anything in flight"
      />
      <button type="submit" disabled={busy() || !q().trim()}>
        {busy() ? "asking…" : "ask"}
      </button>
    </form>
  )
}

export default function Home() {
  const dashboard = useDashboard()
  const state = dashboard.state
  const [refreshing, setRefreshing] = createSignal(false)

  // deep links from the session view's needs-you land on a queue group
  onMount(() => {
    if (location.hash) document.querySelector(location.hash)?.scrollIntoView()
  })

  const refresh = async () => {
    setRefreshing(true)
    try {
      await dashboard.refresh()
    } finally {
      setRefreshing(false)
    }
  }

  const digest = async (sid: string) => {
    try {
      await dashboard.digest(sid)
    } catch (e) {
      alert(String(e))
    }
  }

  const brief = async (ticket: string) => {
    try {
      await dashboard.brief(ticket)
    } catch (e) {
      alert(String(e))
    }
  }

  const [curating, setCurating] = createSignal(false)
  const curate = async () => {
    setCurating(true)
    try {
      await dashboard.curate()
    } catch (e) {
      alert(String(e))
    } finally {
      setCurating(false)
    }
  }

  return (
    <Show when={state()} fallback={<div class="dim">loading… (is es-dashboard running on :7777?)</div>}>
      {(st) => (
        <main>
          <header class="topbar">
            <h1>{st().editspace}</h1>
            <span class="dim">
              updated {ago(st().generated_at * 1000)} · tracker {st().tracker_at ? ago(st().tracker_at * 1000) : "never"} · prs{" "}
              {st().prs_at ? ago(st().prs_at * 1000) : "never"}
            </span>
            <span class="err">
              {[st().tracker_error && `tracker: ${st().tracker_error}`, st().prs_error && `prs: ${st().prs_error}`]
                .filter(Boolean)
                .join(" · ")}
            </span>
            <span style="flex:1" />
            <Show when={st().curated_at}>
              <span class="dim">curated {ago(st().curated_at * 1000)}</span>
            </Show>
            <button onClick={curate} disabled={curating() || st().curating}>
              {curating() || st().curating ? "curating…" : "curate"}
            </button>
            <button onClick={refresh} disabled={refreshing()}>
              {refreshing() ? "refreshing…" : "refresh"}
            </button>
          </header>

          <FrontDesk />

          <h2>Needs you</h2>
          <Queue
            attention={st().attention}
            threads={st().threads}
            directory={st().root}
            briefing={st().briefing ?? []}
            onBrief={brief}
          />

          <h2>Threads</h2>
          <div class="grid">
            <For each={st().threads}>
              {(t: any) => (
                <ThreadCard
                  t={t}
                  directory={st().root}
                  onDigest={digest}
                  onBrief={brief}
                  briefing={st().briefing ?? []}
                />
              )}
            </For>
          </div>

          <h2>Unattached PRs</h2>
          <div>
            <Show when={st().unattached_prs.length} fallback={<span class="dim">none</span>}>
              <PrList prs={st().unattached_prs} />
            </Show>
          </div>

          <AllSessions />

          <h2>Frontier</h2>
          <Show when={st().frontier.length} fallback={<span class="dim">empty</span>}>
            <table>
              <For each={st().frontier}>
                {(f: any) => (
                  <tr>
                    <td>
                      <a href={jiraUrl(f.key)} target="_blank">
                        {f.key}
                      </a>
                    </td>
                    <td class="dim">{f.issue_type}</td>
                    <td>{f.summary}</td>
                  </tr>
                )}
              </For>
            </table>
          </Show>
        </main>
      )}
    </Show>
  )
}
