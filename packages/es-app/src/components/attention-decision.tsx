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

// Every unanswered decision accepts a written answer; an option is optional context for it.
const Answer = (props: { record: AttentionRecord; attention: Attention; choice?: () => string; onView?: (view: AttentionView) => void }) => {
  const [text, setText] = createSignal(localStorage.getItem(answerDraftKey(props.record)) ?? "")
  const canWrite = () => canWriteAttention(props.attention, props.record)
  const send = async () => {
    if (!text().trim() || !canWrite()) return
    const selected = props.choice?.()
    const choice = props.record.options.some(option => option.id === selected) ? selected : undefined
    // The draft is cleared only after the ledger confirms; failures keep it for an exact retry.
    if (await props.attention.act(props.record, { action: "answer", text: text(), ...(choice ? { choice_id: choice } : {}) })) props.onView?.("answered")
  }
  const id = `answer-${props.record.id}`
  const target = () => props.record.lane ? <>the agent that currently owns lane <bdi dir="auto">{props.record.lane}</bdi> through verified handoffs</> : <>the requesting session <bdi dir="ltr">{props.record.source_ref.session_id}</bdi></>
  return <div class="home-answer">
    <label for={id}>Your answer</label>
    <textarea id={id} dir="auto" rows={3} maxLength={8000} value={text()} disabled={!canWrite()}
      aria-describedby={`${id}-meaning`}
      onInput={event => { setText(event.currentTarget.value); localStorage.setItem(answerDraftKey(props.record), event.currentTarget.value) }}
      onKeyDown={event => { if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !event.isComposing && event.keyCode !== 229) { event.preventDefault(); void send() } }} />
    <p id={`${id}-meaning`} class="home-muted">Sends this text{props.choice && props.record.options.length ? " and any selected option" : ""} as mail to {target()}. Saved first; unverified ownership stays blocked here and nothing is sent. Grants no tool permission.</p>
    <div class="home-actions"><button class="home-primary" disabled={!canWrite() || !text().trim()} onClick={() => void send()}>Send answer</button><span class="home-muted">Ctrl/⌘+Enter</span></div>
  </div>
}

const Delivery = (props: { record: AttentionRecord; attention: Attention }) => {
  const delivery = () => props.record.delivery
  const canWrite = () => canWriteAttention(props.attention, props.record)
  // Link the delivered session only with its own verified directory; the source link stays separate.
  const target = () => delivery()?.session && delivery()?.session_directory ? { session: delivery()!.session!, directory: delivery()!.session_directory! } : undefined
  return <div class="home-delivery" data-delivery-state={props.record.delivery_state}>
    <p class="home-recorded">Your answer<Show when={optionLabel(props.record, props.record.answer?.choice_id)}>{label => <> · option <bdi dir="auto">{label()}</bdi></>}</Show></p>
    <pre class="home-answer-text" dir="auto">{props.record.answer?.text}</pre>
    <p class={props.record.delivery_state === "blocked" ? "home-blocked" : "home-muted"} role="status">{deliveryLabel(props.record)}<Show when={props.record.delivery_state === "blocked" && delivery()?.reason}> — {blockedReason(delivery()?.reason)}</Show></p>
    <Show when={delivery()?.error && !["presented", "handled"].includes(props.record.delivery_state)}><p class="home-muted">Last attempt: <bdi dir="auto">{delivery()?.error}</bdi> · retrying the same request</p></Show>
    <Show when={delivery()?.copies?.length}><ul class="home-copies"><For each={delivery()?.copies}>{copy => <li><bdi dir="ltr">{copy.session}</bdi> · {copy.state}{copy.presented_at ? ` · presented ${new Date(copy.presented_at).toLocaleString()}` : ""}{copy.handled_at ? ` · acknowledged ${new Date(copy.handled_at).toLocaleString()}` : ""}</li>}</For></ul></Show>
    <div class="home-actions"><Show when={target()} fallback={<span class="home-muted">Delivered session not yet verified</span>}>{item => <A href={sessionHref(item().session, item().directory)} aria-label="Open delivered agent thread">Open thread</A>}</Show><Show when={["pending", "blocked", "queued"].includes(props.record.delivery_state)}><button disabled={!canWrite()} onClick={() => props.attention.retryDelivery(props.record)}>Retry delivery</button></Show><button disabled={!canWrite()} onClick={() => props.attention.act(props.record, { action: "resolve", reason: "Human marked resolved" })}>Mark resolved</button></div>
  </div>
}

