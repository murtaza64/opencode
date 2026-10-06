/* Right panel on the session page: identity, spend, editspace joins (lane,
 * tickets, PRs via the dashboard's thread model), tracker tickets and docs
 * this session references, and links shared in the conversation. */
import { createEffect, createMemo, createResource, createSignal, For, Show } from "solid-js"
import { A } from "@solidjs/router"
import type { Message, Part, Session } from "@opencode-ai/sdk/v2"
import { es, type IssueRow } from "../api"
import { ago, useDashboard } from "../state"
import { refFromHref, ticketMatchesRef, ticketUrl } from "../ticket-url"
import { docHref } from "../pages/doc"
import { TicketIcon } from "./icons"
import { rightOpen, rightWidth, toggleRight } from "../ui"
import { Pr } from "./pr"
import { prFromHref } from "../pr-matching"
import { linkUrl } from "../link-url"
import { compactTokens, contextUsage, countCompletedTurns, latestCompletedTurn, usageLevel, type ProviderList } from "../context-usage"
import { compositionSlices, estimateComposition } from "../context-composition"
import { accountingGist, CompositionBar, ProviderAccounting } from "./context-viz"
import { prDetail, requestPrDetails } from "../pr-details"

const URL_RE = /https?:\/\/[^\s)\]}"'`>]+/g
// #N / repo#N / owner/repo#N mentions and markdown-ish path tokens
const ISSUE_NUM_RE = /(?:^|[^\w/])([\w./-]*#\d+)\b/g
const MD_PATH_RE = /(?:^|[\s"'`(\[])((?:~\/|\/)?[\w./-]+\.md)\b/g

const compact = (n?: number) => {
  if (!n) return "0"
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`
  return `${(n / 1_000_000).toFixed(1)}M`
}

const home = (p: string) => p.replace(/^\/Users\/[^/]+/, "~")

// per-client memory of the provider-accounting disclosure; collapsed unless the user opened it
const ACCOUNTING_KEY = "es-app-ctx-accounting-open"
const [accountingOpen, setAccountingOpenRaw] = createSignal(localStorage.getItem(ACCOUNTING_KEY) === "1")
const setAccountingOpen = (open: boolean) => {
  localStorage.setItem(ACCOUNTING_KEY, open ? "1" : "0")
  setAccountingOpenRaw(open)
}

export default function SessionInfo(props: {
  sessionID: string
  session?: Session
  messages: Message[]
  parts: Record<string, Part[]>
  providers?: ProviderList
}) {
  return (
    <Show
      when={rightOpen()}
      fallback={
        <aside class="session-info sidebar-mini">
          <button class="mini-btn" title="expand info panel (^l)" onClick={toggleRight}>
            ⟨
          </button>
        </aside>
      }
    >
      <SessionInfoBody {...props} />
    </Show>
  )
}

/** every scannable string in the transcript: text parts plus tool-call file
 * path inputs (a Read of prds/x.md is the strongest doc reference there is) */
function transcriptStrings(parts: Record<string, Part[]>): { texts: string[]; toolPaths: string[] } {
  const texts: string[] = []
  const toolPaths: string[] = []
  for (const list of Object.values(parts)) {
    for (const part of list) {
      if (part.type === "text") {
        const text = (part as any).text
        if (text) texts.push(text)
      } else if (part.type === "tool") {
        const input = (part as any).state?.input ?? {}
        for (const key of ["filePath", "file_path", "path", "notebook_path"]) {
          if (typeof input[key] === "string") toolPaths.push(input[key])
        }
      }
    }
  }
  return { texts, toolPaths }
}

function SessionInfoBody(props: {
  sessionID: string
  session?: Session
  messages: Message[]
  parts: Record<string, Part[]>
  providers?: ProviderList
}) {
  const { state, editspace, allProjects } = useDashboard()

  const thread = createMemo(() =>
    (state()?.threads ?? []).find((t: any) => t.sessions.some((s: any) => s.id === props.sessionID)),
  )

  // tracker issues + doc sources of the current editspace, for reference
  // matching (dotfiles#79); soft-fail so the panel renders without a tracker
  const resourceSource = () => allProjects() && !thread() ? false : editspace() ?? ""
  const [issueList] = createResource(
    resourceSource,
    (name) => es.issues(name || undefined).catch(() => undefined),
  )
  const [docList] = createResource(
    resourceSource,
    (name) => es.docs(name || undefined).catch(() => undefined),
  )

  const sessionParts = createMemo(() => Object.fromEntries(props.messages
    .filter((message) => message.sessionID === props.sessionID)
    .map((message) => [message.id, props.parts[message.id] ?? []])))
  const scanned = createMemo(() => transcriptStrings(sessionParts()))

  // tracker tickets this session references: the lane's claimed issue plus
  // transcript mentions (#N for gh; issues/<feature>/NN-*.md pointers for
  // markdown trackers), matched against the real issue list — never guessed
  const referencedTickets = createMemo<IssueRow[]>(() => {
    if (resourceSource() === false || issueList.loading) return []
    const rows = issueList()?.issues ?? []
    if (!rows.length) return []
    const { texts } = scanned()
    const lanePointers = (thread()?.lanes ?? []).map((l: any) => l.issue ?? "")
    const haystack = [...texts, ...lanePointers]
    const refs = new Set<string>()
    const mdRefs = new Set<string>()
    for (const text of haystack) {
      for (const m of text.matchAll(ISSUE_NUM_RE)) refs.add(m[1])
      for (const url of text.match(URL_RE) ?? []) {
        const ref = refFromHref(url)
        if (ref) refs.add(ref)
      }
      for (const m of text.matchAll(MD_PATH_RE)) {
        const p = m[1].replace(/^.*?(issues\/)/, "$1")
        if (p.startsWith("issues/")) mdRefs.add(p)
      }
    }
    const claimed = new Set(
      (thread()?.lanes ?? []).map((l: any) => `agent:${l.lane}`),
    )
    return rows.filter(
      (row) =>
        (row.url ? [...refs].some((ref) => ticketMatchesRef(ref, row)) : mdRefs.has(row.ref)) ||
        row.claims.some((c) => claimed.has(c)),
    )
  })

  // docs this session touched or mentioned, mapped to viewer targets:
  // absolute tool paths resolve through the doc-source roots table (lane
  // workspace paths fold into their repo source); bare relative mentions
  // ("prds/x.md") assume the first repo source
  const referencedDocs = createMemo(() => {
    if (resourceSource() === false || docList.loading) return []
    const roots = docList()?.roots ?? []
    if (!roots.length) return []
    const home = roots[0].root.match(/^\/Users\/[^/]+/)?.[0] ?? ""
    const repoSource = docList()?.sources.find((s) => s.kind === "repo")?.key
    const out = new Map<string, { source: string; path: string }>()
    const add = (source: string, path: string) => {
      if (path.startsWith("issues/")) return // tracker files are tickets
      out.set(`${source}:${path}`, { source, path })
    }
    const { texts, toolPaths } = scanned()
    for (const raw of toolPaths) {
      const abs = raw.replace(/^~(?=\/)/, home)
      if (!abs.endsWith(".md")) continue
      const hit = roots.find((r) => abs.startsWith(r.root + "/"))
      if (hit) add(hit.source, abs.slice(hit.root.length + 1))
    }
    for (const text of texts) {
      for (const m of text.matchAll(MD_PATH_RE)) {
        const raw = m[1]
        if (raw.startsWith("/") || raw.startsWith("~/")) {
          const abs = raw.replace(/^~(?=\/)/, home)
          const hit = roots.find((r) => abs.startsWith(r.root + "/"))
          if (hit) add(hit.source, abs.slice(hit.root.length + 1))
        } else if (raw.includes("/") && repoSource) {
          add(repoSource, raw.replace(/^\.\//, ""))
        }
      }
    }
    return [...out.values()].slice(0, 20)
  })

  // open attention items for this thread only; renders nothing when empty
  const needsYou = createMemo(() => {
    const key = thread()?.key
    if (!key) return []
    return (state()?.attention ?? []).filter((i: any) => i.thread === key)
  })

  const links = createMemo(() => {
    const seen = new Map<string, string>()
    for (const parts of Object.values(sessionParts())) {
      for (const part of parts) {
        if (part.type !== "text") continue
        for (const raw of (part as any).text?.match(URL_RE) ?? []) {
          const url = raw.replace(/[.,;:]+$/, "")
          if (url.startsWith("http://127.0.0.1") || url.startsWith("http://localhost")) continue
          seen.set(url, url)
        }
      }
    }
    return [...seen.keys()].slice(-25).reverse()
  })

  // PRs cited in this session's text and completed tool output, counted by
  // mention: one count per part a PR appears in (copies of the same URL within
  // one part don't inflate it). Ranked by count, ties in first-mention order.
  const linkedPrs = createMemo(() => {
    const found = new Map<string, { repo: string; number: number; url: string; mentions: number; first: number }>()
    let order = 0
    for (const parts of Object.values(sessionParts())) {
      for (const part of parts) {
        const text = part.type === "text" ? part.text : part.type === "tool" &&
          part.state.status === "completed" ? part.state.output : ""
        const inPart = new Set<string>()
        for (const raw of text.match(URL_RE) ?? []) {
          const pr = prFromHref(raw.replace(/[.,;:]+$/, ""))
          if (!pr || inPart.has(pr.url)) continue
          inPart.add(pr.url)
          const existing = found.get(pr.url)
          if (existing) existing.mentions++
          else found.set(pr.url, { ...pr, mentions: 1, first: order++ })
        }
      }
    }
    return [...found.values()].sort((a, b) => b.mentions - a.mentions || a.first - b.first)
  })

  const richPrs = createMemo(() => new Map<string, any>((thread()?.prs ?? []).flatMap((pr: { url: string }) => {
    const ref = prFromHref(pr.url)
    return ref ? [[ref.url, pr] as const] : []
  })))

  // cited PRs first (by rank), then dashboard-only PRs; every chip renders
  // the same component with whatever real data exists: dashboard record,
  // on-demand detail (dotfiles#139), or the bare reference while loading
  const prs = createMemo(() => {
    const cited = linkedPrs().map((ref) => ({ ref, mentions: ref.mentions, data: richPrs().get(ref.url) ?? prDetail(ref.url), cited: true }))
    const seen = new Set(cited.map((p) => p.ref.url))
    const dashboardOnly = [...richPrs().entries()].filter(([url]) => !seen.has(url))
      .map(([url, data]) => ({ ref: prFromHref(url)!, mentions: 0, data, cited: false }))
    const all = [...cited, ...dashboardOnly]
    // compact labels drop the owner; keep it when two owners share a repo name
    const owners = new Map<string, Set<string>>()
    for (const pr of all) {
      const [owner, name] = pr.ref.repo.split("/")
      owners.set(name!, (owners.get(name!) ?? new Set()).add(owner!))
    }
    return all.map((pr) => ({ ...pr, compact: (owners.get(pr.ref.repo.split("/")[1]!)?.size ?? 1) === 1 }))
  })

  // enrich cited PRs the dashboard doesn't know, highest-ranked first, bounded
  const ENRICH_LIMIT = 30
  createEffect(() => {
    const missing = linkedPrs().filter((ref) => !richPrs().has(ref.url)).slice(0, ENRICH_LIMIT).map((ref) => ref.url)
    if (missing.length) requestPrDetails(missing)
  })

  // exact latest-turn usage plus the estimated composition of the context
  // still represented (since the last compaction when one exists)
  const latestTurn = createMemo(() => latestCompletedTurn(props.messages.filter((m) => m.sessionID === props.sessionID)))
  const usage = createMemo(() => contextUsage(latestTurn(), props.providers))
  const turns = createMemo(() => countCompletedTurns(props.messages.filter((m) => m.sessionID === props.sessionID)))
  const composition = createMemo(() => estimateComposition(props.messages.filter((m) => m.sessionID === props.sessionID), props.parts))
  const slices = createMemo(() => compositionSlices(composition()))

  const tokens = () => (props.session as any)?.tokens

  return (
    <aside class="session-info" style={{ width: `${rightWidth()}px` }}>
      <button class="mini-btn panel-collapse" title="collapse info panel (^l)" onClick={toggleRight}>
        ⟩
      </button>
      <Show when={needsYou().length}>
        <div class="info-section">
          <div class="info-heading">needs you</div>
          <For each={needsYou()}>
            {(i: any) => (
              <div class="needs-you-row" title={i.detail}>
                <span class={`att-mini r${i.rank}`}>{i.type}</span>
                <a href={`/#q-${thread().key}`}>{i.detail}</a>
              </div>
            )}
          </For>
        </div>
      </Show>
      <Show when={props.session}>
        {(s) => (
          <>
            <div class="info-section">
              <div class="info-heading">session</div>
              <div class="info-row">
                <span class="dim">agent</span>
                <span>{(s() as any).agent ?? "?"}</span>
              </div>
              <Show when={(s() as any).model}>
                <div class="info-row">
                  <span class="dim">model</span>
                  <span>{(s() as any).model.id}</span>
                </div>
              </Show>
              <div class="info-row">
                <span class="dim">cost</span>
                <span>${((s() as any).cost ?? 0).toFixed(2)}</span>
              </div>
              <Show when={tokens()}>
                <div class="info-row" title="lifetime session totals, not current context">
                  <span class="dim">tok total</span>
                  <span>
                    {compact(tokens().input)} in · {compact(tokens().output)} out
                  </span>
                </div>
              </Show>
              <div class="info-row">
                <span class="dim">updated</span>
                <span>{ago(s().time?.updated)}</span>
              </div>
              <div class="info-row cwd" title={s().directory}>
                <span class="dim">cwd</span>
                <span>{home(s().directory ?? "")}</span>
              </div>
            </div>
          </>
        )}
      </Show>

       <Show when={props.session || props.messages.some((m) => m.sessionID === props.sessionID)}>
        <div class="info-section" data-section="context">
          <div class="info-heading">context</div>
          <div class="info-row">
            <span class="dim">turns</span>
            <span title="completed assistant turns">{turns()} completed</span>
          </div>
          <Show when={latestTurn()}>{(t) => (
            <Show when={props.session && (props.session as any).model?.id && (props.session as any).model.id !== t().modelID}>
              <div class="info-row" title="model of the latest completed turn differs from the session model">
                <span class="dim">latest</span>
                <span class="mono" dir="ltr">{t().modelID}</span>
              </div>
            </Show>
          )}</Show>
          <div class={`ctx-exact ${usageLevel(usage()?.percent)}`} title="context of the latest completed turn (input + output + reasoning + cache), exact provider count">
            <Show when={usage()} fallback={<span class="dim">latest turn context unknown</span>}>{(u) => (
              <>
                <span class="mono">
                  {compactTokens(u().tokens)}
                  <Show when={u().limit} fallback={<span class="dim"> · limit unknown</span>}>
                    {" / "}{compactTokens(u().limit!)} ({u().percent}%)
                  </Show>
                </span>
                <span class="ctx-exact-meta">exact · latest turn</span>
              </>
            )}</Show>
          </div>
           {/* exact per-class counts collapse by default: cache read is usually ~100% and the
             * five-row table otherwise dominates the panel; the gist keeps the key numbers visible */}
           <details class="ctx-accounting-disclosure" open={accountingOpen()}>
             {/* drive the state ourselves so persistence is synchronous with the click/Enter, not the queued toggle event */}
             <summary aria-label="exact latest-turn provider accounting"
               onClick={(event) => { event.preventDefault(); setAccountingOpen(!accountingOpen()) }}>
               <span class="ctx-subheading">provider accounting</span>
               <span class="ctx-gist mono" dir="ltr">{usage() ? accountingGist(latestTurn()?.tokens) : "unknown"}</span>
             </summary>
             <ProviderAccounting tokens={usage() ? latestTurn()?.tokens : null} heading={false} />
           </details>
           <div class="ctx-subheading">estimated visible content</div>
           <Show when={slices().length} fallback={<div class="ctx-caption">visible estimate unknown or empty</div>}>
             <CompositionBar slices={slices()} />
           </Show>
           <div class="ctx-caption">
             {composition().basis === "since_compaction" ? "since the last completed compaction" : "full stored visible history (no completed compaction marker)"}
             {" · chars ÷ 4; shares of visible estimate only. System/developer instructions, hidden context, compaction, cache and provider tokenization cannot be precisely allocated from stored parts."}
           </div>
        </div>
      </Show>

      <Show when={thread()?.lanes?.length}>
        <div class="info-section">
          <div class="info-heading">lanes</div>
          <For each={thread().lanes}>
            {(l: any) => (
              <div class="info-row" title={l.status}>
                <span class="lane-badge">{l.lane}</span>
              </div>
            )}
          </For>
        </div>
      </Show>

      <Show when={thread()?.tickets?.length}>
        <div class="info-section">
          <div class="info-heading">tickets</div>
          <For each={thread().tickets}>
            {(tk: any) => (
              <div class="info-row">
                <a href={linkUrl(ticketUrl(tk.key, tk.url))} target="_blank">
                  <TicketIcon />
                  {tk.key}
                </a>
                <Show when={tk.status}>
                  <span class="chip">{tk.status}</span>
                </Show>
              </div>
            )}
          </For>
        </div>
      </Show>

      <Show when={referencedTickets().length}>
        <div class="info-section">
          <div class="info-heading">tickets referenced</div>
          <For each={referencedTickets()}>
            {(row) => (
              <A
                class="info-ref"
                href={`/issue?ref=${encodeURIComponent(row.ref)}`}
                title={`${row.title}${row.markers.length ? ` [${row.markers.join(", ")}]` : ""}`}
              >
                <span class="issue-ref">
                  <TicketIcon />
                  {row.url ? `#${row.number}` : (row.ref.split("/").pop() ?? row.ref).replace(/\.md$/, "")}
                </span>
                <span class="ref-title">{row.title}</span>
                <Show when={row.markers[0] ?? (row.claims.length ? "claimed" : "")}>
                  {(m) => <span class={`issue-marker ${m()}`}>{m()}</span>}
                </Show>
              </A>
            )}
          </For>
        </div>
      </Show>

      <Show when={referencedDocs().length}>
        <div class="info-section">
          <div class="info-heading">docs referenced</div>
          <For each={referencedDocs()}>
            {(d) => (
              <A class="info-ref" href={docHref(d.source, d.path)} title={`${d.source} · ${d.path}`}>
                <span class="ref-title mono">{d.path}</span>
              </A>
            )}
          </For>
        </div>
      </Show>

      <Show when={prs().length}>
        <div class="info-section" data-section="prs">
          <div class="info-heading">PRs referenced</div>
          <For each={prs()}>{(pr) => (
            <Pr pr={pr.data ?? { repo: pr.ref.repo, number: pr.ref.number, url: pr.ref.url }} compact={pr.compact} mentions={pr.mentions} />
          )}</For>
        </div>
      </Show>

      <Show when={thread()?.digest?.result?.true_status}>
        <div class="info-section">
          <div class="info-heading">digest status</div>
          <span class="chip">{thread().digest.result.true_status}</span>
        </div>
      </Show>

      <Show when={links().length}>
        <div class="info-section">
          <div class="info-heading">links shared</div>
          <For each={links()}>
            {(url) => (
              <div class="info-link" title={url}>
                <a href={linkUrl(url)} target="_blank">
                  {url.replace(/^https?:\/\//, "").slice(0, 42)}
                </a>
              </div>
            )}
          </For>
        </div>
      </Show>
    </aside>
  )
}
