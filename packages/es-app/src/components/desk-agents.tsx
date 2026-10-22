/* Agents on the Front Desk: pinned agents with their activity, cloud agents,
 * other sessions and recent activity. Topology lives on the Agent map. */
import { createEffect, createSignal, For, onCleanup, Show } from "solid-js"
import { A } from "@solidjs/router"
import { sessionHref, useDashboard, type SessionRow } from "../state"
import { CurrentWorkView, type CurrentWorkSnapshot } from "../current-work"
import { ActivityBriefView } from "./activity-brief"
import type { ActivityBriefInput } from "../activity-brief"
import HomeActivity from "../home-activity"
import { FailureRetry } from "./session-failure"
import { failureLabel } from "../session-failures"
import HomeCloudAgents from "../home-cloud-agents"
import type { HomeActivityRow } from "../home-activity-data"
import { TodoLine, turnOf } from "./todo-line"
import "../pages/home.css"

const PinnedAgent = (props: { session: SessionRow }) => {
  const dashboard = useDashboard()
  const [work, setWork] = createSignal<CurrentWorkSnapshot>({ value: null, checked: 0, error: false, loading: true })
  createEffect(() => onCleanup(dashboard.activity.todos.watch(props.session.id, props.session.directory)))
  const brief = (): ActivityBriefInput => {
    const snapshot = work()
    const status = !snapshot.value || snapshot.error || Date.now() - snapshot.checked > (snapshot.value.turn.status === "busy" ? 15_000 : 45_000) ? "unknown" : snapshot.value.turn.status
    const lane = (dashboard.state()?.threads ?? []).flatMap((thread: { lanes?: { owner: string; activity?: string; activity_at?: string; activity_session?: string }[] }) => thread.lanes ?? [])
      .find((lane: { owner: string }) => lane.owner === props.session.id)
    return {
      sessionID: props.session.id,
      status,
      report: lane?.activity && lane.activity_session && lane.activity_at ? { sessionID: lane.activity_session, owner: lane.owner, text: lane.activity, at: Date.parse(lane.activity_at) } : undefined,
      // This endpoint has safe tool names but no start times. TODOs render separately with their own provenance.
      tools: snapshot.value?.turn.active_tools.map(tool => ({ name: tool.name, status: tool.status, sessionID: props.session.id })),
    }
  }
  const failure = () => dashboard.handedOff(props.session.id) ? undefined : dashboard.failures.failure(props.session.id)
  return <div class="home-agent">
    <div><A class="home-name" href={sessionHref(props.session.id, props.session.directory)}><Show when={failure()}>{item => <span class="dot failed" role="img" aria-label={`Failed: ${failureLabel(item())}`} title={`Failed: ${failureLabel(item())}`} />}</Show><bdi dir="auto">{props.session.title || props.session.id}</bdi></A><Show when={failure()}>{item => <div class="home-failed">{failureLabel(item())} <FailureRetry sessionID={props.session.id} compact /></div>}</Show><div class="home-muted"><bdi dir="auto">{props.session.project || dashboard.editspace() || "project"}</bdi></div><button onClick={() => dashboard.togglePin(props.session)}>Unpin</button></div>
    <div><ActivityBriefView input={brief()} /><TodoLine session={props.session} turn={turnOf(work())} /><details><summary>Turn telemetry</summary><CurrentWorkView id={props.session.id} directory={props.session.directory} compact onSnapshot={setWork} /></details></div>
  </div>
}

export const DeskAgents = (props: { project?: string }) => {
  const dashboard = useDashboard()
  const [cloudCount, setCloudCount] = createSignal(0)
  const [cloudActivity, setCloudActivity] = createSignal<HomeActivityRow[]>([])
  return <>
    <section aria-label="Pinned agents"><div class="home-section"><h2>Pinned agents <span>{dashboard.pinnedSessions().length + cloudCount()}</span></h2></div><For each={dashboard.pinnedSessions()} fallback={<p class="home-muted">No pinned agents.</p>}>{session => <PinnedAgent session={session} />}</For><HomeCloudAgents project={props.project} onCount={setCloudCount} onActivity={setCloudActivity} /><details class="home-workers"><summary>Other sessions ({dashboard.unpinnedSessions().length})</summary><For each={dashboard.unpinnedSessions()}>{session => <div class="home-other"><A href={sessionHref(session.id, session.directory)}><bdi dir="auto">{session.title || session.id}</bdi></A><button onClick={() => dashboard.togglePin(session)}>Pin</button></div>}</For></details></section>
    <HomeActivity cloud={cloudActivity()} />
  </>
}
