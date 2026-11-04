/* A grilling session (a series of questions from one agent) answered one question at a time. Presentation only:
 * every question stays its own attention record, answered by its own command with its own revision and delivery. */
import { createEffect, createMemo, createSignal, For, on, Show } from "solid-js"
import { A } from "@solidjs/router"
import { Markdown } from "@opencode-ai/session-ui/markdown"
import { sessionHref } from "../state"
import { answerDraftKey, deliveryLabel, type AttentionAction, type AttentionRecord, type createAttention } from "../attention"
import { requestMarkdown } from "../request-markdown"
import { answerIsText, answerWords, deliveredState, grilling, hinge } from "../attention-series"
import { dictationInsert } from "../composer"
import type { DeskItem } from "../desk"
import { AgentName, Answer, canWriteAttention, useRequestAgent } from "./attention-decision"
import { AttentionSeries } from "./attention-series"
import { DictationField } from "./dictation-field"
import "./grilling.css"

type Attention = ReturnType<typeof createAttention>
type Session = ReturnType<typeof grilling>
type Question = Session["questions"][number]

// "Sent ✓" stays on the answered question this long before the next one opens.
const ADVANCE_MS = 400

export const Grilling = (props: { item: DeskItem; attention: Attention; onClose: () => void }) => {
  const series = () => props.item.series!
  // Read members from the ledger snapshot, not the queue entry: the entry leaves Needs you with the last answer,
  // and the closing summary still needs that answer.
  const members = createMemo(() => {
    const anchor = props.item.record ?? series().members[0]!
    const live = (props.attention.snapshot()?.value.records ?? []).filter(record => record.series?.id === series().id &&
      record.editspace === anchor.editspace && record.origin_session === anchor.origin_session)
    return live.length ? live : series().members
  })
  const session = createMemo(() => grilling(members()))
  const live = () => session().questions.filter(question => question.record.status !== "withdrawn")
  const [pinned, setPinned] = createSignal<number | "summary">()
  const [sent, setSent] = createSignal<number>()
  const [board, setBoard] = createSignal(false)
  const [strip, setStrip] = createSignal(false)
  const view = () => pinned() ?? session().next?.index ?? "summary"
  const current = () => { const index = view(); return index === "summary" ? undefined : session().questions.find(question => question.index === index) }
  const position = () => { const index = view(); return index === "summary" ? live().length : live().findIndex(question => question.index === index) + 1 }
  const step = (delta: 1 | -1) => {
    const stops = [...live().map(question => question.index), "summary" as const]
    const at = stops.indexOf(view())
    const target = stops[Math.max(0, Math.min(stops.length - 1, (at < 0 ? 0 : at) + delta))]
    if (target !== undefined) setPinned(target)
    setStrip(false)
  }
  // Stay on the answered question while "Sent ✓" shows, then follow the next unanswered one.
  const answer = async (question: Question, action: AttentionAction) => {
    setPinned(question.index)
    if (!await props.attention.act(question.record, action)) return
    advance(question.index)
  }
  const advance = (index: number) => {
    localStorage.removeItem(answerDraftKey(session().questions.find(question => question.index === index)?.record ?? members()[0]!))
    setSent(index)
    setTimeout(() => {
      setSent(undefined)
      if (pinned() === index) setPinned(undefined)
    }, ADVANCE_MS)
  }
  let root: HTMLElement | undefined
  // Focus starts on the recommended choice, so Enter answers it; elsewhere on the first control of the view.
  const focusView = () => requestAnimationFrame(() => {
    const target = root?.querySelector<HTMLElement>(".grill-choice[data-recommended]:not(:disabled), .grill-choice:not(:disabled), .grill-pane .home-answer button:not(:disabled), .grill-summary-done, .grill-pane [data-grill-focus]")
    target?.focus({ preventScroll: true })
  })
  createEffect(on(() => `${view()}:${current()?.record.status ?? ""}:${board()}`, () => { if (!board()) focusView() }))
  const open = (index: number | "summary") => { setPinned(index); setStrip(false); focusView() }
  const keys = (event: KeyboardEvent) => {
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || event.isComposing || board()) return
    const typing = event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLInputElement
    if (typing) {
      // Esc leaves the text box for the choices, keeping the draft; a second Esc pauses.
      if (event.key !== "Escape") return
      event.preventDefault()
      event.stopPropagation()
      ;(root?.querySelector<HTMLElement>(".grill-choice[data-recommended], .grill-choice") ?? root)?.focus()
      return
    }
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); return props.onClose() }
    if (event.key === "j" || event.key === "J") { event.preventDefault(); return step(1) }
    if (event.key === "k" || event.key === "K") { event.preventDefault(); return step(-1) }
    if (event.key === "/") {
      const field = root?.querySelector<HTMLTextAreaElement>(".grill-free textarea:not(:disabled)")
      if (field) { event.preventDefault(); field.focus() }
      return
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      const choices = [...root?.querySelectorAll<HTMLElement>(".grill-choice:not(:disabled)") ?? []]
      const at = choices.indexOf(document.activeElement as HTMLElement)
      if (at < 0 || !choices.length) return
      event.preventDefault()
      choices[(at + (event.key === "ArrowDown" ? 1 : -1) + choices.length) % choices.length]!.focus()
    }
  }
  // A horizontal swipe moves between questions; reading direction decides which way is "next".
  let touch: { x: number; y: number } | undefined
  const swipe = (event: TouchEvent) => {
    const start = touch
    touch = undefined
    const end = event.changedTouches[0]
    if (!start || !end) return
    const dx = end.clientX - start.x
    if (Math.abs(dx) < 60 || Math.abs(end.clientY - start.y) > 40) return
    const rtl = root && getComputedStyle(root).direction === "rtl"
    step((dx < 0) !== !!rtl ? 1 : -1)
  }
  const agentFor = useRequestAgent()
  const anchor = () => props.item.record ?? members()[0]!
  return <article ref={root} class="grill" data-grill-series={series().id} data-view={board() ? "board" : String(view())} onKeyDown={keys}>
    <header class="grill-head">
      <span class="home-source">Grilling · <bdi dir="auto">{props.item.project}</bdi></span>
      <h3 dir="auto">{series().title}</h3>
      <p class="grill-meta home-source">
        <AgentName agent={agentFor(anchor())} />
        {/* English label runs stay left to right in an RTL page. */}
        <span> · </span><bdi dir="ltr"><span class="grill-count">{session().answered} of {session().live} answered</span>
        <Show when={session().followUps}> · <span class="grill-followups">{session().followUps} follow-up{session().followUps === 1 ? "" : "s"}</span></Show></bdi>
      </p>
      <GrillSegments session={session()} current={board() ? undefined : current()?.index} />
      <div class="grill-head-actions">
        <button type="button" class="desk-button" aria-pressed={board()} onClick={() => setBoard(value => !value)}>{board() ? "One at a time" : "See all"}</button>
        <button type="button" class="desk-button" title="Pause: the entry in Needs you keeps your place" aria-keyshortcuts="Escape" onClick={() => props.onClose()}>Pause <kbd>Esc</kbd></button>
      </div>
    </header>
    <Show when={!board()} fallback={<AttentionSeries item={{ ...props.item, series: { ...series(), members: members() } }} attention={props.attention} />}>
      <div class="grill-body">
        <nav class="grill-nav" aria-label="Questions" data-open={strip() ? "" : undefined}>
          <button type="button" class="grill-strip" aria-expanded={strip()} onClick={() => setStrip(value => !value)}>
            {view() === "summary" ? "Summary" : `${position()} of ${live().length}`} <span aria-hidden="true">⌄</span>
          </button>
          <ol class="grill-rail">
            <For each={session().questions}>{question => <li>
              <button type="button" class="grill-rail-item" data-index={question.index} data-status={question.record.status} data-follow-up={question.followUp ? "" : undefined}
                aria-current={view() === question.index ? "step" : undefined} disabled={question.record.status === "withdrawn"}
                onClick={() => open(question.index)}>
                <span class="grill-rail-title" dir="auto"><span class="grill-q">Q{question.index}</span> {question.record.title}</span>
                <RailNote question={question} sent={sent() === question.index} />
              </button>
            </li>}</For>
            <li><button type="button" class="grill-rail-item grill-rail-summary" aria-current={view() === "summary" ? "step" : undefined} onClick={() => open("summary")}>Decided so far</button></li>
          </ol>
        </nav>
        <div class="grill-pane" onTouchStart={event => { const point = event.touches[0]; touch = point && { x: point.clientX, y: point.clientY } }} onTouchEnd={swipe}>
          {/* Keyed by question and revision, not the polled record object, so a poll never resets a draft or focus. */}
          <Show when={current() && `${current()!.record.id}:${current()!.record.revision}`} keyed fallback={
            <Summary session={session()} onDone={props.onClose} onContinue={() => setPinned(undefined)} />}>
            {_key => <QuestionView question={current()!} session={session()} attention={props.attention} sent={sent() === current()!.index}
              onAnswer={action => answer(current()!, action)} onAnswered={() => advance(current()!.index)} />}
          </Show>
          <p class="grill-foot home-source">
            <Show when={view() !== "summary"} fallback={<span dir="ltr"><kbd>K</kbd> back · <kbd>Esc</kbd> pause</span>}>
              <span dir="ltr"><kbd>↑</kbd><kbd>↓</kbd> choose · <kbd>↵</kbd> answer · <kbd>/</kbd> type · <kbd>K</kbd>/<kbd>J</kbd> prev/next question · <kbd>Esc</kbd> pause</span>
            </Show>
            <Show when={view() !== "summary"}><span dir="ltr">Q{current()?.index} · {position()} of {live().length} · each answer is sent as you go</span></Show>
          </p>
        </div>
      </div>
    </Show>
  </article>
}

