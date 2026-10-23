/* One attention record with its native ledger controls. Shared by Home and the
 * front desk so both surfaces keep identical answer, choice and delivery semantics. */
import { createEffect, createSignal, For, Show, type JSX } from "solid-js"
import { A } from "@solidjs/router"
import { ago, sessionHref, useDashboard } from "../state"
import { Glyph } from "./icons"
import type { BriefResult } from "../desk"
import { answerDraftKey, attentionPath, blockedReason, decisionLabel, deliveryLabel, type createAttention, type AttentionRecord } from "../attention"
import { requestAgent, type AgentRef, type RequestAgent } from "../attention-agent"

type Attention = ReturnType<typeof createAttention>

/** Resolves a record's requesting agent from the dashboard's loaded session index and lineage; no fetches. */
export const useRequestAgent = () => {
  const dashboard = useDashboard()
  return (record: AttentionRecord): RequestAgent => requestAgent(record, {
    session: id => dashboard.activity.session(id),
    handoffs: dashboard.lineage(),
    owners: dashboard.lineageOwners(),
  })
}

/** The agent's name, linked to its conversation when its directory is known; the session ID stays in the tooltip. */
export const AgentName = (props: { agent: AgentRef; class?: string }) => {
  const title = () => props.agent.named ? props.agent.session : `${props.agent.session} · no session title`
  return <Show when={props.agent.directory} fallback={<bdi dir="auto" class={props.class} title={title()} data-agent-session={props.agent.session}>{props.agent.label}</bdi>}>
    {directory => <A class={props.class} href={sessionHref(props.agent.session, directory())} title={title()} data-agent-session={props.agent.session}><bdi dir="auto">{props.agent.label}</bdi></A>}
  </Show>
}

// Requester first, project second. Who updated it and where answers go now are listed only when they differ.
const Requester = (props: { record: AttentionRecord }) => {
  const agentFor = useRequestAgent()
  const agent = () => agentFor(props.record)
  return <>
    <span class="attention-requester"><Glyph name={props.record.kind === "blocker" ? "question" : "comment-discussion"} />
      <AgentName agent={agent()} class="attention-agent" /><span class="attention-project"> · <bdi dir="auto">{props.record.editspace}</bdi></span></span>
    <Show when={agent().author || agent().destination}>
      <span class="attention-routing home-source">
        <Show when={agent().author}>{author => <>Updated by <AgentName agent={author()} /></>}</Show>
        <Show when={agent().author && agent().destination}> · </Show>
        <Show when={agent().destination}>{destination => <>Handed off · answers go to <AgentName agent={destination()} /></>}</Show>
      </span>
    </Show>
  </>
}
export type AttentionView = "open" | "answered" | "recorded" | "snoozed" | "history"

export const canWriteAttention = (attention: Attention, record: AttentionRecord) =>
  attention.operator() && !attention.stale() && !attention.pending() && !attention.writing() &&
  attention.snapshot()?.value.projects.find(item => item.editspace === record.editspace)?.available !== false

const optionLabel = (record: AttentionRecord, id?: string | null) => record.options.find(option => option.id === id)?.label
// Delivery events append history without a revision bump, so include delivery evidence in the cache key.
const historyVersion = (record: AttentionRecord) => `${record.revision}:${record.delivery_state}:${record.delivery?.updated_at ?? ""}`

