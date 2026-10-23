/* Derived, source-revision-bound brief for one queue item. The canonical request it explains is
 * rendered separately and stays the authority; this only makes it decidable at a glance. The UI does
 * not caption it as derived: the binding is enforced in code and provenance sits in Details. */
import { createSignal, For, Match, Show, Switch } from "solid-js"
import { useBriefs } from "../desk-briefs"
import { A } from "@solidjs/router"
import { sessionHref } from "../state"
import { docHref } from "../pages/doc"
import { anchorHref } from "../message-anchor"
import { briefComplete, safeSvg, sourceTarget, type BriefResult, type BriefShape, type BriefSource, type DeskItem, type EvidenceRef } from "../desk"
import { currentJob, regeneratingJob, type BriefJob } from "../desk-session"
import { LinkedText } from "./linked-text"
import contract from "../brief-contract.json"

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
  if (target?.kind === "url") return { kind: target.where, href: target.url }
  if (target) return { kind: "Agent thread", href: anchorHref(item.source.session, item.source.directory, target.message, target.to) }
}

type Part = "lead" | "visual" | "after" | "details"
/** `part` renders one slot of a brief inside a decision card; without it the whole brief renders in one place. */
/** `pinned`: show exactly this job (an answered decision's brief), whatever the item's current revision. */
export const BriefPanel = (props: { item: DeskItem; live: boolean; jobs: BriefJob[]; canStart: boolean; confirming: boolean; start: () => void; confirm: () => void; unavailable?: string; unavailableDetail?: string; auto?: boolean; part?: Part; pinned?: string; regenerate?: () => void; regenerating?: boolean }) => {
  const current = () => currentJob(props.jobs, props.item, props.pinned)
  const discarded = () => props.jobs.filter(job => job.meta.revision !== props.item.revision)
  const ready = () => { const job = current(); return job?.state.state === "ready" ? { job, result: job.state.result as BriefResult, omitted: job.state.omitted } : undefined }
  const complete = () => { const value = ready(); return !!value && briefComplete(value.result, props.item) }
  const shows = (part: Part) => !props.part || props.part === part
  return <section class="desk-brief" aria-label="Brief" data-part={props.part} tabIndex={!props.part || props.part === "lead" ? -1 : undefined}>
    <Show when={shows("lead")}>
      <Show when={current()} fallback={<Show when={props.live}>
        <Show when={props.auto && !props.unavailable} fallback={<>
          <button class="desk-button" disabled={!props.canStart} onClick={props.start}>Prepare brief</button>
          <Show when={props.unavailable}><span class="home-source" title={props.unavailableDetail}> {props.unavailable}</span></Show>
        </>}><p class="home-muted" role="status">Preparing brief…</p></Show>
      </Show>}>{job => <>
        <Show when={job().state.state === "starting" || job().state.state === "running"}><p class="home-muted" role="status">Preparing brief…</p></Show>
        {/* A brief that did not finish is one quiet line: the request below stays readable as written. */}
        <Show when={job().state.state === "failed"}><p class="home-muted" title={(job().state as { error: string }).error}>Brief failed.</p></Show>
        <Show when={job().state.state === "unknown"}><p class="home-muted">{(job().state as { reason: string }).reason}</p></Show>
        {/* Confirm resends the identical request; Core returns the same brief if the first start landed. */}
        <Show when={job().state.state === "unconfirmed"}><p class="home-warning">Brief start not confirmed.</p>
          <button class="desk-button" disabled={props.confirming} onClick={props.confirm}>Confirm start</button></Show>
        <Show when={(job().state.state === "failed" || job().state.state === "unknown") && props.live}><button class="desk-button" disabled={!props.canStart} onClick={props.start}>Prepare again</button></Show>
      </>}</Show>
      <Show when={!current() && discarded().length}><p class="home-source">The request changed since the last brief.</p></Show>
      {/* The question itself is the card's heading; the lead adds only context and the picture. */}
      <Show when={complete() && ready()}>{value => <div class="desk-brief-body">
        <Show when={!props.item.record}><p class="desk-brief-question" dir="auto">{value().result.question}</p></Show>
        <Show when={value().result.context}><p class="desk-brief-context" dir="auto"><LinkedText text={value().result.context} /></p></Show>
        <Subjects subjects={value().result.subjects} refs={value().job.meta.refs} />
        {/* A fresh brief of the same request, made by the host that owns it; this one stays until the new one is ready. */}
        <Show when={props.live && !props.pinned && props.item.record && props.regenerate}><p class="desk-brief-regenerate">
        <Show when={!props.regenerating && !regeneratingJob(props.jobs, props.item)} fallback={<span class="home-muted" role="status">Regenerating brief…</span>}>
          <button type="button" class="desk-link-button" onClick={() => props.regenerate!()}>Regenerate brief</button></Show></p></Show>
        <Show when={!props.item.record?.options.length && value().result.ifWait}><p class="home-muted" dir="auto">If you wait: <LinkedText text={value().result.ifWait} /></p></Show>
      </div>}</Show>
    </Show>
    <Show when={shows("visual") && complete() && ready()}>{value =>
      <Show when={value().result.visual} fallback={<Show when={value().result.shape}>{shape => <Shape shape={shape()} item={props.item} />}</Show>}>{visual => <Visual {...visual()} />}</Show>}</Show>
    <Show when={shows("after") && complete() && ready()}>{value => <div class="desk-brief-after">
      <SourceLinks sources={value().result.sources} refs={value().job.meta.refs} item={props.item} />
    </div>}</Show>
    {/* Cited evidence and provenance stay one click away, not in the reading path. */}
    <Show when={shows("details") && ready()}>{value => <details class="desk-brief-detail"><summary>Details</summary>
      <Show when={value().result.facts.length}><ul><For each={value().result.facts}>{fact => <li><bdi dir="auto"><LinkedText text={fact.text} /></bdi> <Refs refs={fact.refs} known={value().job.meta.refs} item={props.item} /></li>}</For></ul></Show>
      <Show when={value().result.timeline.length}><ol class="desk-timeline"><For each={value().result.timeline}>{entry => <li><Show when={entry.when}><span class="home-source">{entry.when} · </span></Show><bdi dir="auto"><LinkedText text={entry.text} /></bdi> <Refs refs={entry.refs} known={value().job.meta.refs} item={props.item} /></li>}</For></ol></Show>
      <Show when={value().result.gaps.length}><ul class="home-muted"><For each={value().result.gaps}>{gap => <li dir="auto">{gap}</li>}</For></ul></Show>
      {/* An incomplete brief still offers what it found, without standing in for the request. */}
      <Show when={!complete()}><SourceLinks sources={value().result.sources} refs={value().job.meta.refs} item={props.item} /></Show>
      <p class="home-source">Brief for revision {value().job.meta.revision}<Show when={value().omitted}> · {value().omitted} uncited statement(s) omitted</Show> · <A href={sessionHref(value().job.id, value().job.directory)}>Brief thread</A>
</p>
    </details>}</Show>
  </section>
}

