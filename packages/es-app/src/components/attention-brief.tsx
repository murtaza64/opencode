/* Derived, source-revision-bound brief for one queue item. The canonical request it explains is
 * rendered separately and stays the authority; this only makes it decidable at a glance. The UI does
 * not caption it as derived: the binding is enforced in code and provenance sits in Details. */
import { createSignal, For, Match, Show, Switch } from "solid-js"
import { useBriefs } from "../desk-briefs"
import { A } from "@solidjs/router"
import { sessionHref } from "../state"
import { docHref } from "../pages/doc"
import { briefComplete, sourceTarget, type BriefResult, type BriefShape, type BriefSource, type DeskItem, type EvidenceRef } from "../desk"
import { currentJob, type BriefJob } from "../desk-session"

const Refs = (props: { refs: string[]; known: EvidenceRef[]; item: DeskItem }) =>
  <For each={props.refs}>{id => {
    const ref = () => props.known.find(candidate => candidate.id === id)
    return <Show when={ref()?.messageID} fallback={<span class="desk-ref" title={ref()?.label}>{id}</span>}>
      <A class="desk-ref" title={ref()?.label} href={sessionHref(props.item.source.session, props.item.source.directory)}>{id}</A>
    </Show>
  }}</For>

/** Where a cited source opens: the source thread at the cited messages, or a markdown doc in the editspace. */
const sourceLink = (source: BriefSource, refs: EvidenceRef[], item: DeskItem) => {
  const target = sourceTarget(source, refs)
  if (target?.kind === "doc") return { kind: "Doc", href: docHref("editspace", target.path) }
  if (target) return { kind: "Thread", href: `${sessionHref(item.source.session, item.source.directory)}${target.message ? `&message=${encodeURIComponent(target.message)}` : ""}${target.to ? `&to=${encodeURIComponent(target.to)}` : ""}` }
}

