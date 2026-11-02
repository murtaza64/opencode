/* Derived, source-revision-bound brief for one queue item. The canonical request it explains is
 * rendered separately and stays the authority; this only makes it decidable at a glance. The UI does
 * not caption it as derived: the binding is enforced in code and provenance sits in Details. */
import { createResource, createSignal, For, Match, Show, Switch, type JSX } from "solid-js"
import { Dynamic } from "solid-js/web"
import { useBriefs } from "../desk-briefs"
import { A } from "@solidjs/router"
import { sessionHref } from "../state"
import { docHref } from "../pages/doc"
import { anchorHref } from "../message-anchor"
import { briefCommands, briefComplete, briefSteps, safeSvg, sourceTarget, type BriefResult, type BriefSource, type DeskItem, type EvidenceRef, type SceneRole } from "../desk"
import { briefApproval } from "../brief-approval"
import { completeBriefJob, currentJob, readConversation, regeneratingJob, type BriefJob } from "../desk-session"
import { LinkedText } from "./linked-text"
import { CopyCode, linkName, MISSING, Refs, Value } from "./brief-kit"
import contract from "../brief-contract.json"
import { readBriefFeedback, sendBriefFeedback, type BriefRating } from "../brief-feedback"
import { briefSemantics, hudPages, SCENE_CUE, type BriefNode, type BriefNodeGroup, type PicturePart } from "../brief-view"
import { BriefHud } from "./brief-hud"

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
export const BriefPanel = (props: { item: DeskItem; live: boolean; jobs: BriefJob[]; canStart: boolean; confirming: boolean; start: () => void; confirm: () => void; unavailable?: string; unavailableDetail?: string; auto?: boolean; part?: Part; pinned?: string; regenerate?: () => void; regenerating?: boolean; host?: string }) => {
  const current = () => currentJob(props.jobs, props.item, props.pinned)
  const discarded = () => props.jobs.filter(job => job.meta.revision !== props.item.revision)
  const ready = () => { const job = current(); return job?.state.state === "ready" ? { job, result: job.state.result as BriefResult, omitted: job.state.omitted } : undefined }
  const complete = () => { const value = ready(); return !!value && briefComplete(value.result, props.item) }
  const shows = (part: Part) => !props.part || props.part === part
  // One read of the request's conversation documents and one node list for every projection of this brief: the
  // card's rows, evidence and unknowns below and the glasses pages render the same nodes, ids and order.
  const [found] = createResource(() => props.host ? undefined : props.item.record, readConversation)
  const nodes = () => { const value = ready(); return value ? briefSemantics(props.item, value.result, { host: props.host, documents: found()?.documents, asOf: value.job.created }) : undefined }
  const group = (name: BriefNodeGroup) => nodes()?.nodes.filter(node => node.group === name) ?? []
  return <section class="desk-brief" aria-label="Brief" data-part={props.part} tabIndex={!props.part || props.part === "lead" ? -1 : undefined}>
    <Show when={shows("lead")}>
      <Show when={current()} fallback={<Show when={props.live}>
        <Show when={props.auto && !props.unavailable} fallback={<>
          <button class="desk-button" disabled={!props.canStart} onClick={props.start}>Prepare brief</button>
          {/* One plain clause beside the disabled button; the host's reason (status codes, model) is the tooltip. */}
          <Show when={props.unavailable}>{text => <span class="home-source" title={[text(), props.unavailableDetail].filter(Boolean).join("\n")}> {text().split(":")[0].replace(/\.$/, "")}</span>}</Show>
        </>}><p class="home-muted" role="status">Preparing brief…</p></Show>
      </Show>}>{job => <>
        <Show when={job().state.state === "starting" || job().state.state === "running"}><p class="home-muted" role="status">Preparing brief…</p></Show>
        {/* A brief that did not finish is one quiet line: the request below stays readable as written. */}
        {/* One failure line in plain words; the error's own name is secondary detail. */}
        <Show when={job().state.state === "failed"}><p class="brief-failure ds-status" data-tone="risk"><span class="ds-status-glyph" aria-hidden="true">✕</span><span>{failureText((job().state as { error: string }).error)} <span class="brief-failure-detail">(<bdi dir="ltr">{(job().state as { error: string }).error}</bdi>)</span></span></p></Show>
        <Show when={job().state.state === "unknown"}><p class="brief-failure ds-status" data-tone="unknown"><span class="ds-status-glyph" aria-hidden="true">?</span><span>{(job().state as { reason: string }).reason}</span></p></Show>
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
        {/* Record state apart from authority, from the record itself; the same node heads the glasses' first page. */}
        <For each={group("authority")}>{node => <p class="brief-authority" data-node={node.id}><For each={node.strip}>{(segment, index) => <>{index() ? " · " : ""}<span>{segment}</span></>}</For></p>}</For>
        <Show when={!props.item.record}><p class="desk-brief-question" dir="auto">{value().result.question}</p></Show>
        <Show when={value().result.context}><p class="desk-brief-context" dir="auto"><LinkedText text={value().result.context} /></p></Show>
        <Subjects subjects={value().result.subjects} refs={value().job.meta.refs} />
        <Items rows={group("row")} item={props.item} job={value().job} />
        <Steps result={value().result} refs={value().job.meta.refs} item={props.item} host={props.host} />
        <Commands commands={value().result} item={props.item} host={props.host} />
        <Show when={!props.item.record?.options.length && value().result.ifWait}><p class="home-muted" dir="auto">If you wait: <LinkedText text={value().result.ifWait} /></p></Show>
      </div>}</Show>
    </Show>
    <Show when={shows("visual") && complete() && ready()}>{value =>
      <Show when={group("picture")[0]?.part?.role === "visual" && value().result.visual} fallback={<Picture parts={group("picture")} />}>{visual => <div data-node="picture:visual"><Visual {...visual()} /></div>}</Show>}</Show>
    <Show when={shows("after") && complete() && ready()}>{value => <div class="desk-brief-after">
      <SourceLinks sources={value().result.sources} refs={value().job.meta.refs} item={props.item} host={props.host} />
    </div>}</Show>
    {/* Cited evidence and provenance stay one click away, not in the reading path. As a decision's details slot it
      * renders bare, inside the decision's own Details disclosure, so the card has one. */}
    <Show when={shows("details") && ready()}>{value => <Dynamic component={props.part === "details" ? "div" : "details"} class="desk-brief-detail"><Show when={props.part !== "details"}><summary>Details</summary></Show>
      <Show when={group("evidence").length}><ul><For each={group("evidence")}>{fact => <li data-node={fact.id}><bdi dir="auto"><LinkedText text={fact.text} /></bdi> <Refs refs={fact.refs ?? []} known={value().job.meta.refs} item={props.item} host={props.host} /></li>}</For></ul></Show>
      <Show when={value().result.timeline.length}><ol class="desk-timeline"><For each={value().result.timeline}>{entry => <li><Show when={entry.when}><span class="home-source">{entry.when} · </span></Show><bdi dir="auto"><LinkedText text={entry.text} /></bdi> <Refs refs={entry.refs} known={value().job.meta.refs} item={props.item} host={props.host} /></li>}</For></ol></Show>
      <Show when={group("unknown").length}><ul class="home-muted"><For each={group("unknown")}>{gap => <li dir="auto" data-node={gap.id}>{gap.text}</li>}</For></ul></Show>
      {/* An incomplete brief still offers what it found, without standing in for the request. */}
      <Show when={!complete()}><SourceLinks sources={value().result.sources} refs={value().job.meta.refs} item={props.item} host={props.host} /></Show>
      <p class="home-source">Brief for revision {value().job.meta.revision}<Show when={value().omitted}> · {value().omitted} uncited statement(s) omitted</Show> · <A href={sessionHref(value().job.id, value().job.directory) + (props.host ? `&host=${encodeURIComponent(props.host)}` : "")}>Brief thread</A>
</p>
      {/* Upkeep, not reading: a fresh brief of the same request, made by the host that owns it; this one stays until the new one is ready. */}
      <Show when={props.live && !props.pinned && props.item.record && props.regenerate}><p class="desk-brief-regenerate">
        <Show when={!props.regenerating && !regeneratingJob(props.jobs, props.item)} fallback={<span class="home-muted" role="status">Regenerating brief…</span>}>
          <button type="button" class="desk-link-button" onClick={() => props.regenerate!()}>Regenerate brief</button></Show></p></Show>
      {/* The same brief as the glasses would page it: reading aid only, no device, no answer. */}
      <details class="brief-hud-preview"><summary>Glasses preview</summary>
        <Show when={nodes()}>{semantics => <BriefHud pages={hudPages(semantics())} />}</Show></details>
      {/* Keyed to the brief shown, so a newer brief never inherits this one's rating. */}
      <Show when={!props.host && value().job} keyed>{job => <BriefFeedbackControls job={job} />}</Show>
    </Dynamic>}</Show>
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
const Commands = (props: { commands: BriefResult; item: DeskItem; host?: string }) => {
  const [found] = createResource(() => props.host ? undefined : props.item.record, readConversation)
  const commands = () => briefCommands(props.commands, props.item, found()?.documents)
  const option = (id: string) => props.item.record?.options.find(entry => entry.id === id)?.label
  return <Show when={commands().length}>
    <ul class="desk-commands ds-section" aria-label="Commands to run"><For each={commands()}>{entry => <li>
      <span class="desk-command-label" dir="auto">{entry.label}<Show when={entry.where}> · <span class="home-muted">{entry.where}</span></Show>
        <Show when={option(entry.option)}>{label => <span class="home-muted"> · for “<bdi dir="auto">{label()}</bdi>”</span>}</Show></span>
      <CopyCode text={entry.command} />
    </li>}</For></ul>
  </Show>
}

// Steps an option asks the human to do by hand, in order: the page to open (a link only when the request gave
// one), each field with its exact value to copy, and how to check it worked. A value the request does not state
// is shown as missing, never filled in (briefSteps). Display only: nothing here changes any console.
const Steps = (props: { result: BriefResult; refs: EvidenceRef[]; item: DeskItem; host?: string }) => {
  const [found] = createResource(() => props.host ? undefined : props.item.record, readConversation)
  const steps = () => briefSteps(props.result, props.item, found()?.documents)
  const option = (id: string) => props.item.record?.options.find(entry => entry.id === id)?.label
  const url = (refs: string[]) => refs.flatMap(id => props.refs.find(ref => ref.id === id)?.url ?? [])[0]
  return <Show when={steps().length}>
    <ol class="desk-commands desk-steps ds-section" aria-label="Steps to do"><For each={steps()}>{step => <li>
      <span class="desk-command-label" dir="auto">{step.title}
        <Show when={option(step.option)}>{label => <span class="home-muted"> · for “<bdi dir="auto">{label()}</bdi>”</span>}</Show></span>
      <Show when={step.where}>{where => <p dir="auto">Open: <Show when={url(where().refs)} fallback={<bdi dir="auto">{where().label}</bdi>}>{href =>
        <a href={href()} target="_blank" rel="noopener noreferrer">↗ <bdi dir="auto">{where().label}</bdi></a>}</Show></p>}</Show>
      {/* Field and value side by side; a long value wraps inside its column. */}
      <Show when={step.settings.length}><dl class="brief-settings ds-values" aria-label="Settings"><For each={step.settings}>{setting => <>
        <dt dir="auto">{setting.field}</dt>
        <dd><Show when={setting.value} fallback={<span class="brief-missing">{MISSING}</span>}><CopyCode text={setting.value} inline /></Show></dd>
      </>}</For></dl></Show>
      <Show when={step.verify}><p class="home-muted" dir="auto">Check: {step.verify}</p></Show>
    </li>}</For></ol>
  </Show>
}

// The things a decision acts on, one compact row each with its links, readable on a phone; never a picture.
const Subjects = (props: { subjects: BriefResult["subjects"]; refs: EvidenceRef[] }) =>
  <Show when={props.subjects.length}>
    <ul class="desk-subjects ds-section" aria-label="What this covers"><For each={props.subjects}>{subject => {
      const links = () => [...new Set(subject.refs.flatMap(id => props.refs.find(ref => ref.id === id)?.url ?? []))]
      return <li>
        <bdi dir="auto" class="desk-subject-name">{subject.name}</bdi>
        <Show when={subject.detail}><span class="desk-subject-detail" dir="auto">{subject.detail}</span></Show>
        <Show when={links().length}><span class="desk-subject-links"><For each={links()}>{url => <a href={url} target="_blank" rel="noreferrer" title={url}><bdi dir="ltr">{linkName(url)}</bdi></a>}</For></span></Show>
      </li>
    }}</For></ul>
  </Show>

const Items = (props: { rows: BriefNode[]; item: DeskItem; job: BriefJob }) => {
  const rows = () => props.rows.flatMap(node => node.row ? [node.row] : [])
  const approval = () => briefApproval(rows(), props.item, { id: props.job.id, revision: props.job.meta.revision })
  // A column shows only when some row has a value for it: Approved once the ledger has an answer for this brief,
  // the recommendation and alternatives once any item gives one. A row missing a shown value keeps its marker.
  const recommends = () => rows().some(row => row.recommended)
  const alternatives = () => rows().some(row => row.alternatives.length)
  const tracks = () => ["minmax(58px, .55fr)", "minmax(0, 2fr)", ...[recommends(), alternatives(), approval().answered].filter(Boolean).map(() => "minmax(0, 1fr)")].join(" ")
  return <Show when={rows().length}>
    <section class="desk-brief-items ds-section" aria-label="Request items" data-answered={approval().answered ? "" : undefined} style={{ "--desk-item-tracks": tracks() }}>
      <Show when={approval().verbatim}><p class="desk-brief-ledger">Recorded answer: <bdi dir="auto">{approval().verbatim}</bdi></p></Show>
      <div class="desk-brief-item-head" aria-hidden="true"><span>ID</span><span>Question</span><Show when={recommends()}><span>Agent recommends</span></Show><Show when={alternatives()}><span>Alternative(s)</span></Show><Show when={approval().answered}><span>Approved</span></Show></div>
      <ol class="desk-brief-item-list"><For each={rows()}>{(row, index) => <li class="desk-brief-item" data-node={`row:${row.id}`}>
        <span class="desk-brief-item-id"><bdi dir="ltr" class="desk-brief-item-number">{index() + 1}.</bdi> <bdi dir="ltr">{row.id}</bdi></span>
        {/* The question is the row's primary line, so it carries no label. */}
        <div class="desk-brief-item-cell desk-brief-item-question"><Value value={row.question} /></div>
        <Show when={recommends()}><ItemCell label="Agent recommends"><Value value={row.recommended} /></ItemCell></Show>
        <Show when={alternatives()}><ItemCell label="Alternative(s)"><Show when={row.alternatives.length} fallback={<Value value="" />}>
          <For each={row.alternatives}>{(value, at) => <>{at() ? " · " : ""}<Value value={value} /></>}</For></Show></ItemCell></Show>
        <Show when={approval().answered}><ItemCell label="Approved" class="desk-brief-item-approved"><span dir="auto">{approval().values[index()]}</span></ItemCell></Show>
      </li>}</For></ol>
    </section>
  </Show>
}

const ItemCell = (props: { label: string; class?: string; children: JSX.Element }) =>
  <div class={props.class ? `desk-brief-item-cell ${props.class}` : "desk-brief-item-cell"}><span class="desk-brief-item-label">{props.label}</span>{props.children}</div>

const SourceLinks = (props: { sources: BriefSource[]; refs: EvidenceRef[]; item: DeskItem; host?: string }) => {
  const links = () => props.sources.flatMap(source => { const link = sourceLink(source, props.refs, props.item); return link && !(props.host && link.kind === "Doc") ? [{ ...link, href: link.href + (props.host && link.kind === "Agent thread" ? `&host=${encodeURIComponent(props.host)}` : ""), label: source.label }] : [] })
  return <Show when={links().length}><p class="desk-brief-sources ds-links"><For each={links()}>{link =>
    <A href={link.href}>↗ {link.kind} · <bdi dir="auto">{link.label}</bdi></A>}</For></p></Show>
}

// Drawn by the app in its own type styles, so every brief reads the same way and stays RTL-aware. Elements are the
// brief's picture nodes (brief-view pictureNodes), the same ones the glasses page shows, in the same order.
const Picture = (props: { parts: BriefNode[] }) => {
  const parts = <R extends PicturePart["role"]>(...roles: R[]) => props.parts.filter((node): node is BriefNode & { part: Extract<PicturePart, { role: R }> } => !!node.part && (roles as string[]).includes(node.part.role))
  return <Switch>
    <Match when={parts("compare-head")[0]}>{head =>
      // Columns are the request's own options under their own labels; the recommended one comes from the request.
      <table class="desk-compare"><thead><tr data-node={head().id}><th scope="col"><span class="sr-only">Aspect</span></th><For each={head().part.columns}>{column =>
        <th scope="col" data-recommended={column.recommended ? "" : undefined}><bdi dir="auto">{column.label}</bdi><Show when={column.recommended}><span class="desk-compare-recommended">Agent recommends</span></Show></th>}</For></tr></thead>
        <tbody><For each={parts("compare-row")}>{row => <tr data-node={row.id}><th scope="row"><bdi dir="auto">{row.part.label}</bdi></th><For each={row.part.cells}>{cell => <td><bdi dir="auto">{cell}</bdi></td>}</For></tr>}</For></tbody></table>}</Match>
    <Match when={parts("step").length}>
      {/* `approved` is the request's scope (how many steps an approval would cover), not a recorded answer, so it reads as
        * a description: one line after the last covered step and one before the first later step; later steps are muted. */}
      <ol class="desk-flow" aria-label="Sequence" data-approved={parts("step").some(step => step.part.approved) ? "" : undefined}><For each={parts("step")}>{step =>
        <li data-node={step.id} data-later={step.part.later ? "" : undefined} data-stop={step.part.scope === "covered-last" ? "" : undefined}>
          <bdi dir="auto">{step.part.text}</bdi>
          <Show when={step.part.scope === "covered-last"}><span class="desk-flow-scope">Approving covers {step.part.approved === 1 ? "step 1" : `steps 1–${step.part.approved}`}</span></Show>
          <Show when={step.part.scope === "later-first"}><span class="desk-flow-scope">Later steps need their own decision</span></Show>
        </li>}</For></ol></Match>
    <Match when={parts("change", "change-same").length}>
      {/* Rows that stay the same are muted; more than two of them fold into one line so the changes stand out. */}
      <table class="desk-change"><thead><tr><th scope="col">Thing</th><th scope="col">Now</th><th scope="col">After</th></tr></thead>
        <tbody><For each={parts("change", "change-same")}>{row => row.part.role === "change"
          ? <tr data-node={row.id} data-same={row.part.now === row.part.after ? "" : undefined}><th scope="row" dir="auto">{row.part.item}</th><td dir="auto">{row.part.now}</td><td dir="auto">{row.part.after}</td></tr>
          : <tr data-node={row.id} data-same><td colspan="3" class="desk-change-same" title={row.part.items.join(", ")}>{row.part.count} other things stay the same</td></tr>}</For></tbody></table></Match>
    <Match when={parts("in", "out").length}>
      <div class="desk-scope">
        <Show when={parts("in").length}><div><span class="home-source">In</span><ul><For each={parts("in")}>{entry => <li dir="auto" data-node={entry.id}>{entry.part.text}</li>}</For></ul></div></Show>
        <Show when={parts("out").length}><div data-excluded><span class="home-source">Out</span><ul><For each={parts("out")}>{entry => <li dir="auto" data-node={entry.id}>{entry.part.text}</li>}</For></ul></div></Show>
      </div></Match>
    <Match when={parts("entity").length}><Scene nodes={props.parts} /></Match>
    <Match when={parts("impact").length}>
      <ul class="desk-impact"><For each={parts("impact")}>{row => <li data-node={row.id}><bdi dir="auto">{row.part.area}</bdi> → <bdi dir="auto">{row.part.change}</bdi></li>}</For></ul></Match>
  </Switch>
}

type SceneNode = BriefNode & { part: Extract<PicturePart, { role: "entity" | "relation" | "limit" }> }
// Person, app and server outlines: Lucide icons (ISC); see assets/ACTOR-LICENSES.txt. Each is built per use: one
// JSX element is one DOM node, so a shared one would move to the last part of that role.
const OUTLINE: Partial<Record<SceneRole, () => JSX.Element>> = {
  person: () => <><circle cx="12" cy="8" r="5" /><path d="M20 21a8 8 0 0 0-16 0" /></>,
  app: () => <><rect x="2" y="4" width="20" height="16" rx="2" /><path d="M10 4v4M2 8h20M6 4v4" /></>,
  identity: () => <><rect width="20" height="8" x="2" y="2" rx="2" ry="2" /><rect width="20" height="8" x="2" y="14" rx="2" ry="2" /><path d="M6 6h.01M6 18h.01" /></>,
  unknown: () => <><circle cx="12" cy="8" r="5" stroke-dasharray="2 2" /><path d="M20 21a8 8 0 0 0-16 0" stroke-dasharray="2 2" /><text x="12" y="10.5" font-size="7" text-anchor="middle" stroke="none" fill="currentColor">?</text></>,
  capability: () => <><circle cx="7" cy="12" r="5" /><circle cx="7" cy="12" r="1.5" fill="currentColor" /><path d="M12 12h10M18 12v4M21 12v3" /></>,
  message: () => <><rect x="2" y="5" width="20" height="14" rx="2" stroke-dasharray="3 2" /><path d="M2 6l10 7 10-7" stroke-dasharray="3 2" /></>,
  boundary: () => <><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></>,
}
const Outline = (props: { role: SceneRole }) => <Show when={OUTLINE[props.role]}>{shape =>
  <svg class="brief-scene-icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">{shape()()}</svg>}</Show>

// A scene drawn by domain role: actors on one side with what each would do (a dashed send or request, never a solid
// success), the places they act on as nested containers (a channel room holding a thread, an account fence holding a
// role), and the request's limits. The words are the nodes' own, so the glasses read the same parts in the same order.
const Scene = (props: { nodes: BriefNode[] }) => {
  const nodes = () => props.nodes.filter((node): node is SceneNode => !!node.part && ["entity", "relation", "limit"].includes(node.part.role))
  const entity = (node: SceneNode) => node.part.role === "entity" ? node.part : undefined
  const acting = (id: string) => nodes().some(node => node.part.role === "relation" && node.part.from === id)
  const Part = (props: { node: SceneNode }) => {
    const part = entity(props.node)!
    const relations = () => nodes().filter(node => node.part.role === "relation" && node.part.from === part.id)
    const children = () => nodes().filter(node => entity(node)?.parent === part.id)
    const label = <><Outline role={part.entity} /><Show when={["channel", "thread"].includes(part.entity)}><span class="brief-scene-mark" aria-hidden="true">{SCENE_CUE[part.entity].mark}</span></Show>
      <Show when={part.name} fallback={<span class="brief-missing">{SCENE_CUE[part.entity].noun} not stated</span>}><bdi dir="auto">{part.name}</bdi></Show>
      <Show when={part.note}><span class="brief-scene-note" dir="auto">{part.note}</span></Show></>
    return <div class={part.holds ? "brief-scene-place" : "brief-scene-thing"} data-role={part.entity} data-node={props.node.id}>
      <span class="brief-scene-label">{label}</span>
      <For each={relations()}>{relation => <p class="brief-scene-relation" data-kind={relation.part.role === "relation" ? relation.part.kind : undefined} data-node={relation.id}>
        <span class="brief-scene-arrow" aria-hidden="true" /><span dir="auto">{relation.text.replace(/^- -> /, "")}</span></p>}</For>
      <For each={children()}>{child => <Part node={child} />}</For>
    </div>
  }
  const roots = () => nodes().filter(node => entity(node) && entity(node)!.depth === 0)
  return <div class="brief-scene" aria-label="Who and what this involves">
    <Show when={roots().some(node => acting(entity(node)!.id))}><div class="brief-scene-actors"><For each={roots().filter(node => acting(entity(node)!.id))}>{node => <Part node={node} />}</For></div></Show>
    <div class="brief-scene-places"><For each={roots().filter(node => !acting(entity(node)!.id))}>{node => <Part node={node} />}</For></div>
    <Show when={nodes().some(node => node.part.role === "limit")}><ul class="brief-scene-limits"><For each={nodes().filter(node => node.part.role === "limit")}>{node =>
      <li data-node={node.id} dir="auto"><span aria-hidden="true">✕ </span>{node.part.role === "limit" ? node.part.text : ""}</li>}</For></ul></Show>
  </div>
}

// No scripts, forms, navigation or same-origin access, and CSP blocks every network request.
const CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:"
const FRAME_MARGIN = 8
// The frame cannot see the app's stylesheet, so colours are handed in under the names brief-contract.json gives
// the model. Each role takes the system palette's value (wal-palette/1, `--wal-<role>`) when the page has one,
// else es-app's own token. Status colours come from the palette only when it reports ok and risk stay apart for
// colour-blind readers (`--wal-ok-risk-cvd-safe: 1`). Highlights fall back to the accent. Legacy HTML briefs
// (contract 3) used older names, mapped to the same colours.
// `ds`: the design-system role (appearance.css, "Design system v1") each name reads first, so drawings follow the same
// theme as the app; `app` is the base it aliases, for builds before that block. One accent: the app's own (ux-feel).
const TOKENS: Record<string, { wal?: string; ds?: string; app: string; status?: boolean }> = {
  fg: { wal: "--wal-fg", ds: "--ds-text", app: "--text" }, muted: { wal: "--wal-muted", ds: "--ds-muted", app: "--subtext0" }, line: { wal: "--wal-line", app: "--overlay1" },
  surface: { wal: "--wal-surface", ds: "--ds-raised", app: "--surface0" }, accent: { wal: "--wal-accent", ds: "--ds-accent", app: "--accent" },
  ok: { wal: "--wal-ok", ds: "--ds-ok", app: "--green", status: true }, warn: { wal: "--wal-warn", ds: "--ds-warn", app: "--yellow", status: true }, risk: { wal: "--wal-risk", ds: "--ds-risk", app: "--red", status: true },
  bg: { wal: "--wal-bg", ds: "--ds-surface", app: "--base" }, panel: { wal: "--wal-surface", ds: "--ds-raised", app: "--surface0" }, text: { wal: "--wal-fg", ds: "--ds-text", app: "--text" },
  good: { wal: "--wal-ok", ds: "--ds-ok", app: "--green", status: true }, bad: { wal: "--wal-risk", ds: "--ds-risk", app: "--red", status: true },
}
// es-app's line fallback is overlay1, not surface1: strokes and arrows need 3:1 against the drawing's boxes
// (surface0), which surface1 does not reach (about 1.1-1.6:1).
const HIGHLIGHTS = ["hl1", "hl2", "hl3", "hl4"]
/** The colours a brief drawing gets right now, by contract name. */
export const frameColours = (root: CSSStyleDeclaration) => {
  const read = (name?: string) => name ? root.getPropertyValue(name).trim() : ""
  const statusSafe = read("--wal-ok-risk-cvd-safe") === "1"
  const colours = Object.fromEntries(Object.entries(TOKENS).map(([name, token]) =>
    [name, (token.status && !statusSafe ? "" : read(token.wal)) || read(token.ds) || read(token.app) || "initial"]))
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
export const useCompleteBrief = (item: () => DeskItem, pinned?: () => string | undefined, jobs?: () => BriefJob[]) => {
  const prepared = jobs ? undefined : useBriefs()
  return () => {
    const job = completeBriefJob(jobs?.() ?? prepared!.briefs.jobs(), item(), pinned?.())
    return job?.state.state === "ready" ? job.state.result : undefined
  }
}

/** The ready, complete brief job for one item (or the pinned one): what an answer records it was made from. */
export const useCompleteJob = (item: () => DeskItem, pinned?: () => string | undefined, jobs?: () => BriefJob[]) => {
  const prepared = jobs ? undefined : useBriefs()
  return () => completeBriefJob(jobs?.() ?? prepared!.briefs.jobs(), item(), pinned?.())
}

/** The app-wide prepared brief for one item, as Home and the desk show it. */
export const PreparedBrief = (props: { item: DeskItem; live: boolean; part?: Part; pinned?: string; jobs?: () => BriefJob[]; host?: string }) => {
  // A review item's artifact is its own explanation: no brief panel, prepare control or brief reads (attention ATTN-15).
  if (props.item.kind === "review") return null
  const prepared = props.jobs ? undefined : useBriefs()
  prepared?.view()
  if (props.jobs) return <Show when={completeBriefJob(props.jobs(), props.item, props.pinned)}><BriefPanel item={props.item} live={false} part={props.part} pinned={props.pinned} jobs={props.jobs()}
    canStart={false} confirming={false} start={() => undefined} confirm={() => undefined} host={props.host} /></Show>
  return <BriefPanel item={props.item} live={props.live} auto={prepared!.auto()} part={props.part} pinned={props.pinned}
    jobs={prepared!.briefs.jobs().filter(job => job.meta.source === props.item.key)}
    canStart={(!prepared!.auto() || prepared!.anchor.ready()) && !prepared!.briefs.pending() && !prepared!.briefs.preparing() && !prepared!.unavailable()} unavailable={prepared!.unavailable() || prepared!.anchor.error() || undefined} unavailableDetail={prepared!.anchor.detail()}
    confirming={prepared!.briefs.jobs().some(job => job.state.state === "starting")}
    start={() => void prepared!.briefs.start(props.item)} confirm={() => void prepared!.briefs.confirm()}
    regenerate={() => void prepared!.briefs.regenerate(props.item)} regenerating={prepared!.briefs.regenerating()} />
}