/** A short name for a link: owner/repo#123 becomes repo#123; otherwise the host. */
export const linkName = (url: string) => {
  const parsed = new URL(url)
  const pull = /^\/[^/]+\/([^/]+)\/(?:pull|issues)\/(\d+)/.exec(parsed.pathname)
  if (parsed.hostname === "github.com" && pull) return `${pull[1]}#${pull[2]}`
  return parsed.hostname.endsWith(".slack.com") ? "Slack" : parsed.hostname
}

// The things a decision acts on, one compact row each with its links, readable on a phone; never a picture.
const Subjects = (props: { subjects: BriefResult["subjects"]; refs: EvidenceRef[] }) =>
  <Show when={props.subjects.length}>
    <ul class="desk-subjects" aria-label="What this covers"><For each={props.subjects}>{subject => {
      const links = () => [...new Set(subject.refs.flatMap(id => props.refs.find(ref => ref.id === id)?.url ?? []))]
      return <li>
        <bdi dir="auto" class="desk-subject-name">{subject.name}</bdi>
        <Show when={subject.detail}><span class="desk-subject-detail" dir="auto">{subject.detail}</span></Show>
        <Show when={links().length}><span class="desk-subject-links"><For each={links()}>{url => <a href={url} target="_blank" rel="noreferrer" title={url}><bdi dir="ltr">{linkName(url)}</bdi></a>}</For></span></Show>
      </li>
    }}</For></ul>
  </Show>

const SourceLinks = (props: { sources: BriefSource[]; refs: EvidenceRef[]; item: DeskItem }) => {
  const links = () => props.sources.flatMap(source => { const link = sourceLink(source, props.refs, props.item); return link ? [{ ...link, label: source.label }] : [] })
  return <Show when={links().length}><p class="desk-brief-sources"><For each={links()}>{link =>
    <A href={link.href}>↗ {link.kind} · <bdi dir="auto">{link.label}</bdi></A>}</For></p></Show>
}