type Part = "lead" | "after" | "details"
/** `part` renders one slot of a brief inside a decision card; without it the whole brief renders in one place. */
export const BriefPanel = (props: { item: DeskItem; live: boolean; jobs: BriefJob[]; canStart: boolean; confirming: boolean; start: () => void; confirm: () => void; unavailable?: string; auto?: boolean; part?: Part }) => {
  const current = () => currentJob(props.jobs, props.item)
  const discarded = () => props.jobs.filter(job => job.meta.revision !== props.item.revision)
  const ready = () => { const job = current(); return job?.state.state === "ready" ? { job, result: job.state.result as BriefResult, omitted: job.state.omitted } : undefined }
  const complete = () => { const value = ready(); return !!value && briefComplete(value.result, props.item) }
  const shows = (part: Part) => !props.part || props.part === part
  return <section class="desk-brief" aria-label="Brief" data-part={props.part}>
    <Show when={shows("lead")}>
      <Show when={current()} fallback={<Show when={props.live}>
        <Show when={props.auto && !props.unavailable} fallback={<>
          <button class="desk-button" disabled={!props.canStart} onClick={props.start}>Prepare brief</button>
          <Show when={props.unavailable}><span class="home-source"> {props.unavailable}</span></Show>
        </>}><p class="home-muted" role="status">Preparing brief…</p></Show>
      </Show>}>{job => <>
        <Show when={job().state.state === "starting" || job().state.state === "running"}><p class="home-muted" role="status">Preparing brief…</p></Show>
        <Show when={job().state.state === "failed"}><p class="home-warning">Brief failed: {(job().state as { error: string }).error}</p></Show>
        <Show when={job().state.state === "unknown"}><p class="home-warning">{(job().state as { reason: string }).reason}</p></Show>
        {/* Confirm resends the identical request; Core returns the same brief if the first start landed. */}
        <Show when={job().state.state === "unconfirmed"}><p class="home-warning">Brief start not confirmed.</p>
          <button class="desk-button" disabled={props.confirming} onClick={props.confirm}>Confirm start</button></Show>
        <Show when={(job().state.state === "failed" || job().state.state === "unknown") && props.live}><button class="desk-button" disabled={!props.canStart} onClick={props.start}>Prepare again</button></Show>
      </>}</Show>
      <Show when={!current() && discarded().length}><p class="home-source">The request changed since the last brief.</p></Show>
      <Show when={complete() && ready()}>{value => <div class="desk-brief-body">
        <Show when={value().result.ask}><p class="desk-brief-ask" dir="auto">{value().result.ask}</p></Show>
        <Show when={value().result.whyYou || value().result.whyNow}><p class="desk-brief-why" dir="auto">
          <Show when={value().result.whyYou}><b>Why you:</b> {value().result.whyYou} </Show>
          <Show when={value().result.whyNow}><b>Why now:</b> {value().result.whyNow}</Show>
        </p></Show>
      </div>}</Show>
    </Show>
    <Show when={shows("after") && complete() && ready()}>{value => <div class="desk-brief-after">
      <Show when={!props.item.record?.options.length && value().result.ifWait}><p class="home-muted" dir="auto">If you wait: {value().result.ifWait}</p></Show>
      <Show when={value().result.shape}>{shape => <Shape shape={shape()} />}</Show>
      <Show when={value().result.unknown}><p class="desk-brief-unknown" dir="auto"><span>Unknown</span> {value().result.unknown}</p></Show>
      <SourceLinks sources={value().result.sources} refs={value().job.meta.refs} item={props.item} />
    </div>}</Show>
    {/* Cited evidence and provenance stay one click away, not in the reading path. */}
    <Show when={shows("details") && ready()}>{value => <details class="desk-brief-detail"><summary>Details</summary>
      <Show when={value().result.facts.length}><ul><For each={value().result.facts}>{fact => <li><bdi dir="auto">{fact.text}</bdi> <Refs refs={fact.refs} known={value().job.meta.refs} item={props.item} /></li>}</For></ul></Show>
      <Show when={value().result.timeline.length}><ol class="desk-timeline"><For each={value().result.timeline}>{entry => <li><Show when={entry.when}><span class="home-source">{entry.when} · </span></Show><bdi dir="auto">{entry.text}</bdi> <Refs refs={entry.refs} known={value().job.meta.refs} item={props.item} /></li>}</For></ol></Show>
      <Show when={value().result.gaps.length}><ul class="home-muted"><For each={value().result.gaps}>{gap => <li dir="auto">{gap}</li>}</For></ul></Show>
      <Show when={value().result.visual}>{visual => <Visual title={visual().title} html={visual().html} />}</Show>
      {/* An incomplete brief still offers what it found, without standing in for the request. */}
      <Show when={!complete()}><SourceLinks sources={value().result.sources} refs={value().job.meta.refs} item={props.item} /></Show>
      <p class="home-source">Brief for revision {value().job.meta.revision}<Show when={value().omitted}> · {value().omitted} uncited statement(s) omitted</Show> · <A href={sessionHref(value().job.id, value().job.directory)}>Brief thread</A></p>
    </details>}</Show>
  </section>
}

const SourceLinks = (props: { sources: BriefSource[]; refs: EvidenceRef[]; item: DeskItem }) => {
  const links = () => props.sources.flatMap(source => { const link = sourceLink(source, props.refs, props.item); return link ? [{ ...link, label: source.label }] : [] })
  return <Show when={links().length}><p class="desk-brief-sources"><For each={links()}>{link =>
    <A href={link.href}>↗ {link.kind} · <bdi dir="auto">{link.label}</bdi></A>}</For></p></Show>
}

