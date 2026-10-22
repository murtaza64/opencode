/* Derived, source-revision-bound brief for one queue item. The canonical request it explains is
 * rendered separately and stays the authority; this only makes it readable. */
import { For, Show } from "solid-js"
import { useBriefs } from "../desk-briefs"
import { A } from "@solidjs/router"
import { sessionHref } from "../state"
import type { BriefResult, DeskItem, EvidenceRef } from "../desk"
import type { BriefJob } from "../desk-session"

const Refs = (props: { refs: string[]; known: EvidenceRef[]; item: DeskItem }) =>
  <For each={props.refs}>{id => {
    const ref = () => props.known.find(candidate => candidate.id === id)
    return <Show when={ref()?.messageID} fallback={<span class="desk-ref" title={ref()?.label}>{id}</span>}>
      <A class="desk-ref" title={ref()?.label} href={sessionHref(props.item.source.session, props.item.source.directory)}>{id}</A>
    </Show>
  }}</For>

export const BriefPanel = (props: { item: DeskItem; live: boolean; jobs: BriefJob[]; canStart: boolean; confirming: boolean; start: () => void; confirm: () => void; unavailable?: string; auto?: boolean }) => {
  const current = () => props.jobs.find(job => job.meta.revision === props.item.revision)
  const discarded = () => props.jobs.filter(job => job.meta.revision !== props.item.revision)
  const ready = () => { const job = current(); return job?.state.state === "ready" ? { job, result: job.state.result as BriefResult, omitted: job.state.omitted } : undefined }
  return <section class="desk-brief" aria-label="Derived evidence brief">
    <Show when={current()} fallback={<Show when={props.live}>
      <Show when={props.auto && !props.unavailable} fallback={<>
        <button class="desk-button" disabled={!props.canStart} onClick={props.start}>Prepare brief</button>
        <Show when={props.unavailable}><span class="home-source"> {props.unavailable}</span></Show>
      </>}><p class="home-muted" role="status">Preparing a readable brief…</p></Show>
    </Show>}>{job => <>
      <Show when={job().state.state === "starting" || job().state.state === "running"}><p class="home-muted" role="status">Explaining in the background…</p></Show>
      <Show when={job().state.state === "failed"}><p class="home-warning">Brief failed: {(job().state as { error: string }).error} It was not rerun.</p></Show>
      <Show when={job().state.state === "unknown"}><p class="home-warning">{(job().state as { reason: string }).reason}</p></Show>
      <Show when={job().state.state === "unconfirmed"}><p class="home-warning">Start was not confirmed. Confirming resends the identical request; Core returns the same check if it exists.</p>
        <button class="desk-button" disabled={props.confirming} onClick={props.confirm}>Confirm start</button></Show>
      <Show when={(job().state.state === "failed" || job().state.state === "unknown") && props.live}><button class="desk-button" disabled={!props.canStart} onClick={props.start}>Prepare again</button></Show>
      <Show when={ready()}>{value => <div class="desk-brief-body">
        <span class="desk-brief-chip">Brief</span>
        <dl class="desk-brief-plain">
          <Show when={value().result.ask || value().result.summary}><dt>You decide</dt><dd dir="auto">{value().result.ask || value().result.summary}</dd></Show>
          <Show when={value().result.whyNow}><dt>Why now</dt><dd dir="auto">{value().result.whyNow}</dd></Show>
          <Show when={value().result.ifRecommended}><dt>If you follow the recommendation</dt><dd dir="auto">{value().result.ifRecommended}</dd></Show>
          <Show when={value().result.ifWait}><dt>If you wait</dt><dd dir="auto">{value().result.ifWait}</dd></Show>
        </dl>
        <Show when={value().result.ask && value().result.summary}><p dir="auto">{value().result.summary}</p></Show>
        <Show when={value().result.visual}>{visual => <Visual title={visual().title} html={visual().html} />}</Show>
        <Show when={value().result.flow.length}><ol class="desk-flow" aria-label="Flow">{<For each={value().result.flow}>{step => <li><bdi dir="auto">{step}</bdi></li>}</For>}</ol></Show>
        <Show when={value().result.facts.length}><h3>Facts</h3><ul><For each={value().result.facts}>{fact => <li><bdi dir="auto">{fact.text}</bdi> <Refs refs={fact.refs} known={value().job.meta.refs} item={props.item} /></li>}</For></ul></Show>
        <Show when={value().result.timeline.length}><h3>Timeline</h3><ol class="desk-timeline"><For each={value().result.timeline}>{entry => <li><Show when={entry.when}><span class="home-source">{entry.when} · </span></Show><bdi dir="auto">{entry.text}</bdi> <Refs refs={entry.refs} known={value().job.meta.refs} item={props.item} /></li>}</For></ol></Show>
        <Show when={value().result.gaps.length}><h3>Not in the evidence</h3><ul><For each={value().result.gaps}>{gap => <li><bdi dir="auto">{gap}</bdi></li>}</For></ul></Show>
        <Show when={value().omitted}><p class="home-source">{value().omitted} uncited statement(s) omitted.</p></Show>
      </div>}</Show>
      <p class="home-source">Derived from revision {job().meta.revision}, not authoritative · <A href={sessionHref(job().id, job().directory)}>brief source</A></p>
    </>}</Show>
    <Show when={!current() && discarded().length}><p class="home-source">An earlier brief was discarded: the request changed since revision {discarded()[0]!.meta.revision}.</p></Show>
  </section>
}


// No scripts, forms, navigation or same-origin access, and CSP blocks every network request.
const CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:"
const Visual = (props: { title: string; html: string }) =>
  <figure class="desk-visual">
    <iframe title={props.title || "Brief visual"} sandbox="" referrerpolicy="no-referrer" loading="lazy"
      srcdoc={`<!doctype html><meta http-equiv="Content-Security-Policy" content="${CSP}"><style>html{color-scheme:dark;color:#cdd6f4;background:#181825;font:13px system-ui,sans-serif}body{margin:10px}</style>${props.html}`} />
    <Show when={props.title}><figcaption class="home-source">{props.title} · drawn by the brief, not authoritative</figcaption></Show>
  </figure>

/** The app-wide prepared brief for one item, as Home and the desk show it. */
export const PreparedBrief = (props: { item: DeskItem; live: boolean }) => {
  const prepared = useBriefs()
  prepared.view()
  const briefs = prepared.briefs
  return <BriefPanel item={props.item} live={props.live} auto={prepared.auto()}
    jobs={briefs.jobs().filter(job => job.meta.source === props.item.key)}
    canStart={(!prepared.auto() || prepared.anchor.ready()) && !briefs.pending() && !briefs.preparing()} unavailable={prepared.anchor.error() || undefined}
    confirming={briefs.jobs().some(job => job.state.state === "starting")}
    start={() => void briefs.start(props.item)} confirm={() => void briefs.confirm()} />
}
