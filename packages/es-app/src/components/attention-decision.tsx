/* One attention record with its native ledger controls. Shared by Home and the
 * front desk so both surfaces keep identical answer, choice and delivery semantics. */
import { createEffect, createSignal, For, Show, type JSX } from "solid-js"
import { A } from "@solidjs/router"
import { ago, sessionHref } from "../state"
import { Glyph } from "./icons"
import { answerDraftKey, attentionPath, blockedReason, decisionLabel, deliveryLabel, type createAttention, type AttentionRecord } from "../attention"

type Attention = ReturnType<typeof createAttention>
export type AttentionView = "open" | "answered" | "recorded" | "snoozed" | "history"

export const canWriteAttention = (attention: Attention, record: AttentionRecord) =>
  attention.operator() && !attention.stale() && !attention.pending() && !attention.writing() &&
  attention.snapshot()?.value.projects.find(item => item.editspace === record.editspace)?.available !== false

const optionLabel = (record: AttentionRecord, id?: string | null) => record.options.find(option => option.id === id)?.label
// Delivery events append history without a revision bump, so include delivery evidence in the cache key.
const historyVersion = (record: AttentionRecord) => `${record.revision}:${record.delivery_state}:${record.delivery?.updated_at ?? ""}`

// One answer: a selected option, a written note, or both. Either alone is a complete answer;
// nothing is written on the human's behalf. Secondary actions sit beside the single primary one.
const Answer = (props: { record: AttentionRecord; attention: Attention; options: boolean; onView?: (view: AttentionView) => void; extra?: JSX.Element }) => {
  const [text, setText] = createSignal(localStorage.getItem(answerDraftKey(props.record)) ?? "")
  const [choice, setChoice] = createSignal("")
  const canWrite = () => canWriteAttention(props.attention, props.record)
  const selected = () => props.options ? props.record.options.find(option => option.id === choice()) : undefined
  const ready = () => canWrite() && (!!selected() || !!text().trim())
  const send = async () => {
    if (!ready()) return
    const option = selected()
    // Saved first by the ledger client; a lost response keeps this exact command for retry.
    if (await props.attention.act(props.record, { action: "answer", ...(text().trim() ? { text: text() } : {}), ...(option ? { choice_id: option.id } : {}) })) props.onView?.("answered")
  }
  const id = `answer-${props.record.id}`
  const target = () => props.record.lane ? <>lane <bdi dir="auto">{props.record.lane}</bdi></> : <>session <bdi dir="ltr">{props.record.source_ref.session_id}</bdi></>
  const keys = (event: KeyboardEvent) => { if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !event.isComposing && event.keyCode !== 229) { event.preventDefault(); void send() } }
  return <div class="home-answer" onKeyDown={keys}>
    <Show when={props.options}><fieldset class="home-options" disabled={!canWrite()}><legend>Your choice</legend>
      <For each={props.record.options}>{option => <label><input type="radio" name={id} checked={choice() === option.id} onChange={() => setChoice(option.id)} /><bdi dir="auto">{option.label}</bdi></label>}</For>
    </fieldset></Show>
    <label for={id}>{props.options ? "Note (optional)" : "Your answer"}</label>
    <textarea id={id} dir="auto" rows={props.options ? 1 : 2} maxLength={8000} value={text()} disabled={!canWrite()}
      onInput={event => { setText(event.currentTarget.value); localStorage.setItem(answerDraftKey(props.record), event.currentTarget.value) }} />
    <div class="home-actions">
      <button class="home-primary" dir="auto" disabled={!ready()} aria-keyshortcuts="Meta+Enter Control+Enter" onClick={() => void send()}>
        <Show when={selected()} fallback="Send answer">{option => <>Send <bdi dir="auto">{option().label}</bdi></>}</Show>
      </button>
      {props.extra}
      <span class="home-muted">To {target()} · grants no tool permission</span>
    </div>
  </div>
}

const Delivery = (props: { record: AttentionRecord; attention: Attention }) => {
  const delivery = () => props.record.delivery
  const canWrite = () => canWriteAttention(props.attention, props.record)
  // Link the delivered session only with its own verified directory; the source link stays separate.
  const target = () => delivery()?.session && delivery()?.session_directory ? { session: delivery()!.session!, directory: delivery()!.session_directory! } : undefined
  return <div class="home-delivery" data-delivery-state={props.record.delivery_state}>
    <p class="home-recorded">Your answer<Show when={optionLabel(props.record, props.record.answer?.choice_id)}>{label => <> · option <bdi dir="auto">{label()}</bdi></>}</Show></p>
    <Show when={props.record.answer?.text}><pre class="home-answer-text" dir="auto">{props.record.answer?.text}</pre></Show>
    <p class={props.record.delivery_state === "blocked" ? "home-blocked" : "home-muted"} role="status">{deliveryLabel(props.record)}<Show when={props.record.delivery_state === "blocked" && delivery()?.reason}> — {blockedReason(delivery()?.reason)}</Show></p>
    <Show when={delivery()?.error && !["presented", "handled"].includes(props.record.delivery_state)}><p class="home-muted">Last attempt: <bdi dir="auto">{delivery()?.error}</bdi> · retrying the same request</p></Show>
    <Show when={delivery()?.copies?.length}><ul class="home-copies"><For each={delivery()?.copies}>{copy => <li><bdi dir="ltr">{copy.session}</bdi> · {copy.state}{copy.presented_at ? ` · presented ${new Date(copy.presented_at).toLocaleString()}` : ""}{copy.handled_at ? ` · acknowledged ${new Date(copy.handled_at).toLocaleString()}` : ""}</li>}</For></ul></Show>
    <div class="home-actions"><Show when={target()} fallback={<span class="home-muted">Delivered session not yet verified</span>}>{item => <A href={sessionHref(item().session, item().directory)} aria-label="Open delivered agent thread">Open thread</A>}</Show><Show when={["pending", "blocked", "queued"].includes(props.record.delivery_state)}><button disabled={!canWrite()} onClick={() => props.attention.retryDelivery(props.record)}>Retry delivery</button></Show><button disabled={!canWrite()} onClick={() => props.attention.act(props.record, { action: "resolve", reason: "Human marked resolved" })}>Mark resolved</button></div>
  </div>
}

