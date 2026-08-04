/* Right panel on the session page: identity, spend, editspace joins (lane,
 * tickets, PRs via the dashboard's thread model), and links shared in the
 * conversation. */
import { createMemo, For, Show } from "solid-js"
import type { Part, Session } from "@opencode-ai/sdk/v2"
import { ago, jiraUrl, useDashboard } from "../state"
import { PrList } from "./pr"

const URL_RE = /https?:\/\/[^\s)\]}"'`>]+/g

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
  const { state } = useDashboard()

  const thread = createMemo(() =>
    (state()?.threads ?? []).find((t: any) => t.sessions.some((s: any) => s.id === props.sessionID)),
  )

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
    <aside class="session-info">
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
                <a href={url} target="_blank">
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