// Drawn by the app in its own type styles, so every brief reads the same way and stays RTL-aware.
const Shape = (props: { shape: BriefShape; item: DeskItem }) =>
  <Switch>
    <Match when={props.shape.kind === "compare" && compareOf(props.shape, props.item)}>{shape =>
      // Columns are the request's own options under their own labels; the recommended one comes from the request.
      <table class="desk-compare"><thead><tr><th scope="col"><span class="sr-only">Aspect</span></th><For each={shape().columns}>{column =>
        <th scope="col" data-recommended={column.recommended ? "" : undefined}><bdi dir="auto">{column.label}</bdi><Show when={column.recommended}><span class="desk-compare-recommended">Recommended</span></Show></th>}</For></tr></thead>
        <tbody><For each={shape().rows}>{row => <tr><th scope="row" dir="auto">{row.label}</th><For each={row.cells}>{cell => <td dir="auto">{cell}</td>}</For></tr>}</For></tbody></table>}</Match>
    <Match when={props.shape.kind === "sequence" && props.shape}>{shape =>
      // With `approved`, a line under the last approved step says where this approval stops; later steps are muted.
      <ol class="desk-flow" aria-label="Sequence" data-approved={shape().approved ? "" : undefined}><For each={shape().steps}>{(step, index) =>
        <li data-later={shape().approved && index() >= shape().approved! ? "" : undefined} data-stop={shape().approved && index() === shape().approved! - 1 ? "" : undefined}>
          <bdi dir="auto">{step}</bdi>
          <Show when={shape().approved && index() === shape().approved! - 1}><span class="desk-flow-stop">This approval stops here</span></Show>
          <Show when={shape().approved && index() >= shape().approved!}><span class="desk-flow-later">needs a later decision</span></Show>
        </li>}</For></ol>}</Match>
    <Match when={props.shape.kind === "change" && props.shape}>{shape => {
      // Rows that stay the same are muted; more than two of them fold into one line so the changes stand out.
      const same = () => shape().rows.filter(row => row.now === row.after)
      const shown = () => same().length > 2 ? shape().rows.filter(row => row.now !== row.after) : shape().rows
      return <table class="desk-change"><thead><tr><th scope="col">Thing</th><th scope="col">Now</th><th scope="col">After</th></tr></thead>
        <tbody><For each={shown()}>{row => <tr data-same={row.now === row.after ? "" : undefined}>
          <th scope="row" dir="auto">{row.item}</th><td dir="auto">{row.now}</td><td dir="auto">{row.after}</td>
        </tr>}</For>
        <Show when={same().length > 2}><tr data-same><td colspan="3" class="desk-change-same" title={same().map(row => row.item).join(", ")}>{same().length} other things stay the same</td></tr></Show></tbody></table>
    }}</Match>
    <Match when={props.shape.kind === "scope" && props.shape}>{shape =>
      <div class="desk-scope">
        <Show when={shape().included.length}><div><span class="home-source">In</span><ul><For each={shape().included}>{entry => <li dir="auto">{entry}</li>}</For></ul></div></Show>
        <Show when={shape().excluded.length}><div data-excluded><span class="home-source">Out</span><ul><For each={shape().excluded}>{entry => <li dir="auto">{entry}</li>}</For></ul></div></Show>
      </div>}</Match>
    <Match when={props.shape.kind === "impact" && props.shape}>{shape =>
      <ul class="desk-impact"><For each={shape().rows}>{row => <li><bdi dir="auto">{row.area}</bdi> → <bdi dir="auto">{row.change}</bdi></li>}</For></ul>}</Match>
  </Switch>

/** A compare shape reduced to columns that are real options; fewer than two leaves nothing to compare. */
const compareOf = (shape: Extract<BriefShape, { kind: "compare" }>, item: DeskItem) => {
  const options = item.record?.options ?? []
  const kept = shape.columns.flatMap((id, index) => { const option = options.find(candidate => candidate.id === id); return option ? [{ index, label: option.label, recommended: item.record?.recommendation === id }] : [] })
  if (kept.length < 2) return
  return { columns: kept, rows: shape.rows.map(row => ({ label: row.label, cells: kept.map(column => row.cells[column.index] ?? "") })) }
}

// No scripts, forms, navigation or same-origin access, and CSP blocks every network request.
const CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:"
const FRAME_MARGIN = 8
// The frame cannot see the app's stylesheet, so the app's own colour tokens are handed in under the names
// brief-contract.json gives the model; a drawing then matches es-app (and, natively, Android) instead of its own palette.
// Legacy HTML briefs (contract 3) used the older names, mapped to the same colours.
const TOKENS = { fg: "--text", muted: "--subtext0", line: "--surface1", surface: "--surface0", accent: "--blue", ok: "--green", warn: "--yellow", risk: "--red",
  bg: "--base", panel: "--surface0", text: "--text", good: "--green", bad: "--red" }
