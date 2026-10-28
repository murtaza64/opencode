/* One attention record with its native ledger controls. Shared by Home and the
 * front desk so both surfaces keep identical answer, choice and delivery semantics. */
import { createEffect, createSignal, For, Show, type JSX } from "solid-js"
import { A } from "@solidjs/router"
import { ago, sessionHref, useDashboard } from "../state"
import { Glyph } from "./icons"
import { LinkedText } from "./linked-text"
import type { BriefResult } from "../desk"
import { Sketch } from "./attention-brief"
import { Markdown } from "@opencode-ai/session-ui/markdown"
import { requestHasSteps, requestMarkdown } from "../request-markdown"
import { answerDraftKey, attentionPath, blockedReason, contentRevision, decisionLabel, deliveryLabel, inputPayload, inputProblem, inputText, INPUT_KINDS, type createAttention, type AttentionOption, type AttentionRecord, type InputValue } from "../attention"
import { requestAgent, type AgentRef, type RequestAgent } from "../attention-agent"
import { ariaShortcut } from "../shortcuts"

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

// One answer: a selected option, a written note, or both. Either alone is a complete answer unless the
// option declares required input; nothing is written on the human's behalf. Secondary actions sit beside the single primary one.
const Answer = (props: { record: AttentionRecord; attention: Attention; options: boolean; onView?: (view: AttentionView) => void; extra?: JSX.Element; prepared?: BriefResult; afterChoices?: JSX.Element; sends?: Sends; briefJob?: { job: string; revision: string } }) => {
  const [text, setText] = createSignal(localStorage.getItem(answerDraftKey(props.record)) ?? "")
  const [choice, setChoice] = createSignal("")
  const canWrite = () => canWriteAttention(props.attention, props.record)
  // Input typed for each option is kept while switching; only the selected option's value is sent.
  const [values, setValues] = createSignal<Record<string, InputValue>>({})
  const selected = () => props.options ? props.record.options.find(option => option.id === choice()) : undefined
  const problem = () => inputProblem(selected(), values()[choice()])
  const ready = () => canWrite() && (!!selected() || !!text().trim()) && !problem()
  const send = async () => {
    if (!ready()) return
    const option = selected()
    // Saved first by the ledger client; a lost response keeps this exact command for retry.
    // The brief on screen is recorded with the answer, so History reopens what was seen when deciding.
    const brief = props.briefJob && props.briefJob.revision === String(contentRevision(props.record)) ? { brief: props.briefJob } : {}
    if (await props.attention.act(props.record, { action: "answer", ...(text().trim() ? { text: text() } : {}), ...(option ? { choice_id: option.id, ...inputPayload(option, values()[option.id]) } : {}), ...brief })) props.onView?.("answered")
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
          <span class="home-option-body">
            <Show when={outcome()?.sketch}>{sketch => <Sketch title={`What ${option.label} looks like`} sketch={sketch()} />}</Show>
            {/* A plain display label when the brief gives one; the producer's exact label stays the radio's name. */}
            <bdi dir="auto" class="home-option-label" title={outcome()?.label ? option.label : undefined}>{outcome()?.label || option.label}</bdi>
            <Show when={outcome()} fallback={<Show when={recommended()}><span class="home-source" id={`${id}-recommended`}>recommended</span></Show>}>{value => <>
              <span class="home-option-outcome" id={`${id}-${option.id}-outcome`} dir="auto">{value().outcome}</span>
              <Show when={value().note}><span class="home-option-note" dir="auto">{value().note}</span></Show>
              <Show when={recommended()}><span class="home-option-chips"><span data-recommended id={`${id}-recommended`}>Recommended</span></span></Show>
            </>}</Show>
          </span>
        </label>
      }}</For>
      {/* Not answering is shown as its own outcome only when no option already means it. */}
      <Show when={props.prepared?.ifWait}><div class="home-option-card home-option-wait" aria-hidden="true"><span class="home-option-body"><span class="home-option-label">No answer</span><span class="home-option-outcome" dir="auto">{props.prepared!.ifWait}</span></span></div></Show>
    </fieldset></Show>
    <Show when={selected()?.input && selected()}>{option => <OptionField id={`${id}-input`} option={option()} value={values()[option().id]} disabled={!canWrite()} onChange={value => setValues(current => ({ ...current, [option().id]: value }))} />}</Show>
    {props.afterChoices}
    <label for={id}>{props.options ? "Note (optional)" : "Your answer"}</label>
    <textarea id={id} dir="auto" rows={props.options ? 1 : 2} maxLength={8000} value={text()} disabled={!canWrite()}
      onInput={event => { setText(event.currentTarget.value); localStorage.setItem(answerDraftKey(props.record), event.currentTarget.value) }} />
    {/* What a publish decision would send, verbatim from the request, right above the action that approves it. */}
    <Show when={props.sends?.text ? props.sends : undefined}>{sends => <SendsPreview sends={sends()} />}</Show>
    <div class="home-actions">
      {/* On cards the selected card already shows the choice, so the button stays short; its name still says what is sent. */}
      <button class="home-primary" dir="auto" disabled={!ready()} aria-keyshortcuts={ariaShortcut("submit")} onClick={() => void send()}
        aria-label={props.prepared && selected() ? `Send ${selected()!.label}` : undefined}>
        <Show when={selected()} fallback="Send answer">{option => <Show when={!props.prepared} fallback="Send">Send <bdi dir="auto">{option().label}</bdi></Show>}</Show>
      </button>
      {props.extra}
      <span class="home-muted"><bdi>To</bdi> {target()}</span>
    </div>
    <Show when={selected() && problem()}><p class="home-input-problem" id={`${id}-input-problem`} role="status" dir="auto">{problem()}</p></Show>
  </div>
}