/** One segment per live question: answered, current, or waiting; follow-ups tinted. */
export const GrillSegments = (props: { session: Session; current?: number }) =>
  <div class="grill-segments" role="img" aria-label={`${props.session.answered} of ${props.session.live} answered`}>
    <For each={props.session.questions.filter(question => question.record.status !== "withdrawn")}>{question =>
      <span class="grill-segment" data-state={question.record.answer ? "answered" : question.index === props.current ? "current" : "open"} data-follow-up={question.followUp ? "" : undefined} />}</For>
  </div>

const RailNote = (props: { question: Question; sent: boolean }) => {
  const record = () => props.question.record
  return <span class="grill-rail-note" dir="auto">
    <Show when={record().status !== "withdrawn"} fallback="withdrawn">
      <Show when={record().answer} fallback={<Show when={props.question.followUp}>{props.question.cause ? `follow-up to Q${props.question.cause.index}` : "follow-up"}</Show>}>
        <Show when={answerIsText(record())} fallback={<bdi dir="auto">{answerWords(record())}</bdi>}>you: <bdi dir="auto">“{answerWords(record())}”</bdi></Show>
        <span class="grill-delivered" data-state={deliveredState(record())}> {props.sent ? "· sent ✓" : deliveredState(record()) === "delivered" ? "✓ delivered" : `· ${deliveredState(record())}`}</span>
      </Show>
    </Show>
  </span>
}

