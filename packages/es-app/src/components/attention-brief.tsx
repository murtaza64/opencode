/* Derived, source-revision-bound brief for one queue item. The canonical request it explains is
 * rendered separately and stays the authority; this only makes it decidable at a glance. The UI does
 * not caption it as derived: the binding is enforced in code and provenance sits in Details. */
import { createResource, createSignal, For, Match, Show, Switch, type JSX } from "solid-js"
import { useBriefs } from "../desk-briefs"
import { A } from "@solidjs/router"
import { sessionHref } from "../state"
import { docHref } from "../pages/doc"
import { anchorHref } from "../message-anchor"
import { briefCommands, briefComplete, briefItems, briefSteps, safeSvg, sourceTarget, type BriefResult, type BriefShape, type BriefSource, type DeskItem, type EvidenceRef } from "../desk"
import { briefApproval } from "../brief-approval"
import { currentJob, readConversation, regeneratingJob, type BriefJob } from "../desk-session"
import { LinkedText } from "./linked-text"
import { CopyCode, linkName, MISSING, Refs, Value } from "./brief-kit"
import contract from "../brief-contract.json"
import { readBriefFeedback, sendBriefFeedback, type BriefRating } from "../brief-feedback"

/** Where a cited source opens: the source thread at the cited messages, or a markdown doc in the editspace. */
const sourceLink = (source: BriefSource, refs: EvidenceRef[], item: DeskItem) => {
  const target = sourceTarget(source, refs)
  if (target?.kind === "doc") return { kind: "Doc", href: docHref("editspace", target.path) }
  if (target?.kind === "url") return { kind: target.where, href: target.url }
  if (target) return { kind: "Agent thread", href: anchorHref(item.source.session, item.source.directory, target.message, target.to) }
}

/** A brief's failure in plain words, from the error Core recorded on its turn. */
const failureText = (error: string) => ({
  ProviderAuthError: "The model provider refused sign-in.",
  APIError: "The model provider returned an error.",
  MessageAbortedError: "The brief was stopped before it finished.",
  MessageOutputLengthError: "The brief ran out of room before it finished.",
  ContextOverflowError: "The request was too long for the model.",
} as Record<string, string>)[error] ?? (error === "no readable reply." ? "The brief's reply could not be read." : "The brief could not finish.")

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
        {/* One failure line in plain words; the error's own name is secondary detail. */}
        <Show when={job().state.state === "failed"}><p class="brief-failure">{failureText((job().state as { error: string }).error)} <span class="brief-failure-detail">(<bdi dir="ltr">{(job().state as { error: string }).error}</bdi>)</span></p></Show>
        <Show when={job().state.state === "unknown"}><p class="brief-failure">{(job().state as { reason: string }).reason}</p></Show>
        {/* Confirm resends the identical request; Core returns the same brief if the first start landed. */}
        <Show when={job().state.state === "unconfirmed"}><p class="home-warning">Brief start not confirmed.</p>
          <button class="desk-button" disabled={props.confirming} onClick={props.confirm}>Confirm start</button></Show>
        <Show when={(job().state.state === "failed" || job().state.state === "unknown") && props.live}><button class="desk-button" disabled={!props.canStart} onClick={props.start}>Prepare again</button></Show>
        {/* Why it cannot be prepared again here is detail under the one failure line, not a second failure. */}
        <Show when={(job().state.state === "failed" || job().state.state === "unknown") && props.unavailable}><details class="brief-why"><summary>Why can't it be prepared again here?</summary>
          <p class="home-source" title={props.unavailableDetail}>{props.unavailable}</p></details></Show>
      </>}</Show>
      <Show when={!current() && discarded().length}><p class="home-source">The request changed since the last brief.</p></Show>
      {/* The question itself is the card's heading; the lead adds only context and the picture. */}
      <Show when={complete() && ready()}>{value => <div class="desk-brief-body">
        <Show when={!props.item.record}><p class="desk-brief-question" dir="auto">{value().result.question}</p></Show>
        <Show when={value().result.context}><p class="desk-brief-context" dir="auto"><LinkedText text={value().result.context} /></p></Show>
        <Subjects subjects={value().result.subjects} refs={value().job.meta.refs} />
        <Items result={value().result} item={props.item} job={value().job} />
        <Steps result={value().result} refs={value().job.meta.refs} item={props.item} />
        <Commands commands={value().result} item={props.item} />
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
      {/* Keyed to the brief shown, so a newer brief never inherits this one's rating. */}
      <Show when={value().job} keyed>{job => <BriefFeedbackControls job={job} />}</Show>
    </details>}</Show>
  </section>
}