// Drawn by the app in its own type styles, so every brief reads the same way and stays RTL-aware.
const Shape = (props: { shape: BriefShape }) =>
  <Switch>
    <Match when={props.shape.kind === "sequence" && props.shape}>{shape =>
      <ol class="desk-flow" aria-label="Sequence"><For each={shape().steps}>{step => <li><bdi dir="auto">{step}</bdi></li>}</For></ol>}</Match>
    <Match when={props.shape.kind === "scope" && props.shape}>{shape =>
      <div class="desk-scope">
        <Show when={shape().included.length}><div><span class="home-source">In</span><ul><For each={shape().included}>{entry => <li dir="auto">{entry}</li>}</For></ul></div></Show>
        <Show when={shape().excluded.length}><div data-excluded><span class="home-source">Out</span><ul><For each={shape().excluded}>{entry => <li dir="auto">{entry}</li>}</For></ul></div></Show>
      </div>}</Match>
    <Match when={props.shape.kind === "impact" && props.shape}>{shape =>
      <ul class="desk-impact"><For each={shape().rows}>{row => <li><bdi dir="auto">{row.area}</bdi> → <bdi dir="auto">{row.change}</bdi></li>}</For></ul>}</Match>
  </Switch>

// No scripts, forms, navigation or same-origin access, and CSP blocks every network request.
const CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:"
const Visual = (props: { title: string; html: string }) =>
  <figure class="desk-visual">
    <iframe title={props.title || "Brief visual"} sandbox="" referrerpolicy="no-referrer" loading="lazy"
      srcdoc={`<!doctype html><meta http-equiv="Content-Security-Policy" content="${CSP}"><style>html{color-scheme:dark;color:#cdd6f4;background:#181825;font:13px system-ui,sans-serif}body{margin:10px}</style>${props.html}`} />
    <Show when={props.title}><figcaption class="home-source">{props.title}</figcaption></Show>
  </figure>

/** Asks the desk conversation to explain this item further, with an optional question. Only an explicit
 * click sends; renders and refreshes never do. */
export const MoreDetail = (props: { ask: (question: string) => Promise<string | undefined> }) => {
  const [open, setOpen] = createSignal(false)
  const [question, setQuestion] = createSignal("")
  const [sending, setSending] = createSignal(false)
  const [result, setResult] = createSignal<{ error?: string }>()
  const send = async () => {
    if (sending()) return
    setSending(true)
    const error = await props.ask(question()).finally(() => setSending(false))
    setResult({ error })
    if (!error) { setOpen(false); setQuestion("") }
  }
  return <div class="desk-more">
    <Show when={open()} fallback={<button class="desk-button" onClick={() => { setResult(); setOpen(true) }}>More detail</button>}>
      <form class="desk-more-form" onSubmit={event => { event.preventDefault(); void send() }}>
        <input aria-label="Question for the front desk (optional)" placeholder="What do you want to know? (optional)" dir="auto" maxLength={2000}
          value={question()} onInput={event => setQuestion(event.currentTarget.value)} ref={element => queueMicrotask(() => element.focus())} />
        <button class="desk-button home-primary" type="submit" disabled={sending()}>Ask</button>
      </form>
    </Show>
    <Show when={result()}>{value => <span class={value().error ? "home-warning" : "home-muted"} role="status">{value().error ?? "Asked in the chat."}</span>}</Show>
  </div>
}

/** The ready, complete brief for one item, or undefined: what the decision card folds its request behind. */
export const useCompleteBrief = (item: () => DeskItem) => {
  const prepared = useBriefs()
  return () => {
    const job = currentJob(prepared.briefs.jobs(), item())
    const result = job?.state.state === "ready" ? job.state.result : undefined
    return result && briefComplete(result, item()) ? result : undefined
  }
}

/** The app-wide prepared brief for one item, as Home and the desk show it. */
export const PreparedBrief = (props: { item: DeskItem; live: boolean; part?: Part }) => {
  const prepared = useBriefs()
  prepared.view()
  const briefs = prepared.briefs
  return <BriefPanel item={props.item} live={props.live} auto={prepared.auto()} part={props.part}
    jobs={briefs.jobs().filter(job => job.meta.source === props.item.key)}
    canStart={(!prepared.auto() || prepared.anchor.ready()) && !briefs.pending() && !briefs.preparing()} unavailable={prepared.anchor.error() || undefined}
    confirming={briefs.jobs().some(job => job.state.state === "starting")}
    start={() => void briefs.start(props.item)} confirm={() => void briefs.confirm()} />
}
