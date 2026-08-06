/* Ticket reader: read-only view of one tracker issue — gh (body + comments)
 * or sidecar markdown (the file is the whole record, comments inline). */
import { createResource, For, Show } from "solid-js"
import { useSearchParams } from "@solidjs/router"
import { Markdown } from "@opencode-ai/session-ui/markdown"
import { es, type IssueDetail } from "../api"
import { ago, linkUrl, useDashboard } from "../state"

const markerCls = (m: string) =>
  m === "parked" || m === "ready-for-human"
    ? "parked"
    : m === "needs-human" || m === "flagged"
      ? "failing"
      : m === "ready-for-agent" || m === "in-review"
        ? "inprogress"
        : ""

export function IssueChips(props: { row: { state?: string; markers: string[]; claims: string[]; labels?: string[] } }) {
  return (
    <span class="chips">
      <Show when={props.row.state === "closed"}>
        <span class="chip">closed</span>
      </Show>
      <For each={props.row.markers}>{(m) => <span class={`chip ${markerCls(m)}`}>{m}</span>}</For>
      <For each={props.row.claims}>{(c) => <span class="chip claim">{c}</span>}</For>
      <For each={props.row.labels ?? []}>{(l) => <span class="chip plain">{l}</span>}</For>
    </span>
  )
}

export default function IssuePage() {
  const [params] = useSearchParams()
  const { editspace } = useDashboard()
  const [issue] = createResource(
    () => ({ ref: String(params.ref ?? ""), es: editspace() }),
    (src) => (src.ref ? es.issue(src.ref, src.es) : Promise.resolve(undefined as unknown as IssueDetail)),
  )
  const date = (iso?: string) => (iso ? ago(Date.parse(iso)) : "")
  return (
    <main class="browse-page">
      <Show when={issue.error}>
        <div class="err">{String(issue.error)}</div>
      </Show>
      <Show when={issue()}>
        {(doc) => (
          <>
            <div class="browse-head">
              <h1>
                <Show when={doc().backend === "gh" && doc().number != null}>
                  <span class="issue-num">#{doc().number}</span>{" "}
                </Show>
                <Show when={doc().backend === "markdown" && doc().feature}>
                  <span class="issue-num">{doc().feature}/</span>
                </Show>
                {doc().title}
              </h1>
              <div class="browse-meta">
                <IssueChips row={doc()} />
                <Show when={doc().status && doc().backend === "markdown"}>
                  <span class="dim mono">Status: {doc().status}</span>
                </Show>
                <Show when={doc().assignees?.length}>
                  <span class="dim">assigned: {doc().assignees.join(", ")}</span>
                </Show>
                <Show when={doc().updated_at}>
                  <span class="dim">updated {date(doc().updated_at)}</span>
                </Show>
                <Show when={doc().url}>
                  <a href={linkUrl(doc().url)} target="_blank" class="dim">
                    {doc().backend === "gh" ? "open on github ↗" : "open ↗"}
                  </a>
                </Show>
              </div>
              <Show when={doc().blockers?.length || doc().reviewers?.length}>
                <div class="dim mono">
                  <Show when={doc().blockers?.length}>blocked by: {doc().blockers!.join(", ")} </Show>
                  <Show when={doc().reviewers?.length}>needs review of: {doc().reviewers!.join(", ")}</Show>
                </div>
              </Show>
            </div>
            <div class="doc-prose">
              <Markdown text={doc().body || "*(no description)*"} cacheKey={`issue:${doc().ref}`} />
            </div>
            <Show when={doc().comments.length}>
              <h2>comments</h2>
              <For each={doc().comments}>
                {(c) => (
                  <div class="issue-comment">
                    <div class="comment-head">
                      <b>{c.author}</b>
                      <span class="dim">{date(c.created_at)}</span>
                    </div>
                    <div class="doc-prose">
                      <Markdown text={c.body} cacheKey={`comment:${doc().ref}:${c.created_at}`} />
                    </div>
                  </div>
                )}
              </For>
            </Show>
          </>
        )}
      </Show>
    </main>
  )
}