// The labelled control a choice asks for, by input kind; kinds this app does not know get no control (Send explains).
const OptionField = (props: { id: string; option: AttentionOption; value?: InputValue; disabled: boolean; onChange: (value: InputValue) => void }) => {
  const spec = () => props.option.input!
  const picked = () => typeof props.value === "string" ? [props.value] : props.value ?? []
  const label = () => <>{spec().label}<Show when={!spec().required}> <span class="home-muted">(optional)</span></Show></>
  return <Show when={INPUT_KINDS.includes(spec().kind)}>
    <div class="home-input" data-kind={spec().kind}>
      <Show when={spec().kind === "text"} fallback={
        <fieldset disabled={props.disabled} aria-describedby={`${props.id}-hint`}>
          <legend dir="auto">{label()}</legend>
          <Show when={spec().hint}><span class="home-muted" id={`${props.id}-hint`} dir="auto">{spec().hint}</span></Show>
          <For each={spec().choices ?? []}>{choice => <label>
            <input type={spec().kind === "multi" ? "checkbox" : "radio"} name={props.id} checked={picked().includes(choice.id)} onChange={event => props.onChange(spec().kind === "multi"
              ? event.currentTarget.checked ? [...picked(), choice.id] : picked().filter(id => id !== choice.id)
              : choice.id)} />
            <bdi dir="auto">{choice.label}</bdi>
          </label>}</For>
        </fieldset>}>
        <label for={props.id} dir="auto">{label()}</label>
        <textarea id={props.id} dir="auto" rows={2} maxLength={2000} placeholder={spec().hint} required={spec().required} disabled={props.disabled}
          value={typeof props.value === "string" ? props.value : ""} onInput={event => props.onChange(event.currentTarget.value)} />
      </Show>
    </div>
  </Show>
}

/** What approving would publish: the exact text, where it goes and who posts it, as the request and its evidence state. */
export type Sends = { text: string; to: string; as: string }

// The quoted text is the request's own; Copy takes exactly it, with its line breaks and nothing around it.
const SendsPreview = (props: { sends: Sends }) => {
  const [copied, setCopied] = createSignal<"Copied" | "Copy failed">()
  const copy = async () => {
    const ok = await navigator.clipboard?.writeText(props.sends.text).then(() => true, () => false) || copyBySelection(props.sends.text)
    setCopied(ok ? "Copied" : "Copy failed")
    setTimeout(() => setCopied(), 2000)
  }
  return <figure class="home-sends">
    <figcaption class="home-source">Would post<Show when={props.sends.as}> as <bdi dir="auto">{props.sends.as}</bdi></Show><Show when={props.sends.to}> · to <bdi dir="auto">{props.sends.to}</bdi></Show></figcaption>
    <blockquote dir="auto"><LinkedText text={props.sends.text} /></blockquote>
    <button type="button" class="home-sends-copy" aria-label="Copy the text it would post" onClick={() => void copy()}>{copied() ?? "Copy"}</button>
  </figure>
}

// The async Clipboard API is unavailable outside secure contexts; a selection copy inside the click still works.
const copyBySelection = (text: string) => {
  const input = document.createElement("textarea")
  input.value = text
  input.readOnly = true
  input.style.cssText = "position:fixed;top:0;left:0;width:1px;height:1px;opacity:0"
  document.body.append(input)
  try { input.select(); return document.execCommand("copy") } catch { return false } finally { input.remove() }
}

