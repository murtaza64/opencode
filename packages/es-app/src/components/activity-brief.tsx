import { createMemo, createSignal, onCleanup } from "solid-js"
import { activityBrief, activityBriefLabel, type ActivityBriefInput } from "../activity-brief"
import "./activity-brief.css"

const [now, setNow] = createSignal(Date.now())
let users = 0
let timer: ReturnType<typeof setInterval> | undefined

// One clock for the selected session and bounded pinned rows; no telemetry requests.
export const ActivityBriefView = (props: { input: ActivityBriefInput }) => {
  if (!users++) {
    setNow(Date.now())
    timer = setInterval(() => setNow(Date.now()), 15_000)
  }
  onCleanup(() => {
    if (--users) return
    clearInterval(timer)
    timer = undefined
  })
  const brief = createMemo(() => activityBrief(props.input, Math.max(now(), Date.now())))
  const label = () => activityBriefLabel(brief(), Math.max(now(), Date.now()))
  return (
    <span class="activity-brief" data-source={brief().source} title={`${brief().text} — ${label()}`}>
      <bdi class="activity-brief-text" dir="auto">
        {brief().text}
      </bdi>
      <bdi class="activity-brief-source" dir="auto">
        {label()}
      </bdi>
    </span>
  )
}
