import { createMemo, createSignal, For, onMount, Show } from "solid-js"
import type { QuestionInfo, QuestionRequest, ToolPart } from "@opencode-ai/sdk/v2"
import { Markdown } from "@opencode-ai/session-ui/markdown"
import { oc } from "../api"
import { assembleQuestionAnswers, questionOptionLabel } from "../question-answer"

export function InlineQuestion(props: {
  part?: ToolPart
  request?: QuestionRequest
  directory: string
  owner?: string
  onDone: () => Promise<void>
}) {
  const questions = createMemo(() => props.request?.questions ?? (props.part?.state.input.questions as QuestionInfo[] | undefined) ?? [])
  const answers = createMemo(() => {
    if (!props.part || !("metadata" in props.part.state)) return []
    return (props.part.state.metadata?.answers ?? []) as string[][]
  })
  const [selections, setSelections] = createSignal<string[][]>(questions().map(() => []))
  const [notes, setNotes] = createSignal<string[]>(questions().map(() => ""))
  const [missing, setMissing] = createSignal(new Set<number>())
  const [error, setError] = createSignal("")
  const [sending, setSending] = createSignal(false)
  let card: HTMLElement | undefined

  onMount(() => {
    if (props.request) card?.scrollIntoView({ block: "nearest", inline: "nearest" })
  })

  const toggle = (index: number, label: string, multiple?: boolean) => {
    setSelections((previous) => previous.map((current, question) => {
      if (question !== index) return current
      const selected = current.includes(label)
      if (!multiple) return selected ? [] : [label]
      return selected ? current.filter((item) => item !== label) : [...current, label]
    }))
    setMissing((previous) => new Set([...previous].filter((item) => item !== index)))
  }

  const submit = async () => {
    if (!props.request || sending()) return
    const result = assembleQuestionAnswers(questions(), selections(), notes())
    setMissing(new Set(result.missing))
    if (result.missing.length) return
    setSending(true)
    setError("")
    try {
      await oc.questionReply(props.request.id, props.directory, result.answers)
      await props.onDone()
    } catch (cause) {
      setError(String(cause))
    } finally {
      setSending(false)
    }
  }

  const dismiss = async () => {
    if (!props.request || sending()) return
    setSending(true)
    setError("")
    try {
      await oc.questionReject(props.request.id, props.directory)
      await props.onDone()
    } catch (cause) {
      setError(String(cause))
    } finally {
      setSending(false)
    }
  }

  return (
    <Show when={props.request} fallback={
      <Show when={answers().length} fallback={
        <Show when={props.part?.state.status === "error"}>
          <div class="question-summary dismissed" data-timeline-part-id={props.part?.id}>Question dismissed</div>
        </Show>
      }>
        <div class="question-summary" data-question-summary data-timeline-part-id={props.part?.id}>
          <For each={questions()}>
            {(question, index) => (
              <div class="question-summary-row">
                <span class="question-summary-mark" aria-hidden="true">Q</span>
                <bdi dir="auto">{question.header || question.question}</bdi>
                <span class="question-summary-arrow" aria-hidden="true">→</span>
                <bdi class="question-summary-answer" dir="auto">{answers()[index()]?.join(", ") || "No answer"}</bdi>
              </div>
            )}
          </For>
        </div>
      </Show>
    }>
      <section ref={card} class="question-round" data-question-request={props.request!.id} data-timeline-part-id={props.part?.id} aria-label="Questions">
        <div class="question-round-head">
          <span class="question-round-kicker">Question round</span>
          <Show when={props.owner}><span class="question-owner">from subagent: <bdi dir="auto">{props.owner}</bdi></span></Show>
        </div>
        <form onSubmit={(event) => { event.preventDefault(); void submit() }} onKeyDown={(event) => {
          if (event.key !== "Enter" || event.shiftKey || event.target instanceof HTMLTextAreaElement) return
          event.preventDefault()
          void submit()
        }}>
          <For each={questions()}>
            {(question, index) => (
              <article class="question-card" classList={{ invalid: missing().has(index()) }}>
                <div class="question-title"><span>{String(index() + 1).padStart(2, "0")}</span><bdi dir="auto">{question.header || "Question"}</bdi></div>
                <div class="question-markdown" dir="auto">
                  <Markdown text={question.question} cacheKey={`question:${props.request!.id}:${index()}`} />
                </div>
                <div class="question-options">
                  <For each={question.options}>
                    {(option) => {
                      const recommended = option.label.endsWith("(Recommended)")
                      return (
                        <button type="button" class="question-option" classList={{ selected: selections()[index()]?.includes(option.label) }}
                          aria-pressed={selections()[index()]?.includes(option.label)} onClick={() => toggle(index(), option.label, question.multiple)}>
                          <span class="question-option-label"><bdi dir="auto">{questionOptionLabel(option.label)}</bdi><Show when={recommended}><span class="recommended">Recommended</span></Show></span>
                          <span class="question-option-description" dir="auto"><Markdown text={option.description} cacheKey={`question:${props.request!.id}:${index()}:${option.label}`} /></span>
                        </button>
                      )
                    }}
                  </For>
                </div>
                <textarea rows={2} value={notes()[index()] ?? ""} placeholder="Add a note or write your own answer…" aria-label={`${question.header || "Question"} note`}
                  onInput={(event) => {
                    setNotes((previous) => previous.map((note, questionIndex) => questionIndex === index() ? event.currentTarget.value : note))
                    setMissing((previous) => new Set([...previous].filter((item) => item !== index())))
                  }} />
                <Show when={missing().has(index())}><div class="question-error" role="alert">Choose an option or add a note.</div></Show>
              </article>
            )}
          </For>
          <div class="question-actions">
            <button type="submit" class="question-submit" disabled={sending()}>Answer round</button>
            <button type="button" class="danger" disabled={sending()} onClick={() => void dismiss()}>Dismiss</button>
            <span class="question-enter">Enter accepts recommendations</span>
          </div>
          <Show when={error()}><div class="err" role="alert">{error()}</div></Show>
        </form>
      </section>
    </Show>
  )
}