const RATINGS: { value: BriefRating; label: string }[] = [{ value: "good", label: "Good" }, { value: "neutral", label: "Neutral" }, { value: "bad", label: "Bad" }]

// How useful this brief was, for the people improving briefs. It is about the brief shown (its job), never the
// decision: nothing here touches the answer, its draft or Send. Unrated stays unrated; pressing the chosen rating
// again clears it. The note is optional and saved with the rating.
const BriefFeedbackControls = (props: { job: BriefJob }) => {
  const [saved, { mutate }] = createResource(() => props.job.id, job => readBriefFeedback(job).catch(() => undefined))
  const [note, setNote] = createSignal<string>()
  const [status, setStatus] = createSignal("")
  const text = () => note() ?? saved()?.text ?? ""
  const send = async (rating: BriefRating | null) => {
    setStatus("")
    try {
      mutate(await sendBriefFeedback(props.job, rating, text()))
      setNote(undefined)
      setStatus("Saved")
    } catch (cause) {
      setStatus(cause instanceof Error ? cause.message : String(cause))
    }
  }
  return <div class="desk-brief-feedback" role="group" aria-label="Rate this brief">
    <span class="home-source">Was this brief useful?</span>
    <For each={RATINGS}>{option => <button type="button" class="desk-link-button" aria-pressed={saved()?.rating === option.value}
      onClick={() => void send(saved()?.rating === option.value ? null : option.value)}>{option.label}</button>}</For>
    <Show when={saved()?.rating}><textarea aria-label="What would have made this brief better? (optional)" rows={2} maxLength={2000} dir="auto"
      placeholder="What would have made it better? (optional)" value={text()} onInput={event => setNote(event.currentTarget.value)} />
      <Show when={note() !== undefined && note() !== (saved()?.text ?? "")}><button type="button" class="desk-link-button" onClick={() => void send(saved()!.rating)}>Save note</button></Show></Show>
    <Show when={status()}><span class="home-muted" role="status">{status()}</span></Show>
  </div>
}

// Commands an option asks the human to run, exactly as the request quotes them, with where to run them and a
// Copy button. Display only: nothing here runs anything. Dropped unless quoted verbatim (briefCommands).
const Commands = (props: { commands: BriefResult; item: DeskItem }) => {
  const [found] = createResource(() => props.item.record, readConversation)
  const commands = () => briefCommands(props.commands, props.item, found()?.documents)
  const option = (id: string) => props.item.record?.options.find(entry => entry.id === id)?.label
  return <Show when={commands().length}>
    <ul class="desk-commands" aria-label="Commands to run"><For each={commands()}>{entry => <li>
      <span class="desk-command-label" dir="auto">{entry.label}<Show when={entry.where}> · <span class="home-muted">{entry.where}</span></Show>
        <Show when={option(entry.option)}>{label => <span class="home-muted"> · for “<bdi dir="auto">{label()}</bdi>”</span>}</Show></span>
      <CopyCode text={entry.command} />
    </li>}</For></ul>
  </Show>
}