// One answer: a selected option, a written note, or both. Either alone is a complete answer;
// nothing is written on the human's behalf. Secondary actions sit beside the single primary one.
const Answer = (props: { record: AttentionRecord; attention: Attention; options: boolean; onView?: (view: AttentionView) => void; extra?: JSX.Element; prepared?: BriefResult; afterChoices?: JSX.Element }) => {
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
  const dashboard = useDashboard()
  // Name the recipient as the human knows it; the exact session stays in the tooltip.
  const target = () => props.record.lane ? <bdi dir="auto">{props.record.lane}</bdi>
    : <bdi dir="auto" title={props.record.source_ref.session_id}>{dashboard.activity.session(props.record.source_ref.session_id)?.title || "the requesting agent"}</bdi>
  const keys = (event: KeyboardEvent) => { if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !event.isComposing && event.keyCode !== 229) { event.preventDefault(); void send() } }
  return <div class="home-answer" onKeyDown={keys}>
    <Show when={props.options}><fieldset class="home-options" classList={{ "home-option-cards": !!props.prepared }} disabled={!canWrite()}><legend class="sr-only">Your choice</legend>
      <For each={props.record.options}>{option => {
        // A prepared brief turns each choice into a card saying what it leads to; the label, ID and the
        // radio's accessible name stay the producer's, so the card is the one and only option list.
        const outcome = () => props.prepared?.choices.find(choice => choice.id === option.id)
        const recommended = () => props.record.recommendation === option.id
        return <label classList={{ "home-option-card": !!props.prepared }} data-recommended={recommended() ? "" : undefined}>
          <input type="radio" name={id} aria-label={option.label} aria-describedby={[recommended() ? `${id}-recommended` : "", outcome() ? `${id}-${option.id}-outcome` : ""].filter(Boolean).join(" ") || undefined} checked={choice() === option.id} onChange={() => setChoice(option.id)} />
          <span class="home-option-body"><bdi dir="auto" class="home-option-label">{option.label}</bdi>
            <Show when={outcome()} fallback={<Show when={recommended()}><span class="home-source" id={`${id}-recommended`}>recommended</span></Show>}>{value => <>
              <span class="home-option-outcome" id={`${id}-${option.id}-outcome`} dir="auto">{value().outcome}</span>
              <Show when={recommended() || value().chips.length}><span class="home-option-chips">
                <Show when={recommended()}><span data-recommended id={`${id}-recommended`}>Recommended</span></Show>
                <For each={value().chips}>{chip => <span dir="auto">{chip}</span>}</For>
              </span></Show>
              <Show when={value().risk}><span class="home-option-risk" dir="auto">− {value().risk}</span></Show>
            </>}</Show>
          </span>
        </label>
      }}</For>
      {/* Not answering is shown as its own outcome only when no option already means it. */}
      <Show when={props.prepared?.ifWait}><div class="home-option-card home-option-wait" aria-hidden="true"><span class="home-option-body"><span class="home-option-label">No answer</span><span class="home-option-outcome" dir="auto">{props.prepared!.ifWait}</span></span></div></Show>
    </fieldset></Show>
    {props.afterChoices}
    <label for={id}>{props.options ? "Note (optional)" : "Your answer"}</label>
    <textarea id={id} dir="auto" rows={props.options ? 1 : 2} maxLength={8000} value={text()} disabled={!canWrite()}
      onInput={event => { setText(event.currentTarget.value); localStorage.setItem(answerDraftKey(props.record), event.currentTarget.value) }} />
    <div class="home-actions">
      {/* On cards the selected card already shows the choice, so the button stays short; its name still says what is sent. */}
      <button class="home-primary" dir="auto" disabled={!ready()} aria-keyshortcuts="Meta+Enter Control+Enter" onClick={() => void send()}
        aria-label={props.prepared && selected() ? `Send ${selected()!.label}` : undefined}>
        <Show when={selected()} fallback="Send answer">{option => <Show when={!props.prepared} fallback="Send">Send <bdi dir="auto">{option().label}</bdi></Show>}</Show>
      </button>
      {props.extra}
      <span class="home-muted">To {target()} · not a tool approval</span>
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
    <Show when={delivery()?.error && !["presented", "handled"].includes(props.record.delivery_state)}><p class="home-muted">Last attempt failed: <bdi dir="auto">{delivery()?.error}</bdi> · retrying</p></Show>
    <Show when={delivery()?.copies?.length}><ul class="home-copies"><For each={delivery()?.copies}>{copy => <li><bdi dir="ltr">{copy.session}</bdi> · {copy.state}{copy.presented_at ? ` · presented ${new Date(copy.presented_at).toLocaleString()}` : ""}{copy.handled_at ? ` · acknowledged ${new Date(copy.handled_at).toLocaleString()}` : ""}</li>}</For></ul></Show>
    <div class="home-actions"><Show when={target()} fallback={<span class="home-muted">Not delivered yet</span>}>{item => <A href={sessionHref(item().session, item().directory)} aria-label="Open delivered agent thread">Open thread</A>}</Show><Show when={["pending", "blocked", "queued"].includes(props.record.delivery_state)}><button disabled={!canWrite()} onClick={() => props.attention.retryDelivery(props.record)}>Retry delivery</button></Show><button disabled={!canWrite()} onClick={() => props.attention.act(props.record, { action: "resolve", reason: "Human marked resolved" })}>Mark resolved</button></div>
  </div>
}

