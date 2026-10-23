/* The original human conversation behind a request (a GitHub review thread), shown as a short chat so
 * the reader sees where it happened and who said what, not the agent's retelling. Read-only data from
 * the dashboard; shown whatever state the brief is in. */
import { createResource, For, Show } from "solid-js"
import type { AttentionRecord } from "../attention"
import { threadWhere, type ConversationThread } from "../desk"
import { readConversation } from "../desk-session"

// A bot review comment is long markdown; its first line names the point it raises.
const BOT_PREVIEW = 160
const preview = (body: string) => {
  const plain = body.replace(/<[^>]+>/g, " ").replace(/!\[[^\]]*\]\([^)]*\)/g, " ").replace(/\*\*|__|`|^#+ |^> /gm, "").replace(/\s+/g, " ").trim()
  if (plain.length <= BOT_PREVIEW) return plain
  const cut = plain.slice(0, BOT_PREVIEW)
  return `${cut.slice(0, cut.lastIndexOf(" ")).trimEnd()}…`
}
const day = (when: string) => new Date(when).toLocaleDateString(undefined, { month: "short", day: "numeric" })

export const ConversationView = (props: { threads: ConversationThread[] }) =>
  <Show when={props.threads.length}>
    <section class="desk-conversation" aria-label="Original conversation">
      <For each={props.threads}>{thread => <div class="desk-thread">
        <a class="desk-thread-where" href={thread.url} target="_blank" rel="noreferrer">{threadWhere(thread).replace(/^GitHub review /, "GitHub review · ").replace(/#(\d+) /, " #$1 · ")} ↗</a>
        {/* The name and date link to the comment; the words themselves read as plain text. */}
        <For each={thread.comments}>{comment => <div class="desk-bubble" data-bot={comment.bot ? "" : undefined}>
          <a class="desk-bubble-who" href={comment.url} target="_blank" rel="noreferrer">{comment.author}{comment.bot ? " · bot" : ""} · {day(comment.when)}</a>
          <span class="desk-bubble-text" dir="auto">{comment.bot ? preview(comment.body) : comment.body}</span>
        </div>}</For>
      </div>}</For>
    </section>
  </Show>

export const RecordConversation = (props: { record: AttentionRecord }) => {
  const [conversation] = createResource(() => props.record, readConversation)
  return <ConversationView threads={conversation()?.threads ?? []} />
}