/** `brief` renders a derived explanation first; when `readable`, the producer's raw context and ID move behind a disclosure. */
export const AttentionDecision = (props: { record: AttentionRecord; attention: Attention; onView?: (view: AttentionView) => void; brief?: JSX.Element; readable?: boolean }) => {
  const [historyOpen, setHistoryOpen] = createSignal(false)
  const [history, setHistory] = createSignal<{ version: string; events?: unknown[]; error?: string }>()
  const canWrite = () => canWriteAttention(props.attention, props.record)
  let loading = ""
  const loadHistory = async (record: AttentionRecord) => {
    const version = historyVersion(record)
    if (loading === version) return
    loading = version
    try {
      const response = await fetch(attentionPath(`/${encodeURIComponent(record.id)}`, record.editspace), { credentials: "include" })
      if (!response.ok) throw Error("History unavailable")
      const result = await response.json()
      setHistory({ version, events: result.events })
    } catch { setHistory({ version, error: "History unavailable. The record has not changed." }) }
    finally { if (loading === version) loading = "" }
  }
  createEffect(() => { if (historyOpen() && history()?.version !== historyVersion(props.record)) void loadHistory(props.record) })
  return <article class="home-decision" data-attention-id={props.record.id}>
    <div class="home-eyebrow"><span><Glyph name={props.record.kind === "blocker" ? "question" : "comment-discussion"} />{props.record.kind}</span><bdi dir="auto">{props.record.editspace}</bdi><time dateTime={new Date(props.record.created_at).toISOString()}>{ago(props.record.created_at)}</time><span>revision {props.record.revision}</span></div>
    <h3><bdi dir="auto">{props.record.title}</bdi></h3>
    {props.brief}
    <Show when={props.readable} fallback={<>
      <p dir="auto">{props.record.context}</p>
      <div class="home-source">Agent request · <A href={sessionHref(props.record.source_ref.session_id, props.record.source_ref.directory)} aria-label="Open source thread">Open thread</A></div>
    </>}>
      <details class="home-original"><summary>Original request</summary><p dir="auto">{props.record.context}</p>
        <div class="home-source"><bdi dir="ltr">{props.record.id}</bdi> · <A href={sessionHref(props.record.source_ref.session_id, props.record.source_ref.directory)} aria-label="Open source thread">Open thread</A></div></details>
    </Show>
    <Show when={props.record.status === "open"}>
      <Show when={props.record.recommendation}><p class="home-muted">Agent recommends: <bdi dir="auto">{props.record.options.find(option => option.id === props.record.recommendation)?.label ?? props.record.recommendation}</bdi></p></Show>
      <Answer record={props.record} attention={props.attention} options={props.record.options.length > 0} onView={props.onView}
        extra={<><button class="home-quiet" disabled={!canWrite()} onClick={() => props.attention.act(props.record, { action: "snooze", snoozed_until: Date.now() + 3600_000 })}>Snooze 1h</button><button class="home-quiet" disabled={!canWrite()} onClick={() => props.attention.act(props.record, { action: "resolve", reason: "Human marked no longer needed" })}>No longer needed</button></>} />
    </Show>
    <Show when={props.record.status === "decided"}><p class="home-recorded">Saved: <bdi dir="auto">{decisionLabel(props.record)}</bdi> · not sent</p><p class="home-muted">Not a tool permission or approval to publish.</p><Answer record={props.record} attention={props.attention} options={props.record.options.length > 0} onView={props.onView} /><div class="home-actions"><A href={sessionHref(props.record.source_ref.session_id, props.record.source_ref.directory)} aria-label="Open agent thread">Open thread</A><button disabled={!canWrite()} onClick={() => props.attention.act(props.record, { action: "resolve", reason: "Human marked resolved" })}>Mark resolved</button></div></Show>
    <Show when={props.record.status === "answered"}><Delivery record={props.record} attention={props.attention} /></Show>
    <Show when={props.record.status === "snoozed"}><p class="home-muted">Snoozed until {props.record.snoozed_until ? new Date(props.record.snoozed_until).toLocaleString() : "unknown"}</p><button disabled={!canWrite()} onClick={() => props.attention.act(props.record, { action: "wake" })}>Return to Needs you</button></Show>
    <Show when={["resolved", "withdrawn"].includes(props.record.status)}><p class="home-muted">{props.record.status} · retained in history</p><Show when={props.record.answer}><Show when={props.record.answer?.text}><pre class="home-answer-text" dir="auto">{props.record.answer?.text}</pre></Show><Show when={optionLabel(props.record, props.record.answer?.choice_id)}>{label => <p class="home-muted">Option <bdi dir="auto">{label()}</bdi></p>}</Show><p class="home-muted">{deliveryLabel(props.record)}</p></Show></Show>
    <details onToggle={event => setHistoryOpen(event.currentTarget.open)}><summary>Record &amp; history</summary><div class="home-source"><bdi dir="ltr">{props.record.id} · {props.record.gate_key}</bdi></div><Show when={history()?.version === historyVersion(props.record) ? history() : undefined} fallback={<p>Loading history…</p>}>{item => <Show when={!item().error} fallback={<p>{item().error}</p>}><pre dir="ltr">{JSON.stringify(item().events, null, 2)}</pre></Show>}</Show></details>
  </article>
}