// Steps an option asks the human to do by hand, in order: the page to open (a link only when the request gave
// one), each field with its exact value to copy, and how to check it worked. A value the request does not state
// is shown as missing, never filled in (briefSteps). Display only: nothing here changes any console.
const Steps = (props: { result: BriefResult; refs: EvidenceRef[]; item: DeskItem }) => {
  const [found] = createResource(() => props.item.record, readConversation)
  const steps = () => briefSteps(props.result, props.item, found()?.documents)
  const option = (id: string) => props.item.record?.options.find(entry => entry.id === id)?.label
  const url = (refs: string[]) => refs.flatMap(id => props.refs.find(ref => ref.id === id)?.url ?? [])[0]
  return <Show when={steps().length}>
    <ol class="desk-commands desk-steps" aria-label="Steps to do"><For each={steps()}>{step => <li>
      <span class="desk-command-label" dir="auto">{step.title}
        <Show when={option(step.option)}>{label => <span class="home-muted"> · for “<bdi dir="auto">{label()}</bdi>”</span>}</Show></span>
      <Show when={step.where}>{where => <p dir="auto">Open: <Show when={url(where().refs)} fallback={<bdi dir="auto">{where().label}</bdi>}>{href =>
        <a href={href()} target="_blank" rel="noopener noreferrer">↗ <bdi dir="auto">{where().label}</bdi></a>}</Show></p>}</Show>
      {/* Laid out like commands (label, then the exact value to copy), so long values stay inside the column. */}
      <Show when={step.settings.length}><ul class="desk-commands" aria-label="Settings"><For each={step.settings}>{setting => <li>
        <span class="desk-command-label" dir="auto">{setting.field}</span>
        <Show when={setting.value} fallback={<span class="brief-missing">{MISSING}</span>}><CopyCode text={setting.value} /></Show>
      </li>}</For></ul></Show>
      <Show when={step.verify}><p class="home-muted" dir="auto">Check: {step.verify}</p></Show>
    </li>}</For></ol>
  </Show>
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

const Items = (props: { result: BriefResult; item: DeskItem; job: BriefJob }) => {
  const [found] = createResource(() => props.item.record, readConversation)
  const rows = () => briefItems(props.result, props.item, found()?.documents)
  const approval = () => briefApproval(rows(), props.item, { id: props.job.id, revision: props.job.meta.revision })
  // Approved exists only once the ledger has an answer for this brief: unanswered rows carry no empty column.
  return <Show when={rows().length}>
    <section class="desk-brief-items" aria-label="Request items" data-answered={approval().answered ? "" : undefined}>
      <Show when={approval().verbatim}><p class="desk-brief-ledger">Recorded answer: <bdi dir="auto">{approval().verbatim}</bdi></p></Show>
      <div class="desk-brief-item-head" aria-hidden="true"><span>ID</span><span>Question</span><span>Agent recommends</span><span>Alternative(s)</span><Show when={approval().answered}><span>Approved</span></Show></div>
      <ol class="desk-brief-item-list"><For each={rows()}>{(row, index) => <li class="desk-brief-item">
        <span class="desk-brief-item-id"><span class="desk-brief-item-number">{index() + 1}.</span> <bdi dir="ltr">{row.id}</bdi></span>
        {/* The question is the row's primary line, so it carries no label. */}
        <div class="desk-brief-item-cell desk-brief-item-question"><Value value={row.question} /></div>
        <ItemCell label="Agent recommends"><Value value={row.recommended} /></ItemCell>
        <ItemCell label="Alternative(s)"><Show when={row.alternatives.length} fallback={<Value value="" />}>
          <For each={row.alternatives}>{(value, at) => <>{at() ? " · " : ""}<Value value={value} /></>}</For></Show></ItemCell>
        <Show when={approval().answered}><ItemCell label="Approved"><span dir="auto">{approval().values[index()]}</span></ItemCell></Show>
      </li>}</For></ol>
    </section>
  </Show>
}

const ItemCell = (props: { label: string; children: JSX.Element }) =>
  <div class="desk-brief-item-cell"><span class="desk-brief-item-label">{props.label}</span>{props.children}</div>

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
        <th scope="col" data-recommended={column.recommended ? "" : undefined}><bdi dir="auto">{column.label}</bdi><Show when={column.recommended}><span class="desk-compare-recommended">Agent recommends</span></Show></th>}</For></tr></thead>
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
// The frame cannot see the app's stylesheet, so colours are handed in under the names brief-contract.json gives
// the model. Each role takes the system palette's value (wal-palette/1, `--wal-<role>`) when the page has one,
// else es-app's own token. Status colours come from the palette only when it reports ok and risk stay apart for
// colour-blind readers (`--wal-ok-risk-cvd-safe: 1`). Highlights fall back to the accent. Legacy HTML briefs
// (contract 3) used older names, mapped to the same colours.
const TOKENS: Record<string, { wal?: string; app: string; status?: boolean }> = {
  fg: { wal: "--wal-fg", app: "--text" }, muted: { wal: "--wal-muted", app: "--subtext0" }, line: { wal: "--wal-line", app: "--overlay1" },
  surface: { wal: "--wal-surface", app: "--surface0" }, accent: { wal: "--wal-accent", app: "--blue" },
  ok: { wal: "--wal-ok", app: "--green", status: true }, warn: { wal: "--wal-warn", app: "--yellow", status: true }, risk: { wal: "--wal-risk", app: "--red", status: true },
  bg: { wal: "--wal-bg", app: "--base" }, panel: { wal: "--wal-surface", app: "--surface0" }, text: { wal: "--wal-fg", app: "--text" },
  good: { wal: "--wal-ok", app: "--green", status: true }, bad: { wal: "--wal-risk", app: "--red", status: true },
}
// es-app's line fallback is overlay1, not surface1: strokes and arrows need 3:1 against the drawing's boxes
// (surface0), which surface1 does not reach (about 1.1-1.6:1).
const HIGHLIGHTS = ["hl1", "hl2", "hl3", "hl4"]
/** The colours a brief drawing gets right now, by contract name. */
export const frameColours = (root: CSSStyleDeclaration) => {
  const read = (name?: string) => name ? root.getPropertyValue(name).trim() : ""
  const statusSafe = read("--wal-ok-risk-cvd-safe") === "1"
  const colours = Object.fromEntries(Object.entries(TOKENS).map(([name, token]) =>
    [name, (token.status && !statusSafe ? "" : read(token.wal)) || read(token.app) || "initial"]))
  for (const name of HIGHLIGHTS) colours[name] = read(`--wal-${name}`) || colours.accent!
  return colours
}
// The palette's revision; changes when the system palette is switched. Read again whenever the page's styles or
// root attributes change (a palette stylesheet swapped in or out), so open drawings follow without a reload.
const [paletteRevision, setPaletteRevision] = createSignal("")
let watching = false
const watchPalette = () => {
  if (watching || typeof MutationObserver === "undefined") return
  watching = true
  const read = () => setPaletteRevision(`${getComputedStyle(document.documentElement).getPropertyValue("--wal-revision").trim()}|${document.documentElement.className}|${document.documentElement.getAttribute("style") ?? ""}`)
  read()
  const observer = new MutationObserver(() => queueMicrotask(read))
  observer.observe(document.head, { childList: true, subtree: true, characterData: true })
  observer.observe(document.documentElement, { attributes: true })
}
const frameStyle = (svg: boolean) => {
  watchPalette()
  paletteRevision()
  const vars = Object.entries(frameColours(getComputedStyle(document.documentElement))).map(([name, value]) => `--${name}:${value}`).join(";")
  return `:root{${vars}}html{color-scheme:dark;color:var(--fg);background:${svg ? "transparent" : "var(--bg)"};font:13px system-ui,sans-serif}`
    + (svg ? "body{margin:0}svg{display:block;inline-size:100%;block-size:auto}" : "body{margin:8px}svg{display:block;max-inline-size:min(100%,640px);block-size:auto}")
}
/** A brief's drawing in a sandboxed frame. SVG stays at or below its viewBox width; legacy HTML keeps its height. */
export const Visual = (props: { title: string; alt?: string; svg?: string; aspect?: number; html?: string; height?: number; class?: string; maxWidth?: number }) =>
  <VisualFrame {...props} />

