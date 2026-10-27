/* The original human conversation behind a request (a GitHub review thread), shown as a short chat so
 * the reader sees where it happened and who said what, not the agent's retelling. Read-only data from
 * the dashboard; shown whatever state the brief is in. */
import { createResource, For, Show } from "solid-js"
import type { AttentionRecord } from "../attention"
import { threadWhere, type ConversationThread } from "../desk"
import { readConversation } from "../desk-session"

// Long comments (bot reviews, pasted logs) show their opening; the link opens the whole comment.
const BOT_PREVIEW = 220
const preview = (body: string) => {
  const plain = body.replace(/<[^>]+>/g, " ").replace(/!\[[^\]]*\]\([^)]*\)/g, " ").replace(/\*\*|__|`|^#+ |^> /gm, "").replace(/\s+/g, " ").trim()
  if (plain.length <= BOT_PREVIEW) return plain
  const cut = plain.slice(0, BOT_PREVIEW)
  return `${cut.slice(0, cut.lastIndexOf(" ")).trimEnd()}…`
}
const day = (when: string) => new Date(when).toLocaleDateString(undefined, { month: "short", day: "numeric" })

// The name and date link to the comment; the words read as plain text, shortened to their opening.
const Bubble = (props: { comment: ConversationThread["comments"][number] }) =>
  <div class="desk-bubble" data-bot={props.comment.bot ? "" : undefined}>
    <a class="desk-bubble-who" href={props.comment.url} target="_blank" rel="noreferrer">{props.comment.author}{props.comment.bot ? " · bot" : ""} · {day(props.comment.when)}</a>
    <span class="desk-bubble-text" dir="auto">{preview(props.comment.body)}</span>
  </div>

export const ConversationView = (props: { threads: ConversationThread[] }) =>
  <Show when={props.threads.length}>
    <section class="desk-conversation" aria-label="Original conversation">
      <For each={props.threads}>{thread => <div class="desk-thread">
        <a class="desk-thread-where" href={thread.url} target="_blank" rel="noreferrer">{thread.kind === "slack-thread"
          // Who is in the thread, so the reader knows whose conversation a reply would join.
          ? `Slack thread · ${[...new Set(thread.comments.filter(comment => !comment.bot).map(comment => comment.author))].join(", ")}`
          : threadWhere(thread).replace(/^GitHub review /, "GitHub review · ").replace(/#(\d+) /, " #$1 · ")} ↗</a>
        {/* A long thread shows how it started and its latest turn; the middle is one click away. */}
        <Show when={thread.comments.length > 3} fallback={<For each={thread.comments}>{comment => <Bubble comment={comment} />}</For>}>
          <Bubble comment={thread.comments[0]!} />
          <details class="desk-thread-more"><summary>{thread.comments.length - 2} more messages</summary>
            <For each={thread.comments.slice(1, -1)}>{comment => <Bubble comment={comment} />}</For></details>
          <Bubble comment={thread.comments.at(-1)!} />
        </Show>
      </div>}</For>
    </section>
  </Show>

export const RecordConversation = (props: { record: AttentionRecord }) => {
  const [conversation] = createResource(() => props.record, readConversation)
  return <ConversationView threads={conversation()?.threads ?? []} />
}