// The request as its agent wrote it, with Markdown formatting (lists, links, code with copy) and no raw HTML;
// the options and actions stay native controls outside it. No brief or model is needed to read it.
const RequestText = (props: { record: AttentionRecord }) =>
  <div class="home-request-text" dir="auto"><Markdown text={requestMarkdown(props.record.context)} cacheKey={`attention-request:${props.record.editspace}:${props.record.id}:${props.record.revision}`} /></div>

const Delivery = (props: { record: AttentionRecord; attention: Attention }) => {
  const delivery = () => props.record.delivery
  const canWrite = () => canWriteAttention(props.attention, props.record)
  // Link the delivered session only with its own verified directory; the source link stays separate.
  const target = () => delivery()?.session && delivery()?.session_directory ? { session: delivery()!.session!, directory: delivery()!.session_directory! } : undefined
  return <div class="home-delivery" data-delivery-state={props.record.delivery_state}>
    <p class="home-recorded"><Show when={optionLabel(props.record, props.record.answer?.choice_id)} fallback="You answered">{label => <>You chose <bdi dir="auto">{label()}</bdi></>}</Show>
      <Show when={props.record.answer?.answered_at}>{at => <> · <time dateTime={new Date(at()).toISOString()} title={new Date(at()).toLocaleString()}>{ago(at())}</time></>}</Show></p>
    <Show when={props.record.answer?.input_value !== undefined && props.record.options.find(option => option.id === props.record.answer?.choice_id)}>{option =>
      <p class="home-input-value"><span class="home-source">{option().input?.label ?? "Provided"}</span> <bdi dir="auto" class="home-answer-text">{inputText(option(), props.record.answer?.input_value)}</bdi></p>}</Show>
    <Show when={props.record.answer?.text}><pre class="home-answer-text" dir="auto"><LinkedText text={props.record.answer?.text ?? ""} /></pre></Show>
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
export const AttentionDecision = (props: { record: AttentionRecord; attention: Attention; onView?: (view: AttentionView) => void; brief?: JSX.Element; briefVisual?: JSX.Element; briefAfter?: JSX.Element; briefDetails?: JSX.Element; prepared?: BriefResult; sends?: Sends; conversation?: JSX.Element; more?: JSX.Element; briefJob?: { job: string; revision: string } }) => {
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
  // Grouped so a wide pane can set the explanation beside the answer; narrow panes stack the groups in this order.
  return <article class="home-decision" data-attention-id={props.record.id}>
    <header class="home-decision-head"><div class="home-eyebrow"><Requester record={props.record} /><time dateTime={new Date(props.record.created_at).toISOString()}>{ago(props.record.created_at)}</time><A href={sessionHref(props.record.source_ref.session_id, props.record.source_ref.directory)} aria-label="Open source thread">Agent thread</A></div>
      <Show when={!props.prepared}><h3><bdi dir="auto">{props.record.title}</bdi></h3></Show></header>
    {/* A prepared brief is one explainer: the human-level question heads it, with its context, the original
      * conversation and the picture beneath; the answer controls sit beside it (wide) or below it (narrow). */}
    <div class="home-decision-explain">
      <Show when={props.prepared}>{prepared => <div class="home-decision-question">
        <h3 class="home-question"><bdi dir="auto">{prepared().question}</bdi></h3>
        <p class="home-request-line"><bdi>Request:</bdi> <bdi dir="auto">{props.record.title}</bdi></p>
        {props.brief}
        {/* Steps the human must perform stay in the producer's exact words, unfolded, above the answer. */}
        <Show when={requestHasSteps(props.record)}><RequestText record={props.record} /></Show>
      </div>}</Show>
      <Show when={!props.prepared}><RequestText record={props.record} />{props.brief}</Show>
      {/* The picture tells the story; the original conversation it came from follows. */}
      {props.briefVisual}
      {props.conversation}
    </div>
    <div class="home-decision-act">
    <Show when={props.record.status === "open"}>
      {/* A recommendation that names an option is tagged on that option; free text stays visible. */}
      <Show when={props.record.recommendation && !props.record.options.some(option => option.id === props.record.recommendation)}><p class="home-muted">Recommended: <bdi dir="auto"><LinkedText text={props.record.recommendation ?? ""} /></bdi></p></Show>
      <Answer record={props.record} attention={props.attention} options={props.record.options.length > 0} onView={props.onView} prepared={props.prepared} afterChoices={props.briefAfter} sends={props.sends} briefJob={props.briefJob}
        extra={<><button class="home-quiet" disabled={!canWrite()} onClick={() => props.attention.act(props.record, { action: "snooze", snoozed_until: Date.now() + 3600_000 })}>Snooze 1h</button><button class="home-quiet" disabled={!canWrite()} onClick={() => props.attention.act(props.record, { action: "resolve", reason: "Human marked no longer needed" })}>No longer needed</button></>} />
    </Show>
    <Show when={props.record.status === "decided"}><p class="home-recorded">Saved: <bdi dir="auto">{decisionLabel(props.record)}</bdi> · not sent</p><Answer record={props.record} attention={props.attention} options={props.record.options.length > 0} onView={props.onView} /><div class="home-actions"><A href={sessionHref(props.record.source_ref.session_id, props.record.source_ref.directory)} aria-label="Open agent thread">Open thread</A><button disabled={!canWrite()} onClick={() => props.attention.act(props.record, { action: "resolve", reason: "Human marked resolved" })}>Mark resolved</button></div></Show>
    {/* A completed decision keeps its explainer: the options as they were shown, the chosen one marked, read-only. */}
    <Show when={props.prepared && props.record.answer && ["answered", "resolved", "withdrawn"].includes(props.record.status) ? props.prepared : undefined}>{prepared =>
      <ul class="home-options home-option-cards home-chosen" aria-label="Options as shown when you answered"><For each={props.record.options}>{option => {
        const outcome = () => prepared().choices.find(choice => choice.id === option.id)
        return <li class="home-option-card" data-chosen={props.record.answer?.choice_id === option.id ? "" : undefined}>
          <span class="home-option-body">
            <Show when={outcome()?.sketch}>{sketch => <Sketch title={`What ${option.label} looks like`} sketch={sketch()} />}</Show>
            <bdi dir="auto" class="home-option-label" title={outcome()?.label ? option.label : undefined}>{outcome()?.label || option.label}</bdi>
            <Show when={outcome()?.outcome}>{text => <span class="home-option-outcome" dir="auto">{text()}</span>}</Show>
            <Show when={props.record.answer?.choice_id === option.id}><span class="home-option-chips"><span data-chosen>Your choice</span></span></Show>
          </span>
        </li>
      }}</For></ul>}</Show>
    <Show when={props.record.status === "answered"}><Delivery record={props.record} attention={props.attention} /></Show>
    <Show when={props.record.status === "snoozed"}><p class="home-muted">Snoozed until {props.record.snoozed_until ? new Date(props.record.snoozed_until).toLocaleString() : "unknown"}</p><button disabled={!canWrite()} onClick={() => props.attention.act(props.record, { action: "wake" })}>Return to Needs you</button></Show>
    <Show when={["resolved", "withdrawn"].includes(props.record.status)}><p class="home-muted">{props.record.status === "resolved" ? "Resolved" : "Withdrawn"}</p><Show when={props.record.answer}><Show when={props.record.answer?.text}><pre class="home-answer-text" dir="auto"><LinkedText text={props.record.answer?.text ?? ""} /></pre></Show><Show when={optionLabel(props.record, props.record.answer?.choice_id)}>{label => <p class="home-recorded">You chose <bdi dir="auto">{label()}</bdi><Show when={props.record.answer?.answered_at}>{at => <> · <time dateTime={new Date(at()).toISOString()} title={new Date(at()).toLocaleString()}>{ago(at())}</time></>}</Show></p>}</Show><p class="home-muted">{deliveryLabel(props.record)}</p></Show></Show>
    </div>
    <div class="home-decision-more">
    {props.more}
    {props.briefDetails}
    {/* With a brief leading, the producer's exact request comes last, after the native controls. */}
    <Show when={props.prepared && !requestHasSteps(props.record)}>
      <details class="home-original"><summary>Original request</summary><RequestText record={props.record} /></details>
    </Show>
    <details onToggle={event => setHistoryOpen(event.currentTarget.open)}><summary>Record &amp; history</summary><div class="home-source"><bdi dir="ltr">{props.record.id} · {props.record.gate_key} · revision {props.record.revision}</bdi></div><Show when={history()?.version === historyVersion(props.record) ? history() : undefined} fallback={<p>Loading history…</p>}>{item => <Show when={!item().error} fallback={<p>{item().error}</p>}><pre dir="ltr">{JSON.stringify(item().events, null, 2)}</pre></Show>}</Show></details>
    </div>
  </article>
}
