/* Right panel on the session page: identity, spend, editspace joins (lane,
 * tickets, PRs via the dashboard's thread model), tracker tickets and docs
 * this session references, and links shared in the conversation. */
import { createMemo, createResource, For, Show } from "solid-js"
import { A } from "@solidjs/router"
import type { Part, Session } from "@opencode-ai/sdk/v2"
import { es, type IssueRow } from "../api"
import { ago, jiraUrl, linkUrl, useDashboard } from "../state"
import { docHref } from "../pages/doc"
import { TicketIcon } from "./icons"
import { rightOpen, rightWidth, toggleRight } from "../ui"
import { PrList } from "./pr"

const URL_RE = /https?:\/\/[^\s)\]}"'`>]+/g
// #N / repo#N / owner/repo#N mentions and markdown-ish path tokens
const ISSUE_NUM_RE = /(?:^|[^\w/])[\w./-]*#(\d+)\b/g
const MD_PATH_RE = /(?:^|[\s"'`(\[])((?:~\/|\/)?[\w./-]+\.md)\b/g

const compact = (n?: number) => {
  if (!n) return "0"
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`
  return `${(n / 1_000_000).toFixed(1)}M`
}

const home = (p: string) => p.replace(/^\/Users\/[^/]+/, "~")

export default function SessionInfo(props: {
  sessionID: string
  session?: Session
  parts: Record<string, Part[]>
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
  parts: Record<string, Part[]>
}) {
  const { state, editspace } = useDashboard()

  const thread = createMemo(() =>
    (state()?.threads ?? []).find((t: any) => t.sessions.some((s: any) => s.id === props.sessionID)),
  )

  // tracker issues + doc sources of the current editspace, for reference
  // matching (dotfiles#79); soft-fail so the panel renders without a tracker
  const [issueList] = createResource(
    () => editspace() ?? "",
    (name) => es.issues(name || undefined).catch(() => undefined),
  )
  const [docList] = createResource(
    () => editspace() ?? "",
    (name) => es.docs(name || undefined).catch(() => undefined),
  )

  const scanned = createMemo(() => transcriptStrings(props.parts))

  // tracker tickets this session references: the lane's claimed issue plus
  // transcript mentions (#N for gh; issues/<feature>/NN-*.md pointers for
  // markdown trackers), matched against the real issue list — never guessed
  const referencedTickets = createMemo<IssueRow[]>(() => {
    const rows = issueList()?.issues ?? []
    if (!rows.length) return []
    const { texts } = scanned()
    const lanePointers = (thread()?.lanes ?? []).map((l: any) => l.issue ?? "")
    const haystack = [...texts, ...lanePointers]
    const numbers = new Set<string>()
    const mdRefs = new Set<string>()
    for (const text of haystack) {
      for (const m of text.matchAll(ISSUE_NUM_RE)) numbers.add(m[1])
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
        (row.url ? numbers.has(String(row.number)) : mdRefs.has(row.ref)) ||
        row.claims.some((c) => claimed.has(c)),
    )
  })

  // docs this session touched or mentioned, mapped to viewer targets:
  // absolute tool paths resolve through the doc-source roots table (lane
  // workspace paths fold into their repo source); bare relative mentions
  // ("prds/x.md") assume the first repo source
  const referencedDocs = createMemo(() => {
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
    for (const parts of Object.values(props.parts)) {
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
                <a href={jiraUrl(tk.key)} target="_blank">
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

      <Show when={thread()?.prs?.length}>
        <div class="info-section">
          <div class="info-heading">open PRs</div>
          <PrList prs={thread().prs} compact />
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