const VisualFrame = (props: { title: string; alt?: string; svg?: string; aspect?: number; html?: string; height?: number; class?: string; maxWidth?: number }) => {
  const [expanded, setExpanded] = createSignal(false)
  return <figure class={props.class ?? "desk-visual"} data-kind={props.svg ? "svg" : "html"}>
    <div class={props.svg ? "desk-visual-window" : undefined} data-expanded={expanded() ? "" : undefined}>
    <iframe title={props.alt || props.title || "Brief visual"} sandbox="" referrerpolicy="no-referrer" loading="lazy"
      style={props.svg ? { "inline-size": "100%", "max-inline-size": `${props.maxWidth ?? contract.visual.width}px`, "aspect-ratio": `1 / ${props.aspect}`, "block-size": "auto" } : { "block-size": `${(props.height ?? 280) + FRAME_MARGIN * 2}px` }}
      srcdoc={`<!doctype html><meta http-equiv="Content-Security-Policy" content="${CSP}"><style>${frameStyle(!!props.svg)}</style>${props.svg ?? props.html ?? ""}`} />
    </div>
    <Show when={props.svg}><button type="button" class="desk-visual-expand" aria-expanded={expanded()} onClick={() => setExpanded(!expanded())}>{expanded() ? "Collapse visual" : "Expand visual to full"}</button></Show>
    <Show when={props.alt}><figcaption class="sr-only">{props.alt}</figcaption></Show>
  </figure>
}

/** An option's small mockup: contract-4 SVG by its viewBox, or a legacy HTML sketch at a fixed height. */
export const Sketch = (props: { title: string; sketch: string }) => {
  const aspect = () => safeSvg(props.sketch, contract.visual.sketch.width, contract.visual.sketch.height, contract.visual.sketch.maxBytes)
  return <Show when={aspect()} fallback={<Visual class="home-option-sketch" title={props.title} html={props.sketch} height={180} />}>{value =>
    <Visual class="home-option-sketch" title={props.title} svg={props.sketch} aspect={value()} maxWidth={contract.visual.sketch.width} />}</Show>
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
    canStart={(!prepared.auto() || prepared.anchor.ready()) && !briefs.pending() && !briefs.preparing() && !prepared.unavailable()} unavailable={prepared.unavailable() || prepared.anchor.error() || undefined} unavailableDetail={prepared.anchor.detail()}
    confirming={briefs.jobs().some(job => job.state.state === "starting")}
    start={() => void briefs.start(props.item)} confirm={() => void briefs.confirm()}
    regenerate={() => void briefs.regenerate(props.item)} regenerating={briefs.regenerating()} />
}
