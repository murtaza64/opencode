import { createEffect, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import type { Message, Part } from "@opencode-ai/sdk/v2"
import { oc } from "../api"
import { errorText } from "../live-session"
import { createFindHistory, FIND_LIMITS, scanDocuments, type FindDocument, type FindHit } from "../transcript-find"
import "./transcript-find.css"

export const FindExcerpt = (props: { hit: FindHit }) => <>
  <span class="find-source"><bdi dir="auto">{props.hit.kind}</bdi> · <bdi dir="ltr">{props.hit.messageID}</bdi> · character {props.hit.start + 1}</span>
  <span class="find-excerpt" dir="auto">…{props.hit.before}<mark>{props.hit.match}</mark>{props.hit.after}…</span>
</>

export const TranscriptFind = (props: {
  messages?: Message[]
  parts?: Record<string, Part[]>
  sessionID?: string
  directory?: string
  documents?: FindDocument[]
  scopeLabel?: string
  scopeDescription?: string
  jump: (hit: FindHit) => void
  close: () => void
  clear: () => void
}) => {
  const history = createFindHistory((before, signal) => {
    if (!props.sessionID || props.directory === undefined) throw new Error("No earlier history interface for this transcript.")
    return oc.messagesPage(props.sessionID, props.directory, 80, before, signal)
  })
  const [query, setQuery] = createSignal("")
  const [version, setVersion] = createSignal(0)
  const [hits, setHits] = createSignal<FindHit[]>([])
  const [selected, setSelected] = createSignal(-1)
  const [scanning, setScanning] = createSignal(false)
  const [paging, setPaging] = createSignal(false)
  const [scope, setScope] = createSignal(history.state())
  const [error, setError] = createSignal("")
  const [capped, setCapped] = createSignal(false)
  let input: HTMLInputElement | undefined
  let pageController: AbortController | undefined
  let previousIDs = new Set<string>()
  const cancel = () => { pageController?.abort(); pageController = undefined; setPaging(false) }
  onCleanup(cancel)
  onMount(() => input?.focus({ preventScroll: true }))
  createEffect(() => {
    const ids = new Set((props.messages ?? []).map((message) => message.id))
    previousIDs.forEach((id) => { if (!ids.has(id)) history.remove(id) })
    props.messages?.forEach((message) => history.add(message, props.parts?.[message.id] ?? []))
    if (props.documents) {
      const rows = new Map<string, FindDocument[]>()
      props.documents.forEach((document) => rows.set(document.messageID, [...(rows.get(document.messageID) ?? []), document]))
      rows.forEach((documents, id) => { ids.add(id); history.addDocuments(id, documents) })
    }
    previousIDs = ids
    setScope(history.state())
    setVersion((version) => version + 1)
  })
  createEffect(() => {
    const text = query()
    version()
    const controller = new AbortController()
    props.clear()
    setScanning(!!text)
    setHits([])
    setSelected(-1)
    setCapped(false)
    const timer = setTimeout(() => {
      if (!text) { setScanning(false); return }
      void scanDocuments(history.documents(), text, controller.signal).then((result) => {
        if (controller.signal.aborted) return
        setHits(result.hits)
        setCapped(result.capped)
        setScanning(false)
      }, (failure: unknown) => {
        if (controller.signal.aborted) return
        setError(errorText(failure))
        setScanning(false)
      })
    }, 250)
    onCleanup(() => { clearTimeout(timer); controller.abort() })
  })
  const earlier = async () => {
    if (paging() || !query() || scope().complete || scope().limited) return
    const controller = new AbortController()
    pageController = controller
    setPaging(true)
    setError("")
    try {
      while (!controller.signal.aborted) {
        const next = await history.next(controller.signal)
        setScope(next)
        setVersion((version) => version + 1)
        if (next.complete || next.limited) break
        await new Promise<void>((resolve) => setTimeout(resolve, 50))
      }
    } catch (failure) {
      if (!controller.signal.aborted) {
        setError(errorText(failure))
        setScope(history.state())
        setVersion((version) => version + 1)
      }
    } finally {
      if (pageController === controller) { pageController = undefined; setPaging(false) }
    }
  }
  const choose = (index: number) => {
    const hit = hits()[index]
    if (!hit) return
    setSelected(index)
    props.jump(hit)
  }
  const step = (back: boolean) => {
    if (!hits().length) return
    choose(selected() < 0 ? back ? hits().length - 1 : 0 : (selected() + (back ? -1 : 1) + hits().length) % hits().length)
  }
  return <section class="transcript-find" role="search" aria-label="Find in transcript" data-transcript-find
    onKeyDown={(event) => {
      if (event.isComposing) return
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); props.close() }
      if (event.key === "Enter" && event.target === input) { event.preventDefault(); event.stopPropagation(); step(event.shiftKey) }
    }}>
    <div class="find-controls">
      <input ref={input} type="search" aria-label="Find in transcript" dir="auto" maxLength={FIND_LIMITS.query}
        placeholder="Find in transcript" value={query()} onInput={(event) => {
          cancel()
          setQuery(event.currentTarget.value)
          setError("")
        }} />
      <button aria-label="Previous match" disabled={!hits().length} onClick={() => step(true)}>Previous</button>
      <button aria-label="Next match" disabled={!hits().length} onClick={() => step(false)}>Next</button>
      <button aria-label="Close transcript Find" onClick={props.close}>Close</button>
    </div>
    <div class="find-status" role="status" aria-live="polite">
      {scanning() ? "Searching… · " : ""}{selected() < 0 ? 0 : selected() + 1} of {hits().length}{capped() ? "+ (result cap)" : ""} matches
      {" · "}{props.scopeLabel ?? (scope().complete ? "Full selected transcript" : "Partial selected transcript")} · {scope().messages} messages indexed
      {paging() ? ` · Reading history (${scope().pages} pages)…` : ""}
      {scope().limited ? " · Index limit reached (20M characters / 200 pages)" : ""}
    </div>
    <div class="find-scope">{props.scopeDescription ?? "Literal, case-insensitive user/assistant text and tool output/errors, including collapsed results. Excludes generated/system context, reasoning, tool inputs, mail deliveries/wrappers/feed, and other sessions."}</div>
    <div class="find-controls">
      <Show when={props.sessionID && !scope().complete && !scope().limited}>
        <button disabled={!query() || paging()} onClick={() => { void earlier() }}>Search earlier history</button>
      </Show>
      <Show when={paging()}><button onClick={cancel}>Cancel history search</button></Show>
      <Show when={error()}><span role="alert" class="err">{error()}</span></Show>
    </div>
    <div class="find-results" aria-label="Transcript matches">
      <For each={hits()}>{(hit, index) => <button class="find-result" aria-current={selected() === index() ? "true" : undefined}
        onClick={() => choose(index())}><FindExcerpt hit={hit} /></button>}</For>
    </div>
  </section>
}