const QuestionView = (props: { question: Question; session: Session; attention: Attention; sent: boolean; onAnswer: (action: AttentionAction) => Promise<void>; onAnswered: () => void }) => {
  const record = () => props.question.record
  const canWrite = () => canWriteAttention(props.attention, record())
  const answerable = () => !record().answer && (record().status === "open" || record().status === "decided")
  // Plain choices plus at most one written "Other": the stepper's own buttons and free text cover it. Anything else
  // (a pick list, a secret) keeps the full decision card.
  const plain = () => record().options.every(option => !option.input || option.input.kind === "text") && record().options.filter(option => option.input).length <= 1
  const other = () => record().options.find(option => option.input?.kind === "text")
  const [text, setText] = createSignal(localStorage.getItem(answerDraftKey(record())) ?? "")
  const [busy, setBusy] = createSignal(false)
  const write = (value: string) => { setText(value); localStorage.setItem(answerDraftKey(record()), value) }
  const send = (action: Omit<AttentionAction, "action">) => {
    if (busy() || !canWrite()) return
    setBusy(true)
    void props.onAnswer({ action: "answer", ...action }).finally(() => setBusy(false))
  }
  // Free text is a full answer: the producer's "Other" option carries it when there is one (its 2000-character
  // limit permitting), else it goes as the answer's own text.
  const sendText = () => {
    const value = text().trim()
    if (!value) return
    const option = other()
    send(option && text().length <= 2000 ? { choice_id: option.id, input_value: text() } : { text: text() })
  }
  const id = `grill-${record().id}`
  return <section class="grill-question" data-attention-id={record().id} data-index={props.question.index} aria-labelledby={`${id}-title`}>
    <Show when={props.question.cause} fallback={<Show when={props.question.followUp}><p class="grill-because">↳ follow-up</p></Show>}>
      {cause => <p class="grill-because" dir="auto">↳ because you said <bdi dir="auto">“{cause().said}”</bdi> (Q{cause().index})</p>}
    </Show>
    <h4 id={`${id}-title`} dir="auto">{record().title}</h4>
    <Show when={hinge(record().context)}>{line => <p class="grill-hinge" dir="auto">{line()}</p>}</Show>
    <Show when={record().status === "withdrawn"}><p class="home-muted" data-grill-focus tabindex="-1">The agent withdrew this question.</p></Show>
    <Show when={record().status === "snoozed"}><p class="home-muted" data-grill-focus tabindex="-1">Snoozed. Wake it from its card under See all to answer.</p></Show>
    <Show when={record().answer}>
      <div class="grill-recorded" aria-label={`Your answer to question ${props.question.index}`}>
        <strong>{answerIsText(record()) ? "You said" : "You chose"}</strong>
        <p dir="auto">{answerIsText(record()) ? <bdi dir="auto">“{answerWords(record())}”</bdi> : answerWords(record())}</p>
        <Show when={props.sent} fallback={<p class="home-muted">{deliveryLabel(record())}</p>}><p class="grill-sent" role="status">Sent ✓</p></Show>
        <p class="home-muted" data-grill-focus tabindex="-1">To change it, tell the agent in <A href={sessionHref(record().source_ref.session_id, record().source_ref.directory)}>its thread</A>.</p>
      </div>
    </Show>
    <Show when={answerable()}>
      <Show when={plain()} fallback={<Answer record={record()} attention={props.attention} options hideTarget onView={view => view === "answered" && props.onAnswered()} />}>
        <div class="grill-choices" role="group" aria-label="Your answer">
          <For each={record().options.filter(option => !option.input)}>{option => {
            const recommended = () => record().recommendation === option.id
            return <button type="button" class="decision-button grill-choice" classList={{ "home-primary": recommended() }} data-option={option.id}
              data-recommended={recommended() ? "" : undefined} disabled={!canWrite() || busy()} onClick={() => send({ choice_id: option.id })}>
              <bdi dir="auto">{option.label}</bdi><Show when={recommended()}><span class="grill-rec" dir="ltr">rec.</span><span class="sr-only">, recommended</span></Show>
            </button>
          }}</For>
        </div>
        <div class="grill-free">
          <textarea id={`${id}-text`} dir="auto" rows={1} maxLength={8000} value={text()} disabled={!canWrite()} placeholder="Or say it in your words…"
            aria-label={other()?.input?.label ?? "Your answer in your words"} onInput={event => write(event.currentTarget.value)}
            onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey && !event.isComposing && event.keyCode !== 229) { event.preventDefault(); sendText() } }} />
          <Show when={text().trim()}><button type="button" class="decision-button home-primary grill-free-send" disabled={!canWrite() || busy()} onClick={sendText}>Send</button></Show>
          <Show when={canWrite()}><DictationField field={`grill:${record().editspace}:${record().id}`} label="answer" insert={spoken => {
            const el = document.getElementById(`${id}-text`) as HTMLTextAreaElement | null
            const selection: [number, number] = el ? [el.selectionStart, el.selectionEnd] : [text().length, text().length]
            write(dictationInsert({ text: text(), revision: 0, selection }, { revision: 0, selection }, spoken).text)
          }} /></Show>
        </div>
      </Show>
    </Show>
    <Show when={record().context.trim()}>
      <details class="grill-more"><summary>More context <span class="home-muted">(the agent's full note)</span></summary>
        <div class="home-request-text" dir="auto"><Markdown text={requestMarkdown(record().context, {})} cacheKey={`grill:${record().editspace}:${record().id}:${record().revision}`} /></div>
      </details>
    </Show>
  </section>
}

