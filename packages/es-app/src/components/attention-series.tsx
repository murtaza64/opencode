import { createMemo, For, Show } from "solid-js"
import { A } from "@solidjs/router"
import { Markdown } from "@opencode-ai/session-ui/markdown"
import { sessionHref } from "../state"
import { deliveryLabel, inputText, type createAttention, type AttentionRecord } from "../attention"
import { requestMarkdown } from "../request-markdown"
import { seriesProgress } from "../attention-series"
import type { DeskItem } from "../desk"
import { Answer } from "./attention-decision"

/** A series is one card, but each question retains its own ledger answer command and revision. */
export const AttentionSeries = (props: { item: DeskItem; attention: ReturnType<typeof createAttention> }) => {
  // Polls replace ledger objects. Keep unchanged rows mounted so typing an Other value survives a poll.
  const members = createMemo((before: AttentionRecord[] = []) => seriesProgress(props.item.series!.members).ordered.map(record =>
    before.find(old => old.id === record.id && old.revision === record.revision && old.status === record.status &&
      old.delivery_state === record.delivery_state && old.delivery?.updated_at === record.delivery?.updated_at) ?? record))
  const progress = () => seriesProgress(members())
  return <article class="attention-series" data-series-id={props.item.series!.id}>
    <header class="attention-series-head">
      <span class="home-source">Questions · <bdi dir="auto">{props.item.project}</bdi></span>
      <h3 dir="auto">{props.item.series!.title}</h3>
      <p class="attention-series-progress" aria-label={`Answered ${progress().answered} of ${progress().live} live questions`}>
        {progress().answered}/{progress().live} answered
      </p>
      {/* Question numbers only: the titles are listed right below. */}
      <Show when={progress().unanswered.length}><p class="home-muted">Unanswered: <bdi dir="ltr">{progress().unanswered.map(record => `Q${record.series!.index}`).join(", ")}</bdi></p></Show>
    </header>
    <ol class="attention-series-questions" aria-label="Series questions">
      <For each={progress().ordered}>{record => <li class="attention-series-question" data-attention-id={record.id} data-status={record.status}>
        <div class="attention-series-question-head"><h4><span class="home-source">Question {record.series!.index}<Show when={record.revision > 1}> · revision {record.revision}</Show></span><br /><bdi dir="auto">{record.title}</bdi></h4>
          <Show when={record.status === "withdrawn"}><span class="attention-series-withdrawn">Withdrawn</span></Show>
        </div>
        <Show when={record.status !== "withdrawn"}>
          <div class="home-request-text" dir="auto"><Markdown text={requestMarkdown(record.context)} cacheKey={`series:${record.editspace}:${record.id}:${record.revision}`} /></div>
          <Show when={record.options.length && record.status !== "open" && record.status !== "decided"}><div class="home-source">Suggestions</div><ul class="attention-series-suggestions" aria-label={`Suggestions for question ${record.series!.index}`}>
            <For each={record.options}>{option => <li><bdi dir="auto">{option.label}</bdi><Show when={record.recommendation === option.id}> <span class="attention-series-recommended">Recommended</span></Show></li>}</For>
          </ul></Show>
          <Show when={record.status === "open" || record.status === "decided"}>
            <span class="home-source">Suggestions</span><Answer record={record} attention={props.attention} options={record.options.length > 0} />
          </Show>
        </Show>
        <Show when={record.answer}>{answer => <div class="attention-series-recorded" aria-label={`Recorded answer to question ${record.series!.index}`}>
            <strong>Your answer</strong>
            <Show when={record.options.find(option => option.id === answer().choice_id)}>{option => <p><bdi dir="auto">{option().label}</bdi></p>}</Show>
            <Show when={answer().input_value !== undefined && record.options.find(option => option.id === answer().choice_id)}>{option =>
              <pre dir="auto">{inputText(option(), answer().input_value)}</pre>}</Show>
            <Show when={answer().text}><pre dir="auto">{answer().text}</pre></Show>
            <p class="home-muted">{deliveryLabel(record)}</p>
        </div>}</Show>
        <Show when={!record.answer && record.status !== "open" && record.status !== "decided" && record.status !== "withdrawn"}><p class="home-muted">{record.status}</p></Show>
        <A href={sessionHref(record.source_ref.session_id, record.source_ref.directory)} class="home-source">Agent thread</A>
      </li>}</For>
    </ol>
  </article>
}