/** A derived brief fills three slots: `brief` above the controls (status and why), `briefAfter` under the
 * choices (picture, unknown, sources) and `briefDetails` before the original request. With a complete
 * `prepared` brief the producer's raw context moves behind a disclosure and each option becomes a card
 * saying what choosing it leads to. */
export const AttentionDecision = (props: { record: AttentionRecord; attention: Attention; onView?: (view: AttentionView) => void; brief?: JSX.Element; briefAfter?: JSX.Element; briefDetails?: JSX.Element; prepared?: BriefResult; more?: JSX.Element }) => {
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
    <div class="home-eyebrow"><Requester record={props.record} /><time dateTime={new Date(props.record.created_at).toISOString()}>{ago(props.record.created_at)}</time><A href={sessionHref(props.record.source_ref.session_id, props.record.source_ref.directory)} aria-label="Open source thread">Open thread</A></div>
    <h3><bdi dir="auto">{props.record.title}</bdi></h3>
    <Show when={!props.prepared}><p dir="auto">{props.record.context}</p></Show>
    {props.brief}
    <Show when={props.record.status === "open"}>
      {/* A recommendation that names an option is tagged on that option; free text stays visible. */}
      <Show when={props.record.recommendation && !props.record.options.some(option => option.id === props.record.recommendation)}><p class="home-muted">Recommended: <bdi dir="auto">{props.record.recommendation}</bdi></p></Show>
      <Answer record={props.record} attention={props.attention} options={props.record.options.length > 0} onView={props.onView} prepared={props.prepared} afterChoices={props.briefAfter}
        extra={<><button class="home-quiet" disabled={!canWrite()} onClick={() => props.attention.act(props.record, { action: "snooze", snoozed_until: Date.now() + 3600_000 })}>Snooze 1h</button><button class="home-quiet" disabled={!canWrite()} onClick={() => props.attention.act(props.record, { action: "resolve", reason: "Human marked no longer needed" })}>No longer needed</button></>} />
    </Show>
    <Show when={props.record.status === "decided"}><p class="home-recorded">Saved: <bdi dir="auto">{decisionLabel(props.record)}</bdi> · not sent</p><Answer record={props.record} attention={props.attention} options={props.record.options.length > 0} onView={props.onView} /><div class="home-actions"><A href={sessionHref(props.record.source_ref.session_id, props.record.source_ref.directory)} aria-label="Open agent thread">Open thread</A><button disabled={!canWrite()} onClick={() => props.attention.act(props.record, { action: "resolve", reason: "Human marked resolved" })}>Mark resolved</button></div></Show>
    <Show when={props.record.status === "answered"}><Delivery record={props.record} attention={props.attention} /></Show>
    <Show when={props.record.status === "snoozed"}><p class="home-muted">Snoozed until {props.record.snoozed_until ? new Date(props.record.snoozed_until).toLocaleString() : "unknown"}</p><button disabled={!canWrite()} onClick={() => props.attention.act(props.record, { action: "wake" })}>Return to Needs you</button></Show>
    <Show when={["resolved", "withdrawn"].includes(props.record.status)}><p class="home-muted">{props.record.status === "resolved" ? "Resolved" : "Withdrawn"}</p><Show when={props.record.answer}><Show when={props.record.answer?.text}><pre class="home-answer-text" dir="auto">{props.record.answer?.text}</pre></Show><Show when={optionLabel(props.record, props.record.answer?.choice_id)}>{label => <p class="home-muted">Option <bdi dir="auto">{label()}</bdi></p>}</Show><p class="home-muted">{deliveryLabel(props.record)}</p></Show></Show>
    {props.more}
    {props.briefDetails}
    {/* With a brief leading, the producer's exact request comes last, after the native controls. */}
    <Show when={props.prepared}>
      <details class="home-original"><summary>Original request</summary><p dir="auto">{props.record.context}</p></details>
    </Show>
    <details onToggle={event => setHistoryOpen(event.currentTarget.open)}><summary>Record &amp; history</summary><div class="home-source"><bdi dir="ltr">{props.record.id} · {props.record.gate_key} · revision {props.record.revision}</bdi></div><Show when={history()?.version === historyVersion(props.record) ? history() : undefined} fallback={<p>Loading history…</p>}>{item => <Show when={!item().error} fallback={<p>{item().error}</p>}><pre dir="ltr">{JSON.stringify(item().events, null, 2)}</pre></Show>}</Show></details>
  </article>
}