/** B's ledger as the closing summary: what was decided, in the human's words, with each answer's delivery. */
const Summary = (props: { session: Session; onDone: () => void; onContinue: () => void }) => {
  const answered = () => props.session.questions.filter(question => question.record.answer && question.record.status !== "withdrawn")
  return <section class="grill-summary" aria-labelledby="grill-summary-title">
    <h4 id="grill-summary-title">Decided so far</h4>
    <Show when={answered().length} fallback={<p class="home-muted">Nothing answered yet.</p>}>
      <ol class="grill-decided">
        <For each={answered()}>{question => <li data-index={question.index}>
          <span class="grill-q">Q{question.index}</span> <span dir="auto">{question.record.title}</span>
          <span class="grill-decided-answer" dir="auto">{answerIsText(question.record) ? <bdi dir="auto">“{answerWords(question.record)}”</bdi> : answerWords(question.record)}</span>
          <span class="grill-delivered" data-state={deliveredState(question.record)}>{deliveredState(question.record) === "delivered" ? "✓ delivered" : deliveredState(question.record)}</span>
        </li>}</For>
      </ol>
    </Show>
    <Show when={props.session.unanswered.length}>
      <p class="home-muted">Still open: <bdi dir="ltr">{props.session.unanswered.map(record => `Q${record.series!.index}`).join(", ")}</bdi></p>
    </Show>
    <div class="home-actions">
      <Show when={props.session.next} fallback={<button type="button" class="desk-button home-primary grill-summary-done" onClick={() => props.onDone()}>Done</button>}>
        <button type="button" class="desk-button home-primary grill-summary-done" onClick={() => props.onContinue()}>Continue</button>
        <button type="button" class="desk-button" onClick={() => props.onDone()}>Pause</button>
      </Show>
    </div>
  </section>
}
