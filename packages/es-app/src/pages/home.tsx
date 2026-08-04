/* Home = the es dashboard: attention queue + thread cards, from :7777. */
import { createResource, createSignal, For, Show } from "solid-js"
import { A } from "@solidjs/router"
import { oc } from "../api"
import { ago, jiraUrl, sessionHref, useDashboard } from "../state"
import { PrList } from "../components/pr"

function TicketRow(props: { tk: any }) {
  return (
    <div class="ticket-row">
      <a class="key" href={jiraUrl(props.tk.key)} target="_blank">
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

function ThreadCard(props: { t: any; directory: string; onDigest: (sid: string) => void }) {
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
          fallback={<span class="title dim">no live session</span>}
        >
          <span class={`dot ${dotFor(s0())}`} />
          <A class="title" href={sessionHref(s0().id, s0().directory ?? props.directory)}>
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
      </div>
      <For each={props.t.tickets ?? []}>{(tk) => <TicketRow tk={tk} />}</For>
      <Show when={props.t.lanes.length}>
        <div class="lanes">
          <For each={props.t.lanes}>{(l: any) => <span class="lane-badge" title={l.status}>{l.lane}</span>}</For>
        </div>
      </Show>
      <Show when={laneStatuses()}>
        <div class="status-line">{laneStatuses()}</div>
      </Show>
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
      <Show when={props.t.prs.length}>
        <div class="prs">
          <PrList prs={props.t.prs} />
        </div>
      </Show>
    </div>
  )
}

function AllSessions(props: { root: string }) {
  // umbrella listing is fork-only; fall back to the root directory's sessions
  const [sessions] = createResource(async () => {
    const list = await oc.umbrellaSessions(props.root).catch(() => oc.sessions(props.root))
    return list
      .filter((s) => !s.parentID)
      .sort((a, b) => (b.time?.updated ?? 0) - (a.time?.updated ?? 0))
      .slice(0, 40)
  })
  const [open, setOpen] = createSignal(false)
  return (
    <>
      <h2 style="cursor:pointer" onClick={() => setOpen(!open())}>
        All sessions {open() ? "▾" : "▸"} <span class="dim">({sessions()?.length ?? "…"})</span>
      </h2>
      <Show when={open()}>
        <div class="session-list">
          <For each={sessions() ?? []}>
            {(s) => (
              <div class="pr">
                <A href={sessionHref(s.id, s.directory)}>{s.title || s.id}</A>
                <span class="dim">
                  {s.directory?.split("/").slice(-1)[0]} · {ago(s.time?.updated)}
                </span>
              </div>
            )}
          </For>
        </div>
      </Show>
    </>
  )
}

export default function Home() {
  const dashboard = useDashboard()
  const state = dashboard.state
  const [refreshing, setRefreshing] = createSignal(false)

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

  const attentionHref = (item: any) => {
    if (item.session) {
      const t = state()?.threads.find((t: any) => t.sessions.some((s: any) => s.id === item.session))
      const s = t?.sessions.find((s: any) => s.id === item.session)
      if (s) return sessionHref(s.id, s.directory ?? state()?.root)
    }
    return item.thread ? `#t-${item.thread}` : undefined
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
            <button onClick={refresh} disabled={refreshing()}>
              {refreshing() ? "refreshing…" : "refresh"}
            </button>
          </header>

          <h2>Needs you</h2>
          <div class="attention">
            <Show when={st().attention.length} fallback={<div class="dim">nothing — go touch grass</div>}>
              <For each={st().attention}>
                {(i: any) => (
                  <div class={`att r${i.rank}`}>
                    <span class="type">{i.type}</span>
                    <span>
                      <Show when={attentionHref(i)}>
                        {(href) =>
                          href().startsWith("#") ? (
                            <a href={href()}>{i.thread} </a>
                          ) : (
                            <A href={href()}>{i.thread ?? "session"} </A>
                          )
                        }
                      </Show>
                      {i.detail}
                    </span>
                  </div>
                )}
              </For>
            </Show>
          </div>

          <h2>Threads</h2>
          <div class="grid">
            <For each={st().threads}>{(t: any) => <ThreadCard t={t} directory={st().root} onDigest={digest} />}</For>
          </div>

          <h2>Unattached PRs</h2>
          <div>
            <Show when={st().unattached_prs.length} fallback={<span class="dim">none</span>}>
              <PrList prs={st().unattached_prs} />
            </Show>
          </div>

          <AllSessions root={st().root} />

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