const frameStyle = (svg: boolean) => {
  const root = getComputedStyle(document.documentElement)
  const vars = Object.entries(TOKENS).map(([name, token]) => `--${name}:${root.getPropertyValue(token).trim() || "initial"}`).join(";")
  return `:root{${vars}}html{color-scheme:dark;color:var(--fg);background:${svg ? "transparent" : "var(--bg)"};font:13px system-ui,sans-serif}`
    + (svg ? "body{margin:0}svg{display:block;inline-size:100%;block-size:auto}" : "body{margin:8px}svg{display:block;max-inline-size:min(100%,640px);block-size:auto}")
}
/** A brief's drawing in a sandboxed frame. SVG (contract 4) is sized by its viewBox and shown at most 400 px
 * wide so its text never outsizes the card's; legacy HTML keeps its stated height. `alt` names it for screen readers. */
export const Visual = (props: { title: string; alt?: string; svg?: string; aspect?: number; html?: string; height?: number; class?: string; maxWidth?: number }) =>
  <figure class={props.class ?? "desk-visual"} data-kind={props.svg ? "svg" : "html"}>
    <iframe title={props.alt || props.title || "Brief visual"} sandbox="" referrerpolicy="no-referrer" loading="lazy"
      style={props.svg ? { "inline-size": "100%", "max-inline-size": `${props.maxWidth ?? contract.visual.displayMaxWidth}px`, "aspect-ratio": `1 / ${props.aspect}`, "block-size": "auto" } : { "block-size": `${(props.height ?? 280) + FRAME_MARGIN * 2}px` }}
      srcdoc={`<!doctype html><meta http-equiv="Content-Security-Policy" content="${CSP}"><style>${frameStyle(!!props.svg)}</style>${props.svg ?? props.html ?? ""}`} />
    <Show when={props.alt}><figcaption class="sr-only">{props.alt}</figcaption></Show>
  </figure>

/** An option's small mockup: contract-4 SVG by its viewBox, or a legacy HTML sketch at a fixed height. */
export const Sketch = (props: { title: string; sketch: string }) => {
  const aspect = () => safeSvg(props.sketch, contract.visual.sketch.width, contract.visual.sketch.height, contract.visual.sketch.maxBytes)
  return <Show when={aspect()} fallback={<Visual class="home-option-sketch" title={props.title} html={props.sketch} height={180} />}>{value =>
    <Visual class="home-option-sketch" title={props.title} svg={props.sketch} aspect={value()} maxWidth={Math.round(contract.visual.sketch.width * 1.2)} />}</Show>
}

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
export const useCompleteBrief = (item: () => DeskItem, pinned?: () => string | undefined) => {
  const prepared = useBriefs()
  return () => {
    const job = currentJob(prepared.briefs.jobs(), item(), pinned?.())
    const result = job?.state.state === "ready" ? job.state.result : undefined
    return result && briefComplete(result, item()) ? result : undefined
  }
}

/** The ready, complete brief job for one item (or the pinned one): what an answer records it was made from. */
export const useCompleteJob = (item: () => DeskItem, pinned?: () => string | undefined) => {
  const prepared = useBriefs()
  return () => {
    const job = currentJob(prepared.briefs.jobs(), item(), pinned?.())
    return job?.state.state === "ready" && briefComplete(job.state.result, item()) ? job : undefined
  }
}

/** The app-wide prepared brief for one item, as Home and the desk show it. */
export const PreparedBrief = (props: { item: DeskItem; live: boolean; part?: Part; pinned?: string }) => {
  const prepared = useBriefs()
  prepared.view()
  const briefs = prepared.briefs
  return <BriefPanel item={props.item} live={props.live} auto={prepared.auto()} part={props.part} pinned={props.pinned}
    jobs={briefs.jobs().filter(job => job.meta.source === props.item.key)}
    canStart={(!prepared.auto() || prepared.anchor.ready()) && !briefs.pending() && !briefs.preparing()} unavailable={prepared.anchor.error() || undefined} unavailableDetail={prepared.anchor.detail()}
    confirming={briefs.jobs().some(job => job.state.state === "starting")}
    start={() => void briefs.start(props.item)} confirm={() => void briefs.confirm()}
    regenerate={() => void briefs.regenerate(props.item)} regenerating={briefs.regenerating()} />
}