/** `brief` renders a derived explanation first; when `readable`, the producer's raw context and ID move behind a disclosure. */
export const AttentionDecision = (props: { record: AttentionRecord; attention: Attention; onView?: (view: AttentionView) => void; brief?: JSX.Element; readable?: boolean }) => {
  const [choice, setChoice] = createSignal("")
  const [confirm, setConfirm] = createSignal<{ record: AttentionRecord; choice: string }>()
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
    <Show when={!props.readable}>
      <p dir="auto">{props.record.context}</p>
      <div class="home-source">Agent request · <A href={sessionHref(props.record.source_ref.session_id, props.record.source_ref.directory)} aria-label="Open source thread">Open thread</A></div>
    </Show>
    <Show when={props.record.status === "open"}>
      <Show when={props.record.recommendation}><p class="home-muted">Agent recommends: <bdi dir="auto">{props.record.options.find(option => option.id === props.record.recommendation)?.label ?? props.record.recommendation}</bdi></p></Show>
      <Show when={props.record.options.length}><fieldset disabled={!canWrite()}><legend>Your choice</legend><For each={props.record.options}>{option => <label><input type="radio" name={props.record.id} checked={choice() === option.id} onChange={() => setChoice(option.id)} /><bdi dir="auto">{option.label}</bdi></label>}</For></fieldset></Show>
      <Answer record={props.record} attention={props.attention} choice={choice} onView={props.onView} />
      <div class="home-actions"><Show when={props.record.options.length}><button disabled={!canWrite() || !props.record.options.some(option => option.id === choice())} onClick={() => setConfirm({ record: props.record, choice: choice() })}>Review choice</button><span class="home-muted">record only · not sent</span></Show><button disabled={!canWrite()} onClick={() => props.attention.act(props.record, { action: "snooze", snoozed_until: Date.now() + 3600_000 })}>Snooze 1h</button><button disabled={!canWrite()} onClick={() => props.attention.act(props.record, { action: "resolve", reason: "Human marked no longer needed" })}>No longer needed</button></div>
    </Show>
    <Show when={props.record.status === "decided"}><p class="home-recorded">Saved: <bdi dir="auto">{decisionLabel(props.record)}</bdi> · not sent</p><p class="home-muted">Not a tool permission or approval to publish.</p>{/* The earlier record-only choice stays history; a written reply here carries text only. */}<Answer record={props.record} attention={props.attention} onView={props.onView} /><div class="home-actions"><A href={sessionHref(props.record.source_ref.session_id, props.record.source_ref.directory)} aria-label="Open agent thread">Open thread</A><button disabled={!canWrite()} onClick={() => props.attention.act(props.record, { action: "resolve", reason: "Human marked resolved" })}>Mark resolved</button></div></Show>
    <Show when={props.record.status === "answered"}><Delivery record={props.record} attention={props.attention} /></Show>
    <Show when={props.record.status === "snoozed"}><p class="home-muted">Snoozed until {props.record.snoozed_until ? new Date(props.record.snoozed_until).toLocaleString() : "unknown"}</p><button disabled={!canWrite()} onClick={() => props.attention.act(props.record, { action: "wake" })}>Return to Needs you</button></Show>
    <Show when={["resolved", "withdrawn"].includes(props.record.status)}><p class="home-muted">{props.record.status} · retained in history</p><Show when={props.record.answer}><pre class="home-answer-text" dir="auto">{props.record.answer?.text}</pre><p class="home-muted">{deliveryLabel(props.record)}</p></Show></Show>
    {/* With a brief leading, the producer's exact request comes last, after the native controls. */}
    <Show when={props.readable}>
      <details class="home-original"><summary>Original request</summary><p dir="auto">{props.record.context}</p>
        <div class="home-source"><bdi dir="ltr">{props.record.id}</bdi> · <A href={sessionHref(props.record.source_ref.session_id, props.record.source_ref.directory)} aria-label="Open source thread">Open thread</A></div></details>
    </Show>
    <details onToggle={event => setHistoryOpen(event.currentTarget.open)}><summary>Record &amp; history</summary><div class="home-source"><bdi dir="ltr">{props.record.id} · {props.record.gate_key}</bdi></div><Show when={history()?.version === historyVersion(props.record) ? history() : undefined} fallback={<p>Loading history…</p>}>{item => <Show when={!item().error} fallback={<p>{item().error}</p>}><pre dir="ltr">{JSON.stringify(item().events, null, 2)}</pre></Show>}</Show></details>
    <Show when={confirm()}>{draft => <dialog class="home-confirm" ref={element => queueMicrotask(() => element.showModal())} onCancel={() => setConfirm(undefined)} aria-labelledby={`home-choice-title-${props.record.id}`}><h2 id={`home-choice-title-${props.record.id}`}>Record this choice?</h2><p><bdi dir="auto">{draft().record.options.find(option => option.id === draft().choice)?.label}</bdi></p><p>Saved only: nothing is sent, resumed or granted.</p><div class="home-actions"><button class="home-primary" disabled={!canWriteAttention(props.attention, draft().record)} onClick={async () => { const selected = draft(); setConfirm(undefined); if (await props.attention.act(selected.record, { action: "choose", choice_id: selected.choice })) props.onView?.("recorded") }}>Record choice only</button><button onClick={() => setConfirm(undefined)}>Cancel</button></div></dialog>}</Show>
  </article>
}
